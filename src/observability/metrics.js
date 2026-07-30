'use strict';

const os = require('os');

// Fixed-capacity ring buffer — latency samples per endpoint are bounded in
// memory REGARDLESS of how many requests this process serves over its
// entire lifetime (an unbounded array here would itself be the kind of
// memory leak this whole pass is supposed to be hunting for).
const RING_BUFFER_CAPACITY = 1000;

function createRingBuffer(capacity) {
    const buf = new Array(capacity);
    let idx = 0;
    let count = 0;
    return {
        push(value) {
            buf[idx] = value;
            idx = (idx + 1) % capacity;
            if (count < capacity) count++;
        },
        toSortedArray() {
            const out = count < capacity ? buf.slice(0, count) : buf.slice();
            out.sort((a, b) => a - b);
            return out;
        },
        get count() { return count; },
    };
}

const latencyBuffers = new Map(); // endpoint label -> ring buffer

function recordLatency(endpoint, ms) {
    let buf = latencyBuffers.get(endpoint);
    if (!buf) {
        buf = createRingBuffer(RING_BUFFER_CAPACITY);
        latencyBuffers.set(endpoint, buf);
    }
    buf.push(ms);
}

function percentile(sorted, p) {
    if (sorted.length === 0) return null;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return Math.round(sorted[idx] * 100) / 100;
}

function latencyStats(endpoint) {
    const buf = latencyBuffers.get(endpoint);
    if (!buf || buf.count === 0) return null;
    const sorted = buf.toSortedArray();
    return {
        samples: sorted.length,
        min: percentile(sorted, 0),
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: sorted[sorted.length - 1],
        avg: Math.round((sorted.reduce((a, b) => a + b, 0) / sorted.length) * 100) / 100,
    };
}

function getAllLatencyStats() {
    const out = {};
    for (const endpoint of latencyBuffers.keys()) out[endpoint] = latencyStats(endpoint);
    return out;
}

// Express middleware — wraps a route with latency recording tagged by a
// fixed label (the mount path, e.g. 'avatar'/'battle', known up front,
// rather than req.route which isn't populated until routing completes).
// Uses hrtime for sub-millisecond precision and res.on('finish') so the
// recorded duration includes the FULL request lifecycle (route handler +
// Express's own response serialization/send), not just the handler body.
function latencyMiddleware(label) {
    return (req, res, next) => {
        const t0 = process.hrtime.bigint();
        res.on('finish', () => {
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            recordLatency(label, ms);
        });
        next();
    };
}

// Process-level health signals — cheap to compute, genuinely useful for
// spotting a memory leak or event-loop saturation before it becomes an
// outage. loadAvg is Linux/Railway-meaningful; harmlessly [0,0,0] on
// platforms that don't support it (Windows).
function getProcessMetrics() {
    const mem = process.memoryUsage();
    return {
        uptimeSeconds: Math.round(process.uptime()),
        memory: {
            rssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
            heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
            heapTotalMb: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
            externalMb: Math.round((mem.external / 1024 / 1024) * 10) / 10,
        },
        loadAvg: os.loadavg(),
    };
}

module.exports = { latencyMiddleware, recordLatency, getAllLatencyStats, getProcessMetrics };
