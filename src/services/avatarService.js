'use strict';

// Per-PLAYER orchestration: profile info, thumbnail, current worn-items
// (with a narrow stale-data fallback when Roblox is rate-limited), and the
// overall cached/deduplicated "build me this user's valuation" entry point.
// Pricing RULES for a set of worn assets live in valuationService.js — this
// file only knows about fetching what a specific userId currently has.
const roblox = require('../roblox/client');
const cache = require('../cache/memoryCache');
const rateLimiter = require('../roblox/rateLimiter');
const { CircuitOpenError } = rateLimiter;
const valuationService = require('./valuationService');

// Cache TTLs — only for genuinely DYNAMIC, per-player data. Structural
// per-asset data (name/creator/official price/bundle mapping) is NOT here —
// it lives in src/repositories/, permanently and persistently, since it
// doesn't change per-player or over time the way everything below does.
//
// WORN_ASSETS/FULL_VALUATION were previously 5 minutes each, which caused a
// real bug: a player who changes outfit in Roblox and immediately checks
// their value here would see their OLD outfit for up to 5 minutes — bad for
// any use case, actively exploitable for a "fronteo"/flex-battle game (wear
// something expensive just long enough to get it cached, then swap back and
// keep the inflated cached score). That 5-min figure came from conflating
// two DIFFERENT Roblox resources: avatar.roblox.com/v1/users/{id}/avatar —
// confirmed live to send `cache-control: no-cache`, i.e. Roblox itself never
// serves a stale worn-items list — versus catalog.roblox.com/v1/catalog/
// items/details, the genuinely scarce resource (tightened live to as little
// as 1 req/60s, sometimes less). Those are already fully decoupled: item
// PRICING is stored by ASSET id (see valuationService.js/repositories/) and
// shared across every player wearing that item, completely independent of
// any single player's own outfit-check frequency. So shortening
// WORN_ASSETS/FULL_VALUATION does NOT increase load on the scarce resource
// at all. Callers that need a hard freshness guarantee regardless (e.g.
// right before recording a competitive /battle result) can force a live
// re-check via buildAvatarValuation(userId, { fresh: true }) — see below —
// WITHOUT ever touching the asset repositories (structural data is never
// invalidated by `fresh`, on purpose — see that function's docstring).
//
// THUMBNAIL (the rendered avatar image) is also confirmed `cache-control:
// no-cache` on Roblox's side, but a full re-render after an outfit change
// has its own inherent server-side lag on Roblox's end regardless of how
// fast we re-check — so it's less urgent than the VALUE being right, and
// kept a bit longer (60s) purely to cut request volume for something that
// isn't the actual bug being fixed.
const TTL = {
    USER_INFO: 30 * 60_000,
    THUMBNAIL: 60_000,
    // 20s -> 45s: a player doing several VS battles back to back was still
    // re-hitting avatar.roblox.com more often than needed. 45s sits in the
    // middle of the requested 30-60s range — long enough that a hot streak
    // of battles for the same popular player costs at most one real avatar
    // check per 45s (the rest are cache hits or, once past TTL, served
    // instantly via stale-while-revalidate — see getWornAssetsWithStaleFallback),
    // short enough that an outfit change is still reflected well within the
    // timeframe a player would notice.
    WORN_ASSETS: 45_000,
    FULL_VALUATION: 45_000,
};

const metrics = {
    staleWornAssetFallbacks: 0, // times Roblox was confirmed struggling and we served a last-known-good outfit instead of failing the valuation
    swrServed: 0,               // times an expired-but-recent outfit was served INSTANTLY while a background refresh ran, instead of blocking the request
    swrBackgroundRefreshFailed: 0, // background refreshes that themselves failed (harmless — just means the NEXT request tries again)
};

function getMetrics() {
    return { ...metrics, valuation: valuationService.getMetrics(), requestLimiter: rateLimiter.getMetrics() };
}

function getUserBasicInfo(userId) {
    return cache.getOrFetch(`user:${userId}`, TTL.USER_INFO, async () => {
        const profile = await roblox.getUserProfile(userId);
        return { username: profile.name, displayName: profile.displayName };
    });
}

function getAvatarThumbnail(userId) {
    return cache.getOrFetch(`thumb:${userId}`, TTL.THUMBNAIL, () => roblox.getAvatarImage(userId));
}

// Last known-good worn-items list per userId, kept independent of the short
// TTL cache above — this is what makes both the error-fallback AND the
// stale-while-revalidate path below possible. Only ever updated on a
// genuinely successful live fetch, never on a stale-served response, so it
// always reflects "the last time we ACTUALLY confirmed this from Roblox".
// Unbounded by userId count is fine at this project's realistic scale (a
// Discord community, not millions of MAU) — bounded by age instead via the
// periodic sweep below, consistent with memoryCache's own cleanup pattern.
const lastKnownWornAssets = new Map(); // userId -> { assetIds, fetchedAt }
const LAST_KNOWN_MAX_AGE_MS = 24 * 60 * 60_000;

setInterval(() => {
    const cutoff = Date.now() - LAST_KNOWN_MAX_AGE_MS;
    for (const [userId, entry] of lastKnownWornAssets) {
        if (entry.fetchedAt < cutoff) lastKnownWornAssets.delete(userId);
    }
}, 60 * 60_000).unref();

// How long PAST the normal TTL an expired outfit is still safe to serve
// INSTANTLY (no blocking on Roblox at all) while a fresh copy is fetched in
// the background — this is what lets a hot streak of VS battles for the
// same popular player never wait on avatar.roblox.com, not even for the one
// real request every ~45s that keeps the cache warm. Bounded deliberately:
// long enough to fully absorb the "cache just expired" moment with zero
// caller-visible latency; short enough that if background refreshes ever
// stopped succeeding outright (a genuine sustained Roblox outage), data
// doesn't silently drift for hours — past this window a request falls back
// to the blocking path instead (still with its OWN error-fallback safety
// net below, just no longer instant).
const STALE_WHILE_REVALIDATE_MS = 5 * 60_000;

// A failure is worth falling back to last-known-good data for when it says
// "Roblox couldn't be reached / is rate-limiting us right now" — NOT when it
// says something definitive about the request itself (404 user not found,
// 400 bad request), where masking the real answer with old data would be
// actively wrong, not just imprecise:
//   - CircuitOpenError / 429: the exact scenario this whole thing exists for.
//   - 5xx: Roblox's own servers erroring — not our fault, not the user's.
//   - no `err.response` at all (timeout, ECONNRESET, DNS failure, ...):
//     genuine "couldn't reach Roblox", indistinguishable from the caller's
//     perspective from a rate-limit-induced failure.
function isFallbackEligibleError(err) {
    if (err instanceof CircuitOpenError) return true;
    const status = err?.response?.status;
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    if (!err?.response) return true;
    return false;
}

// Single-flight background refresh: reuses cache.getOrFetch's OWN in-flight
// dedup (same key, same mechanism the blocking path uses) rather than
// inventing a second one — if N concurrent requests all trigger this for
// the same userId, only the FIRST actually schedules a fetch; the rest
// transparently join it. Deliberately fire-and-forget from the caller's
// perspective (not awaited) — that's what makes stale-while-revalidate not
// block anything; its own success/failure is handled right here.
function triggerBackgroundRevalidate(userId) {
    cache.getOrFetch(`worn:${userId}`, TTL.WORN_ASSETS, () => roblox.getWornAssetIds(userId))
        .then(assetIds => { lastKnownWornAssets.set(userId, { assetIds, fetchedAt: Date.now() }); })
        .catch(err => {
            metrics.swrBackgroundRefreshFailed++;
            console.warn(`[avatarService] Background outfit revalidation failed for user ${userId} (still serving the last known outfit meanwhile):`, err.message);
        });
}

// Fetches the user's currently-worn asset ids. Three tiers, in order:
//   1. Fresh cache hit (within TTL) — instant, no Roblox call.
//   2. Expired but within the stale-while-revalidate window — ALSO instant:
//      serves the last confirmed outfit immediately and kicks off a
//      deduplicated background refresh, so the cache is warm again for the
//      NEXT request without this one ever waiting on Roblox. Skipped
//      entirely when `allowSwr` is false (see `fresh` below) — a caller
//      that explicitly asked for a guaranteed-live read must actually get
//      one, not a recent-but-not-current snapshot.
//   3. Genuine miss (nothing usable cached) — blocks on a real fetch,
//      falling back to whatever last-known-good data exists (regardless of
//      its age) ONLY if that fetch fails with a fallback-eligible error —
//      see isFallbackEligibleError. This is the last line of defense: it's
//      what keeps a VS battle working through a sustained Roblox outage for
//      a player who hasn't been seen in the last `STALE_WHILE_REVALIDATE_MS`.
async function getWornAssetsWithStaleFallback(userId, { allowSwr = true } = {}) {
    const cached = cache.get(`worn:${userId}`);
    if (cached !== undefined) return { assetIds: cached, stale: false, staleSince: null };

    const last = lastKnownWornAssets.get(userId);
    if (allowSwr && last && Date.now() - last.fetchedAt < TTL.WORN_ASSETS + STALE_WHILE_REVALIDATE_MS) {
        metrics.swrServed++;
        triggerBackgroundRevalidate(userId);
        return { assetIds: last.assetIds, stale: false, staleSince: null };
    }

    try {
        const assetIds = await cache.getOrFetch(`worn:${userId}`, TTL.WORN_ASSETS, () => roblox.getWornAssetIds(userId));
        lastKnownWornAssets.set(userId, { assetIds, fetchedAt: Date.now() });
        return { assetIds, stale: false, staleSince: null };
    } catch (err) {
        if (isFallbackEligibleError(err) && last) {
            metrics.staleWornAssetFallbacks++;
            console.warn(
                `[avatarService] avatar.roblox.com no disponible para user ${userId} (${err?.response?.status ?? err?.code ?? err.name}) — sirviendo el último outfit confirmado (${new Date(last.fetchedAt).toISOString()}) marcado como stale, en vez de fallar la valoración.`
            );
            return { assetIds: last.assetIds, stale: true, staleSince: last.fetchedAt };
        }
        throw err;
    }
}

// The single source of truth for "what is this avatar worth" — used
// directly by GET /avatar/:userId and reused (called twice) by
// GET /battle/:user1/:user2, so the valuation rules only live in one place.
// cache.getOrFetch gives this two things at once: a TTL cache of the WHOLE
// result (so a user queried again soon skips every Roblox call, not just
// some), and in-flight dedup for free (two concurrent requests for the same
// userId — e.g. that user showing up in two different /battle calls at
// once, or several concurrent `fresh` battle-result requests for the same
// userId — join the same in-flight computation instead of running it
// twice: cache.invalidate only clears the completed-value slot, never an
// ALREADY in-flight promise, so a burst of simultaneous callers all land on
// the same single recomputation regardless of how many separately called
// `fresh: true`).
//
// `fresh: true` forces a guaranteed-live recheck of the OUTFIT specifically
// — it invalidates `valuation:${userId}` and `worn:${userId}` ONLY.
// Deliberately does NOT touch the asset repositories (structural per-asset
// data: names/prices/bundle mappings) or the RAP cache — those describe the
// ASSET, not the PLAYER, so "this player wants a fresh check" has no
// bearing on whether item 833772219 is still named "Amethyst Antlers" or
// still costs 2500. Re-fetching known items' catalog data on every
// fresh=1 would reintroduce exactly the catalog/items/details load this
// whole architecture exists to eliminate, for zero benefit — a player
// changing clothes can only ever change WHICH known (or newly-discovered)
// assetIds they're wearing, never what those assetIds mean.
function buildAvatarValuation(userId, { fresh = false } = {}) {
    const key = `valuation:${userId}`;
    if (fresh) {
        cache.invalidate(key);
        cache.invalidate(`worn:${userId}`);
    }
    return cache.getOrFetch(key, TTL.FULL_VALUATION, () => buildAvatarValuationUncached(userId, { fresh }));
}

async function buildAvatarValuationUncached(userId, { fresh = false } = {}) {
    const [basicInfo, avatarThumbnail, wornResult] = await Promise.all([
        getUserBasicInfo(userId),
        getAvatarThumbnail(userId),
        // `fresh` disables stale-while-revalidate specifically — a caller
        // that invalidated the cache and asked for a live read must get one
        // (or the documented error-fallback, if Roblox is truly
        // unreachable), never a merely-recent SWR snapshot.
        getWornAssetsWithStaleFallback(userId, { allowSwr: !fresh }),
    ]);

    const valuation = await valuationService.valuateWornAssets(wornResult.assetIds);

    return {
        userId,
        username: basicInfo.username,
        displayName: basicInfo.displayName,
        avatarThumbnail,
        ...valuation,
        // Set only when the avatar endpoint was confirmed rate-limited and
        // this outfit is a last-known-good fallback rather than a fresh
        // read — see getWornAssetsWithStaleFallback.
        outfitStale: wornResult.stale,
        outfitStaleSince: wornResult.stale ? new Date(wornResult.staleSince).toISOString() : null,
        // The instant THIS valuation was actually computed — a "snapshot"
        // marker so a consumer (especially /battle) can tell two results
        // apart in time, and so a battle recorded from this result can be
        // audited/displayed as "as of <snapshotAt>" rather than implying
        // it's always perfectly live. Distinct from outfitStaleSince (when
        // the OUTFIT was last confirmed) — snapshotAt is when THIS
        // valuation (price data included) was assembled.
        snapshotAt: new Date().toISOString(),
    };
}

module.exports = { buildAvatarValuation, getMetrics };
