'use strict';

// Minimal, dependency-free assertion harness — this project intentionally
// has no jest/mocha (see persistentStore.js's docstring on the same
// "don't add a dependency this project doesn't otherwise need" philosophy).
// Each test file gets its OWN suite instance (closure-local counters), so
// running several test files in the same process (see run.js) never mixes
// up their pass/fail counts.
function createSuite(name) {
    let passed = 0;
    let failed = 0;

    return {
        assert(cond, msg) {
            if (cond) {
                passed++;
                console.log('  PASS:', msg);
            } else {
                failed++;
                console.error('  FAIL:', msg);
            }
        },
        finish() {
            const ok = failed === 0;
            console.log(`${name}: ${passed} passed, ${failed} failed`);
            return ok;
        },
    };
}

module.exports = { createSuite };
