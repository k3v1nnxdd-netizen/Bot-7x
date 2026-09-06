'use strict';

const crypto = require('crypto');
const roblox = require('../roblox/client');
const cacheStore = require('../cache/cacheStore');
const singleFlight = require('../cache/singleFlight');
const config = require('../config');
const logger = require('../observability/logger');
const { buildOutfit } = require('./humanoidDescription');
const { resolveUsername, markerFor } = require('./userService');
const { mapConLimite } = require('../utils/concurrency');
const {
    NotFoundError, UpstreamRateLimitedError, CircuitOpenError, UpstreamError,
} = require('../roblox/errors');

// Listado y detalle de outfits. Cada entidad tiene su propio TTL porque
// cambian a ritmos muy distintos: la LISTA se mueve cuando el jugador crea o
// borra un outfit (minutos), el CONTENIDO de un outfit concreto solo si lo
// edita (horas), la ficha de catalogo de un asset se mueve despacio (hora) y
// su pertenencia a bundle no cambia nunca (dia).

// El CURSOR forma parte de la clave, no un numero de pagina: cada bloque de la
// paginacion se cachea por separado y dos cursores distintos jamas comparten
// entrada. El token es largo (base64), asi que se resume con un hash corto
// para no arrastrar 300 caracteres en cada clave; sigue siendo unico por
// cursor, que es lo unico que importa.
function listCacheKey(userId, limit, pageToken, outfitType) {
    const cursor = pageToken ? crypto.createHash('sha1').update(pageToken).digest('hex').slice(0, 16) : 'first';
    return cacheStore.key('outfits', 'list', userId, limit, cursor, outfitType || 'all');
}

function detailsCacheKey(outfitId) {
    return cacheStore.key('outfits', 'details', outfitId);
}

// Claves por ASSET, no por outfit: tanto la ficha de catalogo como la
// pertenencia a bundle describen el asset, asi que resolverlas una vez sirve
// para todos los outfits de todos los jugadores que lleven esa pieza.
function bundlesCacheKey(assetId) {
    return cacheStore.key('asset', 'bundles', assetId);
}

function catalogCacheKey(assetId) {
    return cacheStore.key('asset', 'catalog', assetId);
}

async function listOutfits(userId, { limit, pageToken, outfitType }, ctx) {
    const result = await cacheStore.withCache(
        listCacheKey(userId, limit, pageToken, outfitType),
        config.ttl.outfitList,
        () => roblox.listOutfits(userId, { limit, pageToken, outfitType }),
        { negativeTtlMs: config.ttl.negative, onStatus: markerFor(ctx) }
    );

    return {
        userId,
        limit,
        outfitType: outfitType ?? null,
        count: result.outfits.length,
        // Se devuelve el cursor de la SIGUIENTE pagina, para reenviarlo tal
        // cual como `pageToken`. null cuando Roblox deja de dar token.
        nextPageToken: result.nextPageToken,
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

// ── Estado de catalogo: limitado / fuera de venta / ya no disponible ─────────

// Resuelve la ficha de catalogo de TODOS los assets del outfit con UNA sola
// llamada a Roblox, no una por asset. El patron es "lee N claves de cache,
// agrupa las que falten en un unico lote, guarda cada una por separado":
//
//   - Cada assetId se cachea por SEPARADO (1 h) y de forma GLOBAL. Dos outfits
//     que compartan sombrero comparten la entrada, sean del jugador que sean.
//   - Lo que falta se pide en UN lote (hasta 100 ids por peticion; un outfit
//     real ronda los 20, asi que siempre es un unico lote).
//   - Ese lote va con single-flight sobre el conjunto exacto de ids que
//     faltan, asi que dos peticiones simultaneas del mismo outfit frio
//     producen una sola llamada, no dos.
//
// ASSETS QUE ROBLOX YA NO RECONOCE: no se pierden. Un asset borrado, moderado
// o fuera del catalogo simplemente no viene en la respuesta (comprobado en
// vivo), y aqui se marca `available: false` conservando su assetId, su nombre
// y su tipo, que siguen llegando del propio outfit. Estar fuera de venta o
// haber desaparecido del catalogo no lo saca del avatar.
// Registro para un asset que Roblox no devolvio en el lote: borrado, moderado
// o simplemente fuera del catalogo. Mantiene EXACTAMENTE las mismas claves que
// un registro normal para que el juego no tenga que comprobar la presencia de
// cada campo, pero todas valen null salvo `available`. null aqui significa "no
// se sabe", que es la verdad: sin ficha de catalogo no podemos afirmar si es
// limitado ni si esta fuera de venta. Poner `false` seria inventarselo.
const SIN_FICHA_DE_CATALOGO = Object.freeze({
    available: false,
    restrictions: null,
    isLimited: null,
    offSale: null,
    price: null,
    lowestPrice: null,
    lowestResalePrice: null,
    hasResellers: null,
    creatorType: null,
    creatorTargetId: null,
    creatorName: null,
});

// Ids de asset de un outfit, sin repetidos y sin nulos.
function assetsDe(outfit) {
    return [...new Set(outfit.assets.map(a => a.id).filter(id => id != null))];
}

// RESOLUCION DE CATALOGO DE UN CONJUNTO DE ASSETS, venga de un outfit o de
// veinticuatro. Devuelve un mapa assetId -> ficha con TODO lo que se pudo
// resolver; lo que falta en el mapa es lo que no se pudo comprobar.
//
// POR QUE ESTA APARTE Y RECIBE UNA LISTA PLANA. Resolver por outfit obliga a
// pagar una tanda de llamadas POR OUTFIT, y los assets se repiten muchisimo
// entre los outfits de una misma persona (la misma camiseta en seis conjuntos).
// Con la lista unida, veinticuatro outfits de unos veinte assets se quedan en
// una sola deduplicacion y en los pocos lotes que hagan falta, en vez de en
// veinticuatro tandas.
//
// Lo que NO cambia: el troceado sigue siendo el mismo, la cache por asset la
// misma y el single-flight el mismo. Esto no pide mas ni mas deprisa; pide
// MENOS VECES lo mismo.
async function resolverCatalogo(assetIds, ctx, contextoLog = {}) {
    const encontrados = new Map();
    if (assetIds.length === 0) return encontrados;

    const faltantes = [];
    for (const assetId of assetIds) {
        const cacheado = await cacheStore.get(catalogCacheKey(assetId));
        if (cacheado !== undefined) encontrados.set(assetId, cacheado);
        else faltantes.push(assetId);
    }

    ctx?.push(faltantes.length === 0 ? 'catalog-hit' : 'catalog-miss');

    for (let i = 0; i < faltantes.length; i += config.maxCatalogBatchSize) {
        const lote = faltantes.slice(i, i + config.maxCatalogBatchSize);
        try {
            const detalles = await singleFlight.run(`catalog:${lote.join('.')}`, () => roblox.getCatalogDetails(lote));
            for (const assetId of lote) {
                // Ausente en la respuesta = Roblox ya no tiene ficha para el.
                const registro = detalles.get(assetId) ?? SIN_FICHA_DE_CATALOGO;
                await cacheStore.set(catalogCacheKey(assetId), registro, config.ttl.catalogDetails);
                encontrados.set(assetId, registro);
            }
        } catch (err) {
            // El outfit es el dato principal; el estado de catalogo es un
            // extra. Si Roblox limita o falla, se entrega el outfit igual con
            // `catalogResolved: false` en lugar de tumbar la respuesta entera.
            logger.warn('No se pudo resolver el estado de catalogo de un lote', {
                ...contextoLog, assets: lote.length, detail: err?.message,
            });
        }
    }

    return encontrados;
}

// Pega las fichas ya resueltas a un outfit. Pura: no consulta nada.
//
// `catalogResolved` se deduce de los datos en vez de arrastrarse como bandera:
// es `true` cuando TODOS los assets del outfit tienen ficha. Un asset que
// Roblox no reconoce si la tiene (SIN_FICHA_DE_CATALOGO), asi que solo queda
// fuera lo que no se pudo comprobar por un fallo NUESTRO o de Roblox. Es lo que
// permite al juego distinguir "no disponible" de "no lo pudimos comprobar", y
// con el lote es ademas exacto por outfit: que fallara el trozo de otro no
// marca a este.
function aplicarCatalogo(outfit, encontrados) {
    const assetIds = assetsDe(outfit);
    return {
        ...outfit,
        assets: outfit.assets.map(asset => {
            const registro = encontrados.get(asset.id);
            return registro ? { ...asset, catalog: registro } : asset;
        }),
        catalogResolved: assetIds.every(id => encontrados.has(id)),
    };
}

async function attachCatalogStatus(outfit, ctx) {
    const assetIds = assetsDe(outfit);
    if (assetIds.length === 0) return { ...outfit, catalogResolved: true };

    const encontrados = await resolverCatalogo(assetIds, ctx, { outfitId: outfit.id });
    return aplicarCatalogo(outfit, encontrados);
}

// ── Bundles (opcional, y con reservas) ──────────────────────────────────────

// Ver la advertencia larga en roblox/client.js. Resumen: Roblox no expone a
// que bundles pertenece un outfit; la unica via es la busqueda inversa por
// asset, que no admite lote, es incompleta y trae ruido. Confirmado ademas que
// el campo `bundledItems` del lote de catalogo NO sirve para esto: va en la
// direccion contraria (que contiene un bundle) y llega vacio para un asset.
// Por eso esta detras de ?bundles=1 y nunca se ejecuta por defecto.
async function attachBundles(outfit, ctx) {
    const assetIds = [...new Set(outfit.assets.map(a => a.id).filter(id => id != null))]
        .slice(0, config.maxBundleLookupsPerRequest);

    const truncated = new Set(outfit.assets.map(a => a.id)).size > assetIds.length;
    if (truncated) {
        logger.warn('Resolucion de bundles truncada', {
            outfitId: outfit.id, assets: outfit.assets.length, resueltos: assetIds.length,
        });
    }

    const byAssetId = new Map();
    await Promise.all(assetIds.map(async assetId => {
        try {
            byAssetId.set(assetId, await cacheStore.withCache(
                bundlesCacheKey(assetId),
                config.ttl.assetBundles,
                () => roblox.getBundlesForAsset(assetId),
                { negativeTtlMs: config.ttl.negative, onStatus: markerFor(ctx) }
            ));
        } catch (err) {
            // null != []. [] significa "Roblox respondio: ninguno";
            // null significa "no lo pudimos comprobar".
            byAssetId.set(assetId, null);
            logger.warn('No se pudo resolver el bundle de un asset', { assetId, detail: err?.message });
        }
    }));

    return {
        ...outfit,
        assets: outfit.assets.map(asset => ({
            ...asset,
            bundles: byAssetId.has(asset.id) ? byAssetId.get(asset.id) : null,
        })),
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

// `catalog` cuesta UNA llamada extra para todo el outfit; `bundles` cuesta una
// por asset. De ahi que sean banderas separadas y ninguna venga activada.
async function getOutfitDetailsWithOptions(outfitId, { catalog = false, bundles = false } = {}, ctx) {
    let outfit = await getOutfitDetails(outfitId, ctx);
    if (catalog) outfit = await attachCatalogStatus(outfit, ctx);
    if (bundles) outfit = await attachBundles(outfit, ctx);
    return outfit;
}


// ── LOTE DE OUTFITS (POST /v1/outfits/batch) ────────────────────────────────
//
// EL PROBLEMA QUE RESUELVE, MEDIDO DEL LADO DE ROBLOX. El buscador del juego
// enseña hasta 24 outfits. Pedirlos de uno en uno cuesta 3 fichas del limitador
// del servidor de Roblox por llamada: 24 x 3 = 72 fichas contra un cubo de 40
// que recarga a 8/s. Aunque el cliente limite el pico a cinco en paralelo, once
// de los veinticuatro se quedan sin datos. No es un problema de cuota NUESTRA y
// no se arregla subiendo limites: se arregla no haciendo 24 llamadas HTTP.
//
// Con una sola peticion, el juego gasta 3 fichas en vez de 72.
//
// AQUI DENTRO NO HAY UN BUCLE SERIAL. El orden es:
//
//   1. Deduplicar. Dos veces el mismo id es un id.
//   2. Leer la cache de TODOS de golpe. Lo cacheado se resuelve al instante y
//      no gasta ni una llamada.
//   3. Solo lo que falta sale a Roblox, con concurrencia acotada y por el
//      camino de siempre — misma cache, mismo single-flight, mismo limitador —
//      asi que si otra peticion ya esta resolviendo ese outfit, esta se
//      engancha a su vuelo en vez de abrir otro.
//
// UN OUTFIT QUE FALLA NO TUMBA EL LOTE. Cada id lleva su propio veredicto: o
// trae outfit, o trae el codigo de error que le corresponda. Un 404 de un
// outfit borrado no puede dejar sin resultados a los otros veintitres.

// Veredicto de un id que no se pudo resolver. El codigo es el MISMO que
// devolveria la ruta individual para ese outfit, para que el juego no tenga que
// aprender dos vocabularios de error.
function errorDeOutfit(err) {
    if (err instanceof NotFoundError) return { code: err.code, message: err.message };
    if (err instanceof UpstreamRateLimitedError || err instanceof CircuitOpenError) {
        return {
            code: err.code,
            message: err.message,
            retryAfterSeconds: err.retryAfterSeconds ?? 5,
        };
    }
    if (err instanceof UpstreamError) {
        // La causa se registra pero NUNCA viaja: un error de axios arrastra
        // URLs, cabeceras y configuracion interna.
        return { code: err.code, message: 'No se pudo obtener la informacion de Roblox' };
    }
    return { code: 'internal_error', message: 'Error interno resolviendo este outfit' };
}

async function getOutfitsBatch(outfitIds, { catalog = false } = {}, ctx) {
    const medidas = {
        requested: outfitIds.length,
        unique: 0,
        cacheHits: 0,
        cacheMisses: 0,
        singleFlightJoins: 0,
        cacheMs: 0,
        fetchMs: 0,
        // Catalogo: assets distintos que hubo que mirar y cuantos quedaron sin
        // ficha. Con `catalog` apagado se quedan a cero y no se toca nada.
        catalogAssets: 0,
        catalogUnresolved: 0,
        catalogMs: 0,
    };

    // ── 1. Deduplicar, conservando el orden de primera aparicion ────────────
    const unicos = [...new Set(outfitIds)];
    medidas.unique = unicos.length;

    // ── 2. Cache de golpe ───────────────────────────────────────────────────
    // Se lee ANTES de lanzar nada. Un lote que ya esta caliente no toca Roblox
    // ni espera al limitador, y ademas asi los contadores de aciertos son
    // exactos en vez de deducidos.
    const resueltos = new Map();
    const faltantes = [];

    const empezoCache = Date.now();
    for (const outfitId of unicos) {
        const cacheado = await cacheStore.get(detailsCacheKey(outfitId));
        if (cacheado !== undefined) {
            resueltos.set(outfitId, { ok: true, outfit: cacheado });
            medidas.cacheHits++;
            ctx?.push('hit');
        } else {
            faltantes.push(outfitId);
            medidas.cacheMisses++;
            ctx?.push('miss');
        }
    }
    medidas.cacheMs = Date.now() - empezoCache;

    // ── 3. Lo que falta, con concurrencia acotada ───────────────────────────
    // (el catalogo va DESPUES, en el paso 4, para poder unir los assets de
    //  todos los outfits en una sola resolucion)
    const empezoFetch = Date.now();
    await mapConLimite(faltantes, config.outfitsBatch.concurrency, async outfitId => {
        // Si YA hay un vuelo para este outfit —otra peticion lo esta pidiendo
        // ahora mismo— esta llamada se va a enganchar a el en vez de abrir otro.
        // Se anota aqui, justo antes, porque despues ya no se distingue.
        if (singleFlight.enVuelo(detailsCacheKey(outfitId))) medidas.singleFlightJoins++;

        try {
            // Por el camino de SIEMPRE: withCache -> singleFlight -> limitador.
            // No se reimplementa nada, y por eso hereda la cache negativa, el
            // breaker y el resto de garantias sin tener que repetirlas.
            const outfit = await getOutfitDetails(outfitId, null);
            resueltos.set(outfitId, { ok: true, outfit });
        } catch (err) {
            // Un fallo es de ESTE id y de ninguno mas. Nada se cachea aqui: los
            // 429 y los 5xx no pasan por la cache (withCache solo guarda la
            // ausencia CONFIRMADA), asi que un mal rato de Roblox no se
            // convierte en respuestas malas guardadas.
            resueltos.set(outfitId, { ok: false, error: errorDeOutfit(err) });
        }
    });
    medidas.fetchMs = Date.now() - empezoFetch;

    // ── 4. Catalogo (precios), UNA VEZ PARA TODO EL LOTE ────────────────────
    //
    // Aqui esta el ahorro que justifica pedir precios por lote. Resolviendo por
    // outfit, veinticuatro outfits son veinticuatro tandas de llamadas al
    // catalogo. Uniendo sus assets y deduplicando, son los pocos trozos que
    // salgan — y los assets repetidos entre conjuntos, que son muchos, se piden
    // UNA vez. No sube ninguna cuota ni ninguna concurrencia: reduce el numero
    // de veces que se pide lo mismo.
    if (catalog) {
        const empezoCatalogo = Date.now();

        const conOutfit = [...resueltos.values()].filter(r => r.ok);
        const todosLosAssets = [...new Set(conOutfit.flatMap(r => assetsDe(r.outfit)))];
        medidas.catalogAssets = todosLosAssets.length;

        const fichas = await resolverCatalogo(todosLosAssets, ctx, { lote: unicos.length });
        medidas.catalogUnresolved = todosLosAssets.filter(id => !fichas.has(id)).length;

        // El pegado es puro y por outfit: un asset que no se pudo comprobar
        // deja a SU outfit con catalogResolved:false y no mancha a los demas.
        for (const [outfitId, veredicto] of resueltos) {
            if (veredicto.ok) {
                resueltos.set(outfitId, { ok: true, outfit: aplicarCatalogo(veredicto.outfit, fichas) });
            }
        }
        medidas.catalogMs = Date.now() - empezoCatalogo;
    }

    // ── 5. Ensamblado, en el orden pedido ───────────────────────────────────
    // Una entrada por id UNICO, en orden de primera aparicion, y con el
    // outfitId siempre explicito: el juego empareja por id y no por posicion.
    const results = unicos.map(outfitId => ({ outfitId, ...resueltos.get(outfitId) }));

    medidas.succeeded = results.filter(r => r.ok).length;
    medidas.failed = results.length - medidas.succeeded;

    return { results, medidas };
}

// Endpoint compuesto: resolver + listar en una sola llamada del juego.
//
// Existe para MINIMIZAR LLAMADAS DESDE ROBLOX, que es un recurso propio y
// escaso del lado del juego: HttpService tiene su propio presupuesto por
// servidor, y este es el flujo dominante (el jugador escribe un nombre y
// quiere ver sus outfits). Partirlo en dos peticiones duplicaria el gasto
// del juego sin ahorrarnos a nosotros ni una llamada a Roblox.
async function listOutfitsByUsername(username, pagination, { details = false, catalog = false } = {}, ctx) {
    const user = await resolveUsername(username, ctx);
    const listing = await listOutfits(user.userId, pagination, ctx);
    const base = { ...listing, username: user.username, displayName: user.displayName };

    // SIN `details`, la respuesta es EXACTAMENTE la de siempre. No un campo de
    // mas, no un campo de menos: lo que ya esta desplegado en el juego no puede
    // cambiar de forma porque exista una bandera nueva.
    if (!details) return base;

    const ids = listing.outfits.map(o => o.id);
    if (ids.length === 0) {
        return { ...base, stats: { requested: 0, unique: 0, succeeded: 0, failed: 0 } };
    }

    // El MISMO servicio que atiende POST /v1/outfits/batch, llamado en memoria.
    // Ni una peticion HTTP contra nosotros mismos: eso pagaria otra vez el
    // limitador por IP, la licencia y la propiedad del juego para resolver algo
    // que ya esta autorizado, y ademas ataria dos rutas por la red en lugar de
    // por una funcion.
    //
    // Hereda entero lo del lote: deduplicacion, cache, single-flight,
    // concurrencia acotada, catalogo resuelto UNA vez para todos los outfits y
    // un veredicto por id. No se sube ninguna cuota ni ninguna concurrencia.
    const { results, medidas } = await getOutfitsBatch(ids, { catalog }, ctx);

    // ORDEN DE LA LISTA, emparejando por id y no por posicion. El lote ya
    // devuelve en orden de primera aparicion y hoy coincide, pero depender de
    // esa coincidencia seria depender de un detalle interno de otra funcion:
    // el dia que el lote reordene, la cuadricula se desordenaria en silencio.
    const porId = new Map(results.map(r => [r.outfitId, r]));

    return {
        ...base,
        // Cada entrada trae su propio veredicto, con el MISMO vocabulario que
        // POST /v1/outfits/batch: { outfitId, ok: true, outfit } o
        // { outfitId, ok: false, error }. Un outfit borrado no puede dejar sin
        // cuadricula a los otros veintitres, y el juego no tiene que aprender
        // dos formas distintas de leer lo mismo.
        outfits: ids.map(id => porId.get(id)),
        stats: {
            requested: medidas.requested,
            unique: medidas.unique,
            succeeded: medidas.succeeded,
            failed: medidas.failed,
            cacheHits: medidas.cacheHits,
            cacheMisses: medidas.cacheMisses,
            singleFlightJoins: medidas.singleFlightJoins,
            catalog,
            catalogAssets: medidas.catalogAssets,
            catalogUnresolved: medidas.catalogUnresolved,
        },
    };
}

module.exports = {
    listOutfits,
    getOutfitsBatch,
    getOutfitDetails,
    getOutfitDetailsWithOptions,
    listOutfitsByUsername,
};
