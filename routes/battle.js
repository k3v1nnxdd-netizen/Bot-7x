'use strict';

const express = require('express');
const router = express.Router();
const { buildAvatarValuation } = require('../services/robloxAvatarService');

function toPlayerSummary(data) {
    return {
        userId: data.userId,
        username: data.username,
        score: data.totalValue,
        rap: data.totalRAP,
        outfitValue: data.totalValue,
        limitedCount: data.limitedCount,
        // Set when Roblox's avatar endpoint was rate-limited and this score
        // is based on the last CONFIRMED outfit rather than a fresh read —
        // see getWornAssetsWithStaleFallback in robloxAvatarService.js. A
        // competitive result built on stale data should be visibly marked
        // as such, not silently presented as current.
        stale: data.outfitStale,
        staleSince: data.outfitStaleSince,
    };
}

router.get('/:user1/:user2', async (req, res) => {
    const id1 = Number(req.params.user1);
    const id2 = Number(req.params.user2);
    if (!Number.isInteger(id1) || id1 <= 0 || !Number.isInteger(id2) || id2 <= 0) {
        return res.status(400).json({ error: 'userId inválido' });
    }

    // ?fresh=1 forces a guaranteed-live read for BOTH players — worth
    // defaulting battle callers toward this: a battle result is a one-shot,
    // consequential comparison (unlike casually re-checking /avatar), so the
    // narrow window where a cached-but-just-changed outfit could favor
    // whoever's snapshot is currently cached matters more here.
    const fresh = req.query.fresh === '1' || req.query.fresh === 'true';

    try {
        const [data1, data2] = await Promise.all([
            buildAvatarValuation(id1, { fresh }),
            buildAvatarValuation(id2, { fresh }),
        ]);

        const player1 = toPlayerSummary(data1);
        const player2 = toPlayerSummary(data2);

        let winner = null;
        const tie = player1.score === player2.score;
        if (!tie) {
            winner = player1.score > player2.score
                ? { userId: player1.userId, username: player1.username }
                : { userId: player2.userId, username: player2.username };
        }

        res.json({ player1, player2, winner, tie });
    } catch (err) {
        if (err?.response?.status === 404) {
            return res.status(404).json({ error: 'Uno de los usuarios de Roblox no fue encontrado' });
        }
        if (err?.circuitOpen) {
            return res.status(503).json({ error: 'Roblox está temporalmente limitado, intenta de nuevo en unos segundos', retryAt: new Date(err.retryAt).toISOString() });
        }
        console.error('[api] /battle error:', err.message);
        res.status(502).json({ error: 'Error al consultar la API de Roblox' });
    }
});

module.exports = router;
