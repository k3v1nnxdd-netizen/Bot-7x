'use strict';

const roblox = require('../roblox/client');
const cacheStore = require('../cache/cacheStore');
const config = require('../config');

// Resolucion username -> userId. Toda la politica de cache de esta entidad
// vive aqui y en ningun otro sitio.

// La clave va en minusculas porque Roblox trata los nombres como
// insensibles a mayusculas: "Sombra", "sombra" y "SOMBRA" son el mismo
// usuario, y sin normalizar serian tres entradas de cache y tres llamadas.
function cacheKeyFor(username) {
    return cacheStore.key('user', 'name', username.toLowerCase());
}

// `ctx` es opcional y solo sirve para observabilidad: recoge de donde salio
// cada dato ('hit' | 'miss' | 'negative-hit') para que el log de la peticion
// lo cuente. Es un array simple en vez de un objeto de Express, para que este
// servicio no sepa nada de HTTP.
function markerFor(ctx) {
    return ctx ? status => ctx.push(status) : undefined;
}

async function resolveUsername(username, ctx) {
    return cacheStore.withCache(
        cacheKeyFor(username),
        config.ttl.usernameLookup,
        () => roblox.lookupUserByUsername(username),
        { negativeTtlMs: config.ttl.negative, onStatus: markerFor(ctx) }
    );
}

module.exports = { resolveUsername, markerFor };
