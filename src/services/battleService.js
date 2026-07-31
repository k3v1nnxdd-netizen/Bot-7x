'use strict';

// Battle-specific business logic, extracted out of the route so
// src/api/routes/battle.js stays a thin HTTP adapter (parse params/body,
// call this, shape the response code) — everything about WHAT a battle
// result means lives here.
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
        // 'client' when this player's outfit came from assetIds supplied
        // directly in the POST /battle body (no avatar.roblox.com call at
        // all); 'roblox' when it came from the normal live/cached avatar
        // check. See avatarService.js's buildAvatarValuationFromAssetIds.
        outfitSource: data.outfitSource,
        snapshotAt: data.snapshotAt,
    };
}

function composeBattleResult(data1, data2) {
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
//
// This is the OLD path (GET /battle/:user1/:user2, kept for compatibility
// and as the fallback when a caller doesn't supply assetIds — see
// runBattleFromPayload below): both players' outfits are fetched live from
// (or cached/SWR'd from) avatar.roblox.com.
async function runBattle(id1, id2, { fresh = false } = {}) {
    const [data1, data2] = await Promise.all([
        avatarService.buildAvatarValuation(id1, { fresh }),
        avatarService.buildAvatarValuation(id2, { fresh }),
    ]);
    return composeBattleResult(data1, data2);
}

// Resolves ONE player's valuation for the payload-driven path (POST
// /battle): if the caller supplied assetIds (already strictly validated and
// normalized upstream — see src/security/validateBattlePayload.js), those
// are trusted as this player's current outfit and priced directly, with
// ZERO avatar.roblox.com calls. If assetIds was omitted entirely for this
// player, falls back to the normal live/cached avatar check — this is the
// "compatibilidad o casos donde no recibamos una lista válida" fallback the
// feature was asked to keep: an omission degrades gracefully to the old
// behavior for that one player, it doesn't fail the whole battle.
async function resolvePlayerValuation({ userId, assetIds }, { fresh }) {
    if (assetIds !== undefined) {
        return avatarService.buildAvatarValuationFromAssetIds(userId, assetIds);
    }
    return avatarService.buildAvatarValuation(userId, { fresh });
}

// The NEW path: both players' userId + current outfit (assetIds) supplied
// in one request by a Roblox server script that already knows firsthand
// what each player has equipped, because they're both live in that server.
// Skips avatar.roblox.com for any player whose assetIds were supplied —
// Railway remains the sole authority on VALUE (price/RAP/limited-status/
// bundle rules all still run through the exact same valuationService used
// everywhere else); the game only ever supplies WHAT a player is wearing,
// never what it's worth.
async function runBattleFromPayload({ player1, player2 }, { fresh = false } = {}) {
    const [data1, data2] = await Promise.all([
        resolvePlayerValuation(player1, { fresh }),
        resolvePlayerValuation(player2, { fresh }),
    ]);
    return composeBattleResult(data1, data2);
}

module.exports = { runBattle, runBattleFromPayload };
