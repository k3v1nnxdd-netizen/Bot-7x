'use strict';

// TEMPORARY DIAGNOSTIC LOGGING — added to answer one specific question: is
// traffic hitting /avatar and /battle (and therefore avatar.roblox.com
// worn-items + catalog.roblox.com items/details) coming from real external
// Roblox game servers, or from something internal to this process?
//
// Already confirmed via static analysis: grepped the whole repo for every
// caller of avatarService/valuationService/battleService and every
// requirer of src/roblox/client.js — the ONLY code paths that can reach
// avatar.roblox.com (worn-items) or catalog.roblox.com/items/details are
// src/api/routes/avatar.js and src/api/routes/battle.js. Nothing in the
// Discord bot side (main.js's ClientReady, ticket rebuild, panel/calc/
// reglas/metodos/verif/roles/seguidores updates, voice connect) touches
// this pipeline at all — handlers/commands.js's /outfit command and
// handlers/modals.js only ever call getUserByUsername/getUserProfile/
// getFollowerCount/getFriendCount/getAvatarImage/getHeadshot/isUserInGroup,
// never getWornAssetIds or getAssetDetails. This module makes that
// conclusion directly OBSERVABLE in Railway's logs (real IP/User-Agent/
// userId/timestamps) instead of relying on that inference alone.
//
// Purely additive: touches no rate limiting, caching, retry, or valuation
// behavior. Every line is tagged [reqlog] for easy grep/filtering and easy
// removal once the question is answered. Can be disabled without a
// redeploy via the Railway env var DEBUG_REQUEST_LOGGING=0 (defaults to
// enabled, since it was requested on right now).
const ENABLED = process.env.DEBUG_REQUEST_LOGGING !== '0' && process.env.DEBUG_REQUEST_LOGGING !== 'false';

// Express middleware — logs every attempt to reach /avatar or /battle,
// INCLUDING ones our own requestRateLimit/requireApiKey middleware would
// reject, since "who's hitting this at all" (even unauthorized/rate-limited
// attempts) is part of the question. Mount this FIRST in the chain for a
// route (before requestRateLimit/requireApiKey) for that reason.
function requestLogger(req, res, next) {
    if (!ENABLED) return next();

    const startedAt = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || '(sin User-Agent)';
    const hasApiKey = Boolean(req.headers['x-api-key']);

    console.log(`[reqlog] IN  ${new Date(startedAt).toISOString()} ${req.method} ${req.originalUrl} ip=${ip} ua="${userAgent}" apiKey=${hasApiKey ? 'presente' : 'AUSENTE'}`);

    res.on('finish', () => {
        const durationMs = Date.now() - startedAt;
        console.log(`[reqlog] OUT ${new Date().toISOString()} ${req.method} ${req.originalUrl} status=${res.statusCode} durationMs=${durationMs}`);
    });

    next();
}

// Logs the specific userId(s)/asset-count context a route is about to act
// on — called explicitly from the route handlers (rather than generically
// inside requestLogger above) since "which userId" is shaped differently
// per route (URL param vs JSON body) and this avoids ever logging a full
// assetIds array (POST /battle's body could legitimately hold up to 200 of
// them across both players — a count is enough to be useful without being
// noisy).
function logRequestContext(label, details) {
    if (!ENABLED) return;
    console.log(`[reqlog] CTX ${new Date().toISOString()} ${label}`, details);
}

module.exports = { requestLogger, logRequestContext };
