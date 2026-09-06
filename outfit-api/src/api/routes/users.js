'use strict';

const express = require('express');
const router = express.Router();
const userService = require('../../services/userService');
const outfitService = require('../../services/outfitService');
const config = require('../../config');
const { parseUsername, parseUserId, parsePagination, parseListingFlags } = require('../../validation/params');

// Adaptadores HTTP finos: validar, llamar al servicio, responder. Ni logica
// de negocio ni try/catch — Express 5 propaga el rechazo de un handler async
// al error handler central, que es el unico sitio donde se traduce a HTTP.

// Las rutas /by-username van declaradas ANTES que /:userId. Aunque no colisionan
// (un userId siempre es numerico y la validacion lo rechazaria), el orden
// explicito evita depender de esa coincidencia si mañana se añade otra ruta.

// GET /v1/users/by-username/:username
router.get('/by-username/:username', async (req, res) => {
    res.locals.routeLabel = '/v1/users/by-username/:username';
    const username = parseUsername(req.params.username);
    res.json(await userService.resolveUsername(username, res.locals.cache));
});

// GET /v1/users/by-username/:username/outfits
//     ?limit=&pageToken=&outfitType=&details=&catalog=
//
// Compuesto: resuelve y lista en una sola llamada, para que el juego gaste
// una peticion de HttpService en vez de dos. Ver outfitService.
//
// CON details=1 GASTA UNA SOLA PETICION PARA TODA LA CUADRICULA. El juego pedia
// la lista aqui y despues los detalles por otra ruta; ahora los detalles se
// resuelven por dentro con el mismo servicio que atiende POST
// /v1/outfits/batch, sin ninguna llamada HTTP contra nosotros mismos.
//
// SIN LAS BANDERAS LA RESPUESTA NO CAMBIA. Es lo que permite desplegar esto sin
// tocar el juego que ya esta publicado.
router.get('/by-username/:username/outfits', async (req, res) => {
    res.locals.routeLabel = '/v1/users/by-username/:username/outfits';
    const username = parseUsername(req.params.username);
    const pagination = parsePagination(req.query);
    const flags = parseListingFlags(req.query, { maxDetails: config.outfitsBatch.maxIds }, pagination.limit);
    res.json(await outfitService.listOutfitsByUsername(username, pagination, flags, res.locals.cache));
});

// GET /v1/users/:userId/outfits?limit=&pageToken=&outfitType=
// Paginacion POR CURSOR: se reenvia el `nextPageToken` de la respuesta
// anterior como `pageToken`. `page` no existe aqui y se rechaza con 400 —
// Roblox lo ignora y devolveria siempre los mismos outfits.
router.get('/:userId/outfits', async (req, res) => {
    res.locals.routeLabel = '/v1/users/:userId/outfits';
    const userId = parseUserId(req.params.userId);
    const pagination = parsePagination(req.query);
    res.json(await outfitService.listOutfits(userId, pagination, res.locals.cache));
});

module.exports = router;
