'use strict';

const roblox = require('../roblox');
const cache = require('./cache');
const { limitedRequest, limitedCatalogRequest } = require('./robloxRequestLimiter');

// TShirt (2) and Shirt (11) — flat 2D clothing textures, not real
// accessories with resale value. Excluded entirely, per spec.
const IGNORED_ASSET_TYPES = new Set([2, 11]);

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

// True Limited/LimitedUnique tag OR hasResellers=true (a real, currently
// active resale market) — the latter is included defensively in case a
// future item type has an active market without carrying the classic tag;
// in every real item sampled while building this, the two always agreed.
function isLimitedItem(details) {
    return details.itemRestrictions.includes('Limited')
        || details.itemRestrictions.includes('LimitedUnique')
        || details.hasResellers === true;
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
    // Caches the ENTIRE valuation per user, not just the sub-pieces above —
    // a cache hit here skips every Roblox call (including the catalog batch,
    // which is what's actually been 429ing), not just some of them. Matches
    // WORN_ASSETS since that's already the outfit-freshness ceiling; there's
    // no point re-deriving the same result from unchanged worn items sooner
    // than that.
    FULL_VALUATION: 5 * 60_000,
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
        // catalog.roblox.com specifically — routed through its own
        // proactive token bucket (10 req/60s), not the generic gate.
        const fresh = await limitedCatalogRequest(() => roblox.getAssetDetails(uncached));
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

    const detailsById = await getAssetDetailsCached(wornAssetIds);

    const kept = [];
    for (const assetId of wornAssetIds) {
        const details = detailsById.get(assetId);
        if (!details) continue; // deleted/moderated asset — ignore
        if (IGNORED_ASSET_TYPES.has(details.assetType)) continue; // 2D shirt/tshirt — ignore
        kept.push({
            assetId,
            details,
            isLimited: isLimitedItem(details),
            isOfficial: isOfficialRobloxItem(details),
        });
    }

    await Promise.all(kept.filter(k => k.isLimited).map(async k => {
        try {
            k.rap = await getRapCached(k.assetId);
        } catch (err) {
            // A failed RAP lookup shouldn't collapse a known-valuable Limited
            // to 0 — fall back to whatever resale price the catalog call
            // already gave us (still far more accurate than zeroing it out).
            console.warn(`[robloxAvatarService] RAP lookup failed for asset ${k.assetId}, falling back to lowestResalePrice:`, err.message);
            k.rap = k.details.lowestResalePrice || 0;
        }
    }));

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
