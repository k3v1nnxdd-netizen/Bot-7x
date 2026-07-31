'use strict';

// Permanently retires a legacy HTTP entry point: responds 410 Gone
// IMMEDIATELY — before any param parsing, any service call, any Roblox
// call. This is the hard guarantee behind retiring GET /avatar/:userId and
// GET /battle/:user1/:user2: even a flood of requests against a disabled
// route must produce ZERO calls to avatar.roblox.com, because the handler
// never reaches code that could make one.
//
// Confirmed via the temporary [reqlog] diagnostic logging (see
// src/observability/requestLogger.js) that public Roblox servers were
// still calling both of these, each one triggering a real avatar.roblox.com
// worn-items check — exactly the load POST /battle (routes/battle.js) was
// built to eliminate. POST /battle is entirely untouched by this: this
// handler is only ever wired to the two OLD GET routes.
function makeLegacyGoneHandler(replacement) {
    return function legacyGone(req, res) {
        const ip = req.ip || req.socket?.remoteAddress || 'unknown';
        console.warn(`[LEGACY BLOCKED] method=${req.method} path=${req.originalUrl} ip=${ip}`);
        res.status(410).json({
            error: 'Este endpoint fue descontinuado y ya no consulta Roblox.',
            replacement,
        });
    };
}

module.exports = { makeLegacyGoneHandler };
