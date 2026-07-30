'use strict';

const axios = require('axios');
const {
    limitedUsernameLookupRequest, observeUsernameLookupLimit,
    limitedUserProfileRequest, observeUserProfileLimit,
    limitedFriendsRequest, observeFriendsLimit,
    limitedThumbnailRequest, observeThumbnailLimit,
    limitedGroupsRequest, observeGroupsLimit,
    limitedAvatarRequest, observeAvatarLimit,
    limitedCatalogRequest, observeCatalogLimit,
    limitedBundlesRequest, observeBundlesLimit,
    limitedLegacyRapRequest, observeLegacyRapLimit,
    limitedRapRequest, observeRapLimit,
} = require('./services/robloxRequestLimiter');

const api = axios.create({ timeout: 8000 });

// This module is the ONLY place that talks to Roblox's HTTP APIs — every
// exported function here goes through its own rate-limit bucket (see
// services/robloxRequestLimiter.js), so EVERY caller gets the same
// protection automatically, whether it's the cached /avatar valuation
// pipeline (services/robloxAvatarService.js) or a one-off Discord command
// (handlers/commands.js, handlers/modals.js) that used to call straight
// into axios with no rate awareness at all — confirmed live: that second
// path was hitting users.roblox.com/friends.roblox.com/thumbnails.roblox.com
// completely unmanaged, on every single /outfit command, with no caching
// and only a blind flat-delay retry. Roblox rate-limits by IP, not by which
// part of our code made the call, so any unmanaged caller can still burn
// through (or help trigger tightened, possibly punitive) limits that then
// affect the valuation API too. Centralizing here closes that gap for good
// instead of requiring every future caller to remember to wrap its calls.
async function retry(fn, attempts = 2, delayMs = 1200) {
    for (let i = 0; i <= attempts; i++) {
        try { return await fn(); }
        catch (err) {
            if (i === attempts) throw err;
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
}

async function getUserByUsername(username) {
    return retry(() =>
        limitedUsernameLookupRequest(() => api.post(
            'https://users.roblox.com/v1/usernames/users',
            { usernames: [username], excludeBannedUsers: false },
            { headers: { 'Content-Type': 'application/json' } }
        )).then(res => {
            observeUsernameLookupLimit(res.headers);
            const u = res.data?.data?.[0];
            if (!u?.id) throw new Error('not_found');
            return u;
        })
    );
}

async function getUserProfile(userId) {
    const res = await limitedUserProfileRequest(() => api.get(`https://users.roblox.com/v1/users/${userId}`));
    observeUserProfileLimit(res.headers);
    return res.data;
}

async function getFollowerCount(userId) {
    const res = await limitedFriendsRequest(() => api.get(`https://friends.roblox.com/v1/users/${userId}/followers/count`));
    observeFriendsLimit(res.headers);
    return res.data?.count ?? 0;
}

async function getFriendCount(userId) {
    const res = await limitedFriendsRequest(() => api.get(`https://friends.roblox.com/v1/users/${userId}/friends/count`));
    observeFriendsLimit(res.headers);
    return res.data?.count ?? 0;
}

async function getAvatarImage(userId) {
    const res = await limitedThumbnailRequest(() => api.get(
        `https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`
    ));
    observeThumbnailLimit(res.headers);
    return res.data?.data?.[0]?.imageUrl ?? null;
}

async function getHeadshot(userId) {
    const res = await limitedThumbnailRequest(() => api.get(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`
    ));
    observeThumbnailLimit(res.headers);
    return res.data?.data?.[0]?.imageUrl ?? null;
}

async function isUserInGroup(userId, groupId) {
    const res = await retry(() =>
        limitedGroupsRequest(() => api.get(`https://groups.roblox.com/v1/users/${userId}/groups/roles`))
    );
    observeGroupsLimit(res.headers);
    return res.data?.data?.some(g => g.group?.id === Number(groupId)) ?? false;
}

// Asset ids the user currently has equipped (their outfit). THE route that
// triggered this whole rate-limiter rework: documented at ~40 req/60s, but
// observed live tightened to 6 req/3600s — see robloxRequestLimiter.js's
// avatar bucket and the report for what's believed to cause that.
async function getWornAssetIds(userId) {
    const res = await limitedAvatarRequest(() => api.get(`https://avatar.roblox.com/v1/users/${userId}/avatar`));
    observeAvatarLimit(res.headers);
    return (res.data?.assets ?? []).map(a => a.id);
}

// catalog.roblox.com requires an XSRF token — cache it and only refresh
// when Roblox rejects a stale one, instead of doing the 403 dance every call.
let catalogCsrfToken = null;

async function postCatalogDetails(assetIds) {
    const body = { items: assetIds.map(id => ({ itemType: 'Asset', id })) };
    const headers = { 'Content-Type': 'application/json' };
    if (catalogCsrfToken) headers['x-csrf-token'] = catalogCsrfToken;

    try {
        return await api.post('https://catalog.roblox.com/v1/catalog/items/details', body, { headers });
    } catch (err) {
        const freshToken = err.response?.status === 403 && err.response.headers['x-csrf-token'];
        if (!freshToken) throw err;
        catalogCsrfToken = freshToken;
        return api.post('https://catalog.roblox.com/v1/catalog/items/details', body, {
            headers: { ...headers, 'x-csrf-token': catalogCsrfToken },
        });
    }
}

// Full item details for many assets in one request, via the batched/
// CSRF-handled catalog call. Returns
// Map<assetId, {name, assetType, itemRestrictions, creatorName, creatorType,
// creatorTargetId, hasResellers, price, lowestPrice, lowestResalePrice,
// collectibleItemId, isOffSale}>; assets Roblox returns no data for
// (deleted, moderated, etc.) are simply absent — callers treat "no entry" as
// "skip". creatorType/creatorTargetId are what let a caller reliably tell an
// official Roblox item (creatorType "User", creatorTargetId 1) apart from
// third-party UGC — catalog search confirms plenty of UGC items reuse famous
// official names verbatim, so name matching alone is not a safe way to
// detect "official".
//
// collectibleItemId (a GUID) is the key to real-time resale/RAP data — see
// getCollectibleRAP below. Confirmed live (2026-07): Roblox has migrated
// essentially the ENTIRE catalog, not just modern "collectible" Limiteds, to
// expose this field — plain off-sale non-Limited hats and decades-old
// classic Limiteds alike all carry one now. This matters because the
// legacy economy.roblox.com/v1/assets/{id}/resale-data endpoint (keyed by
// plain assetId) has been observed returning 400 "The asset id is invalid"
// for a growing, unpredictable subset of classic Limiteds mid-migration —
// while the collectibleItemId-keyed endpoint works uniformly for all of
// them. isOffSale distinguishes "still purchasable at `price`" from
// "discontinued, `price` is the last known list price" for the API
// response's transparency fields — it does NOT gate whether `price` is
// trusted (Roblox keeps it populated either way, confirmed live against
// assets 553870650/833772219/99550579072279).
//
// THE most rate-limited route in this whole file — tightened by Roblox to
// as little as 1 req/60s in production. This is exactly why
// services/assetStore.js exists: once ANY player's valuation has resolved
// assetId X through this call, it's stored globally and permanently, so NO
// other player — this session or a future one, even after a process
// restart — ever needs to call this for that same id again. See
// services/robloxAvatarService.js's getAssetDetailsCached/flushAssetBatch
// for the batching + in-flight dedup on top of that.
async function getAssetDetails(assetIds) {
    const details = new Map();
    if (assetIds.length === 0) return details;

    const res = await limitedCatalogRequest(() => postCatalogDetails(assetIds));
    observeCatalogLimit(res.headers);
    const items = res.data?.data ?? [];
    for (const item of items) {
        details.set(item.id, {
            name: item.name,
            assetType: item.assetType,
            itemRestrictions: item.itemRestrictions ?? [],
            creatorName: item.creatorName,
            creatorType: item.creatorType,
            creatorTargetId: item.creatorTargetId,
            hasResellers: item.hasResellers,
            price: item.price,
            lowestPrice: item.lowestPrice,
            lowestResalePrice: item.lowestResalePrice,
            collectibleItemId: item.collectibleItemId ?? null,
            isOffSale: item.isOffSale === true,
        });
    }
    return details;
}

// Reverse lookup: given a bundle COMPONENT asset id (e.g. an animated
// face's "-Head" or "-Mood" piece, assetType 79/78), returns the bundle(s)
// it belongs to — full details included (creator, itemRestrictions,
// collectibleItemDetail with live price/resale data). Confirmed live: this
// lets a worn animated-face bundle be identified and priced correctly even
// when it isn't in data/limitedBundles.js's curated list — Roblox exposes
// no way to enumerate "all animated face bundles" up front (catalog search
// ignores bundleType/category filters), but resolving component -> bundle
// on demand, per worn item, works perfectly and needs no pre-registration.
// The RESULT (which bundle, if any) is permanently cached per component id
// in services/assetStore.js, same rationale as getAssetDetails above.
async function getBundlesForComponentAsset(assetId) {
    const res = await limitedBundlesRequest(() => api.get(`https://catalog.roblox.com/v1/assets/${assetId}/bundles`));
    observeBundlesLimit(res.headers);
    return res.data?.data ?? [];
}

// LEGACY fallback only — see getCollectibleRAP below, which is now the
// PRIMARY RAP source for essentially every Limited (classic or modern).
// Recent Average Price for a single Limited asset, keyed by plain assetId,
// via the old per-asset economy. Returns null if Roblox has no resale data
// for it. Confirmed live (2026-07): this endpoint now 400s ("The asset id is
// invalid") for a growing, unpredictable subset of classic Limiteds as
// Roblox migrates them to the unified collectible economy — e.g. Pinstripe
// Fedora (14463095) and Bunny Ears (1080949) both 400 here today, while
// Valkyrie Helm and Dominus Praefectus still happen to work. Since which
// items still work is not predictable from itemRestrictions/hasResellers
// (Roblox's migration state, not ours), this is only used as a last-resort
// fallback for the rare asset with no collectibleItemId at all — see
// resolveRap in robloxAvatarService.js. Documented at 50 req/60s.
async function getAssetRAP(assetId) {
    const res = await limitedLegacyRapRequest(() => api.get(`https://economy.roblox.com/v1/assets/${assetId}/resale-data`));
    observeLegacyRapLimit(res.headers);
    return res.data?.recentAveragePrice ?? null;
}

// PRIMARY RAP source for both classic Limiteds (Pinstripe Fedora, Valkyrie
// Helm, ...) and Roblox's newer GUID-keyed collectible Limiteds (the
// "animated face" bundles — Snowflake Eyes, Beast Mode, etc.). Confirmed
// live (2026-07): virtually every catalog item — Limited or not, decades-old
// or brand new — now carries a `collectibleItemId` (see getAssetDetails
// above), and this endpoint resolves real recentAveragePrice/volume data for
// all of them uniformly, unlike the legacy per-assetId endpoint above whose
// per-item migration state is unpredictable. For a non-Limited item it
// returns `recentAveragePrice: null` cleanly (confirmed live) rather than
// erroring, so it's safe to call for anything with a collectibleItemId.
// Rate limit observed live: 50 req/60s (see robloxRequestLimiter.js's
// dedicated bucket for this route). This is intentionally NOT cached in
// assetStore (permanent storage) — a Limited's trade price is genuinely
// dynamic and refreshed on its own short TTL regardless of how long the
// asset's structural record has been known; see resolveRap.
async function getCollectibleRAP(collectibleItemId) {
    const res = await limitedRapRequest(() => api.get(`https://apis.roblox.com/marketplace-sales/v1/item/${collectibleItemId}/resale-data`));
    observeRapLimit(res.headers);
    return res.data?.recentAveragePrice ?? null;
}

module.exports = {
    getUserByUsername,
    getUserProfile,
    getFollowerCount,
    getFriendCount,
    getAvatarImage,
    getHeadshot,
    isUserInGroup,
    getWornAssetIds,
    getAssetDetails,
    getBundlesForComponentAsset,
    getAssetRAP,
    getCollectibleRAP,
};
