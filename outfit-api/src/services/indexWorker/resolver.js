'use strict';

const roblox = require('../../roblox/client');
const cacheStore = require('../../cache/cacheStore');
const config = require('../../config');
const { countAccessories } = require('../../catalog/assetTypes');
const { avatarCacheKey } = require('../pluginSearch/avatarWave');
const { crearIndiceDeBundles } = require('../pluginSearch/bundleIndex');
const { valorar, necesitaBundle, clasificar, CATEGORIA } = require('../pluginSearch/pricing');
const { ESTADO } = require('../../db/avatarIndexRepo');
const catalogoRepo = require('../../db/assetCatalogRepo');
const { UpstreamRateLimitedError, CircuitOpenError, NotFoundError } = require('../../roblox/errors');

// LAS DOS ETAPAS CARAS, cada una con su forma de gastar cuota.
//
//   AVATAR   una llamada por usuario. Es lo caro y no hay forma de agruparlo:
//            ningun endpoint de Roblox acepta varios usuarios por peticion.
//   PRECIO   una pasada para MUCHOS usuarios. Aqui si se agrupa, y por eso las
//            llamadas al catalogo acaban siendo una fraccion de las del avatar:
//            una comunidad entera lleva mas o menos los mismos gorros.
//
// Las dos usan las MISMAS piezas que una busqueda en vivo —el normalizador del
// cliente, `countAccessories`, `pricing.valorar`— porque el dia que cambie como
// se valora un outfit tiene que cambiar en un sitio. Un indice que calculara
// "parecido pero aparte" serviria precios que la busqueda nunca habria dado por
// buenos, y eso es peor que no tener indice.

// Desenlaces que NO son un dato sobre el usuario, sino sobre Roblox. Con estos
// no se escribe NADA: ni estado, ni precio, ni contador de errores.
const MOTIVO = {
    LIMITADO: 'rate_limited',   // 429, cooldown o breaker
    FALLO: 'error',             // red, timeout, 5xx
};

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

// ── ETAPA AVATAR ────────────────────────────────────────────────────────────
//
// Resuelve UN usuario. No lanza por nada que sea normal.
//
// NO LLAMA AL CATALOGO. Ni siquiera para quien tiene accesorios de sobra: eso
// es trabajo de la otra etapa, que lo hara junto al de otros noventa usuarios.
// Y desde luego no para quien no llega al minimo de accesorios, que no puede
// salir en un resultado por muchos assets caros que lleve.
async function resolverAvatar(miembro, { contador = crearContador() } = {}) {
    const userId = String(miembro.userId);

    let avatar;
    try {
        avatar = await cacheStore.withCache(
            // La MISMA clave que usa una busqueda: lo que resuelve el worker se
            // lo encuentra hecho quien busque despues.
            avatarCacheKey(userId),
            config.ttl.userAvatar,
            // v2, y SIN respaldo a v1: v1 esta en seis por hora en Railway y
            // llamarla solo serviria para marcar su ruta como limitada.
            () => roblox.getCurrentAvatarV2(userId),
            { negativeTtlMs: config.ttl.negative, onStatus: e => contador.marcarCache(e) }
        );
    } catch (err) {
        if (err instanceof UpstreamRateLimitedError || err instanceof CircuitOpenError) {
            return { userId, ok: false, motivo: MOTIVO.LIMITADO, ruta: 'userAvatarV2' };
        }
        // 404: el usuario no existe. Esto SI es un dato, y se guarda.
        if (err instanceof NotFoundError) {
            return {
                userId, ok: true,
                registro: { userId, username: miembro.username ?? null, state: ESTADO.NO_EXISTE, accessories: 0 },
            };
        }
        return { userId, ok: false, motivo: MOTIVO.FALLO, detalle: err?.message ?? null };
    }

    const assets = Array.isArray(avatar?.assets) ? avatar.assets : [];

    // Deduplicado por id: un avatar puede repetir un asset por capas, y
    // contarlo dos veces inflaria precio y accesorios.
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
        // EL NUMERO, no el veredicto.
        accessories: countAccessories([...porId.values()]),
    };

    if (porId.size === 0) {
        return { userId, ok: true, registro: { ...base, state: ESTADO.AVATAR_VACIO } };
    }

    // Avatar conocido y sin valorar todavia. Los que no llegan al minimo se
    // quedan aqui para siempre — hasta que el minimo baje, y entonces entran
    // solos en la cola de precios sin tocar ni una fila.
    const bajoMinimo = base.accessories < config.pluginSearch.minAccessories;
    return {
        userId, ok: true, bajoMinimo,
        registro: { ...base, state: ESTADO.SOLO_AVATAR },
    };
}

// ── ETAPA PRECIO ────────────────────────────────────────────────────────────
//
// Toma MUCHOS usuarios pendientes y los valora todos con el minimo de llamadas
// posible. El camino, y cada paso quita trabajo al siguiente:
//
//   1. se unen los assetIds de todos y se DEDUPLICAN globalmente;
//   2. se pregunta al CATALOGO PERSISTENTE: lo que ya se sabe no se vuelve a
//      pedir, ni siquiera despues de un redeploy;
//   3. solo lo que falta va a Roblox, en lotes de hasta maxCatalogBatchSize;
//   4. las fichas nuevas se guardan para la proxima;
//   5. cada usuario se valora con `pricing.valorar`, reutilizando las mismas
//      fichas para todos.
//
// Si Roblox frena a mitad, los usuarios que ya se pudieron valorar SE GUARDAN y
// el resto se queda pendiente. Un limite nunca deja a nadie como
// `unpriceable`: ese estado significa "Roblox contesto y no hay precio".
async function resolverPrecios(pendientes, { contador = crearContador(), metricas = {} } = {}) {
    const salida = { valoraciones: [], limitado: false, ruta: null, medidas: {
        assetsVistos: 0, assetsUnicos: 0, aciertosPostgres: 0, pedidosARoblox: 0, lotes: 0,
    } };
    if (pendientes.length === 0) return salida;

    // ── 1. Union y deduplicado global ───────────────────────────────────────
    const necesarios = new Set();
    for (const u of pendientes) {
        salida.medidas.assetsVistos += u.assetIds.length;
        for (const id of u.assetIds) necesarios.add(String(id));
    }
    const unicos = [...necesarios];
    salida.medidas.assetsUnicos = unicos.length;

    // ── 2. El catalogo persistente primero ──────────────────────────────────
    const { fichas, faltan, aciertos } = await catalogoRepo.leerFrescos(unicos, {
        ttlMs: config.indexWorker.catalogTtlMs,
    });
    salida.medidas.aciertosPostgres = aciertos;

    // ── 3. Solo lo que falta, a Roblox ──────────────────────────────────────
    const nuevas = new Map();
    const ausentes = [];
    const tamano = config.maxCatalogBatchSize;

    for (let i = 0; i < faltan.length; i += tamano) {
        const lote = faltan.slice(i, i + tamano);
        try {
            // POR EL CUBO DE FONDO. El worker pone precio a miles de assets
            // seguidos: si saliera por el cubo del juego, su 429 pondria en
            // cooldown la ruta con la que el juego resuelve los precios de un
            // outfit — que es exactamente el fallo que esto corrige.
            const respuesta = await roblox.getCatalogItemDetails(
                lote.map(id => ({ id, itemType: 'Asset' })),
                { trafico: roblox.TRAFICO.FONDO }
            );
            salida.medidas.lotes++;
            salida.medidas.pedidosARoblox += lote.length;

            for (const assetId of lote) {
                const ficha = respuesta.get(roblox.catalogKey('Asset', assetId));
                if (ficha) { fichas.set(assetId, ficha); nuevas.set(assetId, ficha); }
                else ausentes.push(assetId);      // Roblox contesto: no existe
            }
        } catch (err) {
            if (err instanceof UpstreamRateLimitedError || err instanceof CircuitOpenError) {
                // Se para de pedir, PERO no se tira lo ya conseguido: los
                // usuarios que se puedan valorar con lo que hay se valoran.
                salida.limitado = true;
                salida.ruta = 'catalogDetails';
                break;
            }
            // Un fallo de un lote no condena a sus usuarios: se quedan
            // pendientes y se reintentan. Nunca `unpriceable`.
            salida.limitado = true;
            salida.ruta = 'catalogDetails';
            break;
        }
    }

    // ── 4. Los BUNDLES de quien no tiene precio propio ──────────────────────
    //
    // Un asset de paquete no se vende suelto: su precio es el del bundle. Se
    // resuelve con EL MISMO indice de bundles que usa una busqueda, y tambien
    // agrupando a todos los usuarios de la tanda de una vez.
    //
    // Lo que se averigua se pega a la ficha del asset y se guarda: la
    // pertenencia asset-bundle es estructural y no cambia nunca, asi que
    // preguntarla dos veces es tirar cuota.
    const bundles = crearIndiceDeBundles(contador);
    const dePaquete = [...fichas.entries()]
        .filter(([, ficha]) => necesitaBundle(ficha))
        .map(([assetId]) => assetId);

    if (dePaquete.length > 0 && !salida.limitado) {
        try {
            await bundles.asegurar(dePaquete);
            for (const assetId of dePaquete) {
                const bundleId = bundles.bundleDe(assetId);
                if (bundleId === null || bundleId === undefined) continue;
                const detalle = bundles.detalle(bundleId);
                const ficha = fichas.get(assetId);
                const enriquecida = {
                    ...ficha,
                    bundleId: String(bundleId),
                    bundlePrice: detalle?.price ?? null,
                    bundleAvailable: detalle?.available ?? null,
                };
                fichas.set(assetId, enriquecida);
                nuevas.set(assetId, enriquecida);
            }
        } catch (err) {
            // Un fallo aqui deja a esos assets sin precio de bundle: sus
            // usuarios se quedan PENDIENTES, nunca marcados como sin precio.
            if (err instanceof UpstreamRateLimitedError || err instanceof CircuitOpenError) {
                salida.limitado = true;
                salida.ruta = 'assetBundles';
            }
        }
    }

    // ── 5. Lo nuevo se guarda para la proxima ───────────────────────────────
    if (nuevas.size > 0 || ausentes.length > 0) {
        await catalogoRepo.guardar(nuevas, { faltantes: ausentes });
    }

    // ── 6. Cada usuario, con las MISMAS fichas ──────────────────────────────
    //
    // El indice que espera `pricing.valorar` es el de una busqueda: aqui se le
    // da uno que lee del mapa ya resuelto y no puede llamar a nadie. El
    // valorador es el de siempre, sin una linea distinta.
    const indice = {
        ficha: assetId => fichas.get(String(assetId)),
        irresoluble: assetId => !fichas.has(String(assetId)),
        get frenadoPorLimite() { return false; },
    };

    // Los bundles que ya venian guardados en la ficha se le dan al valorador
    // con la misma forma que tendrian recien resueltos.
    const bundlesParaValorar = {
        bundleDe(assetId) {
            const vivo = bundles.bundleDe(assetId);
            if (vivo !== null && vivo !== undefined) return vivo;
            return fichas.get(String(assetId))?.bundleId ?? null;
        },
        detalle(bundleId) {
            if (bundleId === null || bundleId === undefined) return undefined;
            const vivo = bundles.detalle(bundleId);
            if (vivo !== undefined) return vivo;
            for (const ficha of fichas.values()) {
                if (ficha.bundleId != null && String(ficha.bundleId) === String(bundleId)) {
                    return { available: ficha.bundleAvailable === true, price: ficha.bundlePrice ?? null };
                }
            }
            return undefined;
        },
    };

    for (const usuario of pendientes) {
        const conocidos = usuario.assetIds.filter(id => fichas.has(String(id)));

        // No se sabe lo suficiente todavia: se deja PENDIENTE, no fallido.
        if (conocidos.length < usuario.assetIds.length) {
            if (!salida.limitado) {
                // Roblox contesto por todos y aun asi faltan fichas: sus assets
                // no existen. Eso si es un veredicto.
                salida.valoraciones.push({ userId: usuario.userId, state: ESTADO.SIN_PRECIO, valoracion: null });
            }
            continue;
        }

        const valorado = valorar(usuario.assetIds, indice, bundlesParaValorar);
        if (!valorado.ok) {
            salida.valoraciones.push({ userId: usuario.userId, state: ESTADO.SIN_PRECIO, valoracion: null });
            continue;
        }
        salida.valoraciones.push({
            userId: usuario.userId, state: ESTADO.VALIDO, valoracion: valorado.valoracion,
        });
    }

    return salida;
}

module.exports = {
    resolverAvatar,
    resolverPrecios,
    crearContador,
    MOTIVO,
    // Reexportados para quien orquesta: son las piezas compartidas con la
    // busqueda en vivo y conviene que se vea que son las mismas.
    necesitaBundle, clasificar, CATEGORIA,
};
