'use strict';

const express = require('express');
const router = express.Router();
const outfitService = require('../../services/outfitService');
const { parseOutfitId, parseBooleanFlag } = require('../../validation/params');

// GET /v1/outfits/:outfitId[?catalog=1][?bundles=1]
//
// Por defecto devuelve todo lo necesario para reconstruir el avatar — escalas,
// colores por parte del cuerpo, tipo de avatar (R6/R15), partes del cuerpo,
// ropa clasica 2D, ropa por capas con su order/puffiness, accesorios de cada
// categoria, cara y cabeza dinamica — ya agrupado en forma de
// HumanoidDescription. Todo eso sale de UNA sola llamada a Roblox.
//
// Dos extras opcionales, ambos apagados porque cuestan llamadas de mas:
//   ?catalog=1  estado de cada asset (limitado, fuera de venta, si Roblox
//               todavia lo reconoce). UNA sola llamada por lote para el
//               outfit entero, no una por asset.
//   ?bundles=1  a que bundles pertenece cada asset. UNA llamada POR ASSET —
//               es el unico mecanismo que ofrece Roblox — y ademas con datos
//               incompletos. Ver el README antes de usarlo.
router.get('/:outfitId', async (req, res) => {
    res.locals.routeLabel = '/v1/outfits/:outfitId';
    const outfitId = parseOutfitId(req.params.outfitId);
    const catalog = parseBooleanFlag(req.query.catalog, 'catalog');
    const bundles = parseBooleanFlag(req.query.bundles, 'bundles');
    res.json(await outfitService.getOutfitDetailsWithOptions(outfitId, { catalog, bundles }, res.locals.cache));
});

module.exports = router;
