'use strict';

const config = require('../config');
const robuxLeaderboard = require('./robuxLeaderboard');
const robuxLeaderboardPanel = require('./robuxLeaderboardPanel');

// The order log channel is the single, permanent, independent source of
// truth for every completed Robux purchase — so on every boot, the
// leaderboard is fully rebuilt from it rather than trusted as authoritative
// itself. This is what makes the leaderboard self-healing regardless of
// what state the persisted JSON was in (empty, partial, or already
// complete) — including purchases recorded before per-order dedup existed,
// which a simple "only add what's missing" pass couldn't safely reconcile.
//
// The full history is collected into memory FIRST — nothing is written
// until the scan finishes successfully, so a transient fetch failure
// partway through never leaves the leaderboard in a worse state than it
// started in.
async function backfillFromOrderLog(client) {
    const logChannel = client.channels.cache.get(config.CHANNELS.ORDER_LOG)
        ?? await client.channels.fetch(config.CHANNELS.ORDER_LOG).catch(() => null);
    if (!logChannel) return;

    const orders = [];
    let before;

    for (;;) {
        const batch = await logChannel.messages.fetch({ limit: 100, ...(before && { before }) }).catch(() => null);
        if (!batch) {
            console.warn('[robuxLeaderboardBackfill] Fetch failed mid-scan — leaving the leaderboard untouched.');
            return;
        }
        if (batch.size === 0) break;

        for (const msg of [...batch.values()].reverse()) {
            const embed = msg.embeds[0];
            if (!embed || embed.title !== 'Pedido completado') continue;

            const desc = embed.description ?? '';
            if (!desc.includes('`Compra de Robux`')) continue;

            const buyerId = desc.match(/\*\*Cliente\*\*\n<@(\d+)>/)?.[1];
            const robux   = desc.match(/Robux comprados\*\*\n`([^`]+)`/)?.[1];
            const price   = desc.match(/Precio\*\*\n`\$([^`]+) MXN`/)?.[1];
            if (!buyerId || !robux) continue;

            const robuxAmount = parseInt(robux.replace(/[^\d]/g, ''), 10);
            const priceMxn    = price ? parseFloat(price.replace(/[^\d.]/g, '')) : null;
            if (!robuxAmount || robuxAmount <= 0) continue;

            orders.push({ orderId: msg.id, buyerId, robuxAmount, priceMxn });
        }

        if (batch.size < 100) break;
        before = batch.last().id;
    }

    robuxLeaderboard.resetUsers();

    const buyerIds = new Set();
    for (const { orderId, buyerId, robuxAmount, priceMxn } of orders) {
        robuxLeaderboard.recordPurchase(buyerId, robuxAmount, priceMxn, orderId);
        buyerIds.add(buyerId);
    }

    console.log(`[robuxLeaderboardBackfill] Rebuilt leaderboard from order log: ${orders.length} purchase(s) across ${buyerIds.size} buyer(s).`);

    // Re-derive the Top-1 / Rich Client roles against the rebuilt totals.
    for (const buyerId of buyerIds) {
        await robuxLeaderboardPanel.syncRobuxRoles(client, buyerId).catch(err =>
            console.warn('[robuxLeaderboardBackfill] syncRobuxRoles failed for', buyerId, err.message)
        );
    }
}

module.exports = { backfillFromOrderLog };
