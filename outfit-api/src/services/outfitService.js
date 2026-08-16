'use strict';

const roblox = require('../roblox/client');
const cacheStore = require('../cache/cacheStore');
const config = require('../config');
const logger = require('../observability/logger');
const { buildOutfit } = require('./humanoidDescription');
const { resolveUsername, markerFor } = require('./userService');

// Listado y detalle de outfits. Cada entidad tiene su propio TTL porque
// cambian a ritmos muy distintos: la LISTA se mueve cuando el jugador crea o
// borra un outfit (minutos), el CONTENIDO de un outfit concreto solo si lo
// edita (horas), y la pertenencia de un asset a un bundle no cambia nunca una
// vez publicado (dia). Un unico TTL para todo obligaria a elegir entre datos
// rancios y trafico de mas hacia Roblox.

// La pagina, el limite y el filtro forman parte de la clave: cada combinacion
// se cachea por separado. Es correcto, y es el motivo por el que `limit` y
// `outfitType` estan restringidos a conjuntos cerrados en validation/params.js
// — con valores libres, la misma pagina se guardaria bajo decenas de claves
// distintas y el hit rate se pulverizaria.
function listCacheKey(userId, page, limit, outfitType) {
    return cacheStore.key('outfits', 'list', userId, page, limit, outfitType || 'all');
}

function detailsCacheKey(outfitId) {
    return cacheStore.key('outfits', 'details', outfitId);
}

// Clave por ASSET, no por outfit: la pertenencia a bundle describe el asset,
// asi que resolverla una vez sirve para todos los outfits de todos los
// jugadores que lleven esa pieza.
function bundlesCacheKey(assetId) {
    return cacheStore.key('asset', 'bundles', assetId);
}

async function listOutfits(userId, { page, limit, outfitType }, ctx) {
    const result = await cacheStore.withCache(
        listCacheKey(userId, page, limit, outfitType),
        config.ttl.outfitList,
        () => roblox.listOutfits(userId, { page, limit, outfitType }),
        { negativeTtlMs: config.ttl.negative, onStatus: markerFor(ctx) }
    );

    return {
        userId,
        page,
        limit,
        outfitType: outfitType ?? null,
        count: result.outfits.length,
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

// Resuelve a que bundles pertenece cada asset del outfit. SOLO se llama con
// ?bundles=1 explicito — ver la advertencia larga en roblox/client.js sobre
// por que este dato de Roblox es incompleto y no admite lote.
//
// Tres cosas hacen que el coste sea asumible pese a ser una llamada por asset:
//   - Cada assetId se cachea 24 h de forma GLOBAL. La segunda vez que
//     cualquiera pide un outfit con esa pieza, cuesta cero.
//   - El single-flight de la cache colapsa las peticiones simultaneas sobre el
//     mismo assetId en una sola llamada, incluso entre outfits distintos que
//     comparten pieza.
//   - Todas pasan por el bucket `assetBundles` del limitador, separado del de
//     los tres endpoints principales, asi que este camino no puede dejarlos
//     sin cuota.
//
// Un fallo resolviendo bundles NO tumba la respuesta: el outfit es el dato
// principal y los bundles un extra. Si Roblox limita o falla, ese asset sale
// con `bundles: null` (distinto de `[]`, que significa "Roblox respondio: no
// pertenece a ninguno") y el resto del outfit se entrega igual.
async function attachBundles(outfit, ctx) {
    const assetIds = outfit.assets
        .map(asset => asset.id)
        .filter(id => id != null)
        .slice(0, config.maxBundleLookupsPerRequest);

    const truncated = outfit.assets.length > assetIds.length;
    if (truncated) {
        logger.warn('Resolucion de bundles truncada', {
            outfitId: outfit.id, assets: outfit.assets.length, resueltos: assetIds.length,
        });
    }

    const byAssetId = new Map();
    await Promise.all(assetIds.map(async assetId => {
        try {
            const bundles = await cacheStore.withCache(
                bundlesCacheKey(assetId),
                config.ttl.assetBundles,
                () => roblox.getBundlesForAsset(assetId),
                { negativeTtlMs: config.ttl.negative, onStatus: markerFor(ctx) }
            );
            byAssetId.set(assetId, bundles);
        } catch (err) {
            byAssetId.set(assetId, null);
            logger.warn('No se pudo resolver el bundle de un asset', {
                assetId, detail: err?.message,
            });
        }
    }));

    return {
        ...outfit,
        assets: outfit.assets.map(asset => ({
            ...asset,
            bundles: byAssetId.has(asset.id) ? byAssetId.get(asset.id) : null,
        })),
        // Union de todos los bundles encontrados, deduplicada: normalmente es
        // lo que interesa de verdad ("de que bundles se compone este outfit"),
        // sin tener que recorrer los assets uno a uno.
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

async function getOutfitDetailsWithOptions(outfitId, { bundles = false } = {}, ctx) {
    const outfit = await getOutfitDetails(outfitId, ctx);
    if (!bundles) return outfit;
    return attachBundles(outfit, ctx);
}

// Endpoint compuesto: resolver + listar en una sola llamada del juego.
//
// Existe para MINIMIZAR LLAMADAS DESDE ROBLOX, que es un recurso propio y
// escaso del lado del juego: HttpService tiene su propio presupuesto por
// servidor, y este es el flujo dominante (el jugador escribe un nombre y
// quiere ver sus outfits). Partirlo en dos peticiones duplicaria el gasto
// del juego sin ahorrarnos a nosotros ni una llamada a Roblox.
//
// No añade ninguna ruta nueva hacia Roblox ni ninguna politica de cache
// propia: reutiliza exactamente las dos anteriores, cada una con su TTL y su
// single-flight. En la practica el paso de resolucion casi siempre es un hit
// (TTL de 12 h), asi que el coste real de componer es cero.
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
