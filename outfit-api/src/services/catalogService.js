'use strict';

const roblox = require('../roblox/client');
const cacheStore = require('../cache/cacheStore');
const singleFlight = require('../cache/singleFlight');
const config = require('../config');
const logger = require('../observability/logger');
const requestContext = require('../observability/requestContext');
const { describeAssetType, isBundleBacked, isBodyPart } = require('../catalog/assetTypes');
const { specialBundleForAsset, specialLabel } = require('../catalog/specialBundles');

// LA INTELIGENCIA DE CATALOGO, entera y en un solo sitio.
//
// Lo que este modulo se lleva del juego de Roblox: nombre, precio, tipo, si
// esta fuera de venta, si es limitado, a que bundle pertenece cada asset, que
// es una Dynamic Head, que es su Mood, que es Korblox y que es Headless — y,
// sobre todo, QUE HAY QUE COMPROBAR para saber si un jugador lo tiene.
//
// Lo que NO se lleva y sigue siendo de Roblox: si el jugador lo posee, las
// compras, el HumanoidDescription, la interfaz y los DataStores. Eso necesita
// al jugador delante y no se puede resolver desde fuera.
//
// ═══ TRES OLAS, NI UNA LLAMADA DE MAS ═══
//
//   Ola 1  items/details (LOTE MIXTO: assets + los bundles que ya se conocen)
//          -> nombre, tipo, precio, offsale, limitado, reventa
//   Ola 2  assets/{id}/bundles, SOLO para tipos que pueden venir en bundle
//          -> descubre a que bundle pertenece una Dynamic Head, un Mood o una
//             pierna de Korblox. Unico endpoint sin lote: por eso va acotado.
//   Ola 3  bundles/details (LOTE) para todos los bundles, pedidos y descubiertos
//          -> composicion (que assets lo forman) + precio + reventa
//          + items/details de los bundles descubiertos, solo para saber si son
//            limitados (bundles/details no trae itemRestrictions)
//
// Coste de un outfit tipico en frio: 1 + 2 + 1 + 1 = 5 llamadas. En caliente:
// CERO. Todo se cachea POR ITEM y de forma GLOBAL, asi que el segundo jugador
// que abra el mismo outfit —o cualquier otro que comparta una pieza— no gasta
// ninguna.

// ── Claves de cache ─────────────────────────────────────────────────────────
// Las dos primeras YA EXISTEN y las comparte /v1/outfits?catalog=1&bundles=1:
// resolver un asset aqui lo deja resuelto alli y al reves.
const catalogKey = assetId => cacheStore.key('asset', 'catalog', assetId);
const assetBundlesKey = assetId => cacheStore.key('asset', 'bundles', assetId);
const bundleCatalogKey = bundleId => cacheStore.key('bundle', 'catalog', bundleId);
const bundleDetailsKey = bundleId => cacheStore.key('bundle', 'details', bundleId);

// Registro de un item que Roblox no devolvio: borrado, moderado o fuera del
// catalogo. Conserva TODAS las claves para que el juego no tenga que comprobar
// la presencia de cada campo. `null` significa "no se sabe" — poner `false`
// seria inventarselo.
const SIN_FICHA = Object.freeze({
    available: false,
    name: null,
    itemType: null,
    assetTypeId: null,
    bundleTypeId: null,
    restrictions: null,
    isLimited: null,
    offSale: null,
    price: null,
    lowestPrice: null,
    lowestResalePrice: null,
    hasResellers: null,
    collectibleItemId: null,
    creatorType: null,
    creatorTargetId: null,
    creatorName: null,
});

const unicos = ids => [...new Set(ids.map(String))];

function creador(registro) {
    if (registro.creatorType == null && registro.creatorTargetId == null) return null;
    return {
        type: registro.creatorType ?? null,
        id: registro.creatorTargetId != null ? String(registro.creatorTargetId) : null,
        name: registro.creatorName ?? null,
    };
}

// Datos de reventa. Se incluyen porque items/details Y bundles/details YA los
// devuelven en la misma respuesta: no cuestan ni una llamada extra. Si Roblox
// dejara de mandarlos, salen null en vez de cero.
function reventa(registro) {
    return {
        lowestPrice: registro.lowestPrice ?? null,
        lowestResalePrice: registro.lowestResalePrice ?? null,
        hasResellers: registro.hasResellers ?? null,
        collectibleItemId: registro.collectibleItemId ?? null,
    };
}

// ── Ola 1: ficha de catalogo de los assets ──────────────────────────────────

async function resolverFichasDeAsset(assetIds, fallos) {
    const fichas = new Map();
    const faltantes = [];

    for (const assetId of assetIds) {
        const cacheado = await cacheStore.get(catalogKey(assetId));
        if (cacheado !== undefined) fichas.set(assetId, cacheado);
        else faltantes.push(assetId);
    }

    if (faltantes.length === 0) return fichas;

    try {
        // single-flight sobre el conjunto EXACTO de ids que faltan: dos
        // servidores abriendo el mismo outfit frio a la vez producen una sola
        // llamada, no dos.
        const detalles = await singleFlight.run(
            `catalog:assets:${faltantes.join('.')}`,
            () => roblox.getCatalogItemDetails(
                faltantes.map(id => ({ itemType: 'Asset', id: Number(id) }))
            )
        );

        for (const assetId of faltantes) {
            const registro = detalles.get(roblox.catalogKey('Asset', Number(assetId))) ?? SIN_FICHA;
            await cacheStore.set(catalogKey(assetId), registro, config.ttl.catalogDetails);
            fichas.set(assetId, registro);
        }
    } catch (err) {
        fallos.assetIds.push(...faltantes);
        logger.warn('No se pudo resolver la ficha de catalogo de un lote', {
            // null cuando quien llama no abrio contexto de correlacion.
            requestId: requestContext.requestId(),
            assets: faltantes.length, detail: err?.message,
        });
    }

    return fichas;
}

// ── Ola 2: busqueda inversa asset -> bundle ─────────────────────────────────

// SOLO para tipos que de verdad pueden venir en un bundle. Es la optimizacion
// que hace viable este endpoint: `assets/{id}/bundles` no admite lote, asi que
// preguntarlo por los 20 assets de un outfit costaria 20 llamadas. Preguntarlo
// solo por partes del cuerpo, Dynamic Heads y Moods lo deja en 1-3.
function candidatosAInversa(assetIds, fichas) {
    return assetIds.filter(assetId => {
        const ficha = fichas.get(assetId);
        return ficha?.available === true && isBundleBacked(ficha.assetTypeId);
    });
}

async function resolverBundlesDeAssets(candidatos, fallos) {
    const porAsset = new Map();

    const limite = config.catalogBatch.maxReverseLookups;
    const aResolver = candidatos.slice(0, limite);
    const truncados = candidatos.slice(limite);

    if (truncados.length > 0) {
        logger.warn('Busqueda inversa de bundles truncada', {
            candidatos: candidatos.length, resueltos: aResolver.length,
        });
    }

    await Promise.all(aResolver.map(async assetId => {
        try {
            const bundles = await cacheStore.withCache(
                assetBundlesKey(assetId),
                config.ttl.assetBundles,
                () => roblox.getBundlesForAsset(assetId),
                { negativeTtlMs: config.ttl.negative }
            );
            porAsset.set(assetId, bundles.map(b => String(b.id)));
        } catch (err) {
            // null != []. [] es "Roblox dijo que ninguno"; null es "no se pudo
            // comprobar". El registro curado de specialBundles cubre el hueco
            // para Korblox y Headless.
            porAsset.set(assetId, null);
            logger.warn('No se pudo resolver el bundle de un asset', { assetId, detail: err?.message });
        }
    }));

    for (const assetId of truncados) porAsset.set(assetId, null);
    if (truncados.length > 0) fallos.reverseTruncated = truncados.length;

    return porAsset;
}

// ── Ola 3: detalles de los bundles ──────────────────────────────────────────

async function resolverBundles(bundleIds, yaEnLote1, fallos) {
    const composicion = new Map();
    const fichas = new Map();

    const faltanComposicion = [];
    for (const bundleId of bundleIds) {
        const cacheado = await cacheStore.get(bundleDetailsKey(bundleId));
        if (cacheado !== undefined) composicion.set(bundleId, cacheado);
        else faltanComposicion.push(bundleId);
    }

    if (faltanComposicion.length > 0) {
        try {
            const detalles = await singleFlight.run(
                `catalog:bundles:${faltanComposicion.join('.')}`,
                () => roblox.getBundleDetails(faltanComposicion.map(Number))
            );
            for (const bundleId of faltanComposicion) {
                const registro = detalles.get(bundleId) ?? { available: false };
                await cacheStore.set(bundleDetailsKey(bundleId), registro, config.ttl.bundleDetails);
                composicion.set(bundleId, registro);
            }
        } catch (err) {
            fallos.bundleIds.push(...faltanComposicion);
            logger.warn('No se pudo resolver la composicion de un lote de bundles', {
                bundles: faltanComposicion.length, detail: err?.message,
            });
        }
    }

    // `itemRestrictions` (limitado) NO viene en bundles/details, solo en
    // items/details. Se pide unicamente para los bundles que no pasaron por la
    // ola 1 — es decir, los DESCUBIERTOS por la busqueda inversa.
    const faltanFicha = [];
    for (const bundleId of bundleIds) {
        if (yaEnLote1.has(bundleId)) continue;
        const cacheado = await cacheStore.get(bundleCatalogKey(bundleId));
        if (cacheado !== undefined) fichas.set(bundleId, cacheado);
        else faltanFicha.push(bundleId);
    }

    if (faltanFicha.length > 0) {
        try {
            const detalles = await singleFlight.run(
                `catalog:bundleitems:${faltanFicha.join('.')}`,
                () => roblox.getCatalogItemDetails(faltanFicha.map(id => ({ itemType: 'Bundle', id: Number(id) })))
            );
            for (const bundleId of faltanFicha) {
                const registro = detalles.get(roblox.catalogKey('Bundle', Number(bundleId))) ?? SIN_FICHA;
                await cacheStore.set(bundleCatalogKey(bundleId), registro, config.ttl.catalogDetails);
                fichas.set(bundleId, registro);
            }
        } catch (err) {
            // No es motivo para dejar el bundle fuera: la composicion y el
            // precio ya se tienen. Solo se queda sin saber si es limitado.
            logger.warn('No se pudo resolver la ficha de catalogo de unos bundles', {
                bundles: faltanFicha.length, detail: err?.message,
            });
        }
    }

    return { composicion, fichas };
}

// ── Ensamblado ──────────────────────────────────────────────────────────────

// Etiqueta especial de un asset: primero su bundle (Korblox/Headless), luego
// su tipo. Un Mood de una Dynamic Head se etiqueta como `moodAnimation`, no
// como `dynamicHead`, aunque compartan bundle: son piezas distintas y el juego
// las trata distinto.
function etiquetaDeAsset(ficha, bundleIds) {
    for (const bundleId of bundleIds) {
        const especial = specialLabel(bundleId);
        if (especial) return especial;
    }
    if (ficha.assetTypeId === 79) return 'dynamicHead';
    if (ficha.assetTypeId === 78) return 'moodAnimation';
    if (isBodyPart(ficha.assetTypeId)) return 'bodyPart';
    return null;
}

function construirAsset(assetId, ficha, bundleIds) {
    if (ficha.available !== true) {
        return {
            assetId,
            found: false,
            name: null,
            assetType: { id: null, name: null },
            price: null, offSale: null, limited: null, restrictions: null,
            resale: { lowestPrice: null, lowestResalePrice: null, hasResellers: null, collectibleItemId: null },
            creator: null,
            bundleIds,
            special: bundleIds.map(specialLabel).find(Boolean) ?? null,
            // Sin ficha no se puede afirmar que venga de un bundle, asi que la
            // comprobacion honesta es la del propio asset.
            ownedVia: bundleIds.length > 0
                ? { kind: 'Bundle', id: bundleIds[0] }
                : { kind: 'Asset', id: assetId },
        };
    }

    return {
        assetId,
        found: true,
        name: ficha.name,
        assetType: describeAssetType(ficha.assetTypeId),
        price: ficha.price,
        offSale: ficha.offSale,
        limited: ficha.isLimited,
        restrictions: ficha.restrictions,
        resale: reventa(ficha),
        creator: creador(ficha),
        bundleIds,
        special: etiquetaDeAsset(ficha, bundleIds),
        // LA CLAVE DE TODO: que tiene que comprobar Roblox para este asset. Si
        // viene de un bundle, se comprueba el BUNDLE — es una sola llamada en
        // vez de una por pieza, y es ademas como Roblox concede estos objetos.
        ownedVia: bundleIds.length > 0
            ? { kind: 'Bundle', id: bundleIds[0] }
            : { kind: 'Asset', id: assetId },
    };
}

function construirBundle(bundleId, composicion, ficha) {
    const disponible = composicion?.available === true;
    return {
        bundleId,
        found: disponible,
        name: composicion?.name ?? ficha?.name ?? null,
        bundleType: composicion?.bundleType ?? null,
        price: composicion?.price ?? ficha?.price ?? null,
        forSale: composicion?.forSale ?? null,
        // De items/details; null si ese bundle no llego a pasar por ahi.
        limited: ficha?.isLimited ?? null,
        restrictions: ficha?.restrictions ?? null,
        resale: {
            lowestPrice: composicion?.lowestPrice ?? ficha?.lowestPrice ?? null,
            lowestResalePrice: composicion?.lowestResalePrice ?? ficha?.lowestResalePrice ?? null,
            hasResellers: composicion?.hasResellers ?? ficha?.hasResellers ?? null,
            collectibleItemId: composicion?.collectibleItemId ?? ficha?.collectibleItemId ?? null,
        },
        creator: disponible
            ? { type: composicion.creatorType, id: composicion.creatorTargetId, name: composicion.creatorName }
            : (ficha ? creador(ficha) : null),
        assetIds: composicion?.assetIds ?? [],
        special: specialLabel(bundleId),
    };
}

// La lista MINIMA de comprobaciones que tiene que hacer el juego. Aqui se
// colapsan N assets en 1 bundle: si cinco piezas vienen del mismo pack, el
// juego hace UNA llamada de propiedad, no cinco.
function construirOwnershipChecks(assets, bundles) {
    const checks = new Map();

    const anotar = (kind, id, assetId) => {
        const clave = `${kind}:${id}`;
        if (!checks.has(clave)) {
            checks.set(clave, { kind, id, special: kind === 'Bundle' ? specialLabel(id) : null, covers: [] });
        }
        if (assetId && !checks.get(clave).covers.includes(assetId)) {
            checks.get(clave).covers.push(assetId);
        }
    };

    for (const asset of assets) anotar(asset.ownedVia.kind, asset.ownedVia.id, asset.assetId);

    // Un bundle pedido explicitamente se comprueba aunque ninguno de sus
    // assets venga en la peticion: el juego pregunto por el.
    for (const bundle of bundles) anotar('Bundle', bundle.bundleId, null);

    return [...checks.values()];
}

// ── Entrada publica ─────────────────────────────────────────────────────────

async function resolveBatch({ assetIds = [], bundleIds = [], resolveBundles = true }) {
    const assets = unicos(assetIds);
    const bundlesPedidos = unicos(bundleIds);

    const fallos = { assetIds: [], bundleIds: [], reverseTruncated: 0 };

    // Ola 1.
    const fichasDeAsset = await resolverFichasDeAsset(assets, fallos);

    // Ola 2 — solo los tipos que pueden venir en bundle.
    const inversa = resolveBundles
        ? await resolverBundlesDeAssets(candidatosAInversa(assets, fichasDeAsset), fallos)
        : new Map();

    // Bundle de cada asset: lo que dijo Roblox, y si no dijo nada, el registro
    // curado (Korblox/Headless), que existe justamente porque la busqueda
    // inversa tiene huecos conocidos.
    const bundlesPorAsset = new Map();
    for (const assetId of assets) {
        const deRoblox = inversa.get(assetId);
        const curado = specialBundleForAsset(assetId);
        const lista = Array.isArray(deRoblox) ? [...deRoblox] : [];
        if (curado && !lista.includes(curado)) lista.push(curado);
        bundlesPorAsset.set(assetId, lista);
    }

    // Todos los bundles en juego: los pedidos y los descubiertos.
    const todosLosBundles = unicos([...bundlesPedidos, ...[...bundlesPorAsset.values()].flat()]);

    // Ola 3.
    const { composicion, fichas: fichasDeBundle } = await resolverBundles(
        todosLosBundles, new Set(bundlesPedidos), fallos
    );

    // Un bundle pedido explicitamente tambien aporta pertenencia: si el juego
    // manda el bundle 192 y el asset 139607718, ese asset queda cubierto por el
    // bundle aunque la busqueda inversa no se haya lanzado.
    for (const bundleId of todosLosBundles) {
        for (const assetId of (composicion.get(bundleId)?.assetIds ?? [])) {
            const lista = bundlesPorAsset.get(assetId);
            if (lista && !lista.includes(bundleId)) lista.push(bundleId);
        }
    }

    const assetsResueltos = assets
        .filter(assetId => fichasDeAsset.has(assetId))
        .map(assetId => construirAsset(assetId, fichasDeAsset.get(assetId), bundlesPorAsset.get(assetId) ?? []));

    const bundlesResueltos = todosLosBundles
        .filter(bundleId => composicion.has(bundleId) || fichasDeBundle.has(bundleId))
        .map(bundleId => construirBundle(bundleId, composicion.get(bundleId), fichasDeBundle.get(bundleId)));

    const parcial = fallos.assetIds.length > 0 || fallos.bundleIds.length > 0;

    return {
        partial: parcial,
        // "No se resolvio NADA y ademas se pidio algo": el llamador lo traduce
        // a 503. Devolver 200 con todo vacio diria "estos items no existen",
        // que es falso y romperia la interfaz del cliente.
        nothingResolved: assetsResueltos.length === 0 && bundlesResueltos.length === 0 &&
            (assets.length > 0 || bundlesPedidos.length > 0),
        counts: {
            assets: assetsResueltos.length,
            bundles: bundlesResueltos.length,
            reverseLookups: inversa.size,
        },
        assets: assetsResueltos,
        bundles: bundlesResueltos,
        ownershipChecks: construirOwnershipChecks(assetsResueltos, bundlesResueltos),
        unresolved: {
            assetIds: unicos(fallos.assetIds),
            bundleIds: unicos(fallos.bundleIds),
            reverseTruncated: fallos.reverseTruncated,
        },
    };
}

module.exports = {
    resolveBatch,

    // La MISMA clave que usa este modulo, exportada para que quien mire la
    // cache compartida antes de pedir un lote se quede solo con los assets que
    // de verdad faltan. Sin ella tendria que reconstruir el formato por su
    // cuenta, y una segunda copia del mismo string es exactamente como se
    // desalinean las caches.
    catalogCacheKey: catalogKey,
};
