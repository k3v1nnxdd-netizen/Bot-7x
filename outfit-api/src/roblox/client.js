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
// SUPERFICIE COMPLETA — solo endpoints publicos y documentados de Roblox,
// exactamente tres, ninguno mas:
//   1. POST users.roblox.com/v1/usernames/users            username -> userId
//   2. GET  avatar.roblox.com/v2/avatar/users/{id}/outfits  listado paginado
//   3. GET  avatar.roblox.com/v3/outfits/{id}/details       contenido del outfit
//
// SIN CREDENCIALES DE ROBLOX, POR DISEÑO. Ni cookies, ni .ROBLOSECURITY, ni
// cabeceras de autenticacion, ni tokens CSRF: los tres endpoints sirven datos
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
// Parametros: page (1-based), itemsPerPage.
// Respuesta: { filteredCount, data: [{ id, name, isEditable }] }
//
// Se devuelve solo { id, name } por outfit: `isEditable` describe permisos de
// edicion del dueño, no sirve de nada a un juego que solo quiere mostrar y
// aplicar outfits, y multiplicaria el tamaño de una lista de 50.
async function listOutfits(userId, { page, limit }) {
    const response = await rateLimiter.run('outfitList', () => http_.get(
        `https://avatar.roblox.com/v2/avatar/users/${userId}/outfits`,
        { params: { page, itemsPerPage: limit } }
    ), { notFoundCode: 'user_not_found' });

    const data = Array.isArray(response.data?.data) ? response.data.data : [];
    const filteredCount = Number(response.data?.filteredCount);

    return {
        outfits: data.map(outfit => ({ id: outfit.id, name: outfit.name })),
        // `hasMore` se calcula aqui, donde todavia se ve la respuesta cruda.
        // Roblox no siempre manda filteredCount: si falta, se deduce de si la
        // pagina vino llena, que es la señal que queda disponible.
        hasMore: Number.isFinite(filteredCount)
            ? page * limit < filteredCount
            : data.length === limit,
    };
}

// ── 3. detalles de un outfit ─────────────────────────────────────────────────

// Roblox ha ido cambiando como expone los colores del cuerpo: las respuestas
// modernas traen `bodyColor3s` (hex) y las antiguas `bodyColors` (ids de
// BrickColor). Se normalizan a un unico objeto con claves cortas mas un
// `bodyColorFormat` que dice como leerlo, para que el juego no tenga que
// adivinar el formato ni romperse el dia que Roblox retire uno de los dos.
function normalizeBodyColors(raw) {
    const hex = raw?.bodyColor3s;
    if (hex && typeof hex === 'object') {
        return {
            format: 'hex',
            colors: {
                head: hex.headColor3 ?? null,
                torso: hex.torsoColor3 ?? null,
                leftArm: hex.leftArmColor3 ?? null,
                rightArm: hex.rightArmColor3 ?? null,
                leftLeg: hex.leftLegColor3 ?? null,
                rightLeg: hex.rightLegColor3 ?? null,
            },
        };
    }

    const ids = raw?.bodyColors;
    if (ids && typeof ids === 'object') {
        return {
            format: 'brickColorId',
            colors: {
                head: ids.headColorId ?? null,
                torso: ids.torsoColorId ?? null,
                leftArm: ids.leftArmColorId ?? null,
                rightArm: ids.rightArmColorId ?? null,
                leftLeg: ids.leftLegColorId ?? null,
                rightLeg: ids.rightLegColorId ?? null,
            },
        };
    }

    return { format: null, colors: null };
}

// GET https://avatar.roblox.com/v3/outfits/{userOutfitId}/details
//
// De cada asset se devuelve { id, name, typeId } y no el objeto assetType
// completo: `typeId` es el enum estable de Roblox, disponible en Lua como
// Enum.AvatarAssetType, asi que mandar tambien su nombre seria duplicar en la
// respuesta algo que el cliente ya tiene. En un outfit de 30 piezas eso es
// aproximadamente la mitad del payload.
async function getOutfitDetails(outfitId) {
    const response = await rateLimiter.run('outfitDetails', () => http_.get(
        `https://avatar.roblox.com/v3/outfits/${outfitId}/details`
    ), { notFoundCode: 'outfit_not_found' });

    const raw = response.data ?? {};
    const assets = Array.isArray(raw.assets) ? raw.assets : [];
    const bodyColors = normalizeBodyColors(raw);

    return {
        id: raw.id ?? Number(outfitId),
        name: raw.name ?? null,
        outfitType: raw.outfitType ?? null,
        playerAvatarType: raw.playerAvatarType ?? null,
        assets: assets.map(asset => ({
            id: asset.id,
            name: asset.name,
            typeId: asset.assetType?.id ?? null,
        })),
        bodyColorFormat: bodyColors.format,
        bodyColors: bodyColors.colors,
        // Escalas del avatar: sin ellas el juego no puede reconstruir la
        // proporcion real con HumanoidDescription, solo la ropa.
        scale: raw.scale ?? null,
    };
}

module.exports = { lookupUserByUsername, listOutfits, getOutfitDetails };
