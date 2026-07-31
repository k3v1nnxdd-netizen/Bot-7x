'use strict';
// LIVE verification script — real HTTP server, real Roblox catalog/RAP
// calls for whatever assets aren't already known, but demonstrates ZERO
// avatar.roblox.com calls for the new POST /battle path. Not part of
// `npm test` — run manually: node src/tests/live/battle-with-assets.js
require('dotenv').config();

const PORT = process.env.PORT || 3994;
process.env.PORT = String(PORT); // must be set BEFORE requiring server.js, which reads it via src/config at require-time

const axios = require('axios');
const { startServer } = require('../../api/server');
const avatarService = require('../../services/avatarService');

function avatarCallsSoFar() {
    return avatarService.getMetrics().requestLimiter.avatar.totalCalls;
}

async function post(body) {
    return axios.post(`http://127.0.0.1:${PORT}/battle`, body, { headers: { 'x-api-key': process.env.API_KEY, 'Content-Type': 'application/json' } });
}

(async () => {
    const { server } = startServer(null);
    await new Promise(r => server.once('listening', r));

    console.log('=== POST /battle with real assetIds for both players (the 3 required test ids + Korblox for player1, a Limited for player2) ===');
    const before = avatarCallsSoFar();
    const res = await post({
        player1: { userId: 156, assetIds: [553870650, 833772219, 99550579072279, 139607570, 139607625, 139607673, 139607718, 139607770, 139610147] },
        player2: { userId: 261, assetIds: [14463095] }, // Pinstripe Fedora, real Limited RAP
    });
    console.log(JSON.stringify(res.data, null, 2));
    console.log(`\nreal avatar.roblox.com calls made: ${avatarCallsSoFar() - before} (expected: 0)`);

    console.log('\n=== POST /battle with an invalid payload (negative assetId) -> expect 400 ===');
    try {
        await post({ player1: { userId: 156, assetIds: [-5] }, player2: { userId: 261, assetIds: [1] } });
        console.log('UNEXPECTED: did not reject');
    } catch (err) {
        console.log(`status=${err.response?.status} error=${JSON.stringify(err.response?.data)}`);
    }

    console.log('\n=== POST /battle with one player omitting assetIds -> falls back to live avatar.roblox.com for that player only ===');
    const before2 = avatarCallsSoFar();
    const res2 = await post({
        player1: { userId: 156, assetIds: [553870650] },
        player2: { userId: 261 },
    });
    console.log(`player1.outfitSource=${res2.data.player1.outfitSource} player2.outfitSource=${res2.data.player2.outfitSource}`);
    console.log(`real avatar.roblox.com calls made: ${avatarCallsSoFar() - before2} (expected: 1, only for player2)`);

    console.log('\n=== GET /battle/:user1/:user2 (old path) still works ===');
    const res3 = await axios.get(`http://127.0.0.1:${PORT}/battle/156/261`, { headers: { 'x-api-key': process.env.API_KEY } });
    console.log(`status=${res3.status} winner=${res3.data.winner?.username} player1.outfitSource=${res3.data.player1.outfitSource}`);

    console.log('\n=== Oversized body -> expect 413 ===');
    try {
        await post({ player1: { userId: 1, assetIds: Array.from({ length: 5000 }, (_, i) => i + 1) }, player2: { userId: 2, assetIds: [1] } });
        console.log('UNEXPECTED: did not reject (note: this would also get a 400 for exceeding the 100-per-player cap before size matters)');
    } catch (err) {
        console.log(`status=${err.response?.status} error=${JSON.stringify(err.response?.data)}`);
    }

    server.close();
    process.exit(0);
})().catch(e => { console.error(e.response?.data || e.message); process.exit(1); });
