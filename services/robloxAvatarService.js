'use strict';

const roblox = require('../roblox');
const cache = require('./cache');
const { limitedRequest } = require('./robloxRequestLimiter');

// TShirt (2) and Shirt (11) — flat 2D clothing textures, not real
// accessories with resale value. Excluded entirely, per spec.
const IGNORED_ASSET_TYPES = new Set([2, 11]);

// Caps a single non-Limited item's contribution to the score, so one
// absurdly-priced fake/scam UGC listing can't dominate the total.
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

function isLimitedItem(details) {
    return details.itemRestrictions.includes('Limited') || details.itemRestrictions.includes('LimitedUnique');
}

// Cache TTLs. avatar (worn items) and RAP are both 5 minutes, as requested —
// worn items used to be 30s, which was the single biggest source of 429s
// against avatar.roblox.com (its documented limit is only 40 req/60s with
// no bulk alternative), so 5 min cuts that traffic by ~10x. ASSET_DETAILS
// ("accesorios" — name/type/price/creator) is intentionally kept at 30 min
// rather than lowered to 5 min: that data barely ever changes, and a longer
// TTL means FEWER requests to Roblox, not more — shortening it to 5 min
// would work against the actual goal here. Flagging this in case a strict
// 5-minute cache is wanted anyway.
const TTL = {
    USER_INFO: 30 * 60_000,
    THUMBNAIL: 10 * 60_000,
    WORN_ASSETS: 5 * 60_000,
    ASSET_DETAILS: 30 * 60_000,
    RAP: 5 * 60_000,
};

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

async function getAssetDetailsCached(assetIds) {
    const result = new Map();
    const uncached = [];
    for (const id of assetIds) {
        const cached = cache.get(`asset:${id}`);
        if (cached !== undefined) result.set(id, cached);
        else uncached.push(id);
    }
    if (uncached.length) {
        const fresh = await limitedRequest(() => roblox.getAssetDetails(uncached));
        for (const [id, details] of fresh) {
            cache.set(`asset:${id}`, details, TTL.ASSET_DETAILS);
            result.set(id, details);
        }
    }
    return result;
}

function getRapCached(assetId) {
    return cache.getOrFetch(`rap:${assetId}`, TTL.RAP, () => limitedRequest(() => roblox.getAssetRAP(assetId)));
}

// Valuations currently being computed, keyed by userId. GET /battle calls
// buildAvatarValuation for two different users, but if either of those is
// ALSO mid-flight for a separate concurrent /avatar request (or the same
// user appears in two battles at once), this makes the second caller join
// the first's in-flight work instead of re-running the whole pipeline (and
// re-hitting Roblox) a second time for the same user.
const inFlightValuations = new Map();

function buildAvatarValuation(userId) {
    if (inFlightValuations.has(userId)) return inFlightValuations.get(userId);

    const promise = buildAvatarValuationUncached(userId).finally(() => {
        inFlightValuations.delete(userId);
    });
    inFlightValuations.set(userId, promise);
    return promise;
}

// The single source of truth for "what is this avatar worth" — used
// directly by GET /avatar/:userId and reused (called twice) by
// GET /battle/:user1/:user2, so the valuation rules only live in one place.
async function buildAvatarValuationUncached(userId) {
    const [basicInfo, avatarThumbnail, wornAssetIds] = await Promise.all([
        getUserBasicInfo(userId),
        getAvatarThumbnail(userId),
        getWornAssets(userId),
    ]);

    const detailsById = await getAssetDetailsCached(wornAssetIds);

    const kept = [];
    for (const assetId of wornAssetIds) {
        const details = detailsById.get(assetId);
        if (!details) continue; // deleted/moderated asset — ignore
        if (IGNORED_ASSET_TYPES.has(details.assetType)) continue; // 2D shirt/tshirt — ignore
        kept.push({ assetId, details, isLimited: isLimitedItem(details) });
    }

    await Promise.all(kept.filter(k => k.isLimited).map(async k => {
        try {
            k.rap = await getRapCached(k.assetId);
        } catch (err) {
            console.warn(`[robloxAvatarService] RAP lookup failed for asset ${k.assetId}:`, err.message);
            k.rap = 0;
        }
    }));

    const accessories = kept.map(({ assetId, details, isLimited, rap }) => ({
        assetId,
        name: details.name,
        type: assetTypeName(details.assetType),
        isLimited,
        rap: isLimited ? (rap ?? 0) : null,
        price: isLimited ? null : Math.min(details.price || details.lowestResalePrice || 0, MAX_NON_LIMITED_ITEM_VALUE),
        creator: details.creatorName ?? 'Desconocido',
    }));

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

module.exports = { buildAvatarValuation };
