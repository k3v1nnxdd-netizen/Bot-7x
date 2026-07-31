'use strict';

// Mocked unit tests for avatarService's outfit-caching behavior — single-
// flight dedup, `fresh` correctly forcing a live read, and the error
// fallback to last-known-good data. Zero real network: every Roblox call
// avatarService pulls in is monkey-patched on the shared roblox/client
// module object (safe because avatarService accesses it as `roblox.fn(...)`
// at call time, never destructured, so reassigning the property here is
// what the code under test actually calls).
//
// Deliberately does NOT test the stale-while-revalidate TIME WINDOW itself
// (that needs real TTL/grace-period elapsed time — tens of seconds to
// minutes — which has no place in a fast `npm test` suite without adding a
// fake-timers dependency this project doesn't otherwise need). That
// behavior is exercised live instead — see src/tests/live/concurrency.js
// and the report for real repeated-battle measurements.
const { createSuite } = require('./testHarness');
const roblox = require('../roblox/client');
const { CircuitOpenError } = require('../roblox/rateLimiter');

module.exports = async function run() {
    const { assert, finish } = createSuite('avatarService');

    const originalGetWornAssetIds = roblox.getWornAssetIds;
    const originalGetUserProfile = roblox.getUserProfile;
    const originalGetAvatarImage = roblox.getAvatarImage;
    roblox.getUserProfile = async () => ({ name: 'mockuser', displayName: 'Mock User' });
    roblox.getAvatarImage = async () => 'https://example.com/mock.png';

    // Fresh require AFTER mocking is unnecessary (module already cached by
    // the time this test runs alongside others), but done explicitly here
    // for clarity about what's under test.
    const avatarService = require('../services/avatarService');

    try {
        // --- Single-flight: 10 concurrent cold requests for the SAME userId ---
        {
            const userId = 900000001;
            let calls = 0;
            roblox.getWornAssetIds = async () => {
                calls++;
                await new Promise(r => setTimeout(r, 50)); // simulate a real network round trip so the 10 calls genuinely overlap in-flight
                return [];
            };
            const results = await Promise.all(Array.from({ length: 10 }, () => avatarService.buildAvatarValuation(userId)));
            assert(calls === 1, 'single-flight: 10 concurrent cold requests for the same userId trigger exactly 1 real avatar call');
            assert(results.every(r => r.totalValue === 0 && r.outfitStale === false), 'single-flight: all 10 results are identical and fresh');
        }

        // --- Cache hit: a second call within TTL makes zero new calls ---
        {
            const userId = 900000002;
            let calls = 0;
            roblox.getWornAssetIds = async () => { calls++; return []; };
            await avatarService.buildAvatarValuation(userId);
            await avatarService.buildAvatarValuation(userId);
            assert(calls === 1, 'cache hit: second call within TTL makes zero new avatar calls');
        }

        // --- fresh=1 forces a real new call even though the cache is still valid ---
        {
            const userId = 900000003;
            let calls = 0;
            roblox.getWornAssetIds = async () => { calls++; return []; };
            await avatarService.buildAvatarValuation(userId);
            await avatarService.buildAvatarValuation(userId, { fresh: true });
            assert(calls === 2, 'fresh=1: forces a real new avatar call even though the previous read is still within TTL');
        }

        // --- Error fallback: CircuitOpenError + existing last-known-good -> stale:true, not a thrown error ---
        {
            const userId = 900000004;
            roblox.getWornAssetIds = async () => [];
            const first = await avatarService.buildAvatarValuation(userId);
            assert(first.outfitStale === false, 'fallback setup: first read is fresh');

            roblox.getWornAssetIds = async () => { throw new CircuitOpenError('avatar worn-items', Date.now() + 60_000); };
            const second = await avatarService.buildAvatarValuation(userId, { fresh: true });
            assert(second.outfitStale === true, 'fallback: a circuit-open failure with existing last-known data returns stale:true instead of failing the valuation');
            assert(second.outfitStaleSince !== null, 'fallback: outfitStaleSince is populated on a stale response');
        }

        // --- A definitive 404 is NEVER masked by stale fallback ---
        {
            const userId = 900000005;
            roblox.getWornAssetIds = async () => [];
            await avatarService.buildAvatarValuation(userId);

            roblox.getWornAssetIds = async () => { const e = new Error('Not Found'); e.response = { status: 404 }; throw e; };
            let threw = false;
            try {
                await avatarService.buildAvatarValuation(userId, { fresh: true });
            } catch {
                threw = true;
            }
            assert(threw, '404 propagates even when last-known-good data exists — never masked as a stale success');
        }
    } finally {
        roblox.getWornAssetIds = originalGetWornAssetIds;
        roblox.getUserProfile = originalGetUserProfile;
        roblox.getAvatarImage = originalGetAvatarImage;
    }

    return finish();
};
