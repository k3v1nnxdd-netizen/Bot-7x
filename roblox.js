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

// Single lightweight check, no retry-on-not-found — callers own their own retry/backoff.
async function checkUsernameAvailable(username) {
    const res = await api.post(
        'https://users.roblox.com/v1/usernames/users',
        { usernames: [username], excludeBannedUsers: false },
        { headers: { 'Content-Type': 'application/json' } }
    );
    const found = res.data?.data?.[0];
    return !found;
}

// Checks many usernames in a single request — this endpoint accepts a batch,
// so checking e.g. 15 at once costs the same one request as checking 1,
// which is what lets the sniper go faster without hitting Roblox more often.
async function checkUsernamesAvailable(usernames) {
    const res = await api.post(
        'https://users.roblox.com/v1/usernames/users',
        { usernames, excludeBannedUsers: false },
        { headers: { 'Content-Type': 'application/json' } }
    );
    const taken = new Set((res.data?.data ?? []).map(u => u.requestedUsername));
    const result = {};
    for (const name of usernames) result[name] = !taken.has(name);
    return result;
}

async function isUserInGroup(userId, groupId) {
    const res = await retry(() =>
        api.get(`https://groups.roblox.com/v1/users/${userId}/groups/roles`)
    );
    return res.data?.data?.some(g => g.group?.id === Number(groupId)) ?? false;
}

// One page (100) of a group's member list.
async function getGroupMembersPage(groupId, cursor = null) {
    const query = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
    const res = await api.get(`https://groups.roblox.com/v1/groups/${groupId}/users?limit=100&sortOrder=Asc${query}`);
    return {
        members: (res.data?.data ?? []).map(m => ({ userId: m.user.userId, username: m.user.username })),
        nextCursor: res.data?.nextPageCursor ?? null,
    };
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

// Total Robux value of a set of assets — live resale price for
// limiteds/collectibles when available, otherwise the listed price.
async function getAssetsValue(assetIds) {
    if (assetIds.length === 0) return 0;
    const res = await postCatalogDetails(assetIds);
    const items = res.data?.data ?? [];
    return items.reduce((sum, item) => {
        const value = item.lowestResalePrice > 0 ? item.lowestResalePrice : (item.price || 0);
        return sum + value;
    }, 0);
}

module.exports = {
    getUserByUsername,
    getUserProfile,
    getFollowerCount,
    getFriendCount,
    getAvatarImage,
    getHeadshot,
    checkUsernameAvailable,
    checkUsernamesAvailable,
    isUserInGroup,
    getGroupMembersPage,
    getWornAssetIds,
    getAssetsValue,
};
