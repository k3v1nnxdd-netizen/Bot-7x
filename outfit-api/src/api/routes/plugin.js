'use strict';

const express = require('express');
const router = express.Router();
const logger = require('../../observability/logger');
const pluginSearch = require('../../services/pluginSearchService');
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
// CREDENCIAL PROPIA Y EXCLUSIVA: `x-plugin-key` (PLUGIN_API_KEY), comprobada
// en src/app.js ANTES de llegar aqui — o sea, antes incluso del parser de
// cuerpo que monta este router. Ni la key del juego, ni la de admin, ni un
// token de licencia abren esta ruta; y esta clave no abre ninguna de las
// otras. Ver src/security/pluginKey.js.
//
// Que este autenticada importa mas aqui que en ninguna otra ruta: una sola
// peticion se traduce en decenas o cientos de llamadas a Roblox. Delante
// quedan ademas el limitador por IP que comparte con el resto del servicio y
// los topes duros de la propia busqueda (config.pluginSearch).

// Parser de cuerpo montado SOLO en este router, igual que hacen
// /admin/groups (4kb) y /v1/license/verify (2kb). La API de outfits sigue sin
// parser a nivel de app. 1kb sobra para cuatro numeros, y convierte un cuerpo
// desmedido en un 413 barato en vez de en memoria ocupada.
router.use(express.json({ limit: '1kb' }));

// POST /plugin/outfits/search
//   body: { "amount": 100, "groupId": 59218460, "minPrice": 100, "maxPrice": 3000 }
//     amount    entero 1..500        OBLIGATORIO
//     groupId   entero positivo      OBLIGATORIO (numero JSON, no cadena)
//     minPrice  entero >= 0          opcional (default 0, "sin suelo")
//     maxPrice  entero >= minPrice   opcional (default sin techo)
//
//   200 { success:true, requested, found, outfits:[{userId,username,totalPrice}] }
//   400 { error: { code:'invalid_request', message } }   cuerpo mal formado
//   401 { error: { code:'unauthorized', ... } }          falta o falla x-plugin-key
//   404 { error: { code:'group_not_found', ... } }       Roblox no conoce el grupo
//   503 { error: { code:'plugin_disabled', ... } }       falta PLUGIN_API_KEY en el servidor
//   503 ...                                              Roblox limitando o caido
//
// `found` PUEDE SER MENOR QUE `requested` Y NO ES UN ERROR. Es el caso normal:
// el grupo puede tener menos miembros que outfits pedidos, el rango de precio
// puede descartar a casi todos, la busqueda tiene topes de candidatos y de
// tiempo, y ademas se descarta a todo aquel cuyo avatar no permita calcular un
// precio ENTERO y fiable (ver services/pluginSearchService.js). Devolver 40 de
// 100 es un resultado, no un fallo, y el plugin debe pintarlo como tal. El motivo exacto
// por el que paro cada busqueda queda en el log del servicio, no en la
// respuesta: al plugin no le sirve para nada y la forma de la respuesta es
// contrato con el.
router.post('/outfits/search', async (req, res) => {
    res.locals.routeLabel = 'POST /plugin/outfits/search';

    let peticion;
    try {
        peticion = parsePluginSearchBody(req.body);
    } catch (err) {
        // El 400 lo sigue construyendo el error handler central (aqui no se
        // responde, se relanza) pero un cuerpo rechazado se deja registrado
        // ademas en el log: mientras se integra el plugin, saber QUE mando es
        // la mitad del trabajo de depurarlo, y el 4xx por si solo no lo dice.
        if (err instanceof ValidationError) {
            logger.warn('Peticion invalida del plugin', {
                requestId: req.requestId,
                route: 'POST /plugin/outfits/search',
                amountType: typeof req.body?.amount,
                groupIdType: typeof req.body?.groupId,
                detail: err.message,
            });
        }
        throw err;
    }

    // Sin try/catch alrededor de la busqueda, como el resto de rutas: un fallo
    // duro de Roblox (limite, caida, grupo inexistente) sube al error handler
    // central, que es el unico sitio donde un error se traduce a HTTP. Los
    // fallos BLANDOS (un usuario que no se puede consultar) no llegan hasta
    // aqui: el servicio los descarta y sigue con el siguiente candidato.
    const outfits = await pluginSearch.searchOutfits(peticion, { requestId: req.requestId });

    return res.json({
        success: true,
        requested: peticion.amount,
        found: outfits.length,
        outfits,
    });
});

module.exports = router;
