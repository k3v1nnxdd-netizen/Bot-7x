'use strict';

// Pure(ish) pricing logic: given a set of worn asset ids, decide what the
// outfit is worth. Deliberately separate from avatarService.js (which owns
// per-PLAYER concerns — profile info, thumbnail, worn-items fetch/caching,
// stale fallback) — this module only knows about ASSETS: is this one
// official, is it Limited, what's its real value, is it a bundle component.
// That split is what lets this be exercised directly against an arbitrary
// asset id list (see src/tests/) without needing a live user's avatar.
const roblox = require('../roblox/client');
const cache = require('../cache/memoryCache');
const assetRepository = require('../repositories/assetRepository');
const bundleRepository = require('../repositories/bundleRepository');
const { ASSET_TO_OVERRIDE } = require('../repositories/data/officialItemValues');
const { KNOWN_LIMITED_IDS } = require('../repositories/data/knownLimitedItems');
const { COMPONENT_TO_LIMITED_BUNDLE } = require('../repositories/data/limitedBundles');

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

// Only RAP is time-boxed here — structural per-asset data (name/creator/
// official price/bundle mapping) lives permanently in
// src/repositories/assetRepository.js + bundleRepository.js, not on a TTL,
// since it doesn't change per-player or meaningfully over time the way a
// Limited's trade price does.
const TTL = { RAP: 5 * 60_000 };

// Lightweight in-memory counters — enough to answer "is batching/dedup/
// persistence actually working" from the logs or a script under concurrent
// load, without guessing from timing alone. assetRepository/bundleRepository
// contribute their own sub-metrics — see getMetrics().
const metrics = {
    assetDetailPersistentHits: 0,    // resolved from assetRepository, no Roblox call needed at all
    assetDetailDeduped: 0,           // joined an already-scheduled/in-flight fetch for that id
    assetDetailFetchesScheduled: 0,  // genuinely new ids scheduled into a batch
    assetDetailBatchesSent: 0,       // real POST calls actually sent to catalog.roblox.com
    bundleLookupDeduped: 0,          // joined an already in-flight bundle reverse-lookup
};

function getMetrics() {
    return { ...metrics, assetRepository: assetRepository.getMetrics(), bundleRepository: bundleRepository.getMetrics() };
}

// ── Batched + deduplicated asset-details fetch ─────────────────────────────
// catalog.roblox.com/v1/catalog/items/details has been observed throttled by
// Roblox down to as little as 1 request/60s — under concurrent /avatar
// traffic, every avoidable call directly costs everyone behind it another
// 60s of queued latency. This is the one path that needs real batching
// ACROSS different concurrent callers, on top of assetRepository's
// permanent, cross-PROCESS-RESTART cache:
//   1. Persistent-store-first — an id already known (including a stored
//      "confirmed no data" result) is NEVER re-fetched, this run or any
//      future one, even after a restart. See assetRepository.js.
//   2. In-flight dedup — if id X is already scheduled or mid-fetch (this
//      batch or a still-retrying previous one), a new caller asking for X
//      joins that exact same Promise instead of scheduling a duplicate.
//   3. Cross-request batching — ids requested by DIFFERENT concurrent
//      /avatar calls within a short window are folded into ONE POST,
//      instead of one POST per caller.

// Distinguishes "confirmed: Roblox has no data for this id" from "not yet
// fetched" for the in-flight promise machinery below — assetRepository has
// its own equivalent (isNoData) for the persisted record shape; this symbol
// is purely an implementation detail of fetchAssetDetail/flushAssetBatch.
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
            // src/roblox/client.js already rate-limits/circuit-breaks this
            // route internally (catalog items/details bucket) — no wrapping
            // needed here.
            metrics.assetDetailBatchesSent++;
            const fresh = await roblox.getAssetDetails(chunk);
            for (const id of chunk) {
                const details = fresh.get(id);
                if (details) {
                    assetRepository.setAssetRecord(id, details);
                    pendingAssetFetches.get(id)?.resolve(details);
                } else {
                    assetRepository.setNoData(id);
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
        const stored = assetRepository.getAssetRecord(id);
        if (stored !== undefined) {
            metrics.assetDetailPersistentHits++;
            if (!assetRepository.isNoData(stored)) result.set(id, stored);
            return;
        }
        try {
            const details = await fetchAssetDetail(id);
            if (details !== NO_DATA) result.set(id, details);
        } catch (err) {
            console.warn(`[valuationService] Asset detail fetch failed for ${id}:`, err.message);
        }
    }));

    return result;
}

// PRIMARY RAP path — collectibleItemId-keyed, works uniformly for classic
// AND modern Limiteds (see roblox/client.js's getCollectibleRAP). Ephemeral,
// short-TTL: this is real-time market value, not a fixed price, so unlike
// assetRepository's structural records it MUST be refreshed regularly
// rather than trusted forever.
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
// support to an id that lacks it today. Deliberately ephemeral
// (memoryCache), NOT in assetRepository: unlike genuinely structural facts,
// this could legitimately change as Roblox's migration progresses.
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
// actually works today for ~every asset, confirmed live — see
// roblox/client.js); only falls back to the legacy per-assetId economy
// endpoint when there's no collectibleItemId to use at all. Returns null
// (not 0) when Roblox has no RAP data — callers decide how to treat "no
// data" themselves, since that means something different for an official
// item vs third-party UGC (see the accessories.map() pass below).
async function resolveRap(assetId, collectibleItemId) {
    const negKey = `no-rap:${assetId}`;
    if (cache.get(negKey) === true) return null;

    if (collectibleItemId) {
        try {
            return await getCollectibleRapCached(collectibleItemId);
        } catch (err) {
            if (!isStructuralRapFailure(err)) {
                console.warn(`[valuationService] Collectible RAP lookup failed for asset ${assetId} (transient, will retry next time):`, err.message);
                return null;
            }
            console.warn(`[valuationService] Collectible RAP lookup structurally unsupported for asset ${assetId}, trying legacy endpoint:`, err.message);
        }
    }

    try {
        return await getLegacyRapCached(assetId);
    } catch (err) {
        if (isStructuralRapFailure(err)) {
            cache.set(negKey, true, RAP_NEGATIVE_TTL);
            console.warn(`[valuationService] RAP unsupported for asset ${assetId} via any path — caching negative result for ${RAP_NEGATIVE_TTL / 60_000}min:`, err.message);
        } else {
            console.warn(`[valuationService] Legacy RAP lookup failed for asset ${assetId} (transient, will retry next time):`, err.message);
        }
        return null;
    }
}

// Reverse lookup for a bundle component asset (see ANIMATED_FACE_ASSET_TYPES
// above): given a component id, resolves + PERMANENTLY remembers (via
// bundleRepository) which genuine official Limited bundle it belongs to, if
// any — `null` is a valid, persisted answer meaning "confirmed not part of
// one". In-flight dedup (pendingBundleLookups) covers the gap
// bundleRepository itself doesn't (it's a synchronous Map, not a
// cache.getOrFetch-style promise-sharing helper) — without it, N concurrent
// players wearing the same brand-new animated face would trigger N
// identical reverse-lookups.
const pendingBundleLookups = new Map(); // assetId -> Promise<match | null>

async function getBundleForComponentCached(assetId) {
    const stored = bundleRepository.getBundleForComponent(assetId);
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
            bundleRepository.setBundleForComponent(assetId, match);
            return match;
        } finally {
            pendingBundleLookups.delete(assetId);
        }
    })();
    pendingBundleLookups.set(assetId, promise);
    return promise;
}

// The single source of truth for "what is this SET OF WORN ASSETS worth" —
// exercised directly (real batching/dedup/persistent-store/bundle-
// detection/RAP/pricing rules, zero mocking) against an arbitrary asset id
// list by both avatarService.js (a real user's live avatar, or — via
// buildAvatarValuationFromAssetIds — a Roblox server script's own report of
// a player's current outfit for POST /battle) and by src/tests/ (specific
// asset ids end-to-end).
async function valuateWornAssets(wornAssetIds) {
    // Deduped up front — avatar.roblox.com's own response never contains a
    // duplicate (a player can't equip the same accessory slot twice), so
    // this was always a no-op for that path. It stops being a no-op now
    // that assetIds can also arrive directly in an HTTP request body (POST
    // /battle): without this, a duplicate id in `wornAssetIds` would make
    // the `kept`-building loop below push the SAME asset into `accessories`
    // twice, double-counting its price/RAP in the total. The bundle-override
    // matching above this comment was already immune (Map keyed by the
    // bundle's own id, not the component's), but the per-item loop iterated
    // `remainingAssetIds` directly, so this is the one place that needed it.
    wornAssetIds = [...new Set(wornAssetIds)];

    // Detect known bundles — matched via their equipped COMPONENT assets,
    // since a bundle id is never itself a worn asset. Two kinds:
    //  - Official fixed-value bundles (Headless Horseman, Korblox, etc. —
    //    repositories/data/officialItemValues.js).
    //  - Limited "animated face" bundles with real, live resale value
    //    (Snowflake Eyes, Beast Mode, etc. — repositories/data/limitedBundles.js).
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
    // repositories/data/limitedBundles.js — see ANIMATED_FACE_ASSET_TYPES
    // and getBundleForComponentCached above. Confirmed live: a bare
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
            console.warn(`[valuationService] Bundle reverse-lookup failed for asset ${assetId}:`, err.message);
            return;
        }
        if (!match) return; // confirmed (possibly on a previous run, from bundleRepository): not a genuine official Limited bundle

        discoveredBundleAssetIds.add(assetId);
        if (!matchedLimitedBundles.has(match.id)) {
            matchedLimitedBundles.set(match.id, { id: match.id, name: match.name, collectibleItemId: match.collectibleItemId });
            console.log(`[valuationService] Auto-detected uncurated animated face bundle "${match.name}" (id=${match.id}) via component asset ${assetId} — consider adding it to repositories/data/limitedBundles.js as a fast-path.`);
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
    // trusted uncapped — see repositories/data/officialItemValues.js).
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
    // repositories/data/limitedBundles.js).
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

module.exports = { valuateWornAssets, getMetrics };
