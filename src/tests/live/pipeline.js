'use strict';
// LIVE verification script — hits REAL Roblox endpoints. Not part of
// `npm test` (see src/tests/run.js): a test suite that calls a third-party
// API on every run is bad practice (slow, flaky, and could get an
// automated CI run rate-limited by the very system it's testing). Run this
// manually on demand: `node src/tests/live/pipeline.js`.
//
// Exercises the REAL valuation pipeline (src/services/valuationService.js)
// against curated real Roblox asset ids — same code path avatarService.js
// uses for a live user's worn items: persistent asset repository, batching,
// in-flight dedup, bundle detection, RAP resolution, and every pricing rule.
require('dotenv').config();
const valuationService = require('../../services/valuationService');
const avatarService = require('../../services/avatarService');

const GROUPS = {
    'REQUIRED TEST IDS (off-sale official, must be discovered automatically, never hardcoded)': [553870650, 833772219, 99550579072279],
    'Bundle: Korblox Deathspeaker (must total 17000 ONCE)': [139607570, 139607625, 139610147],
    'Bundle: Headless Horseman (must total 31000 ONCE)': [134082453, 131592085],
    'Animated Face bundle: Beast Mode (live RAP via collectibleItemId)': [127688119049205, 125351719533951],
    'Classic Limited (Pinstripe Fedora) — must get a REAL rap via collectibleItemId': [14463095],
    'Classic Limited, control (Valkyrie Helm)': [1365767],
    'Normal cheap UGC item (Stormbreak Horns, real creator price ~95)': [101440244184624],
    'FRAUD CASE: fake UGC "Dominus Empyreus", price=618,033,988, no real market': [77703650207320],
    'FRAUD CASE: fake UGC "Golden Antlers", price=999,999,999 BUT has real trades -> must use real RAP': [95175788799316],
    'Official ON-SALE non-limited (Violet Valkyrie, price=50000)': [1402432199],
    'Ignored asset types (Shirt + TShirt) — must contribute nothing': [607785314, 1593719],
};

(async () => {
    for (const [label, ids] of Object.entries(GROUPS)) {
        console.log('\n=== ' + label + ' ===');
        const t0 = Date.now();
        const result = await valuationService.valuateWornAssets(ids);
        console.log(`(${Date.now() - t0}ms) totalValue=${result.totalValue} totalRAP=${result.totalRAP} limitedCount=${result.limitedCount}`);
        for (const a of result.accessories) {
            console.log(`  - [${a.type}] ${a.name} method=${a.valuationMethod} estimatedValue=${a.estimatedValue}`);
        }
    }

    console.log('\n=== METRICS (valuationService + repositories + Roblox rate limiter) ===');
    console.log(JSON.stringify(avatarService.getMetrics(), null, 2));
})();
