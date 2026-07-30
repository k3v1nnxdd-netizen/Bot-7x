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
    WORN_ASSETS: 20_000,
    FULL_VALUATION: 20_000,
};

const metrics = {
    staleWornAssetFallbacks: 0, // times a rate-limited avatar check served a last-known-good outfit instead of failing
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
// TTL cache above — this is what makes the stale-fallback below possible.
// Only ever updated on a genuinely successful live fetch (see
// getWornAssetsWithStaleFallback), never on a stale-served response, so it
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

// Fetches the user's currently-worn asset ids, with a narrow, explicit
// stale-data fallback: if Roblox's avatar endpoint is CONFIRMED rate-limited
// right now (the bucket's circuit is open — see src/roblox/rateLimiter.js —
// or Roblox answered with a 429 even after retries) AND we have a
// previously-confirmed-live outfit for this exact user, serve THAT instead
// of failing the whole valuation, clearly flagged as stale so callers (and
// ultimately /battle, which cares most) know not to treat it as guaranteed
// current. Deliberately narrow: any OTHER error (user not found, deleted
// account, genuine network failure with no prior data) still propagates —
// masking those with old data would be actively wrong, not just imprecise.
async function getWornAssetsWithStaleFallback(userId) {
    try {
        const assetIds = await cache.getOrFetch(`worn:${userId}`, TTL.WORN_ASSETS, () => roblox.getWornAssetIds(userId));
        lastKnownWornAssets.set(userId, { assetIds, fetchedAt: Date.now() });
        return { assetIds, stale: false, staleSince: null };
    } catch (err) {
        const isRateLimited = err instanceof CircuitOpenError || err?.response?.status === 429;
        const last = lastKnownWornAssets.get(userId);
        if (isRateLimited && last) {
            metrics.staleWornAssetFallbacks++;
            console.warn(
                `[avatarService] avatar.roblox.com rate-limited for user ${userId} — sirviendo el último outfit confirmado (${new Date(last.fetchedAt).toISOString()}) marcado como stale, en vez de fallar la valoración.`
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
    return cache.getOrFetch(key, TTL.FULL_VALUATION, () => buildAvatarValuationUncached(userId));
}

async function buildAvatarValuationUncached(userId) {
    const [basicInfo, avatarThumbnail, wornResult] = await Promise.all([
        getUserBasicInfo(userId),
        getAvatarThumbnail(userId),
        getWornAssetsWithStaleFallback(userId),
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
