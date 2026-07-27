'use strict';

// Protects the Roblox-facing routes (/avatar, /battle) with a shared secret.
// Roblox's HttpService must send it back on every request via the
// `x-api-key` header — anything missing or mismatched is rejected here,
// before it ever reaches the route handler or touches Roblox/the cache.
//
// If process.env.API_KEY itself isn't set, `providedKey !== process.env.API_KEY`
// is still true for any real header value (undefined !== a string), so this
// fails closed (rejects everyone) rather than open — the louder, more
// visible warning about the missing var lives in server.js at startup.
function requireApiKey(req, res, next) {
    const providedKey = req.headers['x-api-key'];

    if (!providedKey || providedKey !== process.env.API_KEY) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    next();
}

module.exports = { requireApiKey };
