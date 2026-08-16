'use strict';

const config = require('../config');

// Guardia anti-abuso de NUESTRA API, por IP de origen. Es independiente de
// src/roblox/rateLimiter.js y protege lo contrario: aquel protege a Roblox de
// nosotros, este nos protege a nosotros de quien nos llama — una integracion
// atascada en un bucle de reintentos sin backoff, una key filtrada, o abuso
// directo.
//
// Ventana fija en vez de token bucket: esto es un tope grosero contra
// avalanchas, no un mecanismo de pacing fino (ese trabajo lo hace el
// limitador saliente). Una ventana fija se entiende de un vistazo y no tiene
// estado que pueda desincronizarse.
//
// POR IP Y NO POR API KEY: hay una sola key compartida para toda la
// integracion, asi que agrupar por key metaria a todos los servidores de
// Roblox en el mismo cubo y haria imposible aislar al que se porta mal.
//
// EL DEFAULT ES ALTO (600/min) A PROPOSITO. Quien llama son servidores de
// Roblox: una IP = decenas de jugadores. Un limite pensado para usuarios
// individuales cortaria un servidor lleno en cuanto se animara la partida.
// Lo que de verdad protege los limites de Roblox es la cache, no esto.

const { windowMs: WINDOW_MS, max: MAX_PER_WINDOW } = config.rateLimit;

const buckets = new Map(); // ip -> { count, windowStart }

const metrics = { rejected: 0 };

function sourceKeyFor(req) {
    // `trust proxy` esta activo (ver app.js), asi que req.ip es la IP real
    // del llamador y no la del edge de Railway. Sin eso, TODAS las peticiones
    // compartirian un unico cubo y el limitador no serviria de nada.
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

function rateLimit(req, res, next) {
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
        metrics.rejected++;
        res.set('Retry-After', String(retryAfterSeconds));
        return res.status(429).json({
            error: {
                code: 'rate_limited',
                message: 'Demasiadas peticiones, baja el ritmo y reintenta en unos segundos',
                retryAfterSeconds,
            },
        });
    }

    next();
}

// Barrido: una IP que deja de llamar no se queda ocupando memoria para
// siempre. Se espera a dos ventanas para no borrar un cubo todavia vigente.
const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
        if (now - bucket.windowStart >= WINDOW_MS * 2) buckets.delete(key);
    }
}, WINDOW_MS);
sweepTimer.unref();

function getMetrics() {
    return { trackedSources: buckets.size, windowMs: WINDOW_MS, maxPerWindow: MAX_PER_WINDOW, ...metrics };
}

// Solo para los tests.
function reset() {
    buckets.clear();
    metrics.rejected = 0;
}

module.exports = { rateLimit, getMetrics, reset };
