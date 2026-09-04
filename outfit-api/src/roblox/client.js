'use strict';

const axios = require('axios');
const http = require('http');
const https = require('https');
const config = require('../config');
const rateLimiter = require('./rateLimiter');
const { NotFoundError, UpstreamError } = require('./errors');

// EL UNICO modulo de este servicio que habla con Roblox. Nada mas importa
// axios ni construye una URL de roblox.com: cualquier futura llamada entra
// por aqui y hereda automaticamente el limitador, el breaker, los timeouts y
// la normalizacion, sin que quien la añada tenga que acordarse de nada.
//
// SUPERFICIE COMPLETA — solo endpoints publicos y documentados de Roblox:
//   1. POST users.roblox.com/v1/usernames/users            username -> userId
//   2. GET  avatar.roblox.com/v2/avatar/users/{id}/outfits  listado paginado
//   3. GET  avatar.roblox.com/v3/outfits/{id}/details       contenido del outfit
//   4. GET  catalog.roblox.com/v1/assets/{id}/bundles       SOLO bajo peticion
//      explicita (?bundles=1) — ver getBundlesForAsset y su advertencia.
//   5. GET  apis.roblox.com/universes/v1/places/{id}/universe  placeId -> universeId
//   6. GET  develop.roblox.com/v1/universes/{id}            universeId -> dueño REAL
//   7. GET  groups.roblox.com/v1/groups/{id}/users         miembros del grupo
//   8. GET  avatar.roblox.com/v1/users/{id}/avatar         avatar ACTUAL del usuario
//
// Las dos ultimas son la verificacion de licencia. La 6 NO es games.roblox.com
// a proposito: ver la nota larga sobre la ficha censurada en getUniverseOwner.
//
// Las tres primeras son las que atienden el 100% del trafico normal. Un outfit
// completo — accesorios, ropa 2D y por capas, partes del cuerpo, colores,
// escalas, animaciones y emotes — se resuelve con UNA sola llamada a la 3.
//
// SIN CREDENCIALES DE ROBLOX, POR DISEÑO. Ni cookies, ni .ROBLOSECURITY, ni
// cabeceras de autenticacion, ni tokens CSRF: estos endpoints sirven datos
// PUBLICOS y responden perfectamente sin sesion. `withCredentials: false` y
// la ausencia de cualquier cookie jar lo dejan estructuralmente imposible, no
// solo omitido. Consecuencia buscada: este servicio no puede actuar en nombre
// de ninguna cuenta de Roblox ni aunque alguien lo intente, y no hay ninguna
// credencial de Roblox que pueda filtrarse porque no existe.
//
// keepAlive reutiliza la conexion TCP+TLS entre llamadas al mismo host de
// Roblox en lugar de renegociar un handshake cada vez. Bajo trafico real
// (muchas llamadas pequeñas a dos hostnames) recorta la latencia de cola de
// forma medible: un handshake TLS cuesta bastante mas que la peticion en si
// sobre una conexion ya caliente. El pool es modesto a proposito — el gate de
// concurrencia del limitador ya acota cuantas peticiones vuelan a la vez, asi
// que sockets de mas solo estarian ociosos.
const agentOptions = { keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 20, maxFreeSockets: 10 };

const http_ = axios.create({
    timeout: config.upstream.timeoutMs,
    httpAgent: new http.Agent(agentOptions),
    httpsAgent: new https.Agent(agentOptions),
    withCredentials: false,
    maxRedirects: 0, // estos endpoints no redirigen; seguir uno solo serviria para acabar en un sitio inesperado
    headers: {
        Accept: 'application/json',
        'User-Agent': 'outfit-api (Roblox game integration)',
    },
});

// ── 1. username -> userId ────────────────────────────────────────────────────

// POST https://users.roblox.com/v1/usernames/users
// Devuelve tambien displayName en la MISMA respuesta, asi que no hace falta
// ninguna llamada extra al perfil: una peticion cubre todo lo que expone
// nuestro endpoint de resolucion.
//
// Este endpoint responde 200 con `data: []` cuando el usuario no existe, en
// vez de 404. Se traduce a NotFoundError aqui mismo para que aguas abajo
// "no existe" tenga una sola forma, venga como venga de Roblox.
async function lookupUserByUsername(username) {
    const response = await rateLimiter.run('usernameLookup', () => http_.post(
        'https://users.roblox.com/v1/usernames/users',
        { usernames: [username], excludeBannedUsers: false },
        { headers: { 'Content-Type': 'application/json' } }
    ), { notFoundCode: 'user_not_found' });

    const user = response.data?.data?.[0];
    if (!user?.id) {
        throw new NotFoundError('user_not_found', 'No existe ningun usuario de Roblox con ese nombre');
    }

    return {
        userId: user.id,
        username: user.name,
        displayName: user.displayName ?? user.name,
    };
}

// ── 2. listado de outfits ────────────────────────────────────────────────────

// GET https://avatar.roblox.com/v2/avatar/users/{userId}/outfits
// Parametros: itemsPerPage, paginationToken (opcional), outfitType (opcional),
// isEditable.
//
// PAGINACION POR CURSOR, NO POR NUMERO DE PAGINA. Comprobado en vivo y sin
// lugar a dudas: `page` esta DOCUMENTADO pero Roblox lo IGNORA — page=1,
// page=2 y page=3 devuelven exactamente los mismos ids. Lo que si funciona es
// `paginationToken`: pasar el token de una pagina devuelve el bloque
// siguiente, distinto, junto a un token nuevo.
//     page=1  -> 555869704325162, 17762785106, 11685920016
//     page=2  -> 555869704325162, 17762785106, 11685920016   (identico)
//     token   -> 11155772506, 131929576, 131929573           (avanza de verdad)
//
// FIN DEL RECORRIDO: al agotarse, Roblox devuelve `paginationToken: ""` —
// cadena VACIA, no null y no ausente. Esa cadena vacia es la señal de "no hay
// mas", y es lo que traduce `hasMore`.
//
// isEditable=true SIEMPRE. Sin el, el listado mezcla los outfits que el
// jugador ha guardado con outfits derivados de bundles del catalogo que nunca
// guardo. Verificado: builderman devuelve 25+ entradas sin filtro y solo DOS
// con el ("builderman1" y "builderman2") — las unicas realmente suyas.
//
// Respuesta REAL: { data: [{ id, name, isEditable, outfitType }],
// paginationToken }. NO existe `filteredCount` ni ningun otro total, asi que
// no se expone ninguno: inventarlo seria justo lo contrario de lo pedido.
// Mapeo puro de la respuesta del listado. Separado de la llamada HTTP para que
// los tests puedan ejercitarlo contra respuestas reales guardadas — sobre todo
// la distincion entre "hay mas paginas" y "se acabo", que es exactamente donde
// estaba el fallo de paginacion.
function normalizeOutfitList(raw) {
    const data = Array.isArray(raw?.data) ? raw.data : [];
    const nextToken = raw?.paginationToken;
    // Solo una cadena NO vacia es un cursor de verdad. Al agotarse el
    // recorrido Roblox manda "" (cadena vacia), no null ni ausencia.
    const hasMore = typeof nextToken === 'string' && nextToken.length > 0;

    return {
        outfits: data.map(outfit => ({
            id: outfit.id,
            name: outfit.name,
            outfitType: outfit.outfitType ?? null,
            isEditable: outfit.isEditable ?? null,
        })),
        nextPageToken: hasMore ? nextToken : null,
        hasMore,
    };
}

async function listOutfits(userId, { limit, pageToken, outfitType }) {
    const params = { itemsPerPage: limit, isEditable: true };
    if (pageToken) params.paginationToken = pageToken;
    if (outfitType) params.outfitType = outfitType;

    const response = await rateLimiter.run('outfitList', () => http_.get(
        `https://avatar.roblox.com/v2/avatar/users/${userId}/outfits`,
        { params }
    ), { notFoundCode: 'user_not_found' });

    return normalizeOutfitList(response.data);
}

// ── 3. detalles de un outfit ─────────────────────────────────────────────────

// GET https://avatar.roblox.com/v3/outfits/{userOutfitId}/details
//
// Devuelve el cuerpo CRUDO de Roblox. La normalizacion a forma de
// HumanoidDescription vive en services/humanoidDescription.js, no aqui: asi
// es una funcion pura testeable contra respuestas reales guardadas, y el
// servicio puede cachear ya el resultado normalizado en vez del payload
// original (mas pequeño y sin re-normalizar en cada acierto de cache).
//
// Forma confirmada en vivo sobre 9 outfits distintos:
//   { id, name, assets[], bodyColor3s{6}, scale{6}, playerAvatarType,
//     outfitType, isEditable, universeId, inventoryType }
// donde cada asset es { id, name, assetType{id,name}, currentVersionId } mas,
// segun el caso, `meta{order,puffiness,version}` (ropa por capas) y
// `supportsHeadShapes` (cabezas dinamicas).
async function getOutfitDetailsRaw(outfitId) {
    const response = await rateLimiter.run('outfitDetails', () => http_.get(
        `https://avatar.roblox.com/v3/outfits/${outfitId}/details`
    ), { notFoundCode: 'outfit_not_found' });

    return response.data ?? {};
}

// ── 4. bundles de un asset (opcional, bajo peticion) ─────────────────────────

// GET https://catalog.roblox.com/v1/assets/{assetId}/bundles
//
// LEER ANTES DE USAR. Roblox NO expone a que bundles pertenece un outfit: su
// respuesta de detalles no menciona bundles en ningun campo. Lo unico que hay
// es esta busqueda INVERSA por asset, y tiene tres problemas comprobados en
// vivo:
//   1. No admite lote. Una peticion por asset, sin agrupacion posible. El
//      hermano `catalog/v1/bundles/details?bundleIds=` SI es por lotes, pero
//      va en la direccion contraria (necesitas ya los ids de bundle).
//   2. Es incompleta. "Man - Torso" (12995020128), que pertenece de verdad al
//      bundle "Man", devuelve `data: []`.
//   3. Trae ruido. "Roblox Baseball Cap" (607702162) devuelve un bundle
//      interno llamado "BundleForTesting".
//
// Por eso NO se llama nunca por defecto: solo con ?bundles=1 explicito. El
// coste queda amortizado globalmente porque la pertenencia a bundle es un dato
// ESTRUCTURAL del asset (no del jugador ni del outfit): una vez resuelto un
// assetId, cualquier outfit de cualquier jugador que lo lleve lo lee de cache.
// Tiene ademas su propio bucket en el limitador, para que este camino opcional
// no pueda robarle cuota a los tres endpoints principales.
async function getBundlesForAsset(assetId) {
    const response = await rateLimiter.run('assetBundles', () => http_.get(
        `https://catalog.roblox.com/v1/assets/${assetId}/bundles`
    ), { notFoundCode: 'asset_not_found' });

    const data = Array.isArray(response.data?.data) ? response.data.data : [];

    // Solo id, nombre y tipo. La respuesta cruda arrastra descripcion,
    // creador, precios y `collectibleItemDetail` completo — kilobytes por
    // bundle que no aportan nada a reconstruir un avatar.
    return data.map(bundle => ({
        id: bundle.id,
        name: bundle.name,
        bundleType: bundle.bundleType ?? null,
    }));
}

// ── 5. estado de catalogo de varios assets (opcional, POR LOTES) ─────────────

// catalog.roblox.com requiere un x-csrf-token. Se cachea el token y solo se
// renueva cuando Roblox rechaza uno caducado, en vez de hacer el baile del
// 403 en cada llamada.
let catalogCsrfToken = null;

// `items` ya viene con la forma que espera Roblox: [{ itemType, id }]. Se
// acepta asi, y no como lista de assetIds, porque el endpoint admite Assets y
// Bundles MEZCLADOS y esa es justo la propiedad que aprovecha /v1/catalog/batch.
function postCatalogDetails(items) {
    const body = { items };
    const headers = { 'Content-Type': 'application/json' };
    if (catalogCsrfToken) headers['x-csrf-token'] = catalogCsrfToken;

    return http_.post('https://catalog.roblox.com/v1/catalog/items/details', body, { headers })
        .catch(err => {
            const tokenNuevo = err.response?.status === 403 && err.response.headers['x-csrf-token'];
            if (!tokenNuevo) throw err;
            catalogCsrfToken = tokenNuevo;
            return http_.post('https://catalog.roblox.com/v1/catalog/items/details', body, {
                headers: { ...headers, 'x-csrf-token': catalogCsrfToken },
            });
        });
}

// POST https://catalog.roblox.com/v1/catalog/items/details
//
// UNA SOLA PETICION PARA TODOS LOS ASSETS DEL OUTFIT. Este es el endpoint que
// responde a "¿esta fuera de venta?", "¿es limitado?", "¿sigue existiendo?" —
// y admite lote, asi que un outfit entero (~20 assets) cuesta UNA llamada, no
// veinte. Confirmado en vivo con 8 assets en una sola peticion.
//
// COMO SE DETECTA UN ASSET ELIMINADO O MODERADO: Roblox simplemente NO lo
// incluye en la respuesta. Comprobado: al pedir [607702162, 999999999999]
// vuelve un solo item. Tambien falto un Shirt real y antiguo (13343843), asi
// que "ausente" cubre borrado, moderado o fuera del catalogo. Esa ausencia es
// informacion, no un error: el asset SIGUE formando parte del outfit y
// conserva su assetId — solo deja de tener ficha de catalogo.
//
// Devuelve Map<assetId, registro>. Quien llama decide que hacer con los que
// falten; aqui no se inventa ninguno.
// EL LOTE ADMITE ASSETS Y BUNDLES MEZCLADOS. Comprobado en vivo: mandando
// [{Asset,139607570},{Bundle,192},{Bundle,201}] vuelven los tres en una sola
// respuesta. Eso permite resolver TODO un outfit — piezas sueltas y packs — con
// una peticion, que es la razon de ser de /v1/catalog/batch.
//
// Tope real del endpoint: 120 items. Con 121 responde 400 "Invalid count"
// (comprobado). Los limites de /v1/catalog/batch estan por debajo a proposito,
// para que una peticion nuestra nunca se parta en dos lotes.
//
// Devuelve Map<"Asset:123"|"Bundle:192", registro>: la clave lleva el tipo
// porque un assetId y un bundleId pueden coincidir en numero y son cosas
// distintas.
function normalizeCatalogItem(item) {
    const restrictions = Array.isArray(item.itemRestrictions) ? item.itemRestrictions : [];
    return {
        available: true,
        name: item.name ?? null,
        itemType: item.itemType ?? null,
        assetTypeId: item.assetType ?? null,   // numero; solo en itemType Asset
        bundleTypeId: item.bundleType ?? null, // numero; solo en itemType Bundle
        restrictions,
        // "Limited" y "LimitedUnique" son los dos valores que Roblox usa
        // para un objeto de edicion limitada. Se derivan de lo que manda,
        // no de una suposicion nuestra.
        isLimited: restrictions.includes('Limited') || restrictions.includes('LimitedUnique'),
        offSale: item.isOffSale ?? null,
        price: item.price ?? null,
        lowestPrice: item.lowestPrice ?? null,
        lowestResalePrice: item.lowestResalePrice ?? null,
        hasResellers: item.hasResellers ?? null,
        collectibleItemId: item.collectibleItemId ?? null,
        creatorType: item.creatorType ?? null,
        creatorTargetId: item.creatorTargetId ?? null,
        creatorName: item.creatorName ?? null,
    };
}

const catalogKey = (itemType, id) => `${itemType}:${id}`;

async function getCatalogItemDetails(items) {
    const details = new Map();
    if (items.length === 0) return details;

    const response = await rateLimiter.run('catalogDetails', () => postCatalogDetails(items));

    for (const item of (response.data?.data ?? [])) {
        details.set(catalogKey(item.itemType ?? 'Asset', item.id), normalizeCatalogItem(item));
    }

    return details;
}

// Firma historica, intacta: Map<assetId (NUMERO), registro> con las mismas
// claves de siempre. La usa attachCatalogStatus en outfitService.js y no puede
// cambiar de forma; por dentro reutiliza el lote mixto para no tener dos
// caminos que puedan desalinearse.
async function getCatalogDetails(assetIds) {
    const mixto = await getCatalogItemDetails(assetIds.map(id => ({ itemType: 'Asset', id })));

    const details = new Map();
    for (const assetId of assetIds) {
        const registro = mixto.get(catalogKey('Asset', assetId));
        if (!registro) continue; // ausente = Roblox ya no tiene ficha; lo decide quien llama
        details.set(assetId, {
            available: true,
            restrictions: registro.restrictions,
            isLimited: registro.isLimited,
            offSale: registro.offSale,
            price: registro.price,
            lowestPrice: registro.lowestPrice,
            lowestResalePrice: registro.lowestResalePrice,
            hasResellers: registro.hasResellers,
            creatorType: registro.creatorType,
            creatorTargetId: registro.creatorTargetId,
            creatorName: registro.creatorName,
        });
    }

    return details;
}

// ── 4b. detalles de bundles POR LOTES ────────────────────────────────────────

// GET https://catalog.roblox.com/v1/bundles/details?bundleIds=192,201
//
// Tope real: 100 bundles. Con 101 responde 400 "Cannot request so many bundles
// at once" (comprobado en vivo).
//
// ES EL UNICO SITIO QUE DA LA COMPOSICION del bundle — `items[]` con los assets
// que lo forman —, y esa lista es justo lo que permite que Roblox compruebe la
// propiedad de UN bundle en vez de la de seis assets sueltos. Trae ademas
// precio y datos de reventa (`collectibleItemDetail`), asi que un bundle se
// resuelve entero sin llamadas extra.
//
// Lo que NO trae es `itemRestrictions`, asi que "limitado" para un bundle sale
// del lote mixto de items/details, no de aqui.
async function getBundleDetails(bundleIds) {
    const details = new Map();
    if (bundleIds.length === 0) return details;

    const response = await rateLimiter.run('bundleDetails', () => http_.get(
        `https://catalog.roblox.com/v1/bundles/details?bundleIds=${bundleIds.join(',')}`
    ), { notFoundCode: 'bundle_not_found' });

    // Aqui la respuesta es un ARRAY pelado, no un { data: [...] } como el
    // resto de endpoints de Roblox.
    const data = Array.isArray(response.data) ? response.data : [];

    for (const bundle of data) {
        const collectible = bundle.collectibleItemDetail ?? null;
        details.set(String(bundle.id), {
            available: true,
            name: bundle.name ?? null,
            bundleType: bundle.bundleType ?? null, // aqui SI es texto ("BodyParts", "DynamicHead")
            // Solo los Asset: un bundle lista tambien su UserOutfit, que no es
            // algo que un jugador posea ni pueda llevar puesto.
            assetIds: (Array.isArray(bundle.items) ? bundle.items : [])
                .filter(item => item.type === 'Asset' && item.id != null)
                .map(item => String(item.id)),
            price: bundle.product?.priceInRobux ?? null,
            forSale: bundle.product?.isForSale ?? null,
            noPriceText: bundle.product?.noPriceText ?? null,
            collectibleItemId: collectible?.collectibleItemId ?? null,
            lowestPrice: collectible?.lowestPrice ?? null,
            lowestResalePrice: collectible?.lowestResalePrice ?? null,
            hasResellers: collectible?.hasResellers ?? null,
            saleStatus: collectible?.saleStatus ?? null,
            creatorType: bundle.creator?.type ?? null,
            creatorTargetId: bundle.creator?.id != null ? String(bundle.creator.id) : null,
            creatorName: bundle.creator?.name ?? null,
        });
    }

    return details;
}

// ── 5 y 6. De quien es REALMENTE una experiencia ─────────────────────────────
//
// Estas dos llamadas existen por un motivo de seguridad muy concreto: el
// cliente que llama a /v1/license/verify tiene el .rbxl en su ordenador y puede
// editar el script, asi que CUALQUIER dato que mande sobre a quien pertenece su
// juego es una afirmacion suya, no un hecho. Preguntandoselo a Roblox, la
// propiedad deja de ser algo que el llamador declara y pasa a ser algo que se
// comprueba.
//
// Van en dos pasos porque Roblox no ofrece uno solo que resuelva placeId ->
// propietario sin autenticacion. El primero ademas sirve para otra cosa: es lo
// que permite comprobar que el placeId y el gameId que manda el juego se
// corresponden de verdad entre si.

// GET https://apis.roblox.com/universes/v1/places/{placeId}/universe
// -> { "universeId": 383310974 }
//
// OJO CON EL "NO EXISTE": comprobado en vivo, un placeId inventado NO devuelve
// 404 — devuelve 200 con { "universeId": null }. Si eso no se tratara aqui,
// aguas abajo llegaria un `null` disfrazado de exito y acabaria comparandose
// contra el grupo de la licencia.
async function getUniverseIdForPlace(placeId) {
    const response = await rateLimiter.run('placeUniverse', () => http_.get(
        `https://apis.roblox.com/universes/v1/places/${placeId}/universe`
    ), { notFoundCode: 'place_not_found' });

    const universeId = response.data?.universeId;
    if (universeId === null || universeId === undefined) {
        throw new NotFoundError('place_not_found', 'Roblox no reconoce ese placeId');
    }

    // A texto, como todo id de Roblox en este servicio: por encima de 2^53
    // JavaScript deja de representarlos con exactitud, y una comparacion de
    // propiedad que pierda precision es peor que no hacerla.
    return String(universeId);
}

// GET https://develop.roblox.com/v1/universes/{universeId}
// -> { id, name, rootPlaceId, isActive, privacyType,
//      creatorType: "Group"|"User", creatorTargetId, creatorName }
//
// ESTA es la fuente de verdad de la autorizacion: lo que Roblox dice sobre
// quien es dueño del universo, no lo que dice el script del cliente.
//
// ═══ POR QUE NO games.roblox.com/v1/games?universeIds= ═══
//
// Porque MIENTE POR OMISION, y de la peor forma posible: con un 200.
//
// Ese endpoint solo revela los detalles de una experiencia si el gateway
// publico considera que puede enseñarlos. Cuando no —experiencia privada, sin
// publicar, o publicada pero con el cuestionario de madurez de contenido
// pendiente— NO responde 404 ni 403. Responde 200 con una ficha censurada
// que tiene la forma de una respuesta buena:
//
//     { "id": 0, "rootPlaceId": 0, "name": "[TITLE UNAVAILABLE]",
//       "creator": { "id": 0, "name": "[UNKNOWN]", "type": "Group" },
//       "isContentRestricted": true }
//
// Los ids llegan a CERO. El codigo anterior hacia `if (!juego?.id) throw
// NotFoundError`, y como 0 es falsy, traducia "Roblox no me lo quiere contar"
// por "esa experiencia no existe" -> juego_desconocido -> 403 definitivo
// contra un cliente cuyo juego existe y es suyo. Se detecto con la primera
// experiencia real: placeId 125691607069384, universo 10751677333, del grupo
// 144910779, denegado durante horas.
//
// Y no valia con quitar aquel `if`: con creator.id = 0 la cadena seguia
// adelante y moria en `juego_no_coincide` ("0" !== el grupo de la licencia).
// Otro 403 definitivo, solo que con otro nombre. El endpoint entero no sirve
// para decidir propiedad.
//
// develop.roblox.com/v1/universes/{id} devuelve el propietario REAL tanto de
// experiencias publicas como privadas, sin credenciales de ningun tipo — ni
// cookie, ni Open Cloud, ni OAuth (comprobado en vivo con las dos clases). Se
// mantiene asi la propiedad de este cliente: no existe ninguna credencial de
// Roblox en este servicio que pueda filtrarse, porque no hay ninguna.
//
// ═══ COMO DICE ESTA RUTA "no existe" ═══
//
// Con un 400, no con un 404 (comprobado en vivo):
//     {"errors":[{"code":1,"field":"universeId",
//                 "message":"The universe does not exist."}]}
//
// De ahi el `notFoundWhen`: sin el, un universo inexistente saldria de 502.
// El predicado es DELIBERADAMENTE estrecho —exige el 400, el code 1 y el
// field— porque errar hacia "no lo se" (503, se reintenta) es inofensivo y
// errar hacia "no existe" (403, definitivo) echa a un cliente legitimo.
const UNIVERSO_INEXISTENTE = (status, data) =>
    status === 400 &&
    Array.isArray(data?.errors) &&
    data.errors.some(e => e?.code === 1 && e?.field === 'universeId');

async function getUniverseOwner(universeId) {
    const response = await rateLimiter.run('universeInfo', () => http_.get(
        `https://develop.roblox.com/v1/universes/${universeId}`
    ), { notFoundCode: 'universe_not_found', notFoundWhen: UNIVERSO_INEXISTENTE });

    const universo = response.data;
    const creatorId = universo?.creatorTargetId;

    // 200 CON UN CUERPO QUE NO SIRVE PARA DECIDIR. Esto es UpstreamError y
    // jamas NotFoundError, y es la leccion entera del fallo que arreglo este
    // codigo: "Roblox contesto algo que no puedo usar" no es "esto no existe".
    // Sube como 502/503 —reintentable— en vez de convertirse en una denegacion
    // definitiva. El `<= 0` cubre exactamente la ficha censurada, por si algun
    // dia esta ruta tambien la sirviera.
    if (universo?.id == null || universo.creatorType == null || creatorId == null || Number(creatorId) <= 0) {
        throw new UpstreamError(
            'develop/universes respondio 200 sin un propietario utilizable',
            new Error(`universeId=${universeId} creatorType=${universo?.creatorType ?? 'ausente'} creatorTargetId=${creatorId ?? 'ausente'}`)
        );
    }

    return {
        universeId: String(universo.id),
        // El place RAIZ del universo. NO se usa para autorizar: un universo
        // tiene varios places y el juego puede llamar desde cualquiera de
        // ellos, asi que exigir placeId === rootPlaceId cerraria la puerta a
        // usos legitimos. Va al log, donde si ayuda a entender una reclamacion.
        rootPlaceId: universo.rootPlaceId != null ? String(universo.rootPlaceId) : null,
        name: universo.name ?? null,
        creatorType: universo.creatorType,          // 'Group' | 'User'
        creatorId: String(creatorId),
        creatorName: universo.creatorName ?? null,
        // Informativo: distingue en el log un juego sin publicar de uno vivo.
        privacyType: universo.privacyType ?? null,
    };
}

// ── 7. miembros de un grupo (comunidad) ──────────────────────────────────────

// GET https://groups.roblox.com/v1/groups/{groupId}/users?limit=100&cursor=&sortOrder=
//
// PUBLICO y sin credenciales, como todo lo demas de este modulo. Es la unica
// via oficial para enumerar una comunidad, y pagina POR CURSOR — no admite
// offset ni salto a una pagina N. Eso condiciona el muestreo aguas arriba:
// para variar la muestra hay que jugar con `sortOrder` y barajar lo que se
// trae, porque "dame 100 miembros al azar" no existe en la API (ver
// services/pluginSearchService.js).
//
// El maximo real de `limit` es 100; valores mayores los rechaza con 400.
//
// Cada elemento llega como { user: {userId, username, displayName,
// hasVerifiedBadge}, role: {...} }. Se aplana a lo unico que necesita la
// busqueda — id y nombre — y se descarta el resto: el rol no interesa y
// arrastrarlo solo engordaria la cache.
async function listGroupMembers(groupId, { limit = 100, cursor = null, sortOrder = 'Asc' } = {}) {
    const params = { limit, sortOrder };
    if (cursor) params.cursor = cursor;

    const response = await rateLimiter.run('groupMembers', () => http_.get(
        `https://groups.roblox.com/v1/groups/${groupId}/users`,
        { params }
    ), { notFoundCode: 'group_not_found' });

    const data = Array.isArray(response.data?.data) ? response.data.data : [];
    const next = response.data?.nextPageCursor;

    return {
        members: data
            .map(entry => ({
                userId: entry?.user?.userId ?? null,
                username: entry?.user?.username ?? null,
            }))
            // Un miembro sin id no sirve para nada aguas abajo, y colarlo
            // obligaria a cada consumidor a volver a comprobarlo.
            .filter(m => m.userId != null),
        // Roblox cierra el recorrido con null (a diferencia del listado de
        // outfits, que manda cadena vacia). Se normaliza a null cualquiera de
        // las dos formas para que quien pagine solo tenga que mirar una.
        nextCursor: typeof next === 'string' && next.length > 0 ? next : null,
    };
}

// ── 8. avatar ACTUAL de un usuario ───────────────────────────────────────────

// GET https://avatar.roblox.com/v1/users/{userId}/avatar
//
// Lo que el jugador lleva puesto AHORA MISMO, que no es lo mismo que un outfit
// guardado suyo (eso es el endpoint 2/3). Para la busqueda del plugin es
// justo lo que hace falta: un avatar real, montado por una persona.
//
// Devuelve la misma forma que los detalles de un outfit — scales, bodyColors,
// playerAvatarType y `assets`, cada uno { id, name, assetType{id,name} } — asi
// que reconstruirlo mas adelante como HumanoidDescription no necesitara un
// normalizador nuevo. Aqui solo se aplanan los assets, que es lo unico que se
// usa hoy para poner precio al conjunto.
//
// Un usuario baneado o inexistente responde 404 y sale por NotFoundError, que
// es lo que permite descartarlo y seguir con el siguiente candidato.
async function getCurrentAvatar(userId) {
    const response = await rateLimiter.run('userAvatar', () => http_.get(
        `https://avatar.roblox.com/v1/users/${userId}/avatar`
    ), { notFoundCode: 'user_not_found' });

    const assets = Array.isArray(response.data?.assets) ? response.data.assets : [];

    return {
        assets: assets
            .map(asset => ({
                id: asset?.id ?? null,
                name: asset?.name ?? null,
                assetTypeId: asset?.assetType?.id ?? null,
                assetTypeName: asset?.assetType?.name ?? null,
            }))
            .filter(asset => asset.id != null),
        playerAvatarType: response.data?.playerAvatarType ?? null,
    };
}

module.exports = {
    lookupUserByUsername,
    listGroupMembers,
    getCurrentAvatar,
    listOutfits,
    getOutfitDetailsRaw,
    getBundlesForAsset,
    getCatalogDetails,
    getCatalogItemDetails,
    getBundleDetails,
    getUniverseIdForPlace,
    getUniverseOwner,
    normalizeOutfitList, // puro; exportado para los tests
    // puro; exportado para los tests. Es el que decide si un 4xx de Roblox es
    // "no existe" (definitivo) o "algo va mal" (reintentable), asi que merece
    // pruebas propias en vez de solo ejercitarse de refilon.
    esUniversoInexistente: UNIVERSO_INEXISTENTE,
    catalogKey,          // puro; la clave "Asset:123" / "Bundle:192"
};
