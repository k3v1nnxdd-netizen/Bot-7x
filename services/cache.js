'use strict';

// Simple in-memory TTL cache — single process, no persistence needed. Keeps
// this API from re-hitting Roblox for data that was just fetched a moment
// ago (e.g. the same player queried repeatedly from a Roblox leaderboard).
const store = new Map();

function get(key) {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return undefined;
    }
    return entry.value;
}

function set(key, value, ttlMs) {
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function getOrFetch(key, ttlMs, fetchFn) {
    const cached = get(key);
    if (cached !== undefined) return cached;
    const value = await fetchFn();
    set(key, value, ttlMs);
    return value;
}

// Periodic sweep so keys that are never queried again don't sit in memory
// forever — cheap, and keeps long-running uptime from slowly growing.
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
        if (now > entry.expiresAt) store.delete(key);
    }
}, 10 * 60_000).unref();

module.exports = { get, set, getOrFetch };
