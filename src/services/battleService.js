'use strict';

// Battle-specific business logic, extracted out of the route so
// src/api/routes/battle.js stays a thin HTTP adapter (parse params, call
// this, shape the response code) — everything about WHAT a battle result
// means lives here.
const avatarService = require('./avatarService');

function toPlayerSummary(data) {
    return {
        userId: data.userId,
        username: data.username,
        score: data.totalValue,
        rap: data.totalRAP,
        outfitValue: data.totalValue,
        limitedCount: data.limitedCount,
        // Set when Roblox's avatar endpoint was rate-limited and this score
        // is based on the last CONFIRMED outfit rather than a fresh read —
        // see getWornAssetsWithStaleFallback in avatarService.js. A
        // competitive result built on stale data should be visibly marked
        // as such, not silently presented as current.
        stale: data.outfitStale,
        staleSince: data.outfitStaleSince,
        snapshotAt: data.snapshotAt,
    };
}

// Runs one battle: fetches both players' valuations IN PARALLEL (so their
// snapshots land as close together in time as the underlying Roblox calls
// allow) and decides a winner. `snapshotConsistent` is the battle-level
// signal for "was this a clean, fully-live comparison" — false whenever
// EITHER side had to fall back to a stale cached outfit (see
// getWornAssetsWithStaleFallback), so a consumer can choose to flag/re-run a
// battle that was decided partly on old data instead of silently trusting
// it. This is the "outfit snapshot" guarantee for /battle: each player's
// result is one atomic, internally-consistent valuation (never a mix of
// prices from two different points in time within the SAME player), and the
// pair is timestamped so the comparison itself can be reasoned about after
// the fact.
async function runBattle(id1, id2, { fresh = false } = {}) {
    const [data1, data2] = await Promise.all([
        avatarService.buildAvatarValuation(id1, { fresh }),
        avatarService.buildAvatarValuation(id2, { fresh }),
    ]);

    const player1 = toPlayerSummary(data1);
    const player2 = toPlayerSummary(data2);

    let winner = null;
    const tie = player1.score === player2.score;
    if (!tie) {
        winner = player1.score > player2.score
            ? { userId: player1.userId, username: player1.username }
            : { userId: player2.userId, username: player2.username };
    }

    return {
        player1,
        player2,
        winner,
        tie,
        snapshotConsistent: !player1.stale && !player2.stale,
    };
}

module.exports = { runBattle };
