'use strict';

// Contadores y latencias en memoria, sin dependencias. Es lo que hace
// verificable desde fuera del proceso — bajo carga real, no en teoria — que
// la cache y el single-flight estan funcionando: si el hit rate sube y las
// llamadas a Roblox se mantienen planas mientras el trafico crece, el diseño
// esta cumpliendo. Se expone en GET /v1/metrics (protegida).

// Muestras por ruta para los percentiles. Buffer circular de tamaño fijo: el
// coste de memoria queda acotado pase lo que pase y refleja siempre la
// ventana reciente, que es justo lo que interesa durante una prueba de carga.
const MAX_SAMPLES = 500;

const routes = new Map(); // label -> { count, statuses, samples, idx, filled }

function bucketFor(label) {
    let bucket = routes.get(label);
    if (!bucket) {
        bucket = { count: 0, statuses: Object.create(null), samples: new Array(MAX_SAMPLES), idx: 0, filled: 0 };
        routes.set(label, bucket);
    }
    return bucket;
}

function recordRequest(label, statusCode, durationMs) {
    const bucket = bucketFor(label);
    bucket.count++;
    bucket.statuses[statusCode] = (bucket.statuses[statusCode] ?? 0) + 1;
    bucket.samples[bucket.idx] = durationMs;
    bucket.idx = (bucket.idx + 1) % MAX_SAMPLES;
    if (bucket.filled < MAX_SAMPLES) bucket.filled++;
}

function percentile(sorted, p) {
    if (sorted.length === 0) return null;
    const rank = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

function statsFor(bucket) {
    const sorted = bucket.samples.slice(0, bucket.filled).sort((a, b) => a - b);
    return {
        count: bucket.count,
        statuses: { ...bucket.statuses },
        latencyMs: {
            p50: percentile(sorted, 50),
            p95: percentile(sorted, 95),
            p99: percentile(sorted, 99),
            max: sorted.length ? sorted[sorted.length - 1] : null,
        },
    };
}

function getHttpMetrics() {
    const out = {};
    for (const [label, bucket] of routes) out[label] = statsFor(bucket);
    return out;
}

// Middleware de latencia. La etiqueta la fija cada handler en
// `res.locals.routeLabel` de forma explicita, en vez de deducirla de la URL:
// asi las metricas se agrupan por PATRON de ruta ("/v1/outfits/:outfitId") y
// no explotan en una entrada distinta por cada id concreto consultado.
function latencyMiddleware(req, res, next) {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        const label = `${req.method} ${res.locals.routeLabel || 'unmatched'}`;
        recordRequest(label, res.statusCode, durationMs);
    });
    next();
}

function getProcessMetrics() {
    const mem = process.memoryUsage();
    return {
        uptimeSeconds: Math.round(process.uptime()),
        rssMb: +(mem.rss / 1024 / 1024).toFixed(1),
        heapUsedMb: +(mem.heapUsed / 1024 / 1024).toFixed(1),
        nodeVersion: process.version,
    };
}

// Solo para los tests: deja el estado limpio entre casos.
function reset() {
    routes.clear();
}

module.exports = { latencyMiddleware, recordRequest, getHttpMetrics, getProcessMetrics, reset };
