'use strict';

// Runs every *.test.js file in this directory (NOT src/tests/live/ — those
// hit real Roblox endpoints and are for manual/on-demand verification only,
// never automatic — see src/tests/live/README for why). Safe for `npm test`
// / CI: no network calls, no shared external state.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Redirects the persistent asset/bundle repositories (src/cache/
// persistentStore.js reads STORAGE_DIR via src/config at require-time) to a
// fresh throwaway temp directory for the DURATION OF THIS TEST RUN ONLY —
// must be set before requiring any test file (several write real-looking
// fixture records, e.g. battleService.test.js's asset-repository-reuse
// case). Without this, running `npm test` would leak test fixtures into the
// real local dev ./storage directory. Only applied when STORAGE_DIR isn't
// already explicitly set, so a deliberate override (e.g. to test against a
// real populated store on purpose) still works.
if (!process.env.STORAGE_DIR) {
    process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot7x-test-storage-'));
}

(async () => {
    const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js')).sort();
    console.log(`Running ${files.length} test file(s): ${files.join(', ')}\n`);

    let allOk = true;
    for (const file of files) {
        console.log(`--- ${file} ---`);
        const testFn = require(path.join(__dirname, file));
        const ok = await testFn();
        if (!ok) allOk = false;
        console.log();
    }

    if (!allOk) {
        console.error('SOME TESTS FAILED');
        process.exit(1);
    }
    console.log('ALL TESTS PASSED');
})().catch(err => {
    console.error('TEST RUNNER CRASHED:', err);
    process.exit(1);
});
