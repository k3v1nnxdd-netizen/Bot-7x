'use strict';

const express = require('express');
const router = express.Router();
const battleService = require('../../services/battleService');

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
        const result = await battleService.runBattle(id1, id2, { fresh });
        res.json(result);
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
