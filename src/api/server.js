'use strict';

const express = require('express');
const config = require('../config');
const healthRoute = require('./routes/health');
const avatarRoute = require('./routes/avatar');
const battleRoute = require('./routes/battle');
const metricsRoute = require('./routes/metrics');
const { requireApiKey } = require('../security/auth');
const { requestRateLimit } = require('../security/requestRateLimit');
const { latencyMiddleware } = require('../observability/metrics');

// `client` is accepted (and stashed on `app.locals`) so future routes that
// need to act on the Discord bot (e.g. award a role after a Roblox purchase)
// can reach it via `req.app.locals.discordClient` without re-plumbing this.
function startServer(client) {
    const app = express();

    // Railway (like most PaaS) terminates TLS and proxies requests through
    // an edge layer — without `trust proxy`, req.ip is the PROXY's own
    // address for every single request, which would collapse
    // requestRateLimit's per-SOURCE tracking into one shared bucket for
    // every caller combined (defeating the point of it).
    app.set('trust proxy', true);

    app.use(express.json());
    app.locals.discordClient = client;

    // /health stays PUBLIC, unmetered, unrated — Railway's healthcheck pings
    // this with no headers and must never look dead because of an unrelated
    // rate limit or a missing API key.
    app.use('/health', healthRoute);

    // Every other route, in order: our OWN spam guard first (cheap,
    // in-memory, rejects a flood before it reaches auth or touches
    // Roblox-facing logic at all) -> the shared-secret API key check ->
    // latency instrumentation (measures real authenticated business-logic
    // time, not instant 401/429 rejections) -> the actual route.
    app.use('/avatar', requestRateLimit, requireApiKey, latencyMiddleware('avatar'), avatarRoute);
    app.use('/battle', requestRateLimit, requireApiKey, latencyMiddleware('battle'), battleRoute);
    app.use('/metrics', requestRateLimit, requireApiKey, metricsRoute);

    const server = app.listen(config.port, () => {
        console.log(`[api] Servidor Express escuchando en el puerto ${config.port}`);
    });

    // keepAliveTimeout should exceed common proxy/load-balancer idle
    // timeouts (Railway's edge, like most, defaults around 60s) so OUR
    // server never closes a still-good keep-alive socket a moment before
    // the proxy would have reused it for the next request — a well-known
    // source of sporadic connection resets under real load otherwise.
    // headersTimeout must stay above keepAliveTimeout (Node requirement).
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;

    return { app, server };
}

module.exports = { startServer };
