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

async function isUserInGroup(userId, groupId) {
    const res = await retry(() =>
        api.get(`https://groups.roblox.com/v1/users/${userId}/groups/roles`)
    );
    return res.data?.data?.some(g => g.group?.id === Number(groupId)) ?? false;
}

module.exports = {
    getUserByUsername,
    getUserProfile,
    getFollowerCount,
    getFriendCount,
    getAvatarImage,
    getHeadshot,
    checkUsernameAvailable,
    isUserInGroup,
};
