'use strict';

const axios = require('axios');

const api = axios.create({ timeout: 8000 });

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
        api.post(
            'https://users.roblox.com/v1/usernames/users',
            { usernames: [username], excludeBannedUsers: false },
            { headers: { 'Content-Type': 'application/json' } }
        ).then(res => {
            const u = res.data?.data?.[0];
            if (!u?.id) throw new Error('not_found');
            return u;
        })
    );
}

async function getUserProfile(userId) {
    const res = await api.get(`https://users.roblox.com/v1/users/${userId}`);
    return res.data;
}

async function getFollowerCount(userId) {
    const res = await api.get(`https://friends.roblox.com/v1/users/${userId}/followers/count`);
    return res.data?.count ?? 0;
}

async function getFriendCount(userId) {
    const res = await api.get(`https://friends.roblox.com/v1/users/${userId}/friends/count`);
    return res.data?.count ?? 0;
}

async function getAvatarImage(userId) {
    const res = await api.get(
        `https://thumbnails.roblox.com/v1/users/avatar?userIds=${userId}&size=420x420&format=Png&isCircular=false`
    );
    return res.data?.data?.[0]?.imageUrl ?? null;
}

async function getHeadshot(userId) {
    const res = await api.get(
        `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=150x150&format=Png&isCircular=false`
    );
    return res.data?.data?.[0]?.imageUrl ?? null;
}

async function isUserInGroup(userId, groupId) {
    const res = await retry(() =>
        api.get(`https://groups.roblox.com/v1/users/${userId}/groups/roles`)
    );
    return res.data?.data?.some(g => g.group?.id === Number(groupId)) ?? false;
}

// Asset ids the user currently has equipped (their outfit).
async function getWornAssetIds(userId) {
    const res = await api.get(`https://avatar.roblox.com/v1/users/${userId}/avatar`);
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
// creatorTargetId, hasResellers, price, lowestPrice, lowestResalePrice}>;
// assets Roblox returns no data for (deleted, moderated, etc.) are simply
// absent — callers treat "no entry" as "skip". creatorType/creatorTargetId
// are what let a caller reliably tell an official Roblox item (creatorType
// "User", creatorTargetId 1) apart from third-party UGC — catalog search
// confirms plenty of UGC items reuse famous official names verbatim, so name
// matching alone is not a safe way to detect "official".
async function getAssetDetails(assetIds) {
    const details = new Map();
    if (assetIds.length === 0) return details;

    const res = await postCatalogDetails(assetIds);
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
        });
    }
    return details;
}

// Recent Average Price for a single Limited asset (the actual trading value,
// distinct from lowestResalePrice). Returns null if Roblox has no resale
// data for it. Documented at 50 req/60s — only ever called for items already
// confirmed Limited, so this is never a practical concern per-request.
async function getAssetRAP(assetId) {
    const res = await api.get(`https://economy.roblox.com/v1/assets/${assetId}/resale-data`);
    return res.data?.recentAveragePrice ?? null;
}

// Same idea as getAssetRAP, but for Roblox's newer GUID-keyed collectible
// economy (e.g. the newer "animated face" Limiteds — Snowflake Eyes, Beast
// Mode, etc.) — the classic economy.roblox.com/v1/assets/{id}/resale-data
// endpoint rejects their asset ids outright ("The asset id is invalid"),
// since they're not tracked in the legacy per-asset economy at all. This
// endpoint takes the item's `collectibleItemId` (a GUID, present on the
// catalog item's own details) instead, and returns the same
// `recentAveragePrice` field.
async function getCollectibleRAP(collectibleItemId) {
    const res = await api.get(`https://apis.roblox.com/marketplace-sales/v1/item/${collectibleItemId}/resale-data`);
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
    getAssetRAP,
    getCollectibleRAP,
};
