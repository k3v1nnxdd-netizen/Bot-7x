'use strict';

const express = require('express');
const router = express.Router();
const { buildAvatarValuation } = require('../../services/avatarService');

router.get('/:userId', async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(400).json({ error: 'userId inválido' });
    }

    // ?fresh=1 bypasses the (short) outfit cache for a guaranteed-live read —
    // see buildAvatarValuation's `fresh` option for why this exists and when
    // to actually use it (not on every request — the default cache window is
    // already short enough not to matter for normal traffic).
    const fresh = req.query.fresh === '1' || req.query.fresh === 'true';

    try {
        const data = await buildAvatarValuation(userId, { fresh });
        res.json(data);
    } catch (err) {
        if (err?.response?.status === 404) {
            return res.status(404).json({ error: 'Usuario de Roblox no encontrado' });
        }
        // Only reachable when Roblox is confirmed rate-limited AND there was
        // no last-known-good outfit to fall back on for this user (a brand
        // new userId this process has never seen) — see
        // getWornAssetsWithStaleFallback. 503 + retryAt lets the game
        // distinguish "try again shortly" from a real failure.
        if (err?.circuitOpen) {
            return res.status(503).json({ error: 'Roblox está temporalmente limitado, intenta de nuevo en unos segundos', retryAt: new Date(err.retryAt).toISOString() });
        }
        console.error('[api] /avatar error:', err.message);
        res.status(502).json({ error: 'Error al consultar la API de Roblox' });
    }
});

module.exports = router;
