'use strict';

const roblox = require('../../roblox/client');
const cacheStore = require('../../cache/cacheStore');
const config = require('../../config');
const { countAccessories } = require('../../catalog/assetTypes');
const { crearIndiceDeCatalogo } = require('../pluginSearch/catalogIndex');
const { crearIndiceDeBundles } = require('../pluginSearch/bundleIndex');
const { avatarCacheKey } = require('../pluginSearch/avatarWave');
const { valorar, necesitaBundle } = require('../pluginSearch/pricing');
const { ESTADO } = require('../../db/avatarIndexRepo');
const { UpstreamRateLimitedError, CircuitOpenError, NotFoundError } = require('../../roblox/errors');

// RESOLVER UN USUARIO PARA EL INDICE.
//
// Es EXACTAMENTE la misma cadena que corre hoy dentro de una busqueda —
// `roblox.getCurrentAvatar` (que aplana con normalizeAvatarAssets),
// `countAccessories`, el indice de catalogo, el de bundles y `pricing.valorar`
// — con una sola diferencia: aqui no hay nadie esperando, asi que el resultado
// se guarda en vez de devolverse.
//
// Se reutilizan los modulos tal cual, sin copiarlos ni adaptarlos, porque el
// dia que cambie como se valora un outfit tiene que cambiar en un sitio. Si el
// indice calculara el precio "parecido pero aparte", serviria precios que la
// busqueda nunca habria dado por buenos, y eso es peor que no tener indice.
//
// LO QUE ESTE MODULO NO HACE, y es la mitad de su diseño: no decide si un
// usuario sirve. No aplica minPrice, ni maxPrice, ni el minimo de accesorios.
// Devuelve HECHOS —cuantos accesorios lleva, cuanto vale— y la decision se toma
// al consultar, que es cuando se conocen los filtros de esa busqueda.

// Los tres desenlaces que NO son un dato sobre el usuario, sino sobre Roblox.
// Quien llama tiene que distinguirlos: con estos NO se escribe nada.
const MOTIVO = {
    LIMITADO: 'rate_limited',      // 429, cooldown o breaker: reintentar luego
    FALLO: 'error',                // red, 5xx: reintentar luego, contar el fallo
};

// Stats de mentirijillas: el indice de catalogo y el de bundles anotan su
// trabajo en un objeto de stats. Aqui interesa el resultado, no la telemetria
// de la busqueda, asi que se les da un recolector propio que el worker agrega.
function crearContador() {
    const datos = Object.create(null);
    return {
        datos,
        sumar(clave, cuanto = 1) { datos[clave] = (datos[clave] ?? 0) + cuanto; },
        rechazar(motivo) { this.sumar(`rechazado_${motivo}`); },
        aceptar() { this.sumar('aceptado'); },
        marcarCache(estado) { this.sumar(`cache_${estado}`); },
    };
}

// Resuelve UN usuario. No lanza por nada que sea normal (usuario borrado,
// Roblox limitando): devuelve un desenlace y quien llama decide.
async function resolverUsuario(miembro, { contador = crearContador() } = {}) {
    const userId = String(miembro.userId);

    // ── 1. El avatar ────────────────────────────────────────────────────────
    let avatar;
    try {
        // La MISMA clave que usa una busqueda: lo que el worker resuelve, una
        // busqueda posterior se lo encuentra hecho.
        avatar = await cacheStore.withCache(
            avatarCacheKey(userId),
            config.ttl.userAvatar,
            () => roblox.getCurrentAvatar(userId),
            { negativeTtlMs: config.ttl.negative, onStatus: estado => contador.marcarCache(estado) }
        );
    } catch (err) {
        // Roblox nos esta frenando. NO es informacion sobre este usuario: no se
        // escribe, no se cuenta como fallo suyo, y se reintentara.
        if (err instanceof UpstreamRateLimitedError || err instanceof CircuitOpenError) {
            return { userId, ok: false, motivo: MOTIVO.LIMITADO, ruta: 'userAvatar' };
        }
        // El usuario no existe (baneado, borrado). Esto SI es un dato.
        if (err instanceof NotFoundError) {
            return { userId, ok: true, registro: { userId, username: miembro.username ?? null, state: ESTADO.NO_EXISTE } };
        }
        return { userId, ok: false, motivo: MOTIVO.FALLO, detalle: err?.message ?? null };
    }

    const assets = Array.isArray(avatar?.assets) ? avatar.assets : [];

    // Deduplicado por id, igual que en la ola de avatares: un avatar puede
    // repetir un asset por capas, y contarlo dos veces inflaria precio y
    // accesorios.
    const porId = new Map();
    for (const asset of assets) {
        if (asset?.id == null) continue;
        porId.set(String(asset.id), asset);
    }

    const base = {
        userId,
        username: miembro.username ?? null,
        playerAvatarType: avatar?.playerAvatarType ?? null,
        assetIds: [...porId.keys()],
        assetTypeIds: [...porId.values()].map(a => Number(a.assetTypeId ?? 0)),
        // EL NUMERO, no el veredicto. `minAccessories` se aplica al consultar.
        accessories: countAccessories([...porId.values()]),
    };

    if (porId.size === 0) {
        return { userId, ok: true, registro: { ...base, state: ESTADO.AVATAR_VACIO } };
    }

    // ── 2. El precio, con el mismo catalogo y el mismo valorador ────────────
    const indice = crearIndiceDeCatalogo(contador);
    const bundles = crearIndiceDeBundles(contador);
    const assetIds = base.assetIds;

    try {
        await indice.asegurar(assetIds);
        const sinPrecioPropio = assetIds.filter(assetId => necesitaBundle(indice.ficha(assetId)));
        if (sinPrecioPropio.length > 0) await bundles.asegurar(sinPrecioPropio);
    } catch (err) {
        if (err instanceof UpstreamRateLimitedError || err instanceof CircuitOpenError) {
            return { userId, ok: false, motivo: MOTIVO.LIMITADO, ruta: 'catalogDetails' };
        }
        return { userId, ok: false, motivo: MOTIVO.FALLO, detalle: err?.message ?? null };
    }

    // El catalogo se quedo frenado a mitad: lo que se sepa del avatar es bueno,
    // pero la valoracion estaria incompleta por culpa de un limite y no del
    // usuario. Se guarda el avatar y se deja el precio para el siguiente pase.
    if (indice.frenadoPorLimite) {
        return { userId, ok: true, parcial: true, registro: { ...base, state: ESTADO.SIN_PRECIO } };
    }

    const valorado = valorar(assetIds, indice, bundles);
    if (!valorado.ok) {
        return { userId, ok: true, registro: { ...base, state: ESTADO.SIN_PRECIO } };
    }

    return {
        userId,
        ok: true,
        registro: { ...base, state: ESTADO.VALIDO, valoracion: valorado.valoracion },
    };
}

module.exports = { resolverUsuario, crearContador, MOTIVO };
