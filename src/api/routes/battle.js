'use strict';

const express = require('express');
const router = express.Router();
const battleService = require('../../services/battleService');
const { validateBattlePayload, ValidationError } = require('../../security/validateBattlePayload');

// Shared between both routes below: maps a failure from the valuation
// pipeline to an HTTP response. Not reachable for ValidationError (that's
// handled at the call site, before anything touches Roblox).
function respondWithError(res, err, routeLabel) {
    if (err?.response?.status === 404) {
        return res.status(404).json({ error: 'Uno de los usuarios de Roblox no fue encontrado' });
    }
    if (err?.circuitOpen) {
        return res.status(503).json({ error: 'Roblox está temporalmente limitado, intenta de nuevo en unos segundos', retryAt: new Date(err.retryAt).toISOString() });
    }
    console.error(`[api] ${routeLabel} error:`, err.message);
    return res.status(502).json({ error: 'Error al consultar la API de Roblox' });
}

// PRIMARY path going forward: the Roblox server script already knows both
// players' current outfits firsthand (they're both live in that server) —
// supplying assetIds here means Railway never calls avatar.roblox.com for
// either player, only prices what it's given. Railway remains the sole
// authority on VALUE: price/RAP/limited-status/bundle rules are entirely
// determined server-side via the same valuationService every other path
// uses — the game can only ever say WHAT is worn, never what it's worth.
//
// Body: { player1: { userId, assetIds? }, player2: { userId, assetIds? }, fresh? }
// assetIds omitted for a player (not an empty array) falls back to a live/
// cached avatar.roblox.com check for THAT player only — see
// validateBattlePayload.js and battleService.resolvePlayerValuation.
router.post('/', async (req, res) => {
    let payload;
    try {
        payload = validateBattlePayload(req.body);
    } catch (err) {
        if (err instanceof ValidationError) {
            return res.status(400).json({ error: err.message });
        }
        throw err;
    }

    try {
        const result = await battleService.runBattleFromPayload(payload, { fresh: payload.fresh });
        res.json(result);
    } catch (err) {
        respondWithError(res, err, 'POST /battle');
    }
});

// OLD path — kept for backward compatibility and as the full fallback when
// a caller has no assetIds to supply at all: both players' outfits are
// fetched live from (or served cached/stale-while-revalidate from) Roblox's
// avatar.roblox.com, exactly as before this feature existed.
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
        respondWithError(res, err, 'GET /battle');
    }
});

module.exports = router;
