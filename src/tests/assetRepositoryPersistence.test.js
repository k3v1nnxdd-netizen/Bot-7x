'use strict';
// Verifies "reinicio conservando el volumen": data learned by one process
// survives being read back by a COMPLETELY SEPARATE process pointed at the
// same STORAGE_DIR — the closest faithful simulation of a Railway redeploy
// (new container, same mounted Volume) achievable without an actual deploy.
// Runs two real child `node` processes (never require-cache tricks, which
// would risk corrupting the shared persistent-store singleton every OTHER
// test file in this same `npm test` run depends on) against a throwaway
// temp directory dedicated to this test, so it can't race with the shared
// STORAGE_DIR run.js sets up for the rest of the suite.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createSuite } = require('./testHarness');

const PROBE = path.join(__dirname, 'fixtures', 'persistenceProbe.js');
const FAKE_ASSET_ID = 777000099999; // outside any real Roblox id range used elsewhere in this suite

module.exports = async function run() {
    const { assert, finish } = createSuite('assetRepositoryPersistence (simulated restart)');

    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot7x-persistence-check-'));
    const env = { ...process.env, STORAGE_DIR: storageDir };

    const writeOut = execFileSync('node', [PROBE, 'write', String(FAKE_ASSET_ID)], { env, encoding: 'utf8' });
    const writeResult = JSON.parse(writeOut);
    assert(writeResult.wrote === true, 'process 1 ("cold" — brand new STORAGE_DIR) wrote the asset record and flushed it to disk');
    assert(writeResult.loadedAtStartup === 0, 'process 1 started with an empty store — nothing on disk yet');

    const readOut = execFileSync('node', [PROBE, 'read', String(FAKE_ASSET_ID)], { env, encoding: 'utf8' });
    const readResult = JSON.parse(readOut);
    assert(
        readResult.loadedAtStartup > 0,
        `process 2 (brand new "node" process, same STORAGE_DIR) loaded ${readResult.loadedAtStartup} record(s) from disk at startup — proves data survives a restart`
    );
    assert(readResult.record !== null, 'process 2 found the record process 1 wrote, with zero Roblox calls');
    assert(readResult.record?.noData === false, 'the record is a real resolved asset, not a no-data marker');
    assert(readResult.record?.price === 4242, `the record content survived the restart intact (price=${readResult.record?.price})`);

    return finish();
};
