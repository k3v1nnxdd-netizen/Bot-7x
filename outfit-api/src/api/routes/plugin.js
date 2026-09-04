'use strict';

const express = require('express');
const router = express.Router();
const logger = require('../../observability/logger');
const { parsePluginSearchBody, ValidationError } = require('../../validation/params');

// Rutas del PLUGIN PRIVADO de Roblox Studio ("7x Outfit Importer").
//
// Cliente distinto de todos los demas, y por eso router propio: el plugin
// corre dentro de Studio, no dentro de una experiencia publicada. No tiene
// `game.GameId` real que verificar, asi que la cadena de autorizacion de
// /v1/users y /v1/outfits (token -> licencia -> propiedad del juego) no se
// puede aplicar aqui tal cual. Va FUERA de /v1 por lo mismo que /admin: /v1 es
// el contrato que consume el juego vendido y se versiona para no romperlo.
//
// ESTA PRIMERA VERSION NO AUTENTICA NADA Y NO BUSCA NADA. Existe unicamente
// para comprobar que el plugin llega a la API y sabe leer la respuesta. La
// unica proteccion que tiene delante es el limitador por IP que ya comparte
// con el resto del servicio (ver src/app.js) — el mismo, sin tocarlo.
// Antes de que esta ruta devuelva datos reales hay que ponerle credencial
// propia; la respuesta de abajo es fija a proposito para que quede evidente
// que todavia no lo es.

// Parser de cuerpo montado SOLO en este router, igual que hacen
// /admin/groups (4kb) y /v1/license/verify (2kb). La API de outfits sigue sin
// parser a nivel de app. 1kb sobra para un unico entero, y convierte un cuerpo
// desmedido en un 413 barato en vez de en memoria ocupada.
router.use(express.json({ limit: '1kb' }));

// Respuesta de PRUEBA, fija. No sale de Roblox ni de la base: son los tres
// registros que el plugin necesita para dibujar su lista y demostrar que el
// viaje de ida y vuelta funciona. Congelada para que ningun handler futuro la
// mute por accidente entre peticiones — es un modulo cargado una sola vez.
const OUTFITS_DE_PRUEBA = Object.freeze([
    Object.freeze({ userId: 3156911153, username: 'Soykevinsitop' }),
    Object.freeze({ userId: 156, username: 'Test1' }),
    Object.freeze({ userId: 261, username: 'Test2' }),
]);

// POST /plugin/outfits/search
//   body: { "amount": 100 }   entero, 1..500
//
//   200 { success:true, requested, found, outfits:[{userId,username}] }
//   400 { error: { code:'invalid_request', message } }
//
// `requested` devuelve el `amount` REAL que llego, no el que el plugin cree
// haber mandado: es lo que permite verificar de un vistazo que el cuerpo viajo
// entero y que el numero no se convirtio en cadena por el camino. `found` sale
// de la longitud de la lista y no de una constante, para que el dia que la
// busqueda sea real no haya que acordarse de cambiarlo en dos sitios.
router.post('/outfits/search', (req, res) => {
    res.locals.routeLabel = 'POST /plugin/outfits/search';

    let amount;
    try {
        ({ amount } = parsePluginSearchBody(req.body));
    } catch (err) {
        // El 400 lo sigue construyendo el error handler central — aqui no se
        // responde, se relanza — pero un `amount` rechazado se deja registrado
        // ademas en el log: mientras se integra el plugin, saber QUE mando es
        // la mitad del trabajo de depurarlo, y el 4xx por si solo no lo dice.
        if (err instanceof ValidationError) {
            logger.warn('Peticion invalida del plugin', {
                requestId: req.requestId,
                route: 'POST /plugin/outfits/search',
                amountType: typeof req.body?.amount,
                detail: err.message,
            });
        }
        throw err;
    }

    return res.json({
        success: true,
        requested: amount,
        found: OUTFITS_DE_PRUEBA.length,
        outfits: OUTFITS_DE_PRUEBA,
    });
});

module.exports = router;
