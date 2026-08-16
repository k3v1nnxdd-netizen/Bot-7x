'use strict';

const express = require('express');
const router = express.Router();
const outfitService = require('../../services/outfitService');
const { parseOutfitId, parseBooleanFlag } = require('../../validation/params');

// GET /v1/outfits/:outfitId[?bundles=1]
//
// Devuelve todo lo necesario para reconstruir el avatar: escalas, colores por
// parte del cuerpo, tipo de avatar (R6/R15), partes del cuerpo, ropa clasica
// 2D, ropa por capas con su order/puffiness, accesorios de cada categoria,
// cara, cabeza dinamica, animaciones y emotes — ya agrupado en forma de
// HumanoidDescription para que Studio lo aplique sin procesar nada.
//
// Todo eso sale de UNA sola llamada a Roblox. `?bundles=1` es el unico extra
// que cuesta llamadas adicionales, y por eso hay que pedirlo explicitamente.
router.get('/:outfitId', async (req, res) => {
    res.locals.routeLabel = '/v1/outfits/:outfitId';
    const outfitId = parseOutfitId(req.params.outfitId);
    const bundles = parseBooleanFlag(req.query.bundles, 'bundles');
    res.json(await outfitService.getOutfitDetailsWithOptions(outfitId, { bundles }, res.locals.cache));
});

module.exports = router;
