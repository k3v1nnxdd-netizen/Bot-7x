'use strict';

// Runs every *.test.js file in this directory (NOT src/tests/live/ — those
// hit real Roblox endpoints and are for manual/on-demand verification only,
// never automatic — see src/tests/live/README for why). Safe for `npm test`
// / CI: no network calls, no shared external state.
const fs = require('fs');
const path = require('path');

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
