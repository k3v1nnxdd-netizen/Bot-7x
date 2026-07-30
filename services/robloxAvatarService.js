'use strict';

const roblox = require('../roblox');
const cache = require('./cache');
const robloxRequestLimiter = require('./robloxRequestLimiter');
const { limitedRequest, limitedCatalogRequest, limitedBundlesRequest } = robloxRequestLimiter;
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
// resale market (Limiteds) are exempt — see isOfficialRobloxItem/
// isLimitedItem below and how they're used in buildAvatarValuationUncached.
const MAX_NON_LIMITED_ITEM_VALUE = 10_000;

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

// True Limited/LimitedUnique tag, OR hasResellers=true (a real, currently
// active resale market — included defensively in case a future item has an
// active market without carrying the classic tag), OR the asset id is in
// the explicit KNOWN_LIMITED_IDS registry (data/knownLimitedItems.js) —
// a manually-curated safety net for specific known-important Limiteds, in
// case the automatic signals above ever miss one.
function isLimitedItem(details, assetId) {
    return details.itemRestrictions.includes('Limited')
        || details.itemRestrictions.includes('LimitedUnique')
        || details.hasResellers === true
        || KNOWN_LIMITED_IDS.has(assetId);
}

// Cache TTLs. avatar (worn items) and RAP are both 5 minutes, as requested —
// worn items used to be 30s, which was the single biggest source of 429s
// against avatar.roblox.com (its documented limit is only 40 req/60s with
// no bulk alternative), so 5 min cuts that traffic by ~10x. ASSET_DETAILS
// ("accesorios" — name/type/price/creator) is intentionally kept long rather
// than lowered: that data barely ever changes, and a longer TTL means FEWER
// requests to Roblox, not more. Raised from 30 min to 4h after catalog
// items/details got tightened live to as little as 1 request/60s (see
// robloxRequestLimiter.js) — at that rate, a 30-min TTL alone still forces
// far too many re-fetches of the SAME popular items across different
// players; 4h keeps a request queued behind the 1-token bucket the rare
// exception instead of the norm, at the cost of item price/name changes
// taking up to 4h to show up (an acceptable trade — official item prices
// essentially never change post-release).
const TTL = {
    USER_INFO: 30 * 60_000,
    THUMBNAIL: 10 * 60_000,
    WORN_ASSETS: 5 * 60_000,
    ASSET_DETAILS: 4 * 60 * 60_000,
    RAP: 5 * 60_000,
    // Which bundle a component asset belongs to is essentially permanent —
    // Roblox doesn't reshuffle bundle membership — so this can be cached far
    // longer than anything else here without going stale.
    BUNDLE_LOOKUP: 6 * 60 * 60_000,
    // Caches the ENTIRE valuation per user, not just the sub-pieces above —
    // a cache hit here skips every Roblox call (including the catalog batch,
    // which is what's actually been 429ing), not just some of them. Matches
    // WORN_ASSETS since that's already the outfit-freshness ceiling; there's
    // no point re-deriving the same result from unchanged worn items sooner
    // than that.
    FULL_VALUATION: 5 * 60_000,
};

// Lightweight in-memory counters — no external dependency, just enough to
// answer "is batching/dedup actually working" from the logs or a quick
// script under concurrent load, without guessing from timing alone.
const metrics = {
    assetDetailCacheHits: 0,          // resolved from cache.js, no fetch needed at all
    assetDetailDeduped: 0,            // joined an already-scheduled/in-flight fetch for that id
    assetDetailFetchesScheduled: 0,   // genuinely new ids scheduled into a batch
    assetDetailBatchesSent: 0,        // real POST calls actually sent to catalog.roblox.com
};

function getMetrics() {
    return { ...metrics, requestLimiter: robloxRequestLimiter.getMetrics() };
}

async function getUserBasicInfo(userId) {
    return cache.getOrFetch(`user:${userId}`, TTL.USER_INFO, () => limitedRequest(async () => {
        const profile = await roblox.getUserProfile(userId);
        return { username: profile.name, displayName: profile.displayName };
    }));
}

function getAvatarThumbnail(userId) {
    return cache.getOrFetch(`thumb:${userId}`, TTL.THUMBNAIL, () => limitedRequest(() => roblox.getAvatarImage(userId)));
}

function getWornAssets(userId) {
    return cache.getOrFetch(`worn:${userId}`, TTL.WORN_ASSETS, () => limitedRequest(() => roblox.getWornAssetIds(userId)));
}

// ── Batched + deduplicated asset-details fetch ─────────────────────────────
// catalog.roblox.com/v1/catalog/items/details has been observed throttled by
// Roblox down to as little as 1 request/60s (see robloxRequestLimiter.js) —
// under concurrent /avatar traffic, every avoidable call directly costs
// everyone behind it another 60s of queued latency. Every OTHER Roblox
// lookup in this file gets cache-first + in-flight dedup for free via
// cache.getOrFetch, but that helper is one-key-in-one-value-out and can't
// express "many ids batched into one call" — so this is a small dedicated
// loader doing the same job for the one path that needs real batching:
//   1. Cache-first — an id already cached (including a cached "confirmed no
//      data" result, see NO_DATA below) is never re-fetched.
//   2. In-flight dedup — if id X is already scheduled or mid-fetch (this
//      batch or a still-retrying previous one), a new caller asking for X
//      joins that exact same Promise instead of scheduling a duplicate.
//   3. Cross-request batching — ids requested by DIFFERENT concurrent
//      /avatar calls within a short window are folded into ONE POST,
//      instead of one POST per caller.

// Distinguishes "confirmed: Roblox has no data for this id" (deleted/
// moderated asset) from "not yet fetched" — cache.get() returns undefined
// for both a miss AND an expired entry, so a real cacheable value is needed
// to remember "no data" and stop re-fetching it on every single request.
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
            // catalog.roblox.com specifically — routed through its own
            // proactive, self-adjusting token bucket, not the generic gate.
            metrics.assetDetailBatchesSent++;
            const fresh = await limitedCatalogRequest(() => roblox.getAssetDetails(chunk));
            for (const id of chunk) {
                const details = fresh.get(id) ?? NO_DATA;
                cache.set(`asset:${id}`, details, TTL.ASSET_DETAILS);
                pendingAssetFetches.get(id)?.resolve(details);
                pendingAssetFetches.delete(id);
            }
        } catch (err) {
            // One failed chunk must not fail every OTHER caller sharing an
            // unrelated id from a different chunk/wave — each id's own
            // waiter is rejected individually; getAssetDetailsCached below
            // treats a per-id failure as "no data" for that id alone rather
            // than collapsing the whole valuation.
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
    const uniqueIds = [...new Set(assetIds)]; // dedupe before touching cache or scheduling anything

    await Promise.all(uniqueIds.map(async id => {
        const cached = cache.get(`asset:${id}`);
        if (cached !== undefined) {
            metrics.assetDetailCacheHits++;
            if (cached !== NO_DATA) result.set(id, cached);
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

function getRapCached(assetId) {
    return cache.getOrFetch(`rap:${assetId}`, TTL.RAP, () => limitedRequest(() => roblox.getAssetRAP(assetId)));
}

// Same as getRapCached, but for the newer GUID-keyed collectible economy
// (data/limitedBundles.js — the "animated face" Limiteds) via
// getCollectibleRAP. Same TTL: this is real-time market value, not a fixed
// price, so it still needs to stay fresh.
function getCollectibleRapCached(collectibleItemId) {
    return cache.getOrFetch(`collectible-rap:${collectibleItemId}`, TTL.RAP, () => limitedRequest(() => roblox.getCollectibleRAP(collectibleItemId)));
}

// Reverse lookup for a bundle component asset (see ANIMATED_FACE_ASSET_TYPES
// above) — routed through its own independent bucket (limitedBundlesRequest)
// rather than sharing limitedCatalogRequest's, since that one has been
// observed tightened by Roblox to as little as 1 request/60s; sharing it
// would let this unrelated route starve (or be starved by) that bottleneck.
function getBundlesForComponentCached(assetId) {
    return cache.getOrFetch(`bundle-for-asset:${assetId}`, TTL.BUNDLE_LOOKUP, () => limitedBundlesRequest(() => roblox.getBundlesForComponentAsset(assetId)));
}

// The single source of truth for "what is this avatar worth" — used
// directly by GET /avatar/:userId and reused (called twice) by
// GET /battle/:user1/:user2, so the valuation rules only live in one place.
// cache.getOrFetch gives this two things at once: a TTL cache of the WHOLE
// result (so a user queried again soon skips every Roblox call, not just
// some), and in-flight dedup for free (two concurrent requests for the same
// userId — e.g. that user showing up in two different /battle calls at
// once — join the same in-flight computation instead of running it twice).
function buildAvatarValuation(userId) {
    return cache.getOrFetch(`valuation:${userId}`, TTL.FULL_VALUATION, () => buildAvatarValuationUncached(userId));
}

async function buildAvatarValuationUncached(userId) {
    const [basicInfo, avatarThumbnail, wornAssetIds] = await Promise.all([
        getUserBasicInfo(userId),
        getAvatarThumbnail(userId),
        getWornAssets(userId),
    ]);

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
    // getBundlesForComponentCached above. Confirmed live: a bare
    // MoodAnimation/DynamicHead component carries no price data of its own
    // (it would otherwise silently value at 0), but Roblox's
    // catalog/v1/assets/{id}/bundles endpoint resolves it straight back to
    // its parent bundle — including live resale data — with no
    // pre-registration needed, so a brand-new animated face still gets
    // priced correctly the very first time anyone wears it.
    const discoveredBundleAssetIds = new Set();
    await Promise.all(remainingAssetIds.map(async assetId => {
        const details = detailsById.get(assetId);
        if (!details || !ANIMATED_FACE_ASSET_TYPES.has(details.assetType)) return;

        let bundles;
        try {
            bundles = await getBundlesForComponentCached(assetId);
        } catch (err) {
            console.warn(`[robloxAvatarService] Bundle reverse-lookup failed for asset ${assetId}:`, err.message);
            return;
        }

        const bundle = bundles.find(b =>
            b.creator?.id === 1 &&
            b.collectibleItemDetail &&
            (b.itemRestrictions?.includes('Limited') || b.itemRestrictions?.includes('LimitedUnique'))
        );
        if (!bundle) return; // not a genuine official Limited bundle — leave it to normal per-item pricing

        discoveredBundleAssetIds.add(assetId);
        if (!matchedLimitedBundles.has(bundle.id)) {
            matchedLimitedBundles.set(bundle.id, {
                id: bundle.id,
                name: bundle.name,
                collectibleItemId: bundle.collectibleItemDetail.collectibleItemId,
            });
            console.log(`[robloxAvatarService] Auto-detected uncurated animated face bundle "${bundle.name}" (id=${bundle.id}) via component asset ${assetId} — consider adding it to data/limitedBundles.js as a fast-path.`);
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
            try {
                k.rap = await getRapCached(k.assetId);
            } catch (err) {
                // A failed RAP lookup shouldn't collapse a known-valuable Limited
                // to 0 — fall back to whatever resale price the catalog call
                // already gave us (still far more accurate than zeroing it out).
                console.warn(`[robloxAvatarService] RAP lookup failed for asset ${k.assetId}, falling back to lowestResalePrice:`, err.message);
                k.rap = k.details.lowestResalePrice || 0;
            }
        }),
        ...[...matchedLimitedBundles.values()].map(async bundle => {
            try {
                bundle.rap = await getCollectibleRapCached(bundle.collectibleItemId);
            } catch (err) {
                console.warn(`[robloxAvatarService] Collectible RAP lookup failed for bundle ${bundle.id} (${bundle.name}):`, err.message);
                bundle.rap = 0;
            }
        }),
    ]);

    // Three distinct rules, per item:
    //  - Limited (official or UGC): market-verified via RAP — real trading
    //    activity, not something a creator can just set, so it's trusted
    //    uncapped regardless of who made it.
    //  - Official non-Limited (creatorTargetId 1): trusted Roblox data, used
    //    uncapped even when Offsale/no-longer-purchasable — Korblox
    //    Deathspeaker, for example, is Offsale with itemRestrictions:[] and
    //    hasResellers:false, but still carries a real historical price (475)
    //    that a null/0-only fallback chain would otherwise miss entirely.
    //  - Third-party UGC, non-Limited: the one case actually worth
    //    distrusting — capped, since nothing here stops a creator from
    //    listing a reskinned freebie at an absurd price with zero market
    //    backing to justify it.
    const accessories = kept.map(({ assetId, details, isLimited, isOfficial, rap }) => {
        let price = null;
        let rapValue = null;

        if (isLimited) {
            rapValue = rap ?? 0;
        } else if (isOfficial) {
            price = details.lowestResalePrice || details.price || details.lowestPrice || 0;
        } else {
            price = Math.min(details.price || details.lowestResalePrice || 0, MAX_NON_LIMITED_ITEM_VALUE);
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
        });
    }

    // One synthetic entry per matched Limited bundle — real-time RAP from
    // the collectible economy, same shape as a normal Limited item (see
    // data/limitedBundles.js).
    for (const bundle of matchedLimitedBundles.values()) {
        accessories.push({
            assetId: bundle.id,
            name: bundle.name,
            type: 'Bundle',
            isLimited: true,
            isOfficial: true,
            rap: bundle.rap ?? 0,
            price: null,
            creator: 'Roblox',
        });
    }

    const totalRAP = accessories.reduce((sum, a) => sum + (a.rap ?? 0), 0);
    const totalPrice = accessories.reduce((sum, a) => sum + (a.price ?? 0), 0);
    const limitedCount = accessories.filter(a => a.isLimited).length;

    return {
        userId,
        username: basicInfo.username,
        displayName: basicInfo.displayName,
        avatarThumbnail,
        accessories,
        totalValue: totalRAP + totalPrice,
        totalRAP,
        limitedCount,
    };
}

module.exports = { buildAvatarValuation, getMetrics };
