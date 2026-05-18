'use strict';

// ── Per-key cooldown / mutex ──────────────────────────────────────────────────

const locks = new Map(); // key -> expiresAt (ms)

function isLocked(key) {
    const exp = locks.get(key);
    if (exp === undefined) return false;
    if (Date.now() < exp) return true;
    locks.delete(key);
    return false;
}

function lock(key, durationMs) {
    locks.set(key, Date.now() + durationMs);
    setTimeout(() => {
        const exp = locks.get(key);
        if (exp !== undefined && Date.now() >= exp) locks.delete(key);
    }, durationMs + 50);
}

function unlock(key) {
    locks.delete(key);
}

// ── Global interaction deduplication ─────────────────────────────────────────
// Discord gateway can resend the same interaction event on reconnect.
// Track every interaction.id we process; reject duplicates immediately.

const handledInteractions = new Set();

function markInteraction(id) {
    if (handledInteractions.has(id)) return false;
    handledInteractions.add(id);
    // Interaction tokens expire after 15 min — clean up after 20 min to be safe
    setTimeout(() => handledInteractions.delete(id), 20 * 60 * 1000);
    return true;
}

module.exports = { isLocked, lock, unlock, markInteraction };
