'use strict';

const axios = require('axios');
const http = require('http');
const https = require('https');
const config = require('../config');
const rateLimiter = require('./rateLimiter');
const { NotFoundError } = require('./errors');

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

function postCatalogDetails(assetIds) {
    const body = { items: assetIds.map(id => ({ itemType: 'Asset', id })) };
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
async function getCatalogDetails(assetIds) {
    const details = new Map();
    if (assetIds.length === 0) return details;

    const response = await rateLimiter.run('catalogDetails', () => postCatalogDetails(assetIds));

    for (const item of (response.data?.data ?? [])) {
        const restrictions = Array.isArray(item.itemRestrictions) ? item.itemRestrictions : [];
        details.set(item.id, {
            available: true,
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
            creatorType: item.creatorType ?? null,
            creatorTargetId: item.creatorTargetId ?? null,
            creatorName: item.creatorName ?? null,
        });
    }

    return details;
}

module.exports = {
    lookupUserByUsername,
    listOutfits,
    getOutfitDetailsRaw,
    getBundlesForAsset,
    getCatalogDetails,
    normalizeOutfitList, // puro; exportado para los tests
};
