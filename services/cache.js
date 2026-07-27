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

// Requests already in flight for a given key, keyed the same as `store`.
// If two callers ask for the same uncached key at the same time (e.g. two
// Roblox game servers requesting the same player within milliseconds of
// each other), the second one joins the first's in-flight fetch instead of
// firing a duplicate request — this is on top of, not instead of, the TTL
// cache above.
const inFlight = new Map();

async function getOrFetch(key, ttlMs, fetchFn) {
    const cached = get(key);
    if (cached !== undefined) return cached;

    if (inFlight.has(key)) return inFlight.get(key);

    const promise = (async () => {
        try {
            const value = await fetchFn();
            set(key, value, ttlMs);
            return value;
        } finally {
            inFlight.delete(key);
        }
    })();

    inFlight.set(key, promise);
    return promise;
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
