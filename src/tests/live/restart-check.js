'use strict';
// LIVE verification script for the persistent asset store (the Railway
// Volume, in production). Not part of `npm test` — run manually, TWICE, as
// two SEPARATE Node processes:
//
//   node src/tests/live/restart-check.js     (run 1 — cold)
//   node src/tests/live/restart-check.js     (run 2 — after "restart")
//
// Run 1 fetches a few known real asset ids from Roblox and reports how many
// catalog/items/details calls that took. Run 2, in a brand new process,
// must report catalogDetails calls == 0 and assetRepository.loadedAtStartup
// > 0 — proof the Railway Volume (STORAGE_DIR) survived the "restart".
require('dotenv').config();
const valuationService = require('../../services/valuationService');
const avatarService = require('../../services/avatarService');

const IDS = [553870650, 833772219, 99550579072279, 14463095, 1365767, 101440244184624];

(async () => {
    const before = avatarService.getMetrics();
    const t0 = Date.now();
    const result = await valuationService.valuateWornAssets(IDS);
    console.log(`valuateWornAssets(${IDS.length} ids) -> totalValue=${result.totalValue} in ${Date.now() - t0}ms`);

    const after = avatarService.getMetrics();
    const catalogCallsThisRun = after.requestLimiter.catalogDetails.totalCalls - before.requestLimiter.catalogDetails.totalCalls;
    const loadedAtStartup = after.valuation.assetRepository.store.loadedAtStartup;

    console.log('catalog items/details calls made THIS RUN:', catalogCallsThisRun);
    console.log('assets loaded from disk AT STARTUP (proves the Volume persisted):', loadedAtStartup);
    console.log(loadedAtStartup > 0
        ? '\n=> This looks like a WARM run: data survived from a previous process. Good — that IS the point being verified.'
        : '\n=> This looks like a COLD run (empty store). Run this script again in a NEW process to verify persistence.');
})();
