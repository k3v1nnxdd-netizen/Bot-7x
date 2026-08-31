'use strict';

const roblox = require('../src/roblox/client');
const cache = require('../src/cache/memoryCache');
const { daysSince } = require('./groupTracker');
const config = require('../config');

// ── Antigüedad REAL de un usuario dentro de una comunidad de Roblox ──────────
//
// Todo el "¿cuántos días lleva este usuario en esta comunidad?" de Check
// Group's vive aquí. handlers/checkGroupFlow.js solo pinta el resultado en
// Discord; este módulo es el que sabe hablar con Roblox.
//
// La fuente del dato es `createTime` de la membresía en Open Cloud (ver
// getGroupMembership en src/roblox/client.js): la fecha exacta en la que se
// creó la membresía, dicha por Roblox. NO se estima por orden de miembros, no
// se recorre la lista de la comunidad y no se guarda una fecha propia — si el
// usuario se sale y vuelve a entrar, Roblox devuelve la fecha de la membresía
// NUEVA, que es justamente la que cuenta para un payout.

class GroupCheckError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'GroupCheckError';
        this.code = code;
    }
}

// ── Caché (evitar peticiones innecesarias a Roblox) ──────────────────────────
// Tres TTL distintos, y la diferencia entre ellos es deliberada:
//
//   IDENTIDAD (username -> userId): 10 min. Un username de Roblox no cambia de
//   dueño mientras alguien pulsa un botón dos veces seguidas.
//
//   MEMBRESÍA ENCONTRADA: 5 min. `createTime` es inmutable mientras la
//   membresía exista, así que volver a pedirlo cada pocos segundos solo gasta
//   cuota. Los días se recalculan igualmente en cada consulta a partir de la
//   fecha cacheada, así que un resultado cacheado nunca se queda con un número
//   de días viejo.
//
//   MEMBRESÍA NO ENCONTRADA: 60 s, mucho más corto a propósito. Es el caso en
//   el que el usuario se va a Roblox, se une a la comunidad y vuelve a pulsar
//   el botón enseguida; cachear ese "no" durante cinco minutos haría que el bot
//   siguiera diciéndole que no pertenece cuando ya sí pertenece. 60 s corta el
//   spam sin llegar a confundir a nadie.
const USER_TTL_MS       = 10 * 60_000;
const MEMBER_TTL_MS     = 5 * 60_000;
const NOT_MEMBER_TTL_MS = 60_000;

// ── Caché de imágenes ────────────────────────────────────────────────────────
// Las dos imágenes de la tarjeta (avatar del jugador e icono de la comunidad)
// salen de thumbnails.roblox.com, que es un servicio con su propio límite y al
// que no hay ninguna razón para volver a preguntar lo mismo cada vez que
// alguien pulsa un botón.
//
// El icono de una comunidad no cambia prácticamente nunca y sólo hay tres
// comunidades, así que 12 h significa ~3 peticiones al día en total. El avatar
// de un jugador sí cambia cuando se cambia de ropa, así que 1 h: lo bastante
// largo para que comprobar los tres grupos seguidos cueste UNA sola petición, y
// lo bastante corto para no enseñar un avatar de ayer.
//
// El "no hay imagen" también se cachea (si no, un icono que Roblox aún no ha
// renderizado se reintentaría en cada solicitud), pero mucho menos tiempo: es
// un estado transitorio que se espera que se resuelva solo.
const AVATAR_TTL_MS       = 60 * 60_000;
const AVATAR_MISSING_TTL  = 5 * 60_000;
const ICON_TTL_MS         = 12 * 60 * 60_000;
const ICON_MISSING_TTL_MS = 30 * 60_000;

// Roblox: 3-20 caracteres, letras/números/guion bajo. Validarlo aquí evita una
// llamada garantizada a fallar cada vez que alguien pega un link, un @ o su
// nombre de Discord en el modal.
const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

function isValidUsername(username) {
    return USERNAME_PATTERN.test(username);
}

// La comunidad detrás de un botón del panel, ya resuelta contra config.
// Devuelve null si la clave no existe (customId manipulado).
function getGroup(groupKey) {
    const group = config.CHECK_GROUPS[groupKey];
    if (!group) return null;
    return { key: groupKey, label: group.label, groupId: group.groupId };
}

async function resolveRobloxUser(username) {
    const key = `cg:user:${username.toLowerCase()}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    let user;
    try {
        user = await roblox.getUserByUsername(username);
    } catch (err) {
        if (err?.message === 'not_found') {
            throw new GroupCheckError('user_not_found', `No existe ninguna cuenta de Roblox llamada "${username}".`);
        }
        console.error('[groupMembership] Búsqueda de username falló:', err?.message ?? err);
        throw new GroupCheckError('roblox_unavailable', 'Roblox no respondió a la búsqueda del usuario.');
    }

    // displayName viene en la MISMA respuesta que el id (users.roblox.com
    // /v1/usernames/users lo devuelve junto al name), así que enseñarlo en la
    // tarjeta no cuesta ninguna petición extra.
    const value = {
        id: user.id,
        name: user.name ?? username,
        displayName: user.displayName ?? user.name ?? username,
    };
    cache.set(key, value, USER_TTL_MS);
    return value;
}

// ── Imágenes (nunca lanzan) ──────────────────────────────────────────────────
// Contrato deliberado: una imagen es decoración. Si Roblox no la da, devuelven
// null y la solicitud se publica igual. Una comprobación de elegibilidad no
// puede fallar porque una foto no estuviera lista.
async function cachedImage(key, fetchFn, { ttlMs, missingTtlMs, label }) {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    let url = null;
    try {
        url = await fetchFn();
    } catch (err) {
        console.warn(`[groupMembership] No se pudo obtener ${label}: ${err?.message ?? err}`);
        url = null;
    }

    cache.set(key, url, url ? ttlMs : missingTtlMs);
    return url;
}

// Avatar (headshot) actual del jugador, desde thumbnails.roblox.com.
function getPlayerAvatar(userId) {
    return cachedImage(
        `cg:avatar:${userId}`,
        () => roblox.getHeadshot(userId),
        { ttlMs: AVATAR_TTL_MS, missingTtlMs: AVATAR_MISSING_TTL, label: `el avatar de ${userId}` }
    );
}

// Icono ACTUAL de la comunidad, pedido a Roblox — no la imagen local del repo.
// getGroupIcon ya devuelve null cuando Roblox aún no ha terminado de renderizar
// el icono (estado "Pending"/"Blocked"), así que aquí no hay que distinguirlo.
function getCommunityIcon(groupId) {
    return cachedImage(
        `cg:icon:${groupId}`,
        () => roblox.getGroupIcon(groupId),
        { ttlMs: ICON_TTL_MS, missingTtlMs: ICON_MISSING_TTL_MS, label: `el icono del grupo ${groupId}` }
    );
}

// Devuelve { createTime, role, user } o null (no es miembro).
async function resolveMembership(groupId, userId) {
    const key = `cg:membership:${groupId}:${userId}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    let membership;
    try {
        membership = await roblox.getGroupMembership(groupId, userId);
    } catch (err) {
        // `err` ya viene saneado por client.js (OpenCloudError con `code`):
        // nunca es el error crudo de axios, así que no puede arrastrar la API
        // key en err.config.headers hacia estos logs.
        const code = err?.code ?? 'network';
        console.error(`[groupMembership] Open Cloud falló (grupo ${groupId}, user ${userId}): ${code} — ${err?.message ?? 'sin detalle'}`);

        if (code === 'not_configured')  throw new GroupCheckError('open_cloud_not_configured', 'El sistema de verificación no está configurado.');
        if (code === 'unauthorized')    throw new GroupCheckError('open_cloud_unauthorized', 'La API key de Open Cloud no tiene acceso a esta comunidad.');
        if (code === 'group_not_found') throw new GroupCheckError('group_not_found', 'Roblox no encuentra esta comunidad.');
        if (code === 'rate_limited')    throw new GroupCheckError('rate_limited', 'Roblox está limitando las consultas ahora mismo.');
        throw new GroupCheckError('roblox_unavailable', 'Roblox no respondió a la consulta de membresía.');
    }

    cache.set(key, membership, membership ? MEMBER_TTL_MS : NOT_MEMBER_TTL_MS);
    return membership;
}

// ── La consulta completa ─────────────────────────────────────────────────────
// username -> userId -> membresía -> días -> elegible.
//
// Devuelve SIEMPRE un objeto describiendo lo que Roblox contestó, o lanza un
// GroupCheckError si no se pudo averiguar. Nunca devuelve "no elegible" para
// decir "no lo pude comprobar": eso es un error, y quien llama tiene que poder
// distinguirlo — un fallo de la API no es un veredicto sobre el usuario.
async function checkMembership(groupKey, username) {
    const group = getGroup(groupKey);
    if (!group) {
        throw new GroupCheckError('unknown_group', 'Esa comunidad no existe en la configuración del bot.');
    }
    if (!group.groupId) {
        console.warn(`[groupMembership] El grupo "${groupKey}" no tiene groupId en config.CHECK_GROUPS.`);
        throw new GroupCheckError('group_not_configured', `La comunidad **${group.label}** todavía no tiene configurado su ID de Roblox.`);
    }
    if (!isValidUsername(username)) {
        throw new GroupCheckError('invalid_username', 'Un usuario de Roblox son 3-20 caracteres: letras, números y guion bajo.');
    }

    const user = await resolveRobloxUser(username);
    const membership = await resolveMembership(group.groupId, user.id);

    const base = {
        groupKey: group.key,
        groupLabel: group.label,
        groupId: group.groupId,
        robloxUserId: user.id,
        robloxUsername: user.name,
        robloxDisplayName: user.displayName,
    };

    if (!membership) {
        return { ...base, isMember: false, joinedAt: null, days: null, eligible: false };
    }

    const joinedAt = membership.createTime ? new Date(membership.createTime) : null;
    if (!joinedAt || Number.isNaN(joinedAt.getTime())) {
        // Roblox contestó que sí es miembro, pero sin una fecha usable. Eso es
        // "no se pudo comprobar", no "no elegible" — ver el contrato de arriba.
        console.error(`[groupMembership] createTime inválido (grupo ${group.groupId}, user ${user.id}):`, membership.createTime);
        throw new GroupCheckError('invalid_create_time', 'Roblox devolvió una fecha de ingreso que no se pudo leer.');
    }

    const days = daysSince(joinedAt);
    return {
        ...base,
        isMember: true,
        joinedAt,
        days,
        eligible: days >= config.MIN_GROUP_DAYS,
    };
}

module.exports = {
    checkMembership,
    getGroup,
    getPlayerAvatar,
    getCommunityIcon,
    isValidUsername,
    GroupCheckError,
};
