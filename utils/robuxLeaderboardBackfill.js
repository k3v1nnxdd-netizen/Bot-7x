'use strict';

const config = require('../config');
const robuxLeaderboard = require('./robuxLeaderboard');
const robuxLeaderboardPanel = require('./robuxLeaderboardPanel');

// Self-healing migration: if the leaderboard has no data (e.g. a freshly
// attached/emptied Volume), rebuild it by replaying every "Pedido
// completado" (Compra de Robux) entry already sitting in the order log
// channel — that channel is an independent, permanent historical record,
// so the leaderboard can always be reconstructed from it. No-ops the
// moment there's real data, so this is safe to run on every boot.
async function backfillFromOrderLog(client) {
    if (robuxLeaderboard.getRanked().length > 0) return;

    const logChannel = client.channels.cache.get(config.CHANNELS.ORDER_LOG)
        ?? await client.channels.fetch(config.CHANNELS.ORDER_LOG).catch(() => null);
    if (!logChannel) return;

    console.log('[robuxLeaderboardBackfill] Leaderboard is empty — rebuilding from order log history...');

    let before;
    let restored = 0;
    const buyerIds = new Set();

    for (;;) {
        const batch = await logChannel.messages.fetch({ limit: 100, ...(before && { before }) }).catch(() => null);
        if (!batch || batch.size === 0) break;

        // Oldest-first within each batch so purchase counts/order are
        // reconstructed in the same sequence they actually happened.
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

            robuxLeaderboard.recordPurchase(buyerId, robuxAmount, priceMxn);
            buyerIds.add(buyerId);
            restored++;
        }

        if (batch.size < 100) break;
        before = batch.last().id;
    }

    console.log(`[robuxLeaderboardBackfill] Restored ${restored} purchase(s) from order log.`);

    // Re-derive the Top-1 / Rich Client roles against the restored totals —
    // they were tied to the same now-rebuilt data and need to catch up too.
    for (const buyerId of buyerIds) {
        await robuxLeaderboardPanel.syncRobuxRoles(client, buyerId).catch(err =>
            console.warn('[robuxLeaderboardBackfill] syncRobuxRoles failed for', buyerId, err.message)
        );
    }
}

module.exports = { backfillFromOrderLog };
