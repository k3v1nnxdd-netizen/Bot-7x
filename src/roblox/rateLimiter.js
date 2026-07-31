'use strict';

// Every Roblox call in roblox.js goes through a named bucket created by
// makeBucket() below — each Roblox route gets its OWN independent,
// self-adjusting token bucket + circuit breaker. This used to be split
// between a single generic `limitedRequest` gate and a couple of dedicated
// buckets for the two routes that had already 429'd; that assumption (only
// catalog/items/details and avatar need special handling) didn't hold up —
// confirmed live that Roblox rate-limits per ROUTE, and that ANY route can
// be tightened at any time (avatar.roblox.com alone has been observed at
// both ~40 req/60s AND a much tighter 6 req/3600s — see the report). Every
// route roblox.js calls now gets the same quality of adaptive protection.
//
// A small global concurrency gate (schedule/MAX_CONCURRENT) still wraps
// every bucket on top of its own token bucket — belt-and-suspenders so a
// sudden burst across MULTIPLE different routes at once can't open more
// than a handful of concurrent outbound connections to Roblox regardless of
// how much token headroom each individual bucket has.
const MAX_CONCURRENT = 3;
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 500;

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

function schedule(fn) {
    return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        runNext();
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Thrown instead of ever calling Roblox when a bucket's circuit breaker is
// open (see makeBucket) — lets a caller distinguish "Roblox is known to be
// exhausted right now, don't even try" from a normal error, so it can decide
// on a fallback (e.g. serving a stale-but-known-good cached result) instead
// of just failing the whole request. `retryAt` is when it's expected to be
// safe to try again.
class CircuitOpenError extends Error {
    constructor(label, retryAt) {
        super(`[${label}] circuit open — Roblox reported this route exhausted until ${new Date(retryAt).toISOString()}`);
        this.name = 'CircuitOpenError';
        this.circuitOpen = true;
        this.retryAt = retryAt;
    }
}

// x-ratelimit-reset / x-ratelimit-limit / x-ratelimit-remaining come back as
// a COMMA-SEPARATED list — one entry per rate-limit policy Roblox is
// tracking for that route (e.g. "6, 6;w=3600, 70000": 6 left on the strict
// per-route bucket with an explicit 3600s window, then a generic
// platform-wide 70000 quota with no window annotation). Each entry can carry
// its own `;w=<seconds>` window — critically, that window is NOT always 60s:
// the same avatar.roblox.com route observed live both "40, 40;w=60, 70000"
// (documented default) AND "6, 6;w=3600, 70000" (a much tighter policy —
// see the report for how this is interpreted). Hardcoding one window for
// every bucket, like this file used to, silently mis-paces any bucket whose
// real window isn't 60s: a "6 tokens per 3600s" bucket refilled on a
// hardcoded 60s assumption would think it gets a fresh token every 10s, then
// hit a real 429 wall almost immediately.
//
// Re-verified live (2026-07-30) rather than assumed: avatar.roblox.com is
// currently back to reporting "40, 40;w=60, 70000" (x-ratelimit-remaining:
// "39, 70000", x-ratelimit-reset: "49, 0") — the tighter "6, 6;w=3600,
// 70000" seen previously was a real, distinct policy this same route was
// put under at some point, not a fixed/permanent limit and not a
// misreading on our part. Both formats parse correctly with the logic
// below (see src/tests/rateLimiter.test.js, which asserts both). The
// takeaway operationally: don't hardcode an assumption about what "the"
// avatar.roblox.com limit is anywhere — this bucket has to keep reading it
// from whatever Roblox actually sends on every response, because it has
// already been observed to change.
function parseLimitSegments(headerValue) {
    if (!headerValue) return [];
    return String(headerValue)
        .split(',')
        .map(seg => seg.trim())
        .map(seg => {
            const [valuePart, ...rest] = seg.split(';');
            const value = parseFloat(valuePart);
            if (!Number.isFinite(value)) return null;
            const windowMatch = rest.join(';').match(/w=(\d+(?:\.\d+)?)/);
            return { value, windowMs: windowMatch ? Number(windowMatch[1]) * 1000 : null };
        })
        .filter(Boolean);
}

// MIN of the parsed values — the strictest active policy (e.g.
// "1, 1;w=60, 70000" -> 1, ignoring the generic 70000 platform quota that's
// basically never the binding constraint).
function parseMinHeaderValue(headerValue) {
    const segments = parseLimitSegments(headerValue);
    return segments.length ? Math.min(...segments.map(s => s.value)) : null;
}

// MAX of the parsed values — used for x-ratelimit-reset/retry-after, where
// the conservative choice is to wait for every exhausted policy to clear,
// not just whichever happens to be first in the list.
function parseMaxHeaderValue(headerValue) {
    const segments = parseLimitSegments(headerValue);
    return segments.length ? Math.max(...segments.map(s => s.value)) : null;
}

// Returns { limit, windowMs } for the STRICTEST (min-value) policy in
// x-ratelimit-limit, preferring whichever tied-for-strictest segment carries
// an explicit ;w= window (more informative) — see parseLimitSegments above
// for why the window can't just be assumed.
function parseStrictestLimit(headerValue, fallbackWindowMs) {
    const segments = parseLimitSegments(headerValue);
    if (!segments.length) return null;
    const minValue = Math.min(...segments.map(s => s.value));
    const tied = segments.filter(s => s.value === minValue);
    const withWindow = tied.find(s => s.windowMs !== null);
    const chosen = withWindow ?? tied[0];
    return { limit: chosen.value, windowMs: chosen.windowMs ?? fallbackWindowMs };
}

// Roblox's Retry-After header is sometimes far shorter than how long the
// endpoint actually stays throttled (seen in production: retry-after=5 while
// the real x-ratelimit-reset was 1447s / ~24min) — prefer x-ratelimit-reset
// when both are present.
function computeWaitMs(err) {
    const headers = err?.response?.headers ?? {};
    const resetSeconds = parseMaxHeaderValue(headers['x-ratelimit-reset']);
    if (resetSeconds !== null && resetSeconds > 0) return resetSeconds * 1000;
    const retryAfterSeconds = parseMaxHeaderValue(headers['retry-after']);
    if (retryAfterSeconds !== null && retryAfterSeconds > 0) return retryAfterSeconds * 1000;
    return null; // no explicit guidance from Roblox — caller falls back to exponential backoff
}

function computeExponentialBackoffMs(attempt) {
    const exp = BASE_BACKOFF_MS * 2 ** (attempt - 1);
    const jitter = exp * (Math.random() * 0.2);
    return exp + jitter; // 500ms, 1s, 2s, 4s (+ up to 20% jitter)
}

// A 429 whose indicated wait is under this is still worth an inline
// sleep-and-retry. At or above this, sleeping the CURRENT request in place
// stops being reasonable — an HTTP caller (a player's /avatar request)
// shouldn't hang for tens of seconds or minutes, and doing that for every
// one of N concurrent requests is exactly the retry storm this is meant to
// prevent. This is a deliberate tightening versus the OLD behavior (which
// capped every wait at a flat 65s and slept inline regardless — including a
// previously-seen 26s case): even 26s is too long to hold a live HTTP
// request hostage, so that case now opens the circuit too, trading one fast
// 503 (see routes/avatar.js's CircuitOpenError handling) for what used to
// be a 26-second hang. Past this threshold, the circuit opens instead:
// every request (this one and any other concurrently hitting the same
// bucket) fails FAST with CircuitOpenError instead of queuing/sleeping/
// retrying, until Roblox's own indicated reset time passes. This is the
// direct fix for the reported bug:
// a 1447s reset was previously truncated to a 65s sleep-and-retry, which
// just re-hit the same still-exhausted bucket every ~65s for 24 minutes
// straight — a retry storm, not a fix.
const INLINE_RETRY_CEILING_MS = 10_000;

// Sanity ceiling on how long a circuit can stay open from ONE observed
// header value — protects against a garbage/extreme reset value locking a
// route out far longer than any legitimate Roblox policy would (the
// longest legitimate value seen live is ~1447s/24min on a 3600s-window
// bucket; 30min leaves comfortable headroom above that without being
// effectively unbounded).
const CIRCUIT_MAX_OPEN_MS = 30 * 60_000;

const DEFAULT_WINDOW_MS = 60_000;

// Creates one named, independent rate-limit bucket for a single Roblox
// route. Three layers, each doing a different job:
//   1. Proactive token bucket — paces requests to STAY under the limit,
//      refilled over `windowMs` (not a hardcoded 60s — see
//      parseLimitSegments), self-correcting the moment Roblox's own
//      response headers say the real limit/window is different. Callers
//      (roblox.js) call this bucket's `observeLimit` on EVERY response,
//      success or error, so a tightened limit is caught proactively instead
//      of only after already getting 429'd once.
//   2. Inline retry — a 429 with a SHORT indicated wait (< INLINE_RETRY_
//      CEILING_MS) is retried in place, same as before.
//   3. Circuit breaker — a 429 with a LONG indicated wait opens the circuit:
//      every request against this bucket fails immediately with
//      CircuitOpenError (no queuing, no sleeping, no additional requests
//      sent to Roblox) until the reset time Roblox itself reported (bounded
//      by CIRCUIT_MAX_OPEN_MS). Shared across every caller in this process —
//      opening it once protects everyone, instead of each of N concurrent
//      requests independently discovering the same 429 the hard way.
function makeBucket(label, { startingMaxTokens, startingWindowMs = DEFAULT_WINDOW_MS } = {}) {
    let maxTokens = startingMaxTokens; // starting assumption only — corrected live from real responses
    let tokens = maxTokens;
    let windowMs = startingWindowMs;
    let lastRefill = Date.now();

    let circuitOpenUntil = 0;
    let circuitBreakerActivations = 0;

    const metrics = { totalCalls: 0, total429s: 0, total400s: 0 };

    function isCircuitOpen() {
        return circuitOpenUntil > Date.now();
    }

    // Raw diagnostic snapshot of the 4 headers that actually drive (or could
// help diagnose) rate-limit decisions — logged verbatim, no interpretation,
// specifically so a policy change on a route like avatar.roblox.com can be
// read directly off the logs instead of reverse-engineered from derived
// numbers. x-ratelimit-remaining isn't used for any DECISION here (this
// bucket tracks its OWN consumption locally via `tokens`, which is more
// reliable than Roblox's server-reported remaining count — that count can
// reflect other traffic on the same Roblox-side quota, not just ours — but
// it's genuine diagnostic signal worth always having in the log line).
function headerSnapshot(headers) {
    return {
        'x-ratelimit-limit': headers?.['x-ratelimit-limit'],
        'x-ratelimit-remaining': headers?.['x-ratelimit-remaining'],
        'x-ratelimit-reset': headers?.['x-ratelimit-reset'],
        'retry-after': headers?.['retry-after'],
    };
}

function openCircuit(waitMs, status, headers) {
        const boundedWaitMs = Math.min(waitMs, CIRCUIT_MAX_OPEN_MS);
        const newOpenUntil = Date.now() + boundedWaitMs;
        if (newOpenUntil > circuitOpenUntil) circuitOpenUntil = newOpenUntil; // never shorten an already-open window
        circuitBreakerActivations++;
        console.warn(
            `[rateLimiter] Circuit OPEN para "${label}" — Roblox indicó ~${Math.round(boundedWaitMs / 1000)}s de espera` +
            (waitMs > boundedWaitMs ? ` (limitado a ${CIRCUIT_MAX_OPEN_MS / 60_000}min por seguridad, header pedía ${Math.round(waitMs / 1000)}s)` : '') +
            `. Todas las requests a esta ruta fallarán rápido hasta ${new Date(circuitOpenUntil).toISOString()} en vez de reintentar.`,
            { status, headers: headerSnapshot(headers) }
        );
    }

    async function takeToken() {
        for (;;) {
            if (isCircuitOpen()) throw new CircuitOpenError(label, circuitOpenUntil);
            const now = Date.now();
            const elapsed = now - lastRefill;
            if (elapsed > 0) {
                tokens = Math.min(maxTokens, tokens + (elapsed / windowMs) * maxTokens);
                lastRefill = now;
            }
            if (tokens >= 1) { tokens -= 1; return; }
            await sleep(Math.min(100, Math.max(10, windowMs / maxTokens / 4)));
        }
    }

    // Reads the real capacity/window Roblox just reported and adopts it
    // immediately. Called by roblox.js on EVERY response (success or
    // error) — that's what lets this bucket notice a tightened limit before
    // it ever causes a 429, not just after.
    function observeLimit(headers) {
        const observed = parseStrictestLimit(headers?.['x-ratelimit-limit'], windowMs);
        if (!observed || observed.limit <= 0) return;
        if (observed.limit === maxTokens && observed.windowMs === windowMs) return;
        console.warn(
            `[rateLimiter] Roblox cambió el límite de "${label}": ${maxTokens} req/${windowMs / 1000}s -> ${observed.limit} req/${observed.windowMs / 1000}s. Ajustando el limitador en caliente.`
        );
        maxTokens = observed.limit;
        windowMs = observed.windowMs;
        tokens = Math.min(tokens, maxTokens);
    }

    async function attemptOnce(fn) {
        if (isCircuitOpen()) throw new CircuitOpenError(label, circuitOpenUntil);
        await takeToken();
        metrics.totalCalls++;
        return fn();
    }

    async function run(fn) {
        let attempt = 0;
        for (;;) {
            try {
                return await attemptOnce(fn);
            } catch (err) {
                if (err instanceof CircuitOpenError) throw err;
                if (err?.response?.headers) observeLimit(err.response.headers);
                const status = err?.response?.status;
                if (status === 429) metrics.total429s++;
                if (status === 400) metrics.total400s++;

                // Every 429 gets logged with the raw headers, regardless of
                // which path it takes next (inline retry vs circuit-open) —
                // "429 y situaciones relevantes" is exactly what this is:
                // low-frequency by construction (only fires on an actual
                // 429), and the one moment a policy investigation actually
                // needs the real numbers, not a derived summary.
                if (status === 429) {
                    console.warn(`[rateLimiter] 429 de Roblox en "${label}"`, { headers: headerSnapshot(err.response.headers) });
                    const waitMs = computeWaitMs(err);
                    if (waitMs !== null && waitMs >= INLINE_RETRY_CEILING_MS) {
                        openCircuit(waitMs, status, err.response.headers);
                        throw new CircuitOpenError(label, circuitOpenUntil);
                    }
                }

                // 5xx (Roblox's own servers, not a rate-limit signal) is
                // worth a bounded inline retry same as a network error — a
                // transient 502/503 is common and usually clears within a
                // retry or two; unlike 429 it never opens the circuit, since
                // it says nothing about OUR consumption of this route.
                const isNetworkError = !err?.response;
                const isServerError = status >= 500 && status < 600;
                const isRetryable = status === 429 || isNetworkError || isServerError;
                if (!isRetryable || attempt >= MAX_RETRIES) throw err;

                attempt++;
                const waitMs = computeWaitMs(err);
                const backoff = waitMs !== null ? Math.min(waitMs, INLINE_RETRY_CEILING_MS) : computeExponentialBackoffMs(attempt);
                console.warn(
                    `[rateLimiter] Reintentando request a Roblox (${label})`,
                    {
                        attempt,
                        maxRetries: MAX_RETRIES,
                        backoffMs: Math.round(backoff),
                        maxTokens,
                        windowMs,
                        url: err.config?.url,
                        method: err.config?.method,
                        status,
                        errorCode: err.code,
                        headers: headerSnapshot(err?.response?.headers),
                    }
                );
                await sleep(backoff);
            }
        }
    }

    return {
        run: fn => schedule(() => run(fn)),
        observeLimit,
        getMaxTokens: () => maxTokens,
        getMetrics: () => ({
            label,
            maxTokens,
            windowMs,
            ...metrics,
            circuitBreakerActivations,
            circuitOpen: isCircuitOpen(),
            circuitOpenUntil: circuitOpenUntil > Date.now() ? circuitOpenUntil : null,
        }),
    };
}

// /v1/catalog/items/details — the route most observed 429ing in production,
// tightened by Roblox to as little as 1 req/60s.
const catalogBucket = makeBucket('catalog items/details', { startingMaxTokens: 10 });
// /v1/assets/{id}/bundles — the animated-face reverse-lookup route added for
// auto-detection.
const bundlesBucket = makeBucket('catalog assets/bundles', { startingMaxTokens: 10 });
// apis.roblox.com/marketplace-sales/v1/item/{collectibleItemId}/resale-data
// — the PRIMARY RAP source (see roblox.js's getCollectibleRAP), called for
// every Limited item's valuation. Observed live: 50 req/60s.
const rapBucket = makeBucket('collectible RAP', { startingMaxTokens: 50 });
// economy.roblox.com/v1/assets/{id}/resale-data — LEGACY RAP fallback, only
// reached when an asset has no collectibleItemId at all (rare — see
// resolveRap in services/valuationService.js). Documented at 50 req/60s.
const legacyRapBucket = makeBucket('legacy RAP', { startingMaxTokens: 50 });
// avatar.roblox.com/v1/users/{id}/avatar — worn items. THE route this
// architecture pass was triggered by: documented at ~40 req/60s, but
// observed live in production tightened to 6 req/3600s (see the report).
// Starting assumption is the documented default; observeLimit corrects it
// immediately from real response headers either way.
const avatarBucket = makeBucket('avatar worn-items', { startingMaxTokens: 40 });
// users.roblox.com/v1/users/{id} — display name/username/profile.
const userProfileBucket = makeBucket('user profile', { startingMaxTokens: 60 });
// users.roblox.com/v1/usernames/users — username -> id lookup (Discord
// /outfit command's entry point).
const usernameLookupBucket = makeBucket('username lookup', { startingMaxTokens: 60 });
// friends.roblox.com — follower/friend counts (Discord /outfit command).
const friendsBucket = makeBucket('friends', { startingMaxTokens: 60 });
// thumbnails.roblox.com — rendered avatar image + headshot URLs.
const thumbnailBucket = makeBucket('avatar thumbnail', { startingMaxTokens: 60 });
// groups.roblox.com — group membership check (verification flow).
const groupsBucket = makeBucket('groups', { startingMaxTokens: 60 });

function getMetrics() {
    return {
        catalogDetails: catalogBucket.getMetrics(),
        bundles: bundlesBucket.getMetrics(),
        rap: rapBucket.getMetrics(),
        legacyRap: legacyRapBucket.getMetrics(),
        avatar: avatarBucket.getMetrics(),
        userProfile: userProfileBucket.getMetrics(),
        usernameLookup: usernameLookupBucket.getMetrics(),
        friends: friendsBucket.getMetrics(),
        thumbnail: thumbnailBucket.getMetrics(),
        groups: groupsBucket.getMetrics(),
    };
}

module.exports = {
    limitedCatalogRequest: catalogBucket.run,
    observeCatalogLimit: catalogBucket.observeLimit,
    limitedBundlesRequest: bundlesBucket.run,
    observeBundlesLimit: bundlesBucket.observeLimit,
    limitedRapRequest: rapBucket.run,
    observeRapLimit: rapBucket.observeLimit,
    limitedLegacyRapRequest: legacyRapBucket.run,
    observeLegacyRapLimit: legacyRapBucket.observeLimit,
    limitedAvatarRequest: avatarBucket.run,
    observeAvatarLimit: avatarBucket.observeLimit,
    limitedUserProfileRequest: userProfileBucket.run,
    observeUserProfileLimit: userProfileBucket.observeLimit,
    limitedUsernameLookupRequest: usernameLookupBucket.run,
    observeUsernameLookupLimit: usernameLookupBucket.observeLimit,
    limitedFriendsRequest: friendsBucket.run,
    observeFriendsLimit: friendsBucket.observeLimit,
    limitedThumbnailRequest: thumbnailBucket.run,
    observeThumbnailLimit: thumbnailBucket.observeLimit,
    limitedGroupsRequest: groupsBucket.run,
    observeGroupsLimit: groupsBucket.observeLimit,
    getMetrics,
    CircuitOpenError,
    __test: {
        parseMinHeaderValue,
        parseStrictestLimit,
        parseLimitSegments,
        makeBucket,
        INLINE_RETRY_CEILING_MS,
        CIRCUIT_MAX_OPEN_MS,
    },
};
