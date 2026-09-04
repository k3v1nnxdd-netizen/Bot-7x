'use strict';

const roblox = require('../../roblox/client');
const cacheStore = require('../../cache/cacheStore');
const config = require('../../config');

// ETAPA 1 — MIEMBROS. Una sola responsabilidad: entregar UNA pagina de la
// comunidad, cacheada. Quien decide por que pagina va el recorrido es
// rotation.js; aqui no se sabe nada de rotaciones ni de cursores guardados.
//
// La variedad entre busquedas ya NO sale de barajar un bombo: sale de que la
// rotacion avanza por la comunidad y no repite a nadie. Barajar aqui, ademas
// de innecesario, estropearia la continuidad secuencial que es justo lo que se
// quiere.

// Cache por PAGINA de cursor, que es la unidad que devuelve Roblox.
// `sortOrder` entra en la clave porque Asc y Desc son recorridos distintos del
// mismo grupo.
function membersCacheKey(groupId, sortOrder, cursor) {
    return cacheStore.key('group', 'members', groupId, sortOrder, cursor || 'first');
}

// Miembros por pagina. 100 es el maximo real del endpoint: por encima responde
// 400. Pedir menos solo multiplicaria las llamadas.
const MIEMBROS_POR_PAGINA = 100;

// Una pagina de miembros: { miembros, nextCursor }. `nextCursor` null significa
// fin del recorrido, y es lo que dispara el wrap-around de la rotacion.
async function traerPaginaDeMiembros(groupId, sortOrder, cursor, stats) {
    const pagina = await cacheStore.withCache(
        membersCacheKey(groupId, sortOrder, cursor),
        config.ttl.groupMembers,
        () => roblox.listGroupMembers(groupId, {
            limit: MIEMBROS_POR_PAGINA, cursor, sortOrder,
        }),
        { negativeTtlMs: config.ttl.negative, onStatus: estado => stats.marcarCache(estado) }
    );

    stats.sumar('memberPagesFetched');

    return { miembros: pagina.members, nextCursor: pagina.nextCursor };
}

module.exports = { traerPaginaDeMiembros, MIEMBROS_POR_PAGINA };
