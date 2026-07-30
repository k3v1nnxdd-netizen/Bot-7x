'use strict';

const config = require('../config');

// Protects the Roblox-facing routes (/avatar, /battle, /metrics) with a
// shared secret. The game's HttpService must send it back on every request
// via the `x-api-key` header — anything missing or mismatched is rejected
// here, before it ever reaches the route handler or touches Roblox/the
// cache.
//
// If config.apiKey itself isn't set, `providedKey !== config.apiKey` is
// still true for any real header value (undefined !== a string), so this
// fails closed (rejects everyone) rather than open — the louder, more
// visible warning about the missing var is logged once at startup, by
// src/config/index.js itself.
function requireApiKey(req, res, next) {
    const providedKey = req.headers['x-api-key'];

    if (!providedKey || providedKey !== config.apiKey) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    next();
}

module.exports = { requireApiKey };
