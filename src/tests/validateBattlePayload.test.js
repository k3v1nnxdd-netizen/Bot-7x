'use strict';

// Pure unit tests for the POST /battle input boundary — no network, no
// mocking needed.
const { createSuite } = require('./testHarness');
const { validateBattlePayload, ValidationError } = require('../security/validateBattlePayload');

function expectRejects(assert, body, label) {
    let threw = false;
    try { validateBattlePayload(body); }
    catch (err) { threw = err instanceof ValidationError; }
    assert(threw, `rejects: ${label}`);
}

module.exports = async function run() {
    const { assert, finish } = createSuite('validateBattlePayload');

    // --- Valid cases ---
    {
        const result = validateBattlePayload({
            player1: { userId: 156, assetIds: [1, 2, 3] },
            player2: { userId: 261, assetIds: [4, 5] },
        });
        assert(result.player1.userId === 156, 'valid: player1.userId passed through');
        assert(JSON.stringify(result.player1.assetIds) === JSON.stringify([1, 2, 3]), 'valid: player1.assetIds passed through');
        assert(result.fresh === false, 'valid: fresh defaults to false when omitted');
    }
    {
        // assetIds OMITTED for player2 -> undefined (not []), signaling
        // "fall back to a live avatar check for this player" downstream.
        const result = validateBattlePayload({
            player1: { userId: 156, assetIds: [1, 2, 3] },
            player2: { userId: 261 },
        });
        assert(result.player2.assetIds === undefined, 'valid: omitted assetIds stays undefined (distinct from an empty array)');
    }
    {
        // An explicitly empty array IS valid — "confirmed bare avatar", not "unknown".
        const result = validateBattlePayload({
            player1: { userId: 156, assetIds: [] },
            player2: { userId: 261, assetIds: [1] },
        });
        assert(Array.isArray(result.player1.assetIds) && result.player1.assetIds.length === 0, 'valid: an explicit empty array is accepted as-is');
    }
    {
        // Duplicates are NORMALIZED (deduped), not rejected.
        const result = validateBattlePayload({
            player1: { userId: 156, assetIds: [1, 1, 2, 2, 2, 3] },
            player2: { userId: 261, assetIds: [4] },
        });
        assert(JSON.stringify(result.player1.assetIds) === JSON.stringify([1, 2, 3]), `duplicates deduped, got ${JSON.stringify(result.player1.assetIds)}`);
    }
    {
        const result = validateBattlePayload({
            player1: { userId: 156, assetIds: [1] },
            player2: { userId: 261, assetIds: [2] },
            fresh: true,
        });
        assert(result.fresh === true, 'fresh:true is passed through');
    }
    {
        // Exactly at the cap is fine.
        const ids = Array.from({ length: 100 }, (_, i) => i + 1);
        const result = validateBattlePayload({ player1: { userId: 1, assetIds: ids }, player2: { userId: 2, assetIds: [1] } });
        assert(result.player1.assetIds.length === 100, 'exactly MAX_ASSET_IDS_PER_PLAYER (100) is accepted');
    }

    // --- Invalid cases: whole request rejected, never silently patched ---
    expectRejects(assert, null, 'null body');
    expectRejects(assert, 'not an object', 'string body');
    expectRejects(assert, [], 'array body');
    expectRejects(assert, {}, 'missing player1 and player2');
    expectRejects(assert, { player1: { userId: 156, assetIds: [1] } }, 'missing player2');
    expectRejects(assert, { player1: 'nope', player2: { userId: 2, assetIds: [1] } }, 'player1 not an object');
    expectRejects(assert, { player1: { userId: 0, assetIds: [1] }, player2: { userId: 2, assetIds: [1] } }, 'userId zero');
    expectRejects(assert, { player1: { userId: -5, assetIds: [1] }, player2: { userId: 2, assetIds: [1] } }, 'userId negative');
    expectRejects(assert, { player1: { userId: 1.5, assetIds: [1] }, player2: { userId: 2, assetIds: [1] } }, 'userId non-integer');
    expectRejects(assert, { player1: { userId: '156', assetIds: [1] }, player2: { userId: 2, assetIds: [1] } }, 'userId as a string');
    expectRejects(assert, { player1: { userId: 1, assetIds: 'not-an-array' }, player2: { userId: 2, assetIds: [1] } }, 'assetIds not an array');
    expectRejects(assert, { player1: { userId: 1, assetIds: [1, 0, 2] }, player2: { userId: 2, assetIds: [1] } }, 'assetIds contains zero');
    expectRejects(assert, { player1: { userId: 1, assetIds: [1, -2] }, player2: { userId: 2, assetIds: [1] } }, 'assetIds contains a negative number');
    expectRejects(assert, { player1: { userId: 1, assetIds: [1, 2.5] }, player2: { userId: 2, assetIds: [1] } }, 'assetIds contains a non-integer');
    expectRejects(assert, { player1: { userId: 1, assetIds: ['553870650'] }, player2: { userId: 2, assetIds: [1] } }, 'assetIds contains a numeric STRING, not a number');
    expectRejects(assert, { player1: { userId: 1, assetIds: [1, null] }, player2: { userId: 2, assetIds: [1] } }, 'assetIds contains null');
    {
        const tooMany = Array.from({ length: 101 }, (_, i) => i + 1);
        expectRejects(assert, { player1: { userId: 1, assetIds: tooMany }, player2: { userId: 2, assetIds: [1] } }, 'assetIds exceeds the 100 cap');
    }

    return finish();
};
