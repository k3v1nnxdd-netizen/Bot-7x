'use strict';

// Mocked/simulated rate-limit tests — deliberately does NOT hit real Roblox
// endpoints (never trigger real 429s to test this). Exercises
// src/roblox/rateLimiter.js's bucket logic directly with synthetic
// axios-shaped errors, including the EXACT headers observed in production:
//   x-ratelimit-limit: 6, 6;w=3600
//   x-ratelimit-remaining: 0
//   x-ratelimit-reset: 1447
//   retry-after: 5
// Safe to run in CI / on every `npm test` — no network calls at all.
const { createSuite } = require('./testHarness');
const rateLimiter = require('../roblox/rateLimiter');
const { makeBucket, parseStrictestLimit, parseLimitSegments } = rateLimiter.__test;

function make429Error({ limitHeader, remaining, reset, retryAfter }) {
    const err = new Error('Request failed with status code 429');
    err.response = {
        status: 429,
        headers: {
            'x-ratelimit-limit': limitHeader,
            'x-ratelimit-remaining': remaining,
            'x-ratelimit-reset': String(reset),
            'retry-after': String(retryAfter),
        },
        data: { errors: [{ code: 0, message: '' }] },
    };
    return err;
}

module.exports = async function run() {
    const { assert, finish } = createSuite('rateLimiter');

    // --- Header parsing ---
    const parsed = parseStrictestLimit('6, 6;w=3600, 70000', 60_000);
    assert(parsed.limit === 6 && parsed.windowMs === 3_600_000, 'parses "6, 6;w=3600, 70000" as limit=6, windowMs=3600000');

    const parsedNoWindow = parseStrictestLimit('10, 10;w=60, 70000', 60_000);
    assert(parsedNoWindow.limit === 10 && parsedNoWindow.windowMs === 60_000, 'parses "10, 10;w=60, 70000" as limit=10, windowMs=60000');

    assert(parseLimitSegments('1, 1;w=60, 70000').length === 3, 'parseLimitSegments splits 3 comma segments');

    // --- Short-wait 429 (3s, under the 10s inline-retry ceiling): inline retry ---
    {
        const bucket = makeBucket('test-short', { startingMaxTokens: 10 });
        let calls = 0;
        const fn = async () => {
            calls++;
            if (calls === 1) throw make429Error({ limitHeader: '10, 10;w=60', remaining: '0', reset: 3, retryAfter: 2 });
            return { headers: { 'x-ratelimit-limit': '10, 10;w=60' } };
        };
        await bucket.run(fn);
        const m = bucket.getMetrics();
        assert(calls === 2, 'short wait: retried inline and succeeded on 2nd attempt');
        assert(!m.circuitOpen, 'short wait: circuit did NOT open');
        assert(m.circuitBreakerActivations === 0, 'short wait: zero circuit breaker activations');
    }

    // --- Moderate wait (26s): opens the circuit instead of hanging the request ---
    {
        const bucket = makeBucket('test-moderate', { startingMaxTokens: 10 });
        let calls = 0;
        const fn = async () => { calls++; throw make429Error({ limitHeader: '10, 10;w=60', remaining: '0', reset: 26, retryAfter: 5 }); };
        const t0 = Date.now();
        let caught = null;
        try { await bucket.run(fn); } catch (err) { caught = err; }
        assert(caught?.circuitOpen === true, 'moderate wait: opened the circuit instead of sleeping 26s inline');
        assert(Date.now() - t0 < 2000, 'moderate wait: failed fast instead of hanging');
        assert(calls === 1, 'moderate wait: only one real call made');
    }

    // --- Long wait matching the EXACT reported production case (reset=1447s) ---
    {
        const bucket = makeBucket('test-long', { startingMaxTokens: 40 });
        let calls = 0;
        const fn = async () => { calls++; throw make429Error({ limitHeader: '6, 6;w=3600, 70000', remaining: '0', reset: 1447, retryAfter: 5 }); };
        const t0 = Date.now();
        let caught = null;
        try { await bucket.run(fn); } catch (err) { caught = err; }

        assert(caught?.circuitOpen === true, 'long wait: threw CircuitOpenError');
        assert(Date.now() - t0 < 2000, 'long wait: did not sleep anywhere near 1447s (or the old buggy 65s cap)');
        assert(calls === 1, 'long wait: exactly one real call before opening the circuit');

        const m = bucket.getMetrics();
        assert(m.circuitOpen === true, 'long wait: bucket reports circuitOpen=true');
        assert(m.circuitBreakerActivations === 1, 'long wait: circuitBreakerActivations incremented once');
        const actualOpenFor = m.circuitOpenUntil - Date.now();
        assert(Math.abs(actualOpenFor - 1447 * 1000) < 3000, 'long wait: circuit open duration matches the real 1447s reset, not truncated to 65s');

        let fnCallsDuringOpen = 0;
        const fnDuringOpen = async () => { fnCallsDuringOpen++; return { headers: {} }; };
        const results = await Promise.allSettled(Array.from({ length: 10 }, () => bucket.run(fnDuringOpen)));
        assert(results.every(r => r.status === 'rejected' && r.reason?.circuitOpen === true), 'long wait: 10 concurrent requests all failed FAST with CircuitOpenError');
        assert(fnCallsDuringOpen === 0, 'long wait: zero real calls made by the 10 waiting requests — no retry storm');
    }

    // --- Dynamic window adoption from a SUCCESS response (not just errors) ---
    {
        const bucket = makeBucket('test-observe', { startingMaxTokens: 40, startingWindowMs: 60_000 });
        const res = await bucket.run(async () => ({ headers: { 'x-ratelimit-limit': '6, 6;w=3600, 70000' } }));
        bucket.observeLimit(res.headers); // mirrors src/roblox/client.js's call pattern after every successful request
        const m = bucket.getMetrics();
        assert(m.maxTokens === 6 && m.windowMs === 3_600_000, 'bucket self-adjusted from a SUCCESSFUL response to 6 req/3600s');
    }

    // --- Transient network error (no response) retried, not treated as a rate limit ---
    {
        const bucket = makeBucket('test-network', { startingMaxTokens: 40 });
        let calls = 0;
        const fn = async () => {
            calls++;
            if (calls === 1) { const e = new Error('stream has been aborted'); e.code = 'ECONNABORTED'; throw e; }
            return { headers: {} };
        };
        await bucket.run(fn);
        assert(calls === 2, 'network error retried once and succeeded');
        assert(!bucket.getMetrics().circuitOpen, 'network error did NOT open the circuit');
    }

    // --- 5xx (Roblox's own servers) is retried, same as a network error ---
    {
        const bucket = makeBucket('test-5xx', { startingMaxTokens: 40 });
        let calls = 0;
        const fn = async () => {
            calls++;
            if (calls === 1) { const e = new Error('Bad Gateway'); e.response = { status: 502, headers: {}, data: {} }; throw e; }
            return { headers: {} };
        };
        await bucket.run(fn);
        assert(calls === 2, '5xx retried once and succeeded');
        assert(!bucket.getMetrics().circuitOpen, '5xx does NOT open the circuit — it is not a rate-limit signal');
    }

    // --- 400 is NOT retried, propagates immediately ---
    {
        const bucket = makeBucket('test-400', { startingMaxTokens: 40 });
        let calls = 0;
        const fn = async () => { calls++; const e = new Error('Bad Request'); e.response = { status: 400, headers: {}, data: {} }; throw e; };
        let caught = null;
        try { await bucket.run(fn); } catch (err) { caught = err; }
        assert(calls === 1, '400 was NOT retried');
        assert(caught?.response?.status === 400, 'the original 400 error propagated to the caller');
        assert(bucket.getMetrics().total400s === 1, 'total400s metric incremented');
    }

    return finish();
};
