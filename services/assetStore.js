'use strict';

// GLOBAL, per-assetId, PERSISTENT registry of Roblox catalog structural data
// — the actual fix for "why are we re-asking Roblox for the same accessory
// over and over, once per player, forever". This is deliberately NOT a
// per-user cache: assetId 833772219 ("Amethyst Antlers") means the exact
// same thing — same name, same creator, same official price — no matter
// which of thousands of players is wearing it, so it's looked up and stored
// EXACTLY ONCE, ever, and every other player who wears it afterward (this
// process, or any future one, even after a restart) reads it back for free.
//
// Two independent stores, per services/persistentStore.js:
//   - `assets`       — one record per assetId: name/type/creator/official
//                       flag/known price/collectibleItemId/etc.
//   - `bundleLookup`  — one record per COMPONENT assetId: which bundle (if
//                       any) it belongs to (see ANIMATED_FACE_ASSET_TYPES in
//                       robloxAvatarService.js).
//
// What does NOT live here: RAP and lowestResalePrice-as-a-live-market-signal
// stay in the short-TTL ephemeral cache (services/cache.js) — those are
// genuinely dynamic (a Limited's trade price moves daily) and are refreshed
// on their own short cycle regardless of how long an asset's structural
// record has been known. See resolveRap in robloxAvatarService.js.
const { createPersistentStore } = require('./persistentStore');

const assets = createPersistentStore('assets');
const bundleLookup = createPersistentStore('bundleLookup');

// A NO_DATA record (Roblox's catalog batch call returned no entry at all for
// this id — deleted/moderated asset) is stable but not eternal: bounded so a
// permanently-invalid id doesn't get re-queried forever, while some future,
// currently-unknown circumstance where Roblox's answer changes eventually
// gets a chance to self-correct rather than being frozen in wrong state
// forever. 7 days is generous — a deleted/moderated asset essentially never
// comes back — while still meaningfully bounded, unlike the structural
// records below which have no expiry at all (see module docstring).
const NO_DATA_TTL_MS = 7 * 24 * 60 * 60_000;

const metrics = {
    assetHits: 0,
    assetMisses: 0,
    noDataHits: 0,
    noDataExpired: 0,
    bundleLookupHits: 0,
    bundleLookupMisses: 0,
};

function key(assetId) {
    return String(assetId);
}

// Returns the stored structural record for assetId, or undefined if never
// seen (or its NO_DATA marker expired). Shape matches roblox.js's
// getAssetDetails() output exactly (name, assetType, itemRestrictions,
// creatorName, creatorType, creatorTargetId, hasResellers, price,
// lowestPrice, lowestResalePrice, collectibleItemId, isOffSale) plus
// `storedAt`, so callers don't need to know or care whether a given record
// came from Roblox just now or from disk from three days ago.
function getAssetRecord(assetId) {
    const record = assets.get(key(assetId));
    if (!record) {
        metrics.assetMisses++;
        return undefined;
    }
    if (record.noData) {
        if (Date.now() - record.noDataAt > NO_DATA_TTL_MS) {
            assets.delete(key(assetId));
            metrics.noDataExpired++;
            metrics.assetMisses++;
            return undefined;
        }
        metrics.noDataHits++;
        return record;
    }
    metrics.assetHits++;
    return record;
}

function isNoData(record) {
    return !!record?.noData;
}

// Stores real catalog data for assetId — permanent (no TTL): see module
// docstring for why this is safe (structural facts about a catalog item
// essentially never change post-release).
function setAssetRecord(assetId, details) {
    assets.set(key(assetId), {
        noData: false,
        name: details.name,
        assetType: details.assetType,
        itemRestrictions: details.itemRestrictions,
        creatorName: details.creatorName,
        creatorType: details.creatorType,
        creatorTargetId: details.creatorTargetId,
        hasResellers: details.hasResellers,
        price: details.price,
        lowestPrice: details.lowestPrice,
        lowestResalePrice: details.lowestResalePrice,
        collectibleItemId: details.collectibleItemId,
        isOffSale: details.isOffSale,
        storedAt: Date.now(),
    });
}

// Remembers "Roblox's catalog has no entry for this id" — see NO_DATA_TTL_MS.
function setNoData(assetId) {
    assets.set(key(assetId), { noData: true, noDataAt: Date.now() });
}

// Component asset id -> matched bundle ({id, name, collectibleItemId}), or
// `null` meaning "confirmed: this component is NOT part of a genuine
// official Limited bundle" (e.g. a default/generic MoodAnimation that isn't
// tied to any real animated-face item) — both outcomes are worth
// remembering permanently, since re-hitting catalog/assets/{id}/bundles for
// an id we've already resolved either way is pure waste. `undefined` (vs
// `null`) means "never checked".
function getBundleForComponent(assetId) {
    const record = bundleLookup.get(key(assetId));
    if (record === undefined) {
        metrics.bundleLookupMisses++;
        return undefined;
    }
    metrics.bundleLookupHits++;
    return record.match;
}

function setBundleForComponent(assetId, match) {
    bundleLookup.set(key(assetId), { match, storedAt: Date.now() });
}

function getMetrics() {
    return {
        ...metrics,
        assets: assets.getMetrics(),
        bundleLookup: bundleLookup.getMetrics(),
    };
}

module.exports = {
    getAssetRecord,
    setAssetRecord,
    setNoData,
    isNoData,
    getBundleForComponent,
    setBundleForComponent,
    getMetrics,
};
