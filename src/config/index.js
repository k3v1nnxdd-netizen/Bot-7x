'use strict';

const path = require('path');

// Single source of truth for this API's environment configuration — reads
// process.env ONCE here rather than scattered across every module (server
// startup, auth middleware, the persistent store, ...), so the full set of
// knobs this service depends on is visible in one place instead of grepping
// for `process.env` across a dozen files.
const port = Number(process.env.PORT) || 3000;
const apiKey = process.env.API_KEY || null;

// Railway: a Volume mounted at /app/storage (STORAGE_DIR=/app/storage) is
// what turns "survives a process restart" into "survives a full redeploy"
// too. Falls back to a local ./storage next to the project root when unset
// (e.g. local dev) — still correctly durable across a plain process
// restart, just not a full container rebuild.
const storageDir = process.env.STORAGE_DIR || path.join(__dirname, '..', '..', 'storage');

// Protects THIS API from being spammed by its own callers (a misbehaving
// integration on the game side, a retry loop with no backoff, etc.) —
// independent from and in addition to the Roblox-side rate limiting/circuit
// breaking in src/roblox/rateLimiter.js, which protects Roblox's APIs
// specifically. See src/security/requestRateLimit.js.
const ownApiRateLimit = {
    windowMs: Number(process.env.OWN_API_RATE_LIMIT_WINDOW_MS) || 60_000,
    maxRequestsPerWindow: Number(process.env.OWN_API_RATE_LIMIT_MAX) || 120,
};

if (!apiKey) {
    console.error(
        '[config] ERROR: falta configurar la variable de entorno API_KEY. ' +
        'Las rutas /avatar, /battle y /metrics rechazarán todas las peticiones (401) hasta que la definas.'
    );
}

module.exports = { port, apiKey, storageDir, ownApiRateLimit };
