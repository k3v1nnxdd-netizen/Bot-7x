'use strict';

const axios = require('axios');

// The bot's ONLY door to the license system. Every /addgroup, /deletegroup,
// /checkgroup and /groups call goes through here, and here it stops: this bot
// never opens a Postgres connection, never sees DATABASE_URL and never learns
// the shape of the group_whitelist table. outfit-api owns the data and is the
// single place where "who is authorized" is decided — see
// outfit-api/src/api/routes/adminGroups.js.
//
// THE ADMIN KEY IS THE WHOLE POINT OF THIS FILE BEING A FILE. It is read once
// here, put in one header, and never touched again anywhere else in the bot.
// That matters more than it looks, because of one specific trap: an axios
// error carries `err.config.headers` — the request headers, admin key
// INCLUDED — so a plain `console.error(err)` in a catch block anywhere up the
// stack would print the secret into the Railway logs. Nothing outside this
// module ever gets to hold a raw axios error: every failure is converted to an
// OutfitApiError carrying a code and a message safe to show a human, and the
// original is dropped on the floor. Same reason the base URL never appears in
// a user-facing message: internal hostnames aren't for the server to read.

const TIMEOUT_MS = 8000;

// Bounded so a runaway loop can't hammer the API: 4 pages x 500 = 2000
// licenses, orders of magnitude above anything this is for.
const LIST_PAGE_SIZE = 500;
const LIST_MAX_PAGES = 4;

class OutfitApiError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'OutfitApiError';
        this.code = code;
    }
}

// Accepts whatever ends up pasted into the Railway variable: with or without
// scheme, with or without a trailing slash, and even the full
// `https://host/admin/groups` endpoint (an easy mistake — that's the URL you'd
// have in your terminal history from testing with curl). All four normalize to
// the same origin, because a bot that works only if an env var was typed in
// one exact shape is a bot that breaks on a Friday.
function normalizeBaseUrl(raw) {
    if (typeof raw !== 'string') return null;
    let url = raw.trim();
    if (url === '') return null;

    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    url = url.replace(/\/+$/, '');
    url = url.replace(/\/admin\/groups\/?$/i, '');
    return url.replace(/\/+$/, '') || null;
}

const BASE_URL = normalizeBaseUrl(process.env.OUTFIT_API_URL);
const ADMIN_KEY = process.env.OUTFIT_ADMIN_API_KEY || null;

const http = axios.create({
    timeout: TIMEOUT_MS,
    // The API answers every error with {error:{code,message}} and a real
    // status; letting axios throw on 4xx/5xx is what routes all of them
    // through toSafeError() in one place.
    validateStatus: status => status >= 200 && status < 300,
});

function isConfigured() {
    return Boolean(BASE_URL && ADMIN_KEY);
}

// Error codes from outfit-api whose message was written by us, contains no
// user input beyond a group id, and is genuinely the most useful thing to show
// the administrator. Anything NOT in this list gets a message written here
// instead — an unrecognised error is exactly when an upstream message is most
// likely to leak something (a stack, a hostname, a pg detail).
const MENSAJES_SEGUROS = new Set(['invalid_request', 'group_not_found', 'confirmation_mismatch']);

// The one and only place an axios error is allowed to be inspected. Returns an
// OutfitApiError; never rethrows the original, never logs it.
function toSafeError(err) {
    if (err instanceof OutfitApiError) return err;

    const status = err?.response?.status ?? null;
    const apiCode = err?.response?.data?.error?.code ?? null;
    const apiMessage = err?.response?.data?.error?.message ?? null;

    // No response at all: DNS, refused connection, timeout, TLS. The bot is
    // fine, the API is not reachable from here.
    if (status === null) {
        const transporte = err?.code;
        if (transporte === 'ECONNABORTED' || transporte === 'ETIMEDOUT') {
            return new OutfitApiError(
                'timeout',
                `La API de licencias no respondió en ${TIMEOUT_MS / 1000}s. Vuelve a intentarlo en unos segundos.`
            );
        }
        return new OutfitApiError(
            'unreachable',
            'No se pudo contactar con la API de licencias. Comprueba que el servicio esté levantado.'
        );
    }

    if (status === 401) {
        return new OutfitApiError(
            'unauthorized',
            'La API de licencias rechazó la clave de administración. Revisa la variable OUTFIT_ADMIN_API_KEY del bot.'
        );
    }
    if (apiCode === 'admin_disabled') {
        return new OutfitApiError(
            'admin_disabled',
            'La administración de licencias está desactivada en la API: le falta configurar su ADMIN_API_KEY.'
        );
    }
    if (apiCode === 'database_unavailable') {
        return new OutfitApiError(
            'database_unavailable',
            'La base de datos de licencias no está disponible ahora mismo. Inténtalo de nuevo en unos segundos.'
        );
    }
    if (apiCode === 'rate_limited') {
        return new OutfitApiError('rate_limited', 'La API de licencias está limitando las peticiones. Espera un momento.');
    }
    if (apiCode === 'route_not_found') {
        return new OutfitApiError(
            'route_not_found',
            'La API respondió que esa ruta no existe. Revisa la variable OUTFIT_API_URL del bot.'
        );
    }
    if (apiCode && MENSAJES_SEGUROS.has(apiCode) && typeof apiMessage === 'string') {
        return new OutfitApiError(apiCode, apiMessage);
    }

    return new OutfitApiError(
        apiCode || 'api_error',
        `La API de licencias respondió con un error (${status}).`
    );
}

// Every request funnels through here so the header, the timeout, the "is this
// even configured" check and the error conversion exist exactly once.
async function pedir(method, path, { params, data } = {}) {
    if (!isConfigured()) {
        throw new OutfitApiError(
            'not_configured',
            'El sistema de licencias no está configurado en el bot (faltan OUTFIT_API_URL u OUTFIT_ADMIN_API_KEY).'
        );
    }

    try {
        const res = await http.request({
            method,
            url: `${BASE_URL}${path}`,
            params,
            data,
            // Only ever in a header, never in the query string or the body:
            // a secret in a URL ends up in the access log of every proxy in
            // between. Same rule the API itself follows.
            headers: { 'x-admin-key': ADMIN_KEY, 'Content-Type': 'application/json' },
        });
        return res.data;
    } catch (err) {
        const seguro = toSafeError(err);
        // The status and OUR error code are worth logging; the axios error is
        // not, and never will be — see this file's header.
        console.error('[outfitApi] fallo llamando a la API de licencias:', {
            method,
            path,
            code: seguro.code,
            status: err?.response?.status ?? null,
        });
        throw seguro;
    }
}

// Registers (or re-activates) a license. Idempotent on the API side: calling
// it twice leaves the same state, and the response's `created` flag is what
// tells a brand new license apart from a reactivation.
function addGroup({ groupId, discordUserId, robloxUsername, groupName, addedBy }) {
    return pedir('post', '/admin/groups', {
        data: { groupId, discordUserId, robloxUsername, groupName, addedBy },
    });
}

// Never 404s for an unknown group: answers {found, authorized} so the caller
// can tell "never had a license" from "had one and lost it".
function getGroup(groupId) {
    return pedir('get', `/admin/groups/${encodeURIComponent(groupId)}`);
}

// Rotates the license credential: a brand new token, the old one dead on the
// spot. The two fields in the body do NOT modify the license — they are an
// identity confirmation and must match what's already linked, or the API
// refuses (409 confirmation_mismatch) without touching the row.
//
// The response carries the new token in the clear ONE time. It is never logged
// here (see `pedir`, which logs only method/path/code/status).
function regenerateToken(groupId, { discordUserId, robloxUsername }) {
    return pedir('post', `/admin/groups/${encodeURIComponent(groupId)}/token`, {
        data: { discordUserId, robloxUsername },
    });
}

// Deactivates without deleting: the row (and its original date) survives, so
// the license can still be accounted for months later.
function removeGroup(groupId, { reason = null, actorId = null } = {}) {
    const params = {};
    if (reason) params.reason = reason;
    if (actorId) params.actor = actorId;
    return pedir('delete', `/admin/groups/${encodeURIComponent(groupId)}`, { params });
}

function listGroups({ includeInactive = true, limit = LIST_PAGE_SIZE, offset = 0 } = {}) {
    return pedir('get', '/admin/groups', {
        params: { includeInactive: includeInactive ? '1' : '0', limit, offset },
    });
}

// Walks the API's pagination so /groups can show real totals instead of "the
// first 500". Stops on hasMore=false or at LIST_MAX_PAGES, and reports
// `truncated` rather than silently pretending it got everything.
async function listAllGroups({ includeInactive = true } = {}) {
    const groups = [];
    let total = 0;
    let offset = 0;
    let truncated = false;

    for (let page = 0; page < LIST_MAX_PAGES; page++) {
        const respuesta = await listGroups({ includeInactive, limit: LIST_PAGE_SIZE, offset });
        groups.push(...(respuesta.groups ?? []));
        total = respuesta.total ?? groups.length;

        if (!respuesta.hasMore) return { groups, total, truncated: false };
        offset += respuesta.count ?? LIST_PAGE_SIZE;
        truncated = true; // stays true only if the loop runs out of pages
    }

    return { groups, total, truncated };
}

module.exports = {
    OutfitApiError,
    isConfigured,
    addGroup,
    getGroup,
    removeGroup,
    regenerateToken,
    listGroups,
    listAllGroups,
    // Exported for the tests: both are pure and cover the two things that
    // must never regress — a mistyped URL still works, and no failure path
    // can carry the admin key or the internal host into a message.
    __test: { normalizeBaseUrl, toSafeError, TIMEOUT_MS },
};
