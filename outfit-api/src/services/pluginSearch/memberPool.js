'use strict';

const roblox = require('../../roblox/client');
const cacheStore = require('../../cache/cacheStore');
const config = require('../../config');

// ETAPA 1 — DESCUBRIMIENTO. De un groupId a un bombo de candidatos barajado.
//
// Es la etapa mas barata de las tres (una llamada por cada 100 miembros) y la
// unica que no depende de nada mas, asi que se hace entera antes de tocar un
// solo avatar.

// Cache por PAGINA de cursor, que es la unidad que devuelve Roblox. `sortOrder`
// entra en la clave porque Asc y Desc son recorridos distintos del mismo grupo.
function membersCacheKey(groupId, sortOrder, cursor) {
    return cacheStore.key('group', 'members', groupId, sortOrder, cursor || 'first');
}

// Fisher-Yates. Barajar es un REQUISITO, no un adorno: sin esto cada busqueda
// sobre el mismo grupo devolveria a los mismos primeros miembros que Roblox
// pagine, y el plugin acabaria importando siempre los mismos avatares.
function barajar(lista) {
    for (let i = lista.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [lista[i], lista[j]] = [lista[j], lista[i]];
    }
    return lista;
}

// La API de grupos NO tiene offset: solo cursor, asi que no se puede saltar a
// una pagina al azar sin recorrer todas las anteriores. La variedad se consigue
// con lo unico que si es gratis (empezar por un extremo o por el otro) y
// barajando despues el bombo entero. No es un muestreo uniforme sobre toda la
// comunidad y no se pretende que lo sea: es lo que la API permite sin pagar N
// paginas para llegar a la N+1.
function ordenAleatorio() {
    return Math.random() < 0.5 ? 'Asc' : 'Desc';
}

// Miembros por pagina. 100 es el maximo real del endpoint: por encima responde
// 400. Pedir menos solo multiplicaria las llamadas.
const MIEMBROS_POR_PAGINA = 100;

// Recorre paginas hasta juntar `objetivo` candidatos, agotar el grupo o llegar
// al tope de paginas. Devuelve el bombo ya barajado y sin duplicados.
async function descubrirCandidatos(groupId, objetivo, stats) {
    const sortOrder = ordenAleatorio();
    const candidatos = [];
    const vistos = new Set();

    let cursor = null;
    let paginas = 0;

    while (candidatos.length < objetivo && paginas < config.pluginSearch.maxMemberPages) {
        const pagina = await cacheStore.withCache(
            membersCacheKey(groupId, sortOrder, cursor),
            config.ttl.groupMembers,
            () => roblox.listGroupMembers(groupId, {
                limit: MIEMBROS_POR_PAGINA, cursor, sortOrder,
            }),
            { negativeTtlMs: config.ttl.negative, onStatus: estado => stats.marcarCache(estado) }
        );

        paginas++;

        // Deduplicado YA en el bombo: Roblox puede repetir a alguien entre
        // paginas si el grupo cambia a mitad del recorrido, y arrastrar el
        // duplicado hasta el final costaria un avatar de mas por cada uno.
        for (const miembro of pagina.members) {
            if (vistos.has(miembro.userId)) continue;
            vistos.add(miembro.userId);
            candidatos.push(miembro);
        }

        cursor = pagina.nextCursor;
        if (!cursor) break; // grupo recorrido entero
    }

    stats.sumar('memberPagesFetched', paginas);
    stats.sumar('candidatesDiscovered', candidatos.length);

    return { candidatos: barajar(candidatos), sortOrder };
}

module.exports = { descubrirCandidatos, barajar };
