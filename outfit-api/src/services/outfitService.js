'use strict';

const crypto = require('crypto');
const roblox = require('../roblox/client');
const cacheStore = require('../cache/cacheStore');
const singleFlight = require('../cache/singleFlight');
const config = require('../config');
const logger = require('../observability/logger');
const { buildOutfit } = require('./humanoidDescription');
const { resolveUsername, markerFor } = require('./userService');

// Listado y detalle de outfits. Cada entidad tiene su propio TTL porque
// cambian a ritmos muy distintos: la LISTA se mueve cuando el jugador crea o
// borra un outfit (minutos), el CONTENIDO de un outfit concreto solo si lo
// edita (horas), la ficha de catalogo de un asset se mueve despacio (hora) y
// su pertenencia a bundle no cambia nunca (dia).

// El CURSOR forma parte de la clave, no un numero de pagina: cada bloque de la
// paginacion se cachea por separado y dos cursores distintos jamas comparten
// entrada. El token es largo (base64), asi que se resume con un hash corto
// para no arrastrar 300 caracteres en cada clave; sigue siendo unico por
// cursor, que es lo unico que importa.
function listCacheKey(userId, limit, pageToken, outfitType) {
    const cursor = pageToken ? crypto.createHash('sha1').update(pageToken).digest('hex').slice(0, 16) : 'first';
    return cacheStore.key('outfits', 'list', userId, limit, cursor, outfitType || 'all');
}

function detailsCacheKey(outfitId) {
    return cacheStore.key('outfits', 'details', outfitId);
}

// Claves por ASSET, no por outfit: tanto la ficha de catalogo como la
// pertenencia a bundle describen el asset, asi que resolverlas una vez sirve
// para todos los outfits de todos los jugadores que lleven esa pieza.
function bundlesCacheKey(assetId) {
    return cacheStore.key('asset', 'bundles', assetId);
}

function catalogCacheKey(assetId) {
    return cacheStore.key('asset', 'catalog', assetId);
}

async function listOutfits(userId, { limit, pageToken, outfitType }, ctx) {
    const result = await cacheStore.withCache(
        listCacheKey(userId, limit, pageToken, outfitType),
        config.ttl.outfitList,
        () => roblox.listOutfits(userId, { limit, pageToken, outfitType }),
        { negativeTtlMs: config.ttl.negative, onStatus: markerFor(ctx) }
    );

    return {
        userId,
        limit,
        outfitType: outfitType ?? null,
        count: result.outfits.length,
        // Se devuelve el cursor de la SIGUIENTE pagina, para reenviarlo tal
        // cual como `pageToken`. null cuando Roblox deja de dar token.
        nextPageToken: result.nextPageToken,
        hasMore: result.hasMore,
        outfits: result.outfits,
    };
}

// Lo que se cachea es el resultado YA NORMALIZADO, no el payload crudo de
// Roblox: es mas pequeño y evita re-normalizar en cada acierto de cache.
// buildOutfit es una funcion pura, asi que ejecutarla dentro del fetch es
// seguro y ocurre una sola vez por miss.
async function getOutfitDetails(outfitId, ctx) {
    return cacheStore.withCache(
        detailsCacheKey(outfitId),
        config.ttl.outfitDetails,
        async () => buildOutfit(await roblox.getOutfitDetailsRaw(outfitId), outfitId),
        { negativeTtlMs: config.ttl.negative, onStatus: markerFor(ctx) }
    );
}

// ── Estado de catalogo: limitado / fuera de venta / ya no disponible ─────────

// Resuelve la ficha de catalogo de TODOS los assets del outfit con UNA sola
// llamada a Roblox, no una por asset. El patron es "lee N claves de cache,
// agrupa las que falten en un unico lote, guarda cada una por separado":
//
//   - Cada assetId se cachea por SEPARADO (1 h) y de forma GLOBAL. Dos outfits
//     que compartan sombrero comparten la entrada, sean del jugador que sean.
//   - Lo que falta se pide en UN lote (hasta 100 ids por peticion; un outfit
//     real ronda los 20, asi que siempre es un unico lote).
//   - Ese lote va con single-flight sobre el conjunto exacto de ids que
//     faltan, asi que dos peticiones simultaneas del mismo outfit frio
//     producen una sola llamada, no dos.
//
// ASSETS QUE ROBLOX YA NO RECONOCE: no se pierden. Un asset borrado, moderado
// o fuera del catalogo simplemente no viene en la respuesta (comprobado en
// vivo), y aqui se marca `available: false` conservando su assetId, su nombre
// y su tipo, que siguen llegando del propio outfit. Estar fuera de venta o
// haber desaparecido del catalogo no lo saca del avatar.
// Registro para un asset que Roblox no devolvio en el lote: borrado, moderado
// o simplemente fuera del catalogo. Mantiene EXACTAMENTE las mismas claves que
// un registro normal para que el juego no tenga que comprobar la presencia de
// cada campo, pero todas valen null salvo `available`. null aqui significa "no
// se sabe", que es la verdad: sin ficha de catalogo no podemos afirmar si es
// limitado ni si esta fuera de venta. Poner `false` seria inventarselo.
const SIN_FICHA_DE_CATALOGO = Object.freeze({
    available: false,
    restrictions: null,
    isLimited: null,
    offSale: null,
    price: null,
    lowestPrice: null,
    lowestResalePrice: null,
    hasResellers: null,
    creatorType: null,
    creatorTargetId: null,
    creatorName: null,
});

async function attachCatalogStatus(outfit, ctx) {
    const assetIds = [...new Set(outfit.assets.map(a => a.id).filter(id => id != null))];
    if (assetIds.length === 0) return { ...outfit, catalogResolved: true };

    const encontrados = new Map();
    const faltantes = [];

    for (const assetId of assetIds) {
        const cacheado = await cacheStore.get(catalogCacheKey(assetId));
        if (cacheado !== undefined) encontrados.set(assetId, cacheado);
        else faltantes.push(assetId);
    }

    ctx?.push(faltantes.length === 0 ? 'catalog-hit' : 'catalog-miss');

    let resuelto = true;
    for (let i = 0; i < faltantes.length; i += config.maxCatalogBatchSize) {
        const lote = faltantes.slice(i, i + config.maxCatalogBatchSize);
        try {
            const detalles = await singleFlight.run(`catalog:${lote.join('.')}`, () => roblox.getCatalogDetails(lote));
            for (const assetId of lote) {
                // Ausente en la respuesta = Roblox ya no tiene ficha para el.
                const registro = detalles.get(assetId) ?? SIN_FICHA_DE_CATALOGO;
                await cacheStore.set(catalogCacheKey(assetId), registro, config.ttl.catalogDetails);
                encontrados.set(assetId, registro);
            }
        } catch (err) {
            // El outfit es el dato principal; el estado de catalogo es un
            // extra. Si Roblox limita o falla, se entrega el outfit igual con
            // `catalogResolved: false` en lugar de tumbar la respuesta entera.
            resuelto = false;
            logger.warn('No se pudo resolver el estado de catalogo de un lote', {
                outfitId: outfit.id, assets: lote.length, detail: err?.message,
            });
        }
    }

    return {
        ...outfit,
        assets: outfit.assets.map(asset => {
            const registro = encontrados.get(asset.id);
            return registro ? { ...asset, catalog: registro } : asset;
        }),
        // false = alguna consulta de catalogo fallo y hay assets sin ficha por
        // motivos NUESTROS (no porque Roblox diga que no existen). Permite al
        // juego distinguir "no disponible" de "no lo pudimos comprobar".
        catalogResolved: resuelto,
    };
}

// ── Bundles (opcional, y con reservas) ──────────────────────────────────────

// Ver la advertencia larga en roblox/client.js. Resumen: Roblox no expone a
// que bundles pertenece un outfit; la unica via es la busqueda inversa por
// asset, que no admite lote, es incompleta y trae ruido. Confirmado ademas que
// el campo `bundledItems` del lote de catalogo NO sirve para esto: va en la
// direccion contraria (que contiene un bundle) y llega vacio para un asset.
// Por eso esta detras de ?bundles=1 y nunca se ejecuta por defecto.
async function attachBundles(outfit, ctx) {
    const assetIds = [...new Set(outfit.assets.map(a => a.id).filter(id => id != null))]
        .slice(0, config.maxBundleLookupsPerRequest);

    const truncated = new Set(outfit.assets.map(a => a.id)).size > assetIds.length;
    if (truncated) {
        logger.warn('Resolucion de bundles truncada', {
            outfitId: outfit.id, assets: outfit.assets.length, resueltos: assetIds.length,
        });
    }

    const byAssetId = new Map();
    await Promise.all(assetIds.map(async assetId => {
        try {
            byAssetId.set(assetId, await cacheStore.withCache(
                bundlesCacheKey(assetId),
                config.ttl.assetBundles,
                () => roblox.getBundlesForAsset(assetId),
                { negativeTtlMs: config.ttl.negative, onStatus: markerFor(ctx) }
            ));
        } catch (err) {
            // null != []. [] significa "Roblox respondio: ninguno";
            // null significa "no lo pudimos comprobar".
            byAssetId.set(assetId, null);
            logger.warn('No se pudo resolver el bundle de un asset', { assetId, detail: err?.message });
        }
    }));

    return {
        ...outfit,
        assets: outfit.assets.map(asset => ({
            ...asset,
            bundles: byAssetId.has(asset.id) ? byAssetId.get(asset.id) : null,
        })),
        bundles: dedupeBundles(byAssetId),
        bundlesTruncated: truncated,
    };
}

function dedupeBundles(byAssetId) {
    const seen = new Map();
    for (const bundles of byAssetId.values()) {
        if (!Array.isArray(bundles)) continue;
        for (const bundle of bundles) {
            if (!seen.has(bundle.id)) seen.set(bundle.id, bundle);
        }
    }
    return [...seen.values()];
}

// `catalog` cuesta UNA llamada extra para todo el outfit; `bundles` cuesta una
// por asset. De ahi que sean banderas separadas y ninguna venga activada.
async function getOutfitDetailsWithOptions(outfitId, { catalog = false, bundles = false } = {}, ctx) {
    let outfit = await getOutfitDetails(outfitId, ctx);
    if (catalog) outfit = await attachCatalogStatus(outfit, ctx);
    if (bundles) outfit = await attachBundles(outfit, ctx);
    return outfit;
}

// Endpoint compuesto: resolver + listar en una sola llamada del juego.
//
// Existe para MINIMIZAR LLAMADAS DESDE ROBLOX, que es un recurso propio y
// escaso del lado del juego: HttpService tiene su propio presupuesto por
// servidor, y este es el flujo dominante (el jugador escribe un nombre y
// quiere ver sus outfits). Partirlo en dos peticiones duplicaria el gasto
// del juego sin ahorrarnos a nosotros ni una llamada a Roblox.
async function listOutfitsByUsername(username, pagination, ctx) {
    const user = await resolveUsername(username, ctx);
    const listing = await listOutfits(user.userId, pagination, ctx);
    return { ...listing, username: user.username, displayName: user.displayName };
}

module.exports = {
    listOutfits,
    getOutfitDetails,
    getOutfitDetailsWithOptions,
    listOutfitsByUsername,
};
