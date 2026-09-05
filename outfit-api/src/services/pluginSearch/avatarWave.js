'use strict';

const roblox = require('../../roblox/client');
const cacheStore = require('../../cache/cacheStore');
const config = require('../../config');
const logger = require('../../observability/logger');
const rateLimiter = require('../../roblox/rateLimiter');
const { UpstreamRateLimitedError, CircuitOpenError, NotFoundError } = require('../../roblox/errors');

// ETAPA 2 — AVATARES. De una ola de candidatos a "que lleva puesto cada uno".
//
// Es la etapa que NO se puede agrupar: avatar/v1/users/{id}/avatar no admite
// lote de ninguna forma, asi que cada candidato cuesta una llamada y punto. Es
// tambien, por eso mismo, la ruta que mas se castiga de toda la busqueda, y la
// unica en la que un descuido de gateo se traduce directamente en 429.
//
// ── EL ERROR QUE ESTA VERSION CORRIGE ────────────────────────────────────────
//
// Se gateaba POR OLA: una comprobacion de "¿esta libre el avatar?" antes de
// lanzar 25 candidatos con varios en vuelo. Eso tiene dos agujeros, y los dos
// se vieron en produccion:
//
//   1. Las primeras respuestas de la ola traen 'remaining: 0' — pero para
//      cuando llegan, las siguientes ya han salido. Roblox contesta 429 a esas.
//
//   2. Todo lo que fallaba por limite se marcaba 'avatarError' y la rotacion
//      seguia adelante. Es decir: el candidato 150 no se pudo mirar porque
//      Roblox pidio esperar, y se lo trataba EXACTAMENTE igual que a una cuenta
//      borrada. Un limite no es un veredicto sobre el candidato; es un
//      veredicto sobre el momento.
//
// ── LO QUE HACE AHORA ────────────────────────────────────────────────────────
//
//   candidato
//     ↓
//   cache (hit -> listo, CERO peticiones, ni permiso hace falta)
//     ↓
//   ¿ruta libre AHORA?  (no "al empezar la ola": ahora, para ESTA peticion)
//     ↓ no  -> DIFERIDO: vuelve a la cola, y la ola deja de despachar
//     ↓ si
//   peticion, bajo el slot de ruta y el marcapasos del limitador
//     ↓
//   429 / cooldown a mitad -> DIFERIDO tambien (se cuenta aparte)
//
// Un candidato diferido NO gasta plaza, NO cuenta como examinado y NO avanza
// la rotacion: se devuelve en `pendientes` y la busqueda lo retoma cuando la
// ruta reabra — en este proceso o en otro, porque los pendientes viajan en el
// checkpoint del trabajo.

// La ruta del limitador que protege avatar.roblox.com.
const RUTA_AVATAR = 'userAvatar';

function avatarCacheKey(userId) {
    return cacheStore.key('user', 'avatar', userId);
}

// Marca interna: "no se pudo pedir porque la ruta esta cerrada". Nunca sale de
// este modulo; se traduce a un veredicto 'diferido'.
class DiferidoError extends Error {
    constructor() {
        super('avatar diferido: la ruta esta frenada');
        this.name = 'DiferidoError';
    }
}

function normalizar(miembro, avatar, stats) {
    // De la respuesta de Roblox solo interesan los assetIds, y como TEXTO, que
    // es la forma en la que este servicio maneja los ids de punta a punta.
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

// Un avatar. Devuelve SIEMPRE un veredicto con motivo, nunca null a secas: es
// lo que permite que cada candidato caiga en una casilla de stats y solo en
// una. Descartar candidatos es la operacion NORMAL aqui, no un error.
//
// Tres salidas, y es importante que sean tres y no dos:
//   { ok: true, assetIds }         avatar usable
//   { ok: false, motivo }          descarte de verdad (baneado, vacio)
//   { ok: false, diferido: true }  NO SE PUDO MIRAR: la ruta estaba cerrada.
//                                  No es un descarte y no se cuenta como tal.
async function traerAvatar(miembro, stats, { puedeSalir }) {
    const clave = avatarCacheKey(miembro.userId);

    // ── 1. Cache PRIMERO, antes de pedir permiso a nadie ─────────────────────
    // Un acierto son cero peticiones a Roblox y no necesita que la ruta este
    // libre: si el avatar de este usuario se miro hace cinco minutos, se sabe
    // lo que lleva puesto aunque Roblox tenga la ruta cerrada ahora mismo.
    const cacheado = await cacheStore.get(clave);
    if (cacheado !== undefined) {
        stats.marcarCache('hit');
        stats.sumar('avatarCacheHits');
        return normalizar(miembro, cacheado, stats);
    }

    // ── 2. Permiso de ruta, PARA ESTA PETICION ───────────────────────────────
    // Se pregunta aqui, y no al principio de la ola, porque la respuesta puede
    // haber cambiado desde entonces: la anterior peticion de esta misma ola
    // puede haber traido un 'remaining: 0'.
    if (!puedeSalir()) return { miembro, ok: false, diferido: true };

    let avatar;
    try {
        avatar = await cacheStore.withCache(
            clave,
            config.ttl.userAvatar,
            async () => {
                // Ultima comprobacion, ya dentro del single-flight: entre el
                // permiso de arriba y este punto solo hay un await, pero es un
                // await, y durante el la ruta puede haberse cerrado.
                if (!puedeSalir()) throw new DiferidoError();
                stats.sumar('avatarRequests');
                return roblox.getCurrentAvatar(miembro.userId);
            },
            { negativeTtlMs: config.ttl.negative, onStatus: estado => stats.marcarCache(estado) }
        );
    } catch (err) {
        // ── Diferido: la ruta se cerro antes de poder preguntar ──────────────
        if (err instanceof DiferidoError) return { miembro, ok: false, diferido: true };

        // ── Diferido: Roblox nos freno (429, cooldown, breaker) ──────────────
        // La peticion se hizo (o el limitador la corto en la puerta) y Roblox
        // no evaluo nada: el candidato sigue siendo tan valido como antes. Se
        // cuenta aparte, porque es cuota perdida, pero NO es un descarte.
        if (err instanceof UpstreamRateLimitedError || err instanceof CircuitOpenError) {
            stats.sumar('avatarRateLimited');
            return { miembro, ok: false, diferido: true };
        }

        // ── Descarte de verdad ───────────────────────────────────────────────
        // Nivel debug y no warn: con cientos de candidatos, que unos cuantos no
        // se puedan consultar (cuentas baneadas, borradas) es lo ESPERADO, y a
        // nivel warn ahogaria el log util de todo el servicio.
        logger.debug('Candidato descartado: no se pudo leer su avatar', {
            userId: miembro.userId, notFound: err instanceof NotFoundError, detail: err?.message,
        });
        return { miembro, ok: false, motivo: 'avatarError' };
    }

    stats.sumar('avatarsFetched');
    return normalizar(miembro, avatar, stats);
}

// Trae los avatares de una ola con `limite` tareas en vuelo como maximo.
//
// Devuelve { resultados, pendientes }:
//   resultados  veredictos de los candidatos que SI se pudieron mirar
//   pendientes  los que NO, en el orden original: los diferidos y todos los que
//               venian detras y ya no se llegaron a despachar
//
// EN CUANTO UN CANDIDATO SE DIFIERE, LA OLA DEJA DE DESPACHAR. Es la pieza que
// convierte el gateo por ola en gateo por peticion: una vez la ruta esta
// cerrada, el resto de la ola no lo intenta. Las peticiones que ya estaban en
// vuelo terminan solas — no se cancelan — y su veredicto se conserva.
async function traerOla(miembros, stats, limite) {
    if (miembros.length === 0) return { resultados: [], pendientes: [] };

    const puedeSalir = () => !rateLimiter.getThrottleState(RUTA_AVATAR).throttled;

    const veredictos = new Array(miembros.length);
    const trabajadores = Math.max(1, Math.min(limite, miembros.length));
    let siguiente = 0;
    let parar = false;

    async function trabajador() {
        for (;;) {
            if (parar) return;
            const indice = siguiente++;
            if (indice >= miembros.length) return;

            const veredicto = await traerAvatar(miembros[indice], stats, { puedeSalir });
            veredictos[indice] = veredicto;
            if (veredicto.diferido) parar = true;
        }
    }

    await Promise.all(Array.from({ length: trabajadores }, trabajador));

    const resultados = [];
    const pendientes = [];
    for (let i = 0; i < miembros.length; i++) {
        const v = veredictos[i];
        if (v === undefined || v.diferido) pendientes.push(miembros[i]);
        else resultados.push(v);
    }

    if (pendientes.length > 0) stats.sumar('avatarDeferred', pendientes.length);
    return { resultados, pendientes };
}

module.exports = { traerOla, RUTA_AVATAR };
