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
    // Named so any test that needs to temporarily swap getUserProfile for
    // its own purpose (e.g. simulating per-player latency) can restore THIS
    // default mock afterward — restoring `originalGetUserProfile` instead
    // would silently put the REAL network-calling function back for the
    // rest of this file's tests.
    const defaultGetUserProfile = async () => ({ name: 'mockuser', displayName: 'Mock User' });
    roblox.getUserProfile = defaultGetUserProfile;
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

        // --- Cross-player batching WITHIN one battle: both players' assetIds
        // arrive in the SAME POST /battle call, resolved via
        // avatarService.buildAvatarValuationFromAssetIds for each player in
        // parallel. Before the fix, that function awaited getUserBasicInfo/
        // getAvatarThumbnail BEFORE calling valuateWornAssets, so player2's
        // unknown asset ids could register into valuationService's shared
        // batch only after player1's (unrelated, users.roblox.com/
        // thumbnails.roblox.com) round-trip had already finished — splitting
        // ONE battle's unknown assets across TWO separate catalog.roblox.com
        // batches. This reproduces that exact shape: both players wear
        // DIFFERENT never-before-seen assets, and getUserBasicInfo is made
        // artificially slow (a real network call would be, in production)
        // to prove the two players' assets still land in the same batch. ---
        {
            const NEW_ASSET_P1 = 777000000002;
            const NEW_ASSET_P2 = 777000000003;
            let catalogCalls = 0;
            let catalogCallSizes = [];
            roblox.getWornAssetIds = async () => { throw new Error('should not be called in this test'); };
            roblox.getAssetDetails = async (ids) => {
                catalogCalls++;
                catalogCallSizes.push(ids.length);
                const map = new Map();
                for (const id of ids) {
                    map.set(id, {
                        name: `Fresh Item ${id}`, assetType: 8, itemRestrictions: [], creatorName: 'Roblox',
                        creatorType: 'User', creatorTargetId: 1, hasResellers: false,
                        price: 100, lowestPrice: 100, lowestResalePrice: 0, collectibleItemId: null, isOffSale: false,
                    });
                }
                return map;
            };
            // Simulates real-world users.roblox.com latency for player1
            // ONLY, arriving well after valuationService's 100ms batch
            // coalesce window — the exact scenario that used to split this
            // into two ROBLOX-CALL batches. player2's basicInfo resolves
            // near-instantly (cache hit / fast response), same as it would
            // for a popular player already warmed in the TTL cache.
            let callCount = 0;
            roblox.getUserProfile = async (userId) => {
                callCount++;
                if (callCount === 1) await new Promise(r => setTimeout(r, 250));
                return { name: `mockuser${userId}`, displayName: 'Mock User' };
            };

            const result = await battleService.runBattleFromPayload({
                player1: { userId: 920000001, assetIds: [NEW_ASSET_P1] },
                player2: { userId: 920000002, assetIds: [NEW_ASSET_P2] },
            });

            assert(catalogCalls === 1, `both players' never-before-seen assets landed in ONE catalog.roblox.com batch, not one per player (got ${catalogCalls} call(s), sizes=${JSON.stringify(catalogCallSizes)})`);
            assert(result.player1.score === 100 && result.player2.score === 100, 'both players still priced correctly despite the artificial basicInfo delay');

            roblox.getUserProfile = defaultGetUserProfile;
        }

        // --- Repeated battle: once an asset is known (persisted in
        // assetRepository from the test above), running ANOTHER battle that
        // reuses it makes ZERO catalog.roblox.com calls. ---
        {
            const NEW_ASSET_P1 = 777000000002; // same id resolved by the previous test block
            let catalogCalls = 0;
            roblox.getAssetDetails = async () => { catalogCalls++; return new Map(); };

            const result = await battleService.runBattleFromPayload({
                player1: { userId: 920000003, assetIds: [NEW_ASSET_P1] },
                player2: { userId: 920000004, assetIds: [] },
            });

            assert(catalogCalls === 0, `repeated/cached battle made ZERO catalog.roblox.com calls (got ${catalogCalls})`);
            assert(result.player1.score === 100, 'the cached asset still priced correctly with no Roblox call');
        }

        // --- Many CONCURRENT battles (true Promise.all, not sequential)
        // referencing the same never-before-seen asset must still collapse
        // into exactly one catalog.roblox.com call — proves single-flight
        // dedup holds under real concurrency, not just two back-to-back
        // awaited calls. ---
        {
            const SHARED_NEW_ASSET = 777000000004;
            let catalogCalls = 0;
            roblox.getAssetDetails = async (ids) => {
                catalogCalls++;
                const map = new Map();
                for (const id of ids) {
                    map.set(id, {
                        name: 'Concurrently Discovered Item', assetType: 8, itemRestrictions: [], creatorName: 'Roblox',
                        creatorType: 'User', creatorTargetId: 1, hasResellers: false,
                        price: 500, lowestPrice: 500, lowestResalePrice: 0, collectibleItemId: null, isOffSale: false,
                    });
                }
                return map;
            };

            const BATTLE_COUNT = 12;
            const battles = await Promise.all(
                Array.from({ length: BATTLE_COUNT }, (_, i) => battleService.runBattleFromPayload({
                    player1: { userId: 920100000 + i * 2, assetIds: [SHARED_NEW_ASSET] },
                    player2: { userId: 920100000 + i * 2 + 1, assetIds: [] },
                }))
            );

            assert(catalogCalls === 1, `${BATTLE_COUNT} truly concurrent battles sharing one new asset triggered exactly ONE catalog.roblox.com call (got ${catalogCalls})`);
            assert(battles.every(b => b.player1.score === 500), 'every concurrent battle priced the shared asset correctly');
        }

        // --- Circuit-open / upstream-failure graceful degradation: when the
        // catalog route fails (simulating rateLimiter's CircuitOpenError),
        // 10 concurrent battles referencing the same never-before-seen asset
        // must: (a) still dedup to a single upstream attempt, (b) never
        // hang/block, (c) never invent a price, and (d) never persist the
        // failure as if the asset were confirmed invalid — a later,
        // successful lookup must still be attempted for real. ---
        {
            const { CircuitOpenError } = require('../roblox/rateLimiter');
            const UNSTABLE_ASSET = 777000000006;
            let catalogAttempts = 0;
            roblox.getAssetDetails = async () => {
                catalogAttempts++;
                throw new CircuitOpenError('catalog items/details', Date.now() + 30_000);
            };

            const BATTLE_COUNT = 10;
            const t0 = Date.now();
            const battles = await Promise.all(
                Array.from({ length: BATTLE_COUNT }, (_, i) => battleService.runBattleFromPayload({
                    player1: { userId: 920200000 + i * 2, assetIds: [UNSTABLE_ASSET] },
                    player2: { userId: 920200000 + i * 2 + 1, assetIds: [] },
                }))
            );
            const wallMs = Date.now() - t0;

            assert(catalogAttempts === 1, `circuit-open: 10 concurrent battles collapsed into a single upstream attempt (got ${catalogAttempts})`);
            assert(wallMs < 2000, `circuit-open: battles did not block/hang waiting on the failed route (took ${wallMs}ms)`);
            assert(battles.every(b => b.player1.score === 0), 'circuit-open: the unresolvable asset contributed NO invented price — score is 0, not a guess');
            assert(battles.every(b => !b.player1.stale), 'circuit-open: client-supplied outfitSource is never flagged stale (that flag is for the avatar.roblox.com SWR path only)');

            // Recovery: once the route "recovers", the SAME asset id must
            // still be fetched for real — a 429/circuit-open must never have
            // been written to assetRepository as a confirmed no-data result.
            let recoveredCalls = 0;
            roblox.getAssetDetails = async (ids) => {
                recoveredCalls++;
                const map = new Map();
                for (const id of ids) {
                    map.set(id, {
                        name: 'Recovered Item', assetType: 8, itemRestrictions: [], creatorName: 'Roblox',
                        creatorType: 'User', creatorTargetId: 1, hasResellers: false,
                        price: 750, lowestPrice: 750, lowestResalePrice: 0, collectibleItemId: null, isOffSale: false,
                    });
                }
                return map;
            };
            const recovered = await battleService.runBattleFromPayload({
                player1: { userId: 920200999, assetIds: [UNSTABLE_ASSET] },
                player2: { userId: 920201000, assetIds: [] },
            });
            assert(recoveredCalls === 1, 'circuit-open recovery: the previously-failed asset was fetched for real once the route recovered (not permanently poisoned)');
            assert(recovered.player1.score === 750, 'circuit-open recovery: correctly priced once Roblox actually answered');
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
