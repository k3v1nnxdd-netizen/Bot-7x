'use strict';

const roblox = require('../roblox/client');
const cacheStore = require('../cache/cacheStore');
const config = require('../config');
const { resolveUsername, markerFor } = require('./userService');

// Listado y detalle de outfits. Cada entidad tiene su propio TTL porque
// cambian a ritmos muy distintos: la LISTA se mueve cuando el jugador crea o
// borra un outfit (minutos), el CONTENIDO de un outfit concreto solo si lo
// edita (horas). Un unico TTL para ambos obligaria a elegir entre datos
// rancios o trafico de mas hacia Roblox.

// La pagina y el limite forman parte de la clave: cada pagina se cachea por
// separado. Es correcto y ademas es el motivo por el que `limit` esta
// restringido a un conjunto cerrado en validation/params.js — con un rango
// libre, la misma pagina se guardaria decenas de veces bajo claves distintas.
function listCacheKey(userId, page, limit) {
    return cacheStore.key('outfits', 'list', userId, page, limit);
}

function detailsCacheKey(outfitId) {
    return cacheStore.key('outfits', 'details', outfitId);
}

async function listOutfits(userId, { page, limit }, ctx) {
    const result = await cacheStore.withCache(
        listCacheKey(userId, page, limit),
        config.ttl.outfitList,
        () => roblox.listOutfits(userId, { page, limit }),
        { negativeTtlMs: config.ttl.negative, onStatus: markerFor(ctx) }
    );

    return { userId, page, limit, count: result.outfits.length, hasMore: result.hasMore, outfits: result.outfits };
}

async function getOutfitDetails(outfitId, ctx) {
    return cacheStore.withCache(
        detailsCacheKey(outfitId),
        config.ttl.outfitDetails,
        () => roblox.getOutfitDetails(outfitId),
        { negativeTtlMs: config.ttl.negative, onStatus: markerFor(ctx) }
    );
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

module.exports = { listOutfits, getOutfitDetails, listOutfitsByUsername };
