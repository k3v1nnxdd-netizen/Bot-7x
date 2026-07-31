'use strict';
// Standalone probe process for assetRepositoryPersistence.test.js — run as a
// real child `node` process (never `require`d in-process) so it gets a
// genuinely fresh module graph, the same way a new Railway container does
// after a redeploy with the Volume (STORAGE_DIR) still mounted. Prints one
// JSON line to stdout; the test file parses it.
const assetRepository = require('../../repositories/assetRepository');
const persistentStore = require('../../cache/persistentStore');

const [, , mode, assetIdArg] = process.argv;
const assetId = Number(assetIdArg);
const loadedAtStartup = assetRepository.getMetrics().store.loadedAtStartup;

if (mode === 'write') {
    assetRepository.setAssetRecord(assetId, {
        name: 'Persistence Check Item', assetType: 8, itemRestrictions: [], creatorName: 'Roblox',
        creatorType: 'User', creatorTargetId: 1, hasResellers: false,
        price: 4242, lowestPrice: 4242, lowestResalePrice: 0, collectibleItemId: null, isOffSale: false,
    });
    persistentStore.flushAll(); // synchronous — guarantees it's on disk before this process exits
    console.log(JSON.stringify({ wrote: true, loadedAtStartup }));
} else if (mode === 'read') {
    const record = assetRepository.getAssetRecord(assetId);
    console.log(JSON.stringify({
        loadedAtStartup,
        record: record ? { price: record.price, name: record.name, noData: !!record.noData } : null,
    }));
} else {
    throw new Error(`unknown probe mode: ${mode}`);
}
