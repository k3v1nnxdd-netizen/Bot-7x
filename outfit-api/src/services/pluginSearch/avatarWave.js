'use strict';

const roblox = require('../../roblox/client');
const cacheStore = require('../../cache/cacheStore');
const config = require('../../config');
const logger = require('../../observability/logger');
const rateLimiter = require('../../roblox/rateLimiter');
const { countAccessories } = require('../../catalog/assetTypes');
const { UpstreamRateLimitedError, CircuitOpenError, NotFoundError } = require('../../roblox/errors');

// ETAPA 2 — AVATARES. De una ola de candidatos a "que lleva puesto cada uno",
// y a la PRIMERA decision sobre cada uno: si merece que se le ponga precio.
//
// Es la etapa que NO se puede agrupar: avatar/v1/users/{id}/avatar no admite
// lote de ninguna forma, asi que cada candidato cuesta una llamada y punto. Es
// tambien, por eso mismo, la ruta que mas se castiga de toda la busqueda, y la
// unica en la que un descuido de gateo se traduce directamente en 429.
//
// ── EL ORDEN DE LAS DECISIONES, que es todo el ahorro ────────────────────────
//
//   candidato
//     ↓
//   cache (hit -> CERO peticiones, ni permiso hace falta)
//     ↓
//   ¿ruta libre AHORA, para ESTA peticion?
//     ↓ no  -> DIFERIDO: vuelve a la cola, y la ola deja de despachar
//     ↓ si
//   peticion, bajo el slot de ruta y el marcapasos del limitador
//     ↓
//   429 / cooldown a mitad -> DIFERIDO tambien (se cuenta aparte)
//     ↓
//   ¿MAS DE TRES ACCESORIOS reales?
//     ↓ no  -> DESCARTADO AQUI. Sus assets NO van al catalogo. Siguiente.
//     ↓ si
//   sus assets, al lote de catalogo de la ola
//
// La regla de los accesorios se decide con la respuesta del avatar en la mano
// porque esa respuesta ya trae el tipo de cada asset: no hace falta ninguna
// llamada mas para saber que un avatar de dos gorros no va a ser un outfit.
// Ponerle precio a ese avatar gastaria cuota del catalogo — la ruta que se
// agotaba — en alguien que ya se sabe que no sirve.
//
// Un candidato diferido NO gasta plaza, NO cuenta como examinado y NO avanza
// la rotacion: se devuelve en `pendientes` y la busqueda lo retoma cuando la
// ruta reabra — en este proceso o en otro, porque los pendientes viajan en el
// checkpoint del trabajo. Un limite es un veredicto sobre el momento, no sobre
// el candidato.

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

// Del avatar crudo (ya normalizado por el cliente) al veredicto de esta etapa.
function juzgar(miembro, avatar, stats) {
    const assets = Array.isArray(avatar?.assets) ? avatar.assets : [];
    stats.sumar('assetIdsSeen', assets.length);

    // Deduplicado ya aqui: un avatar puede repetir un asset (capas), y contarlo
    // dos veces inflaria el precio del outfit y el recuento de accesorios.
    const porId = new Map();
    for (const asset of assets) {
        if (asset?.id == null) continue;
        porId.set(String(asset.id), asset);
    }

    // Avatar vacio: no hay outfit que importar. Se separa de avatarError porque
    // no es un fallo — Roblox respondio perfectamente.
    if (porId.size === 0) return { miembro, ok: false, motivo: 'emptyAvatar' };

    // ── LA REGLA: mas de tres accesorios reales ──────────────────────────────
    // Se decide ahora, con lo que ya se tiene, y antes de que ningun asset de
    // este avatar llegue al catalogo. `minAccessories` 0 apaga la regla.
    const minimo = config.pluginSearch.minAccessories;
    const accesorios = countAccessories([...porId.values()]);
    if (minimo > 0 && accesorios < minimo) {
        return { miembro, ok: false, motivo: 'tooFewAccessories', accessories: accesorios };
    }

    return { miembro, ok: true, assetIds: [...porId.keys()], accessories: accesorios };
}

// Un avatar. Devuelve SIEMPRE un veredicto con motivo, nunca null a secas: es
// lo que permite que cada candidato caiga en una casilla de stats y solo en
// una. Descartar candidatos es la operacion NORMAL aqui, no un error.
//
// Tres salidas, y es importante que sean tres y no dos:
//   { ok: true, assetIds }         avatar usable: sus assets van al catalogo
//   { ok: false, motivo }          descarte de verdad (baneado, vacio, pocos
//                                  accesorios). NO va al catalogo.
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
        return juzgar(miembro, cacheado, stats);
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
                return roblox.getCurrentAvatar(miembro.userId);
            },
            { negativeTtlMs: config.ttl.negative, onStatus: estado => stats.marcarCache(estado) }
        );
    } catch (err) {
        // ── Diferido: la ruta se cerro antes de poder preguntar ──────────────
        if (err instanceof DiferidoError) return { miembro, ok: false, diferido: true };

        // ── Diferido: Roblox nos freno (429, cooldown, breaker) ──────────────
        // Un 429 REAL (fromRoblox) es una peticion que salio y volvio limitada:
        // cuenta como peticion y como cuota perdida. Un rechazo del propio
        // limitador antes de enviar (cooldown, breaker, cola) no salio: no se
        // cuenta como peticion. En los dos casos el candidato sigue siendo tan
        // valido como antes y NO es un descarte.
        if (err instanceof UpstreamRateLimitedError || err instanceof CircuitOpenError) {
            if (err.fromRoblox) {
                stats.sumar('avatarRequests');
                stats.sumar('avatarRateLimited');
            } else {
                stats.sumar('avatarShed');
            }
            return { miembro, ok: false, diferido: true };
        }

        // ── Descarte de verdad ───────────────────────────────────────────────
        // La peticion salio (o la cache negativa ya sabia la respuesta). Nivel
        // debug y no warn: con cientos de candidatos, que unos cuantos no se
        // puedan consultar (cuentas baneadas, borradas) es lo ESPERADO.
        if (!(err instanceof NotFoundError) || stats.ultimaMarcaDeCache() !== 'negative-hit') {
            stats.sumar('avatarRequests');
        }
        logger.debug('Candidato descartado: no se pudo leer su avatar', {
            userId: miembro.userId, notFound: err instanceof NotFoundError, detail: err?.message,
        });
        return { miembro, ok: false, motivo: 'avatarError' };
    }

    stats.sumar('avatarRequests');
    stats.sumar('avatarsFetched');
    return juzgar(miembro, avatar, stats);
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

module.exports = { traerOla, RUTA_AVATAR, __juzgar: juzgar };
