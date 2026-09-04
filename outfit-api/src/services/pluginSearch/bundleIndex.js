'use strict';

const roblox = require('../../roblox/client');
const cacheStore = require('../../cache/cacheStore');
const config = require('../../config');
const logger = require('../../observability/logger');
const rateLimiter = require('../../roblox/rateLimiter');
const requestContext = require('../../observability/requestContext');
const { specialBundleForAsset } = require('../../catalog/specialBundles');

// ETAPA 3b — BUNDLES. Solo para los assets que NO tienen precio propio y que
// pertenecen a un tipo que Roblox vende dentro de un pack (partes del cuerpo,
// Dynamic Heads y sus Mood).
//
// POR QUE HACE FALTA. Un brazo de Korblox no tiene precio en items/details: no
// se vende suelto. Su precio vive en el bundle (17.000 Robux los seis). Sin
// esta etapa, un avatar con Korblox se quedaba sin valorar entero — que es
// justo el caso mas caro y mas visible.
//
// COMO SE PAGA SIN ROMPER LA CUOTA. La busqueda inversa
// (catalog/v1/assets/{id}/bundles) es el UNICO endpoint de Roblox sin lote: una
// llamada por asset. Se controla en cuatro niveles, de mas barato a mas caro:
//
//   1. REGISTRO CURADO. Korblox y Headless se resuelven de memoria, sin una
//      sola llamada. Son ademas los dos que mas dinero mueven y los dos que la
//      busqueda inversa falla (documentado en catalog/specialBundles.js).
//   2. CACHE COMPARTIDA de 24 h, la misma que usa /v1/catalog/batch: la
//      pertenencia asset -> bundle es estructural y no cambia nunca.
//   3. PRESUPUESTO por busqueda (PLUGIN_SEARCH_MAX_BUNDLE_LOOKUPS). Agotado,
//      los assets restantes se quedan sin valorar en vez de seguir gastando.
//   4. BACKPRESSURE, igual que el catalogo: si la ruta esta frenada no se
//      pregunta nada, ni se insiste.
//
// El precio del bundle SI va por lotes (bundles/details admite 100 ids), asi
// que descubrir 12 bundles distintos cuesta 12 busquedas inversas + UNA sola
// llamada de precio.

const RUTA_INVERSA = 'assetBundles';
const RUTA_DETALLES = 'bundleDetails';

// Las mismas claves que ya usan catalogService y outfitService: resolver aqui
// deja resuelto alli y al reves.
const bundlesDeAssetKey = assetId => cacheStore.key('asset', 'bundles', assetId);
const detallesDeBundleKey = bundleId => cacheStore.key('bundle', 'details', bundleId);

function crearIndiceDeBundles(stats) {
    // assetId -> bundleId (o null si se comprobo y no tiene).
    const porAsset = new Map();
    // bundleId -> registro de bundles/details.
    const detalles = new Map();

    let presupuesto = config.pluginSearch.maxBundleLookups;

    return {
        // El bundle de un asset, o null si no tiene o no se pudo averiguar.
        bundleDe(assetId) {
            return porAsset.get(assetId) ?? null;
        },

        detalle(bundleId) {
            return bundleId === null ? undefined : detalles.get(bundleId);
        },

        // Resuelve el bundle de los assets indicados y el precio de los bundles
        // que aparezcan. No lanza: lo que no se pueda resolver se queda sin
        // bundle y el valorador lo contara como no valorable.
        async asegurar(assetIds) {
            const pendientes = [...new Set(assetIds)].filter(id => !porAsset.has(id));
            if (pendientes.length === 0) return;

            // ── Nivel 1: registro curado, gratis ─────────────────────────────
            const porBuscar = [];
            for (const assetId of pendientes) {
                const especial = specialBundleForAsset(assetId);
                if (especial) {
                    porAsset.set(assetId, especial);
                    stats.sumar('bundleSpecialHits');
                } else {
                    porBuscar.push(assetId);
                }
            }

            // ── Nivel 2: cache compartida de la busqueda inversa ─────────────
            const sinResolver = [];
            for (const assetId of porBuscar) {
                const cacheado = await cacheStore.get(bundlesDeAssetKey(assetId));
                if (cacheado === undefined) {
                    sinResolver.push(assetId);
                    continue;
                }
                stats.marcarCache('hit');
                porAsset.set(assetId, primerBundle(cacheado));
            }

            // ── Niveles 3 y 4: presupuesto y backpressure ────────────────────
            for (const assetId of sinResolver) {
                if (presupuesto <= 0) {
                    // Se marca como comprobado-sin-bundle para no volver a
                    // mirarlo en las siguientes olas de esta misma busqueda.
                    porAsset.set(assetId, null);
                    stats.sumar('bundleLookupsSkipped');
                    continue;
                }

                const freno = rateLimiter.getThrottleState(RUTA_INVERSA);
                if (freno.throttled) {
                    porAsset.set(assetId, null);
                    stats.sumar('bundleLookupsSkipped');
                    continue;
                }

                presupuesto--;
                stats.sumar('bundleLookups');
                stats.marcarCache('miss');

                try {
                    const encontrados = await cacheStore.withCache(
                        bundlesDeAssetKey(assetId),
                        config.ttl.assetBundles,
                        () => roblox.getBundlesForAsset(assetId),
                        { negativeTtlMs: config.ttl.negative }
                    );
                    porAsset.set(assetId, primerBundle(encontrados));
                } catch (err) {
                    // Sin bundle averiguado. No es un error de la busqueda: ese
                    // asset simplemente se quedara sin valorar.
                    porAsset.set(assetId, null);
                    logger.debug('No se pudo resolver el bundle de un asset', {
                        assetId, detail: err?.message,
                    });
                }
            }

            await asegurarDetalles();
        },
    };

    // Precio y composicion de los bundles descubiertos, POR LOTES.
    async function asegurarDetalles() {
        const faltan = [...new Set([...porAsset.values()])]
            .filter(bundleId => bundleId !== null && !detalles.has(bundleId));
        if (faltan.length === 0) return;

        const desdeCache = [];
        for (const bundleId of faltan) {
            const cacheado = await cacheStore.get(detallesDeBundleKey(bundleId));
            if (cacheado !== undefined) {
                detalles.set(bundleId, cacheado);
                stats.marcarCache('hit');
            } else {
                desdeCache.push(bundleId);
                stats.marcarCache('miss');
            }
        }
        if (desdeCache.length === 0) return;

        const freno = rateLimiter.getThrottleState(RUTA_DETALLES);
        if (freno.throttled) {
            logger.warn('Precio de bundles omitido: la ruta esta limitada', {
                requestId: requestContext.requestId(),
                routeKey: RUTA_DETALLES,
                reason: freno.reason,
                bundlesSinResolver: desdeCache.length,
            });
            return;
        }

        stats.sumar('bundleBatches');
        try {
            const resueltos = await roblox.getBundleDetails(desdeCache.map(Number));
            for (const bundleId of desdeCache) {
                const registro = resueltos.get(bundleId) ?? { available: false };
                await cacheStore.set(detallesDeBundleKey(bundleId), registro, config.ttl.bundleDetails);
                detalles.set(bundleId, registro);
            }
        } catch (err) {
            // Sin precio de bundle, sus piezas se quedan sin valorar. Se
            // registra una linea agregada, no una por bundle.
            logger.warn('No se pudo resolver el precio de un lote de bundles', {
                requestId: requestContext.requestId(),
                bundles: desdeCache.length,
                detail: err?.message,
            });
        }
    }
}

// Un asset puede pertenecer a varios bundles segun Roblox (y alguno es ruido,
// como el "BundleForTesting" documentado en roblox/client.js). Se usa el
// primero, que es el que Roblox devuelve como principal.
function primerBundle(bundles) {
    if (!Array.isArray(bundles) || bundles.length === 0) return null;
    return String(bundles[0].id);
}

module.exports = { crearIndiceDeBundles };
