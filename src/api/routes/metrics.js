'use strict';

const express = require('express');
const router = express.Router();
const observability = require('../../observability/metrics');
const avatarService = require('../../services/avatarService');
const requestRateLimit = require('../../security/requestRateLimit');

// API-key-protected (same gate as /avatar, /battle — see server.js): this
// exposes internal operational detail (cache hit rates, per-route Roblox
// call counts, circuit breaker state, memory) that shouldn't be public, but
// IS exactly what's needed to verify "is the caching/batching/circuit
// breaker actually working" from outside the process, the same way the
// manual scripts used during development did via getMetrics() — just as a
// real, always-available endpoint instead of an ad hoc script.
router.get('/', (req, res) => {
    res.json({
        process: observability.getProcessMetrics(),
        latency: observability.getAllLatencyStats(),
        ownApiRateLimit: requestRateLimit.getMetrics(),
        // avatarService.getMetrics() cascades: staleWornAssetFallbacks ->
        // valuationService (asset batching/dedup + repositories) ->
        // rateLimiter (per-Roblox-route calls/429s/400s/circuit breakers).
        avatar: avatarService.getMetrics(),
    });
});

module.exports = router;
