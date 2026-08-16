'use strict';

const express = require('express');
const router = express.Router();
const outfitService = require('../../services/outfitService');
const { parseOutfitId } = require('../../validation/params');

// GET /v1/outfits/:outfitId
// Contenido de un outfit concreto: assets, colores de cuerpo y escalas — lo
// justo para reconstruirlo con HumanoidDescription del lado del juego.
router.get('/:outfitId', async (req, res) => {
    res.locals.routeLabel = '/v1/outfits/:outfitId';
    const outfitId = parseOutfitId(req.params.outfitId);
    res.json(await outfitService.getOutfitDetails(outfitId, res.locals.cache));
});

module.exports = router;
