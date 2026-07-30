'use strict';

const roblox = require('../roblox');
const cache = require('./cache');
const robloxRequestLimiter = require('./robloxRequestLimiter');
const { limitedRequest, limitedCatalogRequest, limitedBundlesRequest, limitedRapRequest } = robloxRequestLimiter;
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
// used in buildAvatarValuationUncached.
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

// Cache TTLs.
//
// WORN_ASSETS/FULL_VALUATION were previously 5 minutes each, which caused a
// real bug: a player who changes outfit in Roblox and immediately checks
// their value here would see their OLD outfit for up to 5 minutes — bad for
// any use case, actively exploitable for a "fronteo"/flex-battle game (wear
// something expensive just long enough to get it cached, then swap back and
// keep the inflated cached score). That 5-min figure came from conflating
// two DIFFERENT Roblox resources: avatar.roblox.com/v1/users/{id}/avatar —
// confirmed live to send `cache-control: no-cache`, i.e. Roblox itself never
// serves a stale worn-items list, it's cheap (documented 40 req/60s, no bulk
// alternative), and it changes the instant a player re-equips something —
// versus catalog.roblox.com/v1/catalog/items/details, the genuinely scarce
// resource (tightened live to as little as 1 req/60s). Those are already
// fully decoupled: item PRICING is cached by ASSET id (ASSET_DETAILS, below)
// and shared across every player wearing that item, completely independent
// of any single player's own outfit-check frequency. So shortening
// WORN_ASSETS/FULL_VALUATION does NOT increase load on the scarce resource
// at all — it only increases calls to the cheap, always-fresh avatar
// endpoint, which is exactly what needs to happen for a "did they change
// clothes" check to actually be trustworthy. 20s keeps real burst protection
// (repeated UI refreshes, two /battle calls landing on the same player close
// together) while keeping staleness low enough to not matter in practice.
// Callers that need a hard freshness guarantee regardless (e.g. right before
// recording a competitive /battle result) can force a live re-check via
// buildAvatarValuation(userId, { fresh: true }) — see below.
//
// THUMBNAIL (the rendered avatar image) is also confirmed `cache-control:
// no-cache` on Roblox's side, but a full re-render after an outfit change
// has its own inherent server-side lag on Roblox's end regardless of how
// fast we re-check — so it's less urgent than the VALUE being right, and
// kept a bit longer (60s, still 10x shorter than the old 10min) purely to
// cut request volume for something that isn't the actual bug being fixed.
//
// ASSET_DETAILS ("accesorios" — name/type/price/creator) is intentionally
// kept long: that data barely ever changes, and a longer TTL means FEWER
// requests to Roblox, not more. 4h keeps a request queued behind catalog's
// 1-token bucket the rare exception instead of the norm, at the cost of
// item price/name changes taking up to 4h to show up (an acceptable trade —
// official item prices essentially never change post-release).
const TTL = {
    USER_INFO: 30 * 60_000,
    THUMBNAIL: 60_000,
    WORN_ASSETS: 20_000,
    ASSET_DETAILS: 4 * 60 * 60_000,
    RAP: 5 * 60_000,
    // Which bundle a component asset belongs to is essentially permanent —
    // Roblox doesn't reshuffle bundle membership — so this can be cached far
    // longer than anything else here without going stale.
    BUNDLE_LOOKUP: 6 * 60 * 60_000,
    // Caches the ENTIRE valuation per user, not just the sub-pieces above —
    // a cache hit here skips every Roblox call, not just some of them.
    // Matches WORN_ASSETS since that's already the outfit-freshness ceiling;
    // there's no point re-deriving the same result from unchanged worn items
    // sooner than that.
    FULL_VALUATION: 20_000,
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

// PRIMARY RAP path — collectibleItemId-keyed, works uniformly for classic
// AND modern Limiteds (see roblox.js's getCollectibleRAP). Routed through
// its own proactive token bucket (limitedRapRequest, 50 req/60s observed)
// rather than the generic concurrency gate, same rationale as the catalog
// buckets above. Same TTL as the legacy path: real-time market value, not a
// fixed price, so it still needs to stay fresh.
function getCollectibleRapCached(collectibleItemId) {
    return cache.getOrFetch(`collectible-rap:${collectibleItemId}`, TTL.RAP, () => limitedRapRequest(() => roblox.getCollectibleRAP(collectibleItemId)));
}

// LEGACY fallback path — plain assetId-keyed, only reached when an asset has
// no collectibleItemId at all (see resolveRap below). Kept on the generic
// concurrency gate rather than its own bucket: expected to be hit rarely
// enough now that a dedicated bucket isn't worth the complexity.
function getLegacyRapCached(assetId) {
    return cache.getOrFetch(`rap:${assetId}`, TTL.RAP, () => limitedRequest(() => roblox.getAssetRAP(assetId)));
}

// Remembers "RAP is not obtainable for this asset id via any path" so a
// worn item that structurally can't be RAP-priced (e.g. the rare asset with
// neither a collectibleItemId nor legacy economy support) doesn't retry —
// and fail, and log a warning — on every single valuation. Longer than
// TTL.RAP on purpose: this isn't "the price changed", it's "this id doesn't
// support the endpoint", a much more stable fact — but still bounded (not
// permanent), since Roblox's ongoing migration could add collectibleItemId
// support to an id that lacks it today.
const RAP_NEGATIVE_TTL = 30 * 60_000;

// Only a genuinely STRUCTURAL rejection (400/404 — "this id/endpoint
// combination will never work") is negative-cached. A transient error
// (timeout, 5xx, network blip) must NOT poison the cache — the next request
// deserves a fresh attempt, since nothing about the asset itself was
// confirmed unsupported.
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
//
// `fresh: true` forces a guaranteed-live recheck, bypassing TTL.FULL_VALUATION
// and TTL.WORN_ASSETS entirely for this call — for callers where a stale
// (even 20s-stale) outfit snapshot is unacceptable, e.g. right before
// recording a competitive /battle result, where a 20s cache window would
// otherwise be a real (if narrow) window to game the score by briefly
// wearing something expensive. Normal /avatar traffic should NOT pass this —
// it turns off burst protection for that one call, and the default 20s
// window is already short enough that nobody will notice it.
function buildAvatarValuation(userId, { fresh = false } = {}) {
    const key = `valuation:${userId}`;
    if (fresh) {
        cache.invalidate(key);
        cache.invalidate(`worn:${userId}`);
    }
    return cache.getOrFetch(key, TTL.FULL_VALUATION, () => buildAvatarValuationUncached(userId));
}

async function buildAvatarValuationUncached(userId) {
    const [basicInfo, avatarThumbnail, wornAssetIds] = await Promise.all([
        getUserBasicInfo(userId),
        getAvatarThumbnail(userId),
        getWornAssets(userId),
    ]);

    const valuation = await valuateWornAssets(wornAssetIds);

    return {
        userId,
        username: basicInfo.username,
        displayName: basicInfo.displayName,
        avatarThumbnail,
        ...valuation,
    };
}

// The single source of truth for "what is this SET OF WORN ASSETS worth" —
// split out from buildAvatarValuationUncached so it can be exercised
// directly (real batching/dedup/cache/bundle-detection/RAP/pricing rules,
// zero mocking) against an arbitrary asset id list, not just a real user's
// live avatar. Used by both buildAvatarValuationUncached above and by
// scripts/tests that need to validate specific asset ids end-to-end.
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
