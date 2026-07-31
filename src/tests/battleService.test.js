'use strict';

// Mocked tests for the POST /battle payload-driven path — proves the core
// claim (assetIds supplied -> ZERO avatar.roblox.com calls) plus dedup and
// the per-player fallback, without hitting real Roblox for the worn-items
// check. Uses REAL Korblox Deathspeaker / Headless Horseman component ids
// (src/repositories/data/officialItemValues.js) for the "known asset, no
// network at all" cases — bundle-override matching is pure static local
// data, so this needs no mocking of the catalog layer either and leaves no
// side effects on the persistent store. One test (asset-repository reuse
// across players) does mock catalog.roblox.com for a single clearly-fake
// asset id, which — like avatarService.test.js's fake userIds — is an
// accepted, harmless local-dev-storage side effect of exercising that code
// path deterministically without depending on some other script having
// warmed the cache first.
const { createSuite } = require('./testHarness');
const roblox = require('../roblox/client');
const battleService = require('../services/battleService');

// Korblox Deathspeaker components (see repositories/data/officialItemValues.js) — value 17000, matched via a static Map, zero Roblox calls.
const KORBLOX_COMPONENTS = [139607570, 139607625, 139607673, 139607718, 139607770, 139610147];
// Headless Horseman components — value 31000.
const HEADLESS_COMPONENTS = [134082453, 134082473, 134082507, 134082533, 134082557, 131592085];

module.exports = async function run() {
    const { assert, finish } = createSuite('battleService');

    const originalGetWornAssetIds = roblox.getWornAssetIds;
    const originalGetUserProfile = roblox.getUserProfile;
    const originalGetAvatarImage = roblox.getAvatarImage;
    const originalGetAssetDetails = roblox.getAssetDetails;
    roblox.getUserProfile = async () => ({ name: 'mockuser', displayName: 'Mock User' });
    roblox.getAvatarImage = async () => 'https://example.com/mock.png';

    try {
        // --- Both players supply assetIds -> ZERO avatar.roblox.com calls ---
        {
            let wornCalls = 0;
            roblox.getWornAssetIds = async () => { wornCalls++; return []; };

            const result = await battleService.runBattleFromPayload({
                player1: { userId: 910000001, assetIds: KORBLOX_COMPONENTS },
                player2: { userId: 910000002, assetIds: HEADLESS_COMPONENTS },
            });

            assert(wornCalls === 0, 'both players supplied assetIds: avatar.roblox.com (getWornAssetIds) was never called');
            assert(result.player1.score === 17000, `player1 (Korblox) scores 17000 (got ${result.player1.score})`);
            assert(result.player2.score === 31000, `player2 (Headless) scores 31000 (got ${result.player2.score})`);
            assert(result.player1.outfitSource === 'client' && result.player2.outfitSource === 'client', 'both flagged outfitSource:"client"');
            assert(result.winner.userId === 910000002, 'winner correctly computed (Headless > Korblox)');
            assert(result.player1.stale === false && result.player2.stale === false, 'never flagged stale — this is authoritative caller-supplied data');
        }

        // --- Duplicate ids within a single player's list do NOT double-count ---
        {
            let wornCalls = 0;
            roblox.getWornAssetIds = async () => { wornCalls++; return []; };

            const dupedKorblox = [...KORBLOX_COMPONENTS, ...KORBLOX_COMPONENTS, KORBLOX_COMPONENTS[0]]; // repeated 2x + one extra
            const result = await battleService.runBattleFromPayload({
                player1: { userId: 910000003, assetIds: dupedKorblox },
                player2: { userId: 910000004, assetIds: [] },
            });

            assert(result.player1.score === 17000, `duplicated Korblox components still total 17000 exactly once (got ${result.player1.score})`);
            assert(wornCalls === 0, 'still zero avatar.roblox.com calls with duplicates present');
        }

        // --- assetIds omitted for ONE player -> falls back to a live avatar check for THAT player only ---
        {
            let wornCalls = 0;
            const calledFor = [];
            roblox.getWornAssetIds = async (userId) => { wornCalls++; calledFor.push(userId); return []; };

            const result = await battleService.runBattleFromPayload({
                player1: { userId: 910000005, assetIds: KORBLOX_COMPONENTS },
                player2: { userId: 910000006 }, // no assetIds at all
            });

            assert(wornCalls === 1, `exactly one avatar.roblox.com call made, only for the player who omitted assetIds (got ${wornCalls})`);
            assert(calledFor[0] === 910000006, 'the fallback call was for the correct (omitting) player');
            assert(result.player1.outfitSource === 'client' && result.player2.outfitSource === 'roblox', 'outfitSource correctly distinguishes the two players');
            assert(result.player1.score === 17000, 'the client-supplied player still valued correctly');
        }

        // --- Asset repository reuse: two DIFFERENT players wearing the SAME
        // previously-unknown asset trigger exactly ONE catalog.roblox.com call,
        // not one per player. ---
        {
            const FAKE_ASSET_ID = 777000000001; // deliberately outside any real Roblox id range used elsewhere in this suite
            let catalogCalls = 0;
            roblox.getWornAssetIds = async () => { throw new Error('should not be called in this test'); };
            roblox.getAssetDetails = async (ids) => {
                catalogCalls++;
                const map = new Map();
                for (const id of ids) {
                    if (id === FAKE_ASSET_ID) {
                        map.set(id, {
                            name: 'Test Fake Item', assetType: 8, itemRestrictions: [], creatorName: 'Roblox',
                            creatorType: 'User', creatorTargetId: 1, hasResellers: false,
                            price: 250, lowestPrice: 250, lowestResalePrice: 0, collectibleItemId: null, isOffSale: false,
                        });
                    }
                }
                return map;
            };

            const battleA = await battleService.runBattleFromPayload({
                player1: { userId: 910000007, assetIds: [FAKE_ASSET_ID] },
                player2: { userId: 910000008, assetIds: [] },
            });
            const battleB = await battleService.runBattleFromPayload({
                player1: { userId: 910000009, assetIds: [FAKE_ASSET_ID] },
                player2: { userId: 910000010, assetIds: [] },
            });

            assert(battleA.player1.score === 250 && battleB.player1.score === 250, 'both battles correctly priced the shared asset at 250');
            assert(catalogCalls === 1, `catalog.roblox.com called exactly once across TWO separate battles referencing the same previously-unknown asset (got ${catalogCalls})`);
        }

        // --- runBattle (old GET-style path) still works, unaffected ---
        {
            let wornCalls = 0;
            roblox.getWornAssetIds = async () => { wornCalls++; return KORBLOX_COMPONENTS; };
            const result = await battleService.runBattle(910000011, 910000012);
            assert(wornCalls === 2, 'old GET-style runBattle still fetches both players live via avatar.roblox.com');
            assert(result.tie === true && result.player1.score === 17000 && result.player2.score === 17000, 'both players wearing the same bundle tie correctly');
            assert(result.player1.outfitSource === 'roblox', 'old path still reports outfitSource:"roblox"');
        }
    } finally {
        roblox.getWornAssetIds = originalGetWornAssetIds;
        roblox.getUserProfile = originalGetUserProfile;
        roblox.getAvatarImage = originalGetAvatarImage;
        roblox.getAssetDetails = originalGetAssetDetails;
    }

    return finish();
};
