'use strict';

// Map<key, expiresAt> — simple per-key cooldown / mutex
const locks = new Map();

function isLocked(key) {
    const exp = locks.get(key);
    if (exp === undefined) return false;
    if (Date.now() < exp) return true;
    locks.delete(key);
    return false;
}

function lock(key, durationMs) {
    locks.set(key, Date.now() + durationMs);
    // Auto-evict after expiry so the map stays small
    setTimeout(() => {
        const exp = locks.get(key);
        if (exp !== undefined && Date.now() >= exp) locks.delete(key);
    }, durationMs + 50);
}

function unlock(key) {
    locks.delete(key);
}

module.exports = { isLocked, lock, unlock };
