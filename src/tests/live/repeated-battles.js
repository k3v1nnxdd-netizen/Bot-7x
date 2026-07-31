'use strict';
// LIVE verification script — hits REAL Roblox endpoints through the real
// HTTP server. Not part of `npm test` — run manually:
//   node src/tests/live/repeated-battles.js
//
// Demonstrates the exact scenario reported: many /battle calls for the same
// two players in a row should cost AT MOST ONE real avatar.roblox.com call
// per player per ~45s TTL window, with concurrent bursts deduped to a
// single in-flight request, and — after the TTL passes — a request during
// the stale-while-revalidate grace period should still respond instantly
// (no blocking on Roblox) while a background refresh brings the cache back
// to fully fresh for the next request.
require('dotenv').config();

const PORT = process.env.PORT || 3996;
process.env.PORT = String(PORT); // must be set BEFORE requiring server.js, which reads it via src/config at require-time

const axios = require('axios');
const { startServer } = require('../../api/server');
const avatarService = require('../../services/avatarService');

const PLAYER_A = 156;   // builderman
const PLAYER_B = 261;   // Shedletsky

function avatarCallsSoFar() {
    return avatarService.getMetrics().requestLimiter.avatar.totalCalls;
}

async function battle() {
    const t0 = Date.now();
    const res = await axios.get(`http://127.0.0.1:${PORT}/battle/${PLAYER_A}/${PLAYER_B}`, {
        headers: { 'x-api-key': process.env.API_KEY },
    });
    return { ms: Date.now() - t0, data: res.data };
}

(async () => {
    const { server } = startServer(null);
    await new Promise(r => server.once('listening', r));

    console.log('=== Wave 1: 5 SEQUENTIAL /battle calls for the same 2 players (cold) ===');
    let before = avatarCallsSoFar();
    for (let i = 0; i < 5; i++) {
        const { ms } = await battle();
        console.log(`  battle #${i + 1}: ${ms}ms`);
    }
    console.log(`  real avatar.roblox.com calls used: ${avatarCallsSoFar() - before} (expected: 2 — one per player, the rest reused the cache)`);

    console.log('\n=== Wave 2: 10 CONCURRENT /battle calls for the same 2 players ===');
    before = avatarCallsSoFar();
    const t0 = Date.now();
    const results = await Promise.all(Array.from({ length: 10 }, battle));
    console.log(`  wall clock for 10 concurrent battles: ${Date.now() - t0}ms`);
    console.log(`  real avatar.roblox.com calls used: ${avatarCallsSoFar() - before} (expected: 0 — still within TTL)`);
    console.log(`  all 10 winners agree: ${new Set(results.map(r => r.data.winner?.userId)).size === 1}`);

    console.log('\n=== Wave 3: waiting ~50s for the outfit TTL (45s) to expire, then 5 CONCURRENT battles ===');
    await new Promise(r => setTimeout(r, 50_000));
    before = avatarCallsSoFar();
    const swrBefore = avatarService.getMetrics().swrServed;
    const t1 = Date.now();
    await Promise.all(Array.from({ length: 5 }, battle));
    console.log(`  5 concurrent battles right after TTL expiry, wall clock: ${Date.now() - t1}ms (should still be FAST — served via stale-while-revalidate, none blocked on Roblox)`);
    console.log(`  swrServed incremented by: ${avatarService.getMetrics().swrServed - swrBefore} (expected: 2, not 10 — the PRE-EXISTING valuation-level single-flight`);
    console.log(`  cache (cache.getOrFetch on "valuation:<userId>") already collapses all 5 concurrent requests per player into ONE`);
    console.log(`  buildAvatarValuationUncached() call before it ever reaches the worn-assets SWR check — so SWR only even has to make`);
    console.log(`  the "serve stale + revalidate" decision once per player per wave, not once per HTTP request. The two dedup layers stack.)`);

    console.log('\n=== Waiting 1s for the background revalidation(s) to land ===');
    await new Promise(r => setTimeout(r, 1000));
    console.log(`  real avatar.roblox.com calls added by the background refresh: ${avatarCallsSoFar() - before} (expected: exactly 2 — ONE background refresh per player, deduped across the 5 concurrent SWR triggers, not 10)`);
    console.log(JSON.stringify(avatarService.getMetrics().requestLimiter.avatar, null, 2));

    server.close();
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
