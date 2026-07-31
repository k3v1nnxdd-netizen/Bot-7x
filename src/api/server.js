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
const { requestLogger } = require('../observability/requestLogger');

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

    // 32kb comfortably covers POST /battle's real shape (2 players x up to
    // 100 assetIds each — a few KB at most) while bounding a broken/abusive
    // caller from sending an oversized body instead of relying on Express's
    // much larger 100kb default.
    app.use(express.json({ limit: '32kb' }));
    app.locals.discordClient = client;

    // /health stays PUBLIC, unmetered, unrated — Railway's healthcheck pings
    // this with no headers and must never look dead because of an unrelated
    // rate limit or a missing API key.
    app.use('/health', healthRoute);

    // Every other route, in order: TEMPORARY diagnostic request logging
    // first (logs every attempt, including ones about to get rejected below
    // — see src/observability/requestLogger.js for why and how to disable
    // it) -> our OWN spam guard (cheap, in-memory, rejects a flood before it
    // reaches auth or touches Roblox-facing logic at all) -> the
    // shared-secret API key check -> latency instrumentation (measures real
    // authenticated business-logic time, not instant 401/429 rejections) ->
    // the actual route.
    app.use('/avatar', requestLogger, requestRateLimit, requireApiKey, latencyMiddleware('avatar'), avatarRoute);
    app.use('/battle', requestLogger, requestRateLimit, requireApiKey, latencyMiddleware('battle'), battleRoute);
    app.use('/metrics', requestRateLimit, requireApiKey, metricsRoute);

    // Body-parser (express.json() above) errors — malformed JSON, body over
    // the 32kb limit — arrive here as an error instead of reaching any route
    // handler. Formatted as JSON like every other response this API sends,
    // instead of Express's default HTML error page. Must be registered
    // AFTER every route (Express convention: a 4-arg middleware is only
    // ever invoked as an error handler).
    app.use((err, req, res, next) => {
        if (err?.type === 'entity.too.large' || err?.status === 413) {
            return res.status(413).json({ error: 'El body de la petición excede el tamaño máximo permitido' });
        }
        if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
            return res.status(400).json({ error: 'JSON inválido en el body de la petición' });
        }
        console.error('[api] Unhandled error:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    });

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
