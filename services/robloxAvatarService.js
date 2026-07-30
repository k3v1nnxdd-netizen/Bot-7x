'use strict';

const roblox = require('../roblox');
const cache = require('./cache');
const assetStore = require('./assetStore');
const robloxRequestLimiter = require('./robloxRequestLimiter');
const { CircuitOpenError } = robloxRequestLimiter;
const { ASSET_TO_OVERRIDE } = require('../data/officialItemValues');
const { KNOWN_LIMITED_IDS } = require('../data/knownLimitedItems');
const { COMPONENT_TO_LIMITED_BUNDLE } = require('../data/limitedBundles');

// TShirt (2) and Shirt (11) — flat 2D clothing textures, not real
// accessories with resale value. Excluded entirely, per spec.
const IGNORED_ASSET_TYPES = new Set([2, 11]);

// MoodAnimation (78) and DynamicHead (79) — the two component types every
// animated-face bundle is built from. Never worn standalone, and their bare
// per-asset catalog data carries no price at all (confirmed live) — so any
// one of these NOT already matched via data/limitedBundles.js gets a live
// reverse lookup (see getBundleForComponentCached) instead of silently
// pricing at 0.
const ANIMATED_FACE_ASSET_TYPES = new Set([78, 79]);

// Caps a single non-Limited, non-official (i.e. third-party UGC) item's
// contribution to the score, so one absurdly-priced fake/scam UGC listing
// can't dominate the total. Official Roblox items and anything with a real
// MARKET-VERIFIED resale value (a Limited with a real RAP — see resolveRap)
// are exempt — see isOfficialRobloxItem/isLimitedItem below and how they're
// used in valuateWornAssets.
const MAX_NON_LIMITED_ITEM_VALUE = 10_000;

// Same idea, same value, but a DIFFERENT case: a non-official (third-party
// UGC) Limited that Roblox has RAP data infrastructure for but returns
// `recentAveragePrice: null` for — meaning it has literally zero completed
// trades yet. Its only available number is then a reseller's current ASKING
// price (lowestResalePrice), which — unlike RAP — is just a number someone
// typed in, not verified by any real trade. For a Roblox-made item that's
// still fine (Roblox controls issuance directly), but for third-party UGC
// this is exactly the "manipulated price to fake value" scenario flagged as
// a priority to guard against, so it gets capped the same way an
// unverified UGC list price does. Kept as its own named constant (rather
// than reusing MAX_NON_LIMITED_ITEM_VALUE inline) so each cap site documents
// which specific risk it's guarding against. See the accessories.map() pass
// in valuateWornAssets below.
const MAX_UNVERIFIED_LIMITED_VALUE = 10_000;

const ASSET_TYPE_NAMES = {
    8: 'Hat', 12: 'Pants', 17: 'Head', 18: 'Face', 19: 'Gear',
    41: 'HairAccessory', 42: 'FaceAccessory', 43: 'NeckAccessory',
    44: 'ShoulderAccessory', 45: 'FrontAccessory', 46: 'BackAccessory',
    47: 'WaistAccessory', 64: 'ClimbAnimation', 78: 'MoodAnimation', 79: 'DynamicHead',
};

function assetTypeName(assetType) {
    return ASSET_TYPE_NAMES[assetType] ?? `Type_${assetType}`;
}

// Roblox's own corporate account — every genuinely official item (Headless
// Horseman, Korblox, Sparkle Time, official bundles/heads/faces, etc.) is
// created by this exact account. This is the only reliable signal: catalog
// search turns up dozens of UGC items with names like "Headless Horseman"
// or "Korblox Deathspeaker" made by random groups (verified live), so
// matching by name would be trivially exploitable.
function isOfficialRobloxItem(details) {
    return details.creatorType === 'User' && details.creatorTargetId === 1;
}

// True Limited/LimitedUnique/Collectible tag, OR hasResellers=true (a real,
// currently active resale market — included defensively in case a future
// item has an active market without carrying any of those tags), OR the
// asset id is in the explicit KNOWN_LIMITED_IDS registry
// (data/knownLimitedItems.js) — a manually-curated safety net for specific
// known-important Limiteds, in case the automatic signals above ever miss
// one.
//
// 'Collectible' (confirmed live, 2026-07) is Roblox's newer tag for
// UGC-minted limited-supply items — distinct from the classic
// 'Limited'/'LimitedUnique' tags, and NOT implied by them. Catching it here
// matters for fraud resistance specifically: catalog search turns up UGC
// items named "Dominus Empyreus" / "Black Sparkle Time Fedora" (creator:
// random Group, NOT Roblox) with `price` set to 618,033,988 and
// 987,654,321 respectively — itemRestrictions: ['Collectible'],
// hasResellers: false. Routing anything tagged 'Collectible' through the
// Limited/RAP pricing path means that fake `price` field is never even
// looked at (see valuateWornAssets — the Limited branch only trusts RAP and
// lowestResalePrice, never the creator-set `price`); both of those fake
// items have lowestResalePrice: 0 and no RAP data (zero real trades), so
// they correctly value at 0 either way. A genuinely-trading UGC collectible
// (e.g. "Golden Antlers", same fake-price pattern but hasResellers: true)
// was already caught by the hasResellers check below, and correctly prices
// off its real RAP (1,213 — confirmed live) instead of its fake price field.
function isLimitedItem(details, assetId) {
    return details.itemRestrictions.includes('Limited')
        || details.itemRestrictions.includes('LimitedUnique')
        || details.itemRestrictions.includes('Collectible')
        || details.hasResellers === true
        || KNOWN_LIMITED_IDS.has(assetId);
}

// Cache TTLs — only for genuinely DYNAMIC, per-user or per-market data.
// Structural per-asset data (name/creator/official price/bundle mapping)
// is NOT here anymore — it lives in services/assetStore.js, permanently
// and persistently, since it doesn't change per-player or over time the way
// everything below does. See assetStore.js's module docstring.
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
// as 1 req/60s). Those are already fully decoupled: item PRICING is stored
// by ASSET id (assetStore) and shared across every player wearing that item,
// completely independent of any single player's own outfit-check frequency.
// So shortening WORN_ASSETS/FULL_VALUATION does NOT increase load on the
// scarce resource at all. Callers that need a hard freshness guarantee
// regardless (e.g. right before recording a competitive /battle result) can
// force a live re-check via buildAvatarValuation(userId, { fresh: true }) —
// see below — WITHOUT ever touching assetStore (structural data is never
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
    RAP: 5 * 60_000,
    FULL_VALUATION: 20_000,
};

// Lightweight in-memory counters — enough to answer "is batching/dedup/
// persistence actually working" from the logs or a script under concurrent
// load, without guessing from timing alone. assetStore/robloxRequestLimiter
// contribute their own sub-metrics — see getMetrics().
const metrics = {
    assetDetailPersistentHits: 0,    // resolved from assetStore, no Roblox call needed at all
    assetDetailDeduped: 0,           // joined an already-scheduled/in-flight fetch for that id
    assetDetailFetchesScheduled: 0,  // genuinely new ids scheduled into a batch
    assetDetailBatchesSent: 0,       // real POST calls actually sent to catalog.roblox.com
    bundleLookupDeduped: 0,          // joined an already in-flight bundle reverse-lookup
    staleWornAssetFallbacks: 0,      // times a rate-limited avatar check served a last-known-good outfit instead of failing
};

function getMetrics() {
    return { ...metrics, assetStore: assetStore.getMetrics(), requestLimiter: robloxRequestLimiter.getMetrics() };
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
// periodic sweep below, consistent with cache.js's own cleanup pattern.
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
// right now (the bucket's circuit is open — see robloxRequestLimiter.js —
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
                `[robloxAvatarService] avatar.roblox.com rate-limited for user ${userId} — sirviendo el último outfit confirmado (${new Date(last.fetchedAt).toISOString()}) marcado como stale, en vez de fallar la valoración.`
            );
            return { assetIds: last.assetIds, stale: true, staleSince: last.fetchedAt };
        }
        throw err;
    }
}

// ── Batched + deduplicated asset-details fetch ─────────────────────────────
// catalog.roblox.com/v1/catalog/items/details has been observed throttled by
// Roblox down to as little as 1 request/60s — under concurrent /avatar
// traffic, every avoidable call directly costs everyone behind it another
// 60s of queued latency. This is the one path that needs real batching
// ACROSS different concurrent callers, on top of assetStore's permanent,
// cross-PROCESS-RESTART cache:
//   1. Persistent-store-first — an id already known (including a stored
//      "confirmed no data" result) is NEVER re-fetched, this run or any
//      future one, even after a restart. See services/assetStore.js.
//   2. In-flight dedup — if id X is already scheduled or mid-fetch (this
//      batch or a still-retrying previous one), a new caller asking for X
//      joins that exact same Promise instead of scheduling a duplicate.
//   3. Cross-request batching — ids requested by DIFFERENT concurrent
//      /avatar calls within a short window are folded into ONE POST,
//      instead of one POST per caller.

// Distinguishes "confirmed: Roblox has no data for this id" from "not yet
// fetched" for the in-flight promise machinery below — assetStore has its
// own equivalent (isNoData) for the persisted record shape; this symbol is
// purely an implementation detail of fetchAssetDetail/flushAssetBatch.
const NO_DATA = Symbol('no-data');

// Roblox's own per-call limit for this endpoint isn't documented; this just
// keeps any one POST body bounded even if an unusually large concurrent
// burst coalesces into one window, splitting into sequential (still
// rate-limited, still deduped) calls instead of ever sending one unbounded
// request.
const MAX_BATCH_SIZE = 100;
// Small enough to be an imperceptible latency add on top of the several
// other network hops a valuation already makes; large enough to reliably
// catch concurrent /avatar requests, which in practice arrive staggered by
// whatever their own upstream calls took rather than in the exact same tick.
const BATCH_COALESCE_MS = 100;

const pendingAssetFetches = new Map(); // assetId -> { promise, resolve, reject }
let scheduledAssetIds = new Set();
let assetBatchTimer = null;

function scheduleAssetBatchFlush() {
    if (assetBatchTimer) return;
    assetBatchTimer = setTimeout(flushAssetBatch, BATCH_COALESCE_MS);
}

async function flushAssetBatch() {
    assetBatchTimer = null;
    if (scheduledAssetIds.size === 0) return;
    const ids = [...scheduledAssetIds];
    scheduledAssetIds = new Set();

    for (let i = 0; i < ids.length; i += MAX_BATCH_SIZE) {
        const chunk = ids.slice(i, i + MAX_BATCH_SIZE);
        try {
            // roblox.js already rate-limits/circuit-breaks this route
            // internally (catalog items/details bucket) — no wrapping
            // needed here anymore.
            metrics.assetDetailBatchesSent++;
            const fresh = await roblox.getAssetDetails(chunk);
            for (const id of chunk) {
                const details = fresh.get(id);
                if (details) {
                    assetStore.setAssetRecord(id, details);
                    pendingAssetFetches.get(id)?.resolve(details);
                } else {
                    assetStore.setNoData(id);
                    pendingAssetFetches.get(id)?.resolve(NO_DATA);
                }
                pendingAssetFetches.delete(id);
            }
        } catch (err) {
            // One failed chunk must not fail every OTHER caller sharing an
            // unrelated id from a different chunk/wave — each id's own
            // waiter is rejected individually; getAssetDetailsCached below
            // treats a per-id failure as "no data" for that id alone rather
            // than collapsing the whole valuation. Deliberately NOT
            // persisted as NO_DATA — a fetch failure (429, network error,
            // circuit open) says nothing about whether Roblox actually has
            // data for this id, unlike a successful call that just omits it.
            for (const id of chunk) {
                pendingAssetFetches.get(id)?.reject(err);
                pendingAssetFetches.delete(id);
            }
        }
    }
}

// Promise<details | NO_DATA> for one asset id — joins an already-scheduled
// or in-flight fetch for that same id instead of scheduling a duplicate.
function fetchAssetDetail(assetId) {
    const existing = pendingAssetFetches.get(assetId);
    if (existing) {
        metrics.assetDetailDeduped++;
        return existing.promise;
    }

    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    pendingAssetFetches.set(assetId, { promise, resolve, reject });
    scheduledAssetIds.add(assetId);
    metrics.assetDetailFetchesScheduled++;
    scheduleAssetBatchFlush();
    return promise;
}

async function getAssetDetailsCached(assetIds) {
    const result = new Map();
    const uniqueIds = [...new Set(assetIds)]; // dedupe before touching the store or scheduling anything

    await Promise.all(uniqueIds.map(async id => {
        const stored = assetStore.getAssetRecord(id);
        if (stored !== undefined) {
            metrics.assetDetailPersistentHits++;
            if (!assetStore.isNoData(stored)) result.set(id, stored);
            return;
        }
        try {
            const details = await fetchAssetDetail(id);
            if (details !== NO_DATA) result.set(id, details);
        } catch (err) {
            console.warn(`[robloxAvatarService] Asset detail fetch failed for ${id}:`, err.message);
        }
    }));

    return result;
}

// PRIMARY RAP path — collectibleItemId-keyed, works uniformly for classic
// AND modern Limiteds (see roblox.js's getCollectibleRAP). Ephemeral,
// short-TTL: this is real-time market value, not a fixed price, so unlike
// assetStore's structural records it MUST be refreshed regularly rather
// than trusted forever.
function getCollectibleRapCached(collectibleItemId) {
    return cache.getOrFetch(`collectible-rap:${collectibleItemId}`, TTL.RAP, () => roblox.getCollectibleRAP(collectibleItemId));
}

// LEGACY fallback path — plain assetId-keyed, only reached when an asset has
// no collectibleItemId at all (see resolveRap below).
function getLegacyRapCached(assetId) {
    return cache.getOrFetch(`rap:${assetId}`, TTL.RAP, () => roblox.getAssetRAP(assetId));
}

// Remembers "RAP is not obtainable for this asset id via any path" so a
// worn item that structurally can't be RAP-priced (e.g. the rare asset with
// neither a collectibleItemId nor legacy economy support) doesn't retry —
// and fail, and log a warning — on every single valuation. Longer than
// TTL.RAP on purpose: this isn't "the price changed", it's "this id doesn't
// support the endpoint", a much more stable fact — but still bounded (not
// permanent), since Roblox's ongoing migration could add collectibleItemId
// support to an id that lacks it today. Deliberately ephemeral (cache.js),
// NOT in assetStore: unlike genuinely structural facts, this could
// legitimately change as Roblox's migration progresses.
const RAP_NEGATIVE_TTL = 30 * 60_000;

// Only a genuinely STRUCTURAL rejection (400/404 — "this id/endpoint
// combination will never work") is negative-cached. A transient error
// (timeout, 5xx, network blip, or the bucket's circuit being open) must NOT
// poison the cache — the next request deserves a fresh attempt, since
// nothing about the asset itself was confirmed unsupported.
function isStructuralRapFailure(err) {
    const status = err?.response?.status;
    return status === 400 || status === 404;
}

// The single entry point for "what is this Limited's RAP" — used for both
// normal worn Limited items and matched Limited bundles (see
// valuateWornAssets below). Prefers collectibleItemId (the path that
// actually works today for ~every asset, confirmed live — see roblox.js);
// only falls back to the legacy per-assetId economy endpoint when there's no
// collectibleItemId to use at all. Returns null (not 0) when Roblox has no
// RAP data — callers decide how to treat "no data" themselves, since that
// means something different for an official item vs third-party UGC (see
// the accessories.map() pass in valuateWornAssets).
async function resolveRap(assetId, collectibleItemId) {
    const negKey = `no-rap:${assetId}`;
    if (cache.get(negKey) === true) return null;

    if (collectibleItemId) {
        try {
            return await getCollectibleRapCached(collectibleItemId);
        } catch (err) {
            if (!isStructuralRapFailure(err)) {
                console.warn(`[robloxAvatarService] Collectible RAP lookup failed for asset ${assetId} (transient, will retry next time):`, err.message);
                return null;
            }
            console.warn(`[robloxAvatarService] Collectible RAP lookup structurally unsupported for asset ${assetId}, trying legacy endpoint:`, err.message);
        }
    }

    try {
        return await getLegacyRapCached(assetId);
    } catch (err) {
        if (isStructuralRapFailure(err)) {
            cache.set(negKey, true, RAP_NEGATIVE_TTL);
            console.warn(`[robloxAvatarService] RAP unsupported for asset ${assetId} via any path — caching negative result for ${RAP_NEGATIVE_TTL / 60_000}min:`, err.message);
        } else {
            console.warn(`[robloxAvatarService] Legacy RAP lookup failed for asset ${assetId} (transient, will retry next time):`, err.message);
        }
        return null;
    }
}

// Reverse lookup for a bundle component asset (see ANIMATED_FACE_ASSET_TYPES
// above): given a component id, resolves + PERMANENTLY remembers (via
// assetStore) which genuine official Limited bundle it belongs to, if any —
// `null` is a valid, persisted answer meaning "confirmed not part of one".
// In-flight dedup (pendingBundleLookups) covers the gap assetStore itself
// doesn't (it's a synchronous Map, not a cache.getOrFetch-style
// promise-sharing helper) — without it, N concurrent players wearing the
// same brand-new animated face would trigger N identical reverse-lookups.
const pendingBundleLookups = new Map(); // assetId -> Promise<match | null>

async function getBundleForComponentCached(assetId) {
    const stored = assetStore.getBundleForComponent(assetId);
    if (stored !== undefined) return stored;

    if (pendingBundleLookups.has(assetId)) {
        metrics.bundleLookupDeduped++;
        return pendingBundleLookups.get(assetId);
    }

    const promise = (async () => {
        try {
            const bundles = await roblox.getBundlesForComponentAsset(assetId);
            const found = bundles.find(b =>
                b.creator?.id === 1 &&
                b.collectibleItemDetail &&
                (b.itemRestrictions?.includes('Limited') || b.itemRestrictions?.includes('LimitedUnique'))
            );
            const match = found ? { id: found.id, name: found.name, collectibleItemId: found.collectibleItemDetail.collectibleItemId } : null;
            assetStore.setBundleForComponent(assetId, match);
            return match;
        } finally {
            pendingBundleLookups.delete(assetId);
        }
    })();
    pendingBundleLookups.set(assetId, promise);
    return promise;
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
// Deliberately does NOT touch assetStore (structural per-asset data:
// names/prices/bundle mappings) or the RAP cache — those describe the
// ASSET, not the PLAYER, so "this player wants a fresh check" has no
// bearing on whether item 833772219 is still named "Amethyst Antlers" or
// still costs 2500. Re-fetching known items' catalog data on every
// fresh=1 would reintroduce exactly the catalog/items/details load this
// whole pass exists to eliminate, for zero benefit — a player changing
// clothes can only ever change WHICH known (or newly-discovered) assetIds
// they're wearing, never what those assetIds mean.
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

    const valuation = await valuateWornAssets(wornResult.assetIds);

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
    };
}

// The single source of truth for "what is this SET OF WORN ASSETS worth" —
// split out from buildAvatarValuationUncached so it can be exercised
// directly (real batching/dedup/persistent-store/bundle-detection/RAP/
// pricing rules, zero mocking) against an arbitrary asset id list, not just
// a real user's live avatar. Used by both buildAvatarValuationUncached above
// and by scripts/tests that need to validate specific asset ids end-to-end.
async function valuateWornAssets(wornAssetIds) {
    // Detect known bundles — matched via their equipped COMPONENT assets,
    // since a bundle id is never itself a worn asset. Two kinds:
    //  - Official fixed-value bundles (Headless Horseman, Korblox, etc. —
    //    data/officialItemValues.js).
    //  - Limited "animated face" bundles with real, live resale value
    //    (Snowflake Eyes, Beast Mode, etc. — data/limitedBundles.js).
    // Wearing multiple pieces of the same bundle still only counts its
    // value once, and every matched component id is excluded from the
    // normal per-item pass below (and never even sent to catalog.roblox.com
    // for pricing) so it isn't also valued individually.
    const matchedOverrides = new Map(); // override.id -> override
    const matchedLimitedBundles = new Map(); // bundle.id -> bundle
    const overriddenAssetIds = new Set();
    for (const assetId of wornAssetIds) {
        const override = ASSET_TO_OVERRIDE.get(assetId);
        if (override) {
            matchedOverrides.set(override.id, override);
            overriddenAssetIds.add(assetId);
            continue;
        }
        const limitedBundle = COMPONENT_TO_LIMITED_BUNDLE.get(assetId);
        if (limitedBundle) {
            matchedLimitedBundles.set(limitedBundle.id, limitedBundle);
            overriddenAssetIds.add(assetId);
        }
    }
    const remainingAssetIds = wornAssetIds.filter(id => !overriddenAssetIds.has(id));

    const detailsById = await getAssetDetailsCached(remainingAssetIds);

    // Live auto-detection for animated-face bundles NOT already in
    // data/limitedBundles.js — see ANIMATED_FACE_ASSET_TYPES and
    // getBundleForComponentCached above. Confirmed live: a bare
    // MoodAnimation/DynamicHead component carries no price data of its own
    // (it would otherwise silently value at 0), but Roblox's
    // catalog/v1/assets/{id}/bundles endpoint resolves it straight back to
    // its parent bundle — including live resale data — with no
    // pre-registration needed, so a brand-new animated face still gets
    // priced correctly the very first time anyone wears it (and every
    // subsequent time, for any player, is a persistent-store hit).
    const discoveredBundleAssetIds = new Set();
    await Promise.all(remainingAssetIds.map(async assetId => {
        const details = detailsById.get(assetId);
        if (!details || !ANIMATED_FACE_ASSET_TYPES.has(details.assetType)) return;

        let match;
        try {
            match = await getBundleForComponentCached(assetId);
        } catch (err) {
            console.warn(`[robloxAvatarService] Bundle reverse-lookup failed for asset ${assetId}:`, err.message);
            return;
        }
        if (!match) return; // confirmed (possibly on a previous run, from assetStore): not a genuine official Limited bundle

        discoveredBundleAssetIds.add(assetId);
        if (!matchedLimitedBundles.has(match.id)) {
            matchedLimitedBundles.set(match.id, { id: match.id, name: match.name, collectibleItemId: match.collectibleItemId });
            console.log(`[robloxAvatarService] Auto-detected uncurated animated face bundle "${match.name}" (id=${match.id}) via component asset ${assetId} — consider adding it to data/limitedBundles.js as a fast-path.`);
        }
    }));

    const kept = [];
    for (const assetId of remainingAssetIds) {
        if (discoveredBundleAssetIds.has(assetId)) continue; // now represented as a synthetic Bundle entry instead
        const details = detailsById.get(assetId);
        if (!details) continue; // deleted/moderated asset — ignore
        if (IGNORED_ASSET_TYPES.has(details.assetType)) continue; // 2D shirt/tshirt — ignore
        kept.push({
            assetId,
            details,
            isLimited: isLimitedItem(details, assetId),
            isOfficial: isOfficialRobloxItem(details),
        });
    }

    await Promise.all([
        ...kept.filter(k => k.isLimited).map(async k => {
            k.rap = await resolveRap(k.assetId, k.details.collectibleItemId);
        }),
        ...[...matchedLimitedBundles.values()].map(async bundle => {
            // Bundles have no plain assetId of their own — bundle.id (a
            // synthetic catalog bundle id, never itself a worn asset) is
            // used purely as this call's negative-cache key namespace.
            bundle.rap = await resolveRap(bundle.id, bundle.collectibleItemId);
        }),
    ]);

    // Per-item valuation. Every branch is documented because getting this
    // wrong in either direction is the whole point of this system: undercount
    // and the "fronteo" score is useless; overcount and it's trivially
    // gameable with fake/manipulated listings.
    //
    //  - Limited, with a real RAP (recentAveragePrice from actual completed
    //    trades — Roblox computes this server-side, no single account can
    //    set it): trusted uncapped regardless of who made it. This is the
    //    industry-standard "true value" signal for a Limited.
    //  - Limited, with NO RAP (Roblox has zero completed trades for it —
    //    returns null, confirmed live, rather than erroring): the only
    //    number left is lowestResalePrice, a reseller's current ASKING
    //    price — not verified by any actual trade.
    //      - Official Roblox Limited: still trusted (Roblox controls
    //        issuance directly; not third-party-manipulable the way a
    //        listing price is).
    //      - Third-party UGC Limited: capped (MAX_UNVERIFIED_LIMITED_VALUE)
    //        — exactly the "asking price manipulated to fake value"
    //        scenario, since nothing here confirms anyone actually paid it.
    //  - Official non-Limited (creatorTargetId 1): trusted Roblox catalog
    //    price, uncapped, even when Offsale/no-longer-purchasable — Korblox
    //    Deathspeaker's components, for example, are Offsale with
    //    itemRestrictions:[] and hasResellers:false, but still carry a real
    //    historical `price` that a resale-only fallback chain would
    //    otherwise miss entirely. Confirmed live against assets
    //    553870650/833772219/99550579072279: Roblox keeps `price` populated
    //    at its last real value after an official item goes Offsale, so no
    //    manual registry is needed to recover it — whatever asset id shows
    //    up worn gets this treatment automatically.
    //  - Third-party UGC, non-Limited: the item most worth distrusting —
    //    capped (MAX_NON_LIMITED_ITEM_VALUE), since nothing stops a creator
    //    from listing a reskinned freebie at an absurd price with zero
    //    market backing.
    const accessories = kept.map(({ assetId, details, isLimited, isOfficial, rap }) => {
        let price = null;
        let rapValue = null;
        let valuationMethod;

        if (isLimited) {
            if (rap != null) {
                rapValue = rap;
                valuationMethod = 'rap';
            } else {
                const askingPrice = details.lowestResalePrice ?? 0;
                if (isOfficial) {
                    rapValue = askingPrice;
                    valuationMethod = askingPrice > 0 ? 'lowest_resale_fallback' : 'no_market_data';
                } else {
                    rapValue = Math.min(askingPrice, MAX_UNVERIFIED_LIMITED_VALUE);
                    valuationMethod = askingPrice > 0 ? 'unverified_limited_capped' : 'no_market_data';
                }
            }
        } else if (isOfficial) {
            price = details.price ?? details.lowestPrice ?? details.lowestResalePrice ?? 0;
            valuationMethod = 'official_catalog_price';
        } else {
            const rawPrice = details.price ?? details.lowestResalePrice ?? 0;
            price = Math.min(rawPrice, MAX_NON_LIMITED_ITEM_VALUE);
            valuationMethod = rawPrice > MAX_NON_LIMITED_ITEM_VALUE ? 'ugc_price_capped' : 'ugc_price';
        }

        return {
            assetId,
            name: details.name,
            type: assetTypeName(details.assetType),
            isLimited,
            isOfficial,
            rap: rapValue,
            price,
            creator: details.creatorName ?? 'Desconocido',
            // Transparency fields, additive only — rap/price above keep their
            // original meaning/shape for existing consumers of this API.
            // originalPrice: Roblox's own catalog list price (last known, if Offsale).
            // lowestResalePrice: current cheapest active resale listing, if any.
            // saleStatus: whether the item is currently purchasable from Roblox.
            // valuationMethod: which rule actually produced estimatedValue — see
            //   the big comment above this map() for what each method name means.
            // estimatedValue: the one number actually counted toward totalValue.
            originalPrice: details.price ?? null,
            lowestResalePrice: details.lowestResalePrice ?? null,
            saleStatus: details.isOffSale ? 'OffSale' : 'OnSale',
            valuationMethod,
            estimatedValue: rapValue ?? price ?? 0,
        };
    });

    // One synthetic entry per matched bundle override (curated value,
    // trusted uncapped — see data/officialItemValues.js).
    for (const override of matchedOverrides.values()) {
        accessories.push({
            assetId: override.id,
            name: override.name,
            type: 'Bundle',
            isLimited: false,
            isOfficial: true,
            rap: null,
            price: override.value,
            creator: 'Roblox',
            originalPrice: override.value,
            lowestResalePrice: null,
            saleStatus: 'OffSale',
            valuationMethod: 'bundle_override_fixed_price',
            estimatedValue: override.value,
        });
    }

    // One synthetic entry per matched Limited bundle — real-time RAP from
    // the collectible economy, same shape as a normal Limited item (see
    // data/limitedBundles.js).
    for (const bundle of matchedLimitedBundles.values()) {
        const rapValue = bundle.rap ?? 0;
        accessories.push({
            assetId: bundle.id,
            name: bundle.name,
            type: 'Bundle',
            isLimited: true,
            isOfficial: true,
            rap: rapValue,
            price: null,
            creator: 'Roblox',
            originalPrice: null,
            lowestResalePrice: null,
            saleStatus: 'OffSale',
            valuationMethod: bundle.rap != null ? 'bundle_rap' : 'no_market_data',
            estimatedValue: rapValue,
        });
    }

    const totalRAP = accessories.reduce((sum, a) => sum + (a.rap ?? 0), 0);
    const totalPrice = accessories.reduce((sum, a) => sum + (a.price ?? 0), 0);
    const limitedCount = accessories.filter(a => a.isLimited).length;

    return {
        accessories,
        totalValue: totalRAP + totalPrice,
        totalRAP,
        limitedCount,
    };
}

module.exports = { buildAvatarValuation, valuateWornAssets, getMetrics };
