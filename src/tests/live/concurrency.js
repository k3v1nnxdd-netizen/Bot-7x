'use strict';
// LIVE verification script — starts the real Express app in-process and
// fires real concurrent HTTP requests at it, using real Roblox userIds.
// Not part of `npm test` — run manually: `node src/tests/live/concurrency.js`.
// Requires API_KEY set in .env (same key the running server checks).
require('dotenv').config();

const PORT = process.env.PORT || 3999;
process.env.PORT = String(PORT); // must be set BEFORE requiring server.js, which reads it via src/config at require-time

const axios = require('axios');
const { startServer } = require('../../api/server');
const avatarService = require('../../services/avatarService');
const USERS = [1, 2, 3, 6, 8, 16, 17, 18, 156, 261, 80254, 13645, 51645737, 13416513, 7029219094];

function snapshot() { return JSON.parse(JSON.stringify(avatarService.getMetrics())); }

async function hit(userId) {
    const t0 = Date.now();
    try {
        const res = await axios.get(`http://127.0.0.1:${PORT}/avatar/${userId}`, { headers: { 'x-api-key': process.env.API_KEY }, timeout: 30000 });
        return { userId, ms: Date.now() - t0, status: res.status, totalValue: res.data.totalValue, ok: true };
    } catch (err) {
        return { userId, ms: Date.now() - t0, status: err.response?.status ?? 'NETERR', error: err.response?.data?.error ?? err.message, ok: false };
    }
}

(async () => {
    const { server } = startServer(null);
    await new Promise(r => server.once('listening', r));
    console.log('Server listening on', PORT);

    const before = snapshot();
    const t0 = Date.now();
    const results = await Promise.all(USERS.map(hit));
    const wallMs = Date.now() - t0;
    const after = snapshot();

    for (const r of results) console.log(`  user ${r.userId}: ${r.ms}ms status=${r.status} ${r.ok ? 'totalValue=' + r.totalValue : 'ERROR=' + r.error}`);
    console.log(`\n${USERS.length} concurrent distinct users, wall clock: ${wallMs}ms, ok=${results.filter(r => r.ok).length}/${results.length}`);

    console.log('\n--- Roblox calls made this wave ---');
    for (const [name, b] of Object.entries(after.requestLimiter)) {
        const delta = b.totalCalls - before.requestLimiter[name].totalCalls;
        if (delta > 0) console.log(`  ${name}: ${delta} calls, 429s=${b.total429s - before.requestLimiter[name].total429s}, 400s=${b.total400s - before.requestLimiter[name].total400s}`);
    }

    server.close();
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
