'use strict';

const roblox = require('../../roblox/client');
const cacheStore = require('../../cache/cacheStore');
const config = require('../../config');
const logger = require('../../observability/logger');
const { mapConLimite } = require('./concurrency');
const { UpstreamRateLimitedError, CircuitOpenError } = require('../../roblox/errors');

// La ruta del limitador que protege avatar.roblox.com. Es el bucket que mas se
// castiga en esta busqueda: el avatar NO admite lote, asi que un candidato es
// una llamada, y una ola de 25 son 25 llamadas seguidas.
const RUTA_AVATAR = 'userAvatar';

// ETAPA 2 — AVATARES. De una ola de candidatos a "que lleva puesto cada uno".
//
// Es la etapa que NO se puede agrupar: avatar/v1/users/{id}/avatar no admite
// lote de ninguna forma, asi que cada candidato cuesta una llamada y punto. Lo
// unico que se puede controlar es CUANTAS vuelan a la vez, y de eso se encarga
// el pool.
//
// Es tambien la razon de que la busqueda vaya por olas: se traen N avatares,
// se juntan TODOS sus assets y se resuelve el catalogo de la ola entera de una
// vez. Resolver candidato a candidato multiplicaba por N las llamadas al
// catalogo, que es justo lo que hacia saltar los 429.

function avatarCacheKey(userId) {
    return cacheStore.key('user', 'avatar', userId);
}

// Un avatar. Devuelve SIEMPRE un veredicto con motivo, nunca null a secas: es
// lo que permite que cada candidato caiga en una casilla de stats y solo en
// una. Descartar candidatos es la operacion NORMAL aqui, no un error.
async function traerAvatar(miembro, stats) {
    let avatar;
    // Se cuenta el INTENTO, no el exito: es el numero que mide lo que le
    // costamos a Roblox. Los que devuelven avatar usable se cuentan aparte, mas
    // abajo, y la diferencia entre los dos son las cuentas baneadas o borradas.
    stats.sumar('avatarRequests');
    try {
        avatar = await cacheStore.withCache(
            avatarCacheKey(miembro.userId),
            config.ttl.userAvatar,
            () => roblox.getCurrentAvatar(miembro.userId),
            { negativeTtlMs: config.ttl.negative, onStatus: estado => stats.marcarCache(estado) }
        );
    } catch (err) {
        // UN CANDIDATO CAIDO NO ES SIEMPRE LO MISMO, y confundirlos costo caro.
        //
        // Una cuenta baneada o borrada es un descarte NORMAL: pasa a decenas
        // por busqueda y no dice nada de la salud del sistema. Un 429 (o el
        // cooldown que impone el limitador tras el 429, o el breaker abierto)
        // es lo contrario: el candidato estaba bien y lo hemos perdido nosotros
        // porque Roblox nos esta frenando. Los dos acaban en el mismo veredicto
        // — 'avatarError', para no partir la invariante de stats — pero el
        // segundo se cuenta APARTE, porque es la unica forma de que una
        // busqueda con found bajo y el log lleno de 429 lo enseñe en sus
        // numeros en vez de esconderlo detras de "no se encontro nada".
        const frenado = err instanceof UpstreamRateLimitedError || err instanceof CircuitOpenError;
        if (frenado) stats.sumar('avatarRateLimited');

        // Nivel debug y no warn: con cientos de candidatos, que unos cuantos no
        // se puedan consultar (cuentas baneadas, borradas) es lo ESPERADO, y a
        // nivel warn ahogaria el log util de todo el servicio. El recuento
        // agregado va en stats.
        logger.debug('Candidato descartado: no se pudo leer su avatar', {
            userId: miembro.userId, rateLimited: frenado, detail: err?.message,
        });
        return { miembro, ok: false, motivo: 'avatarError' };
    }

    stats.sumar('avatarsFetched');

    // Normalizacion: de la respuesta de Roblox solo interesan los assetIds, y
    // como TEXTO, que es la forma en la que este servicio maneja los ids de
    // punta a punta (un id de Roblox se acerca cada año al entero seguro de JS).
    const assetIds = avatar.assets.map(asset => String(asset.id));
    stats.sumar('assetIdsSeen', assetIds.length);

    // Deduplicado ya aqui: un avatar puede repetir un asset (capas), y contarlo
    // dos veces inflaria el precio del outfit.
    const unicos = [...new Set(assetIds)];

    // Avatar vacio: no hay outfit que importar. Se separa de avatarError porque
    // no es un fallo — Roblox respondio perfectamente.
    if (unicos.length === 0) return { miembro, ok: false, motivo: 'emptyAvatar' };

    return { miembro, ok: true, assetIds: unicos };
}

// Trae los avatares de una ola con `limite` peticiones en vuelo como maximo.
// El pool mantiene ese numero constante de principio a fin: ni se queda ocioso
// entre llamadas ni desborda la cola del limitador de salida.
async function traerOla(miembros, stats, limite) {
    return mapConLimite(miembros, limite, miembro => traerAvatar(miembro, stats));
}

module.exports = { traerOla, RUTA_AVATAR };
