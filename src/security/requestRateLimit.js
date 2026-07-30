'use strict';

const config = require('../config');

// Protects THIS API from being spammed by its own callers — a misconfigured
// integration stuck in a retry loop with no backoff, a leaked API key, or
// plain abuse. Independent from and in ADDITION to src/roblox/rateLimiter.js
// (which protects Roblox's APIs from US); this one protects US from
// whoever's calling /avatar, /battle, /metrics.
//
// Keyed by source IP rather than the API key: there's a single shared
// API_KEY for the whole integration (the game's HttpService), so keying by
// key alone would treat every caller as one bucket and couldn't isolate a
// single misbehaving source. Default threshold (120 req/60s per IP) is
// deliberately generous — high enough that normal game traffic, even
// bursty, never notices it; low enough to stop a real flood or a runaway
// retry loop. Tune via OWN_API_RATE_LIMIT_MAX / OWN_API_RATE_LIMIT_WINDOW_MS
// if actual traffic patterns need it — see src/config/index.js.
const { windowMs: WINDOW_MS, maxRequestsPerWindow: MAX_PER_WINDOW } = config.ownApiRateLimit;

// Fixed-window counter per source — simpler than a token bucket and
// sufficient here: this is a coarse abuse guard, not a precise pacing
// mechanism (that's what the Roblox-side rate limiter is for). Bounded
// memory via the periodic sweep below — an IP that stops sending requests
// doesn't linger forever.
const buckets = new Map(); // sourceKey -> { count, windowStart }

function sourceKeyFor(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

function requestRateLimit(req, res, next) {
    const key = sourceKeyFor(req);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
        bucket = { count: 0, windowStart: now };
        buckets.set(key, bucket);
    }
    bucket.count++;

    if (bucket.count > MAX_PER_WINDOW) {
        const retryAfterSeconds = Math.max(1, Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000));
        res.set('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({ error: 'Demasiadas solicitudes a nuestra API, intenta de nuevo en unos segundos', retryAfterSeconds });
    }

    next();
}

setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
        if (now - bucket.windowStart >= WINDOW_MS * 2) buckets.delete(key);
    }
}, WINDOW_MS).unref();

function getMetrics() {
    return { trackedSources: buckets.size, windowMs: WINDOW_MS, maxRequestsPerWindow: MAX_PER_WINDOW };
}

module.exports = { requestRateLimit, getMetrics };
