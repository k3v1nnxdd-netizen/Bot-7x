'use strict';

const express = require('express');
const router = express.Router();
const { buildAvatarValuation } = require('../services/robloxAvatarService');

router.get('/:userId', async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: 'userId inválido' });
    }

    try {
        const data = await buildAvatarValuation(userId);
        res.json(data);
    } catch (err) {
        if (err?.response?.status === 404) {
            return res.status(404).json({ error: 'Usuario de Roblox no encontrado' });
        }
        console.error('[api] /avatar error:', err.message);
        res.status(502).json({ error: 'Error al consultar la API de Roblox' });
    }
});

module.exports = router;
