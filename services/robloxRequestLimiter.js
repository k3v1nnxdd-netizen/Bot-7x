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
// Catalog's window is 60s, so a real x-ratelimit-reset can legitimately be
// close to that — capping much lower would truncate the wait right back
// into the same bug the correct-parsing fix above just solved.
const MAX_BACKOFF_MS = 65_000;

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

// x-ratelimit-reset (and -limit/-remaining) come back as a COMMA-SEPARATED
// list — one value per rate-limit policy Roblox is tracking for that route
// (e.g. "26, 0": 26s left on the strict per-route bucket, 0 on the generous
// platform-wide one). A bare Number(...) on that string is NaN and silently
// falls through to Retry-After — take the max of the parsed values instead,
// the conservative choice (wait for every exhausted policy to clear, not
// just whichever happens to be first).
function parseMaxHeaderValue(headerValue) {
    if (!headerValue) return null;
    const nums = String(headerValue).split(',').map(s => parseFloat(s.trim())).filter(Number.isFinite);
    return nums.length ? Math.max(...nums) : null;
}

// Roblox's Retry-After header is sometimes far shorter than how long the
// endpoint actually stays throttled (seen in production: retry-after=5 while
// the real reset was 26s) — prefer x-ratelimit-reset when both are present.
function computeBackoffMs(err, attempt) {
    const headers = err?.response?.headers ?? {};
    const resetSeconds = parseMaxHeaderValue(headers['x-ratelimit-reset']);
    if (resetSeconds !== null && resetSeconds > 0) {
        return Math.min(resetSeconds * 1000, MAX_BACKOFF_MS);
    }
    const retryAfterSeconds = parseMaxHeaderValue(headers['retry-after']);
    if (retryAfterSeconds !== null && retryAfterSeconds > 0) {
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

// Proactive rate limiter specifically for
// catalog.roblox.com/v1/catalog/items/details — the endpoint actually
// observed 429ing in production. It's documented at 10 requests/60s, well
// below avatar.roblox.com's 40/60s, and the generic 3-concurrent gate above
// doesn't stop callers from bursting past that on their own — it only
// reacts (retries) after Roblox already rejected a request. This paces
// catalog calls to stay under the real budget proactively, and runs
// independently of the generic queue so unrelated calls (user info,
// thumbnails, worn items) never wait behind it or vice versa.
const CATALOG_MAX_TOKENS = 10;
const CATALOG_WINDOW_MS = 60_000;

let catalogTokens = CATALOG_MAX_TOKENS;
let catalogLastRefill = Date.now();

async function takeCatalogToken() {
    for (;;) {
        const now = Date.now();
        const elapsed = now - catalogLastRefill;
        if (elapsed > 0) {
            catalogTokens = Math.min(CATALOG_MAX_TOKENS, catalogTokens + (elapsed / CATALOG_WINDOW_MS) * CATALOG_MAX_TOKENS);
            catalogLastRefill = now;
        }
        if (catalogTokens >= 1) { catalogTokens -= 1; return; }
        await sleep(100);
    }
}

// Same 429 retry/backoff behavior as limitedRequest, just paced by the
// catalog-specific token bucket instead of the generic concurrency gate.
async function limitedCatalogRequest(fn) {
    let attempt = 0;
    for (;;) {
        await takeCatalogToken();
        try {
            return await fn();
        } catch (err) {
            if (err?.response?.status !== 429 || attempt >= MAX_RETRIES) throw err;
            attempt++;
            const backoff = computeBackoffMs(err, attempt);
            console.warn(
                `[robloxRequestLimiter] 429 de Roblox (catalog)`,
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
}

module.exports = { limitedRequest, limitedCatalogRequest };
