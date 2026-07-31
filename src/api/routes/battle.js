'use strict';

const express = require('express');
const router = express.Router();
const battleService = require('../../services/battleService');
const { validateBattlePayload, ValidationError } = require('../../security/validateBattlePayload');
const { logRequestContext } = require('../../observability/requestLogger');
const { makeLegacyGoneHandler } = require('../legacyGone');

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

    // TEMPORARY — see requestLogger.js. Logs asset COUNTS, never the raw
    // arrays (could legitimately be up to 100 per player).
    logRequestContext('POST /battle', {
        player1: { userId: payload.player1.userId, assetIdCount: payload.player1.assetIds?.length ?? 'omitted (fallback to Roblox)' },
        player2: { userId: payload.player2.userId, assetIdCount: payload.player2.assetIds?.length ?? 'omitted (fallback to Roblox)' },
        fresh: payload.fresh,
    });

    try {
        const result = await battleService.runBattleFromPayload(payload, { fresh: payload.fresh });
        res.json(result);
    } catch (err) {
        respondWithError(res, err, 'POST /battle');
    }
});

// RETIRED (see src/api/legacyGone.js): public Roblox servers were confirmed
// still calling this, each triggering a real avatar.roblox.com worn-items
// check for BOTH players — exactly the load POST /battle above exists to
// eliminate. Responds 410 immediately — never calls battleService.runBattle,
// never touches Roblox. battleService.runBattle itself is untouched and
// still exported (kept for now — not what this change is scoped to remove),
// simply no longer reachable from any HTTP route.
router.get('/:user1/:user2', makeLegacyGoneHandler('POST /battle'));

module.exports = router;
