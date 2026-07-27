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
    };
}

router.get('/:user1/:user2', async (req, res) => {
    const id1 = Number(req.params.user1);
    const id2 = Number(req.params.user2);
    if (!Number.isInteger(id1) || id1 <= 0 || !Number.isInteger(id2) || id2 <= 0) {
        return res.status(400).json({ error: 'userId inválido' });
    }

    try {
        const [data1, data2] = await Promise.all([
            buildAvatarValuation(id1),
            buildAvatarValuation(id2),
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
        console.error('[api] /battle error:', err.message);
        res.status(502).json({ error: 'Error al consultar la API de Roblox' });
    }
});

module.exports = router;
