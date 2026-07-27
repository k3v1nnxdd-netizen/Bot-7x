'use strict';

// Every Roblox call this service makes goes through here — a single global
// gate that (1) never lets more than MAX_CONCURRENT requests to Roblox be
// in flight at once, no matter how many /avatar or /battle requests Railway
// is handling at the same time, and (2) automatically retries with
// exponential backoff when Roblox answers 429, instead of letting the error
// bubble straight up to the route.
const MAX_CONCURRENT = 3;
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;

let active = 0;
const queue = [];

function runNext() {
    if (active >= MAX_CONCURRENT || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
        active--;
        runNext();
    });
}

// Queues `fn` behind the concurrency gate — resolves once a slot is free AND
// fn() has run (with its own retries already applied, see limitedRequest).
function schedule(fn) {
    return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        runNext();
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Roblox's Retry-After header is sometimes far shorter than how long the
// endpoint actually stays throttled (seen in production: retry-after=5 while
// the real reset was 51s) — prefer x-ratelimit-reset when both are present.
function computeBackoffMs(err, attempt) {
    const headers = err?.response?.headers ?? {};
    const resetSeconds = Number(headers['x-ratelimit-reset']);
    if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
        return Math.min(resetSeconds * 1000, MAX_BACKOFF_MS);
    }
    const retryAfterSeconds = Number(headers['retry-after']);
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        return Math.min(retryAfterSeconds * 1000, MAX_BACKOFF_MS);
    }
    // Exponential backoff with jitter: 500ms, 1s, 2s, 4s (± up to 20%).
    const exp = BASE_BACKOFF_MS * 2 ** (attempt - 1);
    const jitter = exp * (Math.random() * 0.2);
    return Math.min(exp + jitter, MAX_BACKOFF_MS);
}

// Wraps a single Roblox call with concurrency limiting + 429 retry/backoff.
// Non-429 errors are not retried here — they propagate immediately, same as
// before this change, so callers' existing error handling still applies.
async function limitedRequest(fn) {
    return schedule(async () => {
        let attempt = 0;
        for (;;) {
            try {
                return await fn();
            } catch (err) {
                if (err?.response?.status !== 429 || attempt >= MAX_RETRIES) throw err;
                attempt++;
                const backoff = computeBackoffMs(err, attempt);
                console.warn(
    `[robloxRequestLimiter] 429 de Roblox`,
    {
        attempt,
        maxRetries: MAX_RETRIES,
        backoffMs: Math.round(backoff),
        url: err.config?.url,
        method: err.config?.method,
        status: err.response?.status,
        headers: err.response?.headers,
    }
);
                await sleep(backoff);
            }
        }
    });
}

module.exports = { limitedRequest };
