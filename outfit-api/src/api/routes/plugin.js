'use strict';

const express = require('express');
const indexQuery = require('../../services/pluginSearch/indexQuery');
const config = require('../../config');
const router = express.Router();
const logger = require('../../observability/logger');
const jobs = require('../../services/pluginSearch/jobs');
const { arrancar } = require('../../services/pluginSearch/runner');
const { parsePluginSearchBody, parseSearchId, ValidationError } = require('../../validation/params');
const { NotFoundError } = require('../../roblox/errors');
const { ColaLlenaError, EsperaAgotadaError } = require('../../services/pluginSearch/groupQueue');

// Rutas del PLUGIN PRIVADO de Roblox Studio ("7x Outfit Importer").
//
// Cliente distinto de todos los demas, y por eso router propio: el plugin corre
// dentro de Studio, no dentro de una experiencia publicada. Va FUERA de /v1 por
// lo mismo que /admin: /v1 es el contrato que consume el juego vendido.
//
// CREDENCIAL PROPIA Y EXCLUSIVA: `x-plugin-key` (PLUGIN_API_KEY), comprobada en
// src/app.js ANTES de llegar aqui — o sea, antes incluso del parser de cuerpo
// que monta este router. Ni la key del juego, ni la de admin, ni un token de
// licencia abren estas rutas; y esta clave no abre ninguna de las otras.
//
// ── DOS MODOS, Y POR QUE ─────────────────────────────────────────────────────
//
// SINCRONO (default): POST devuelve cuando la busqueda termina. Es el
// comportamiento historico y sigue intacto, asi que un plugin que no cambie
// sigue funcionando exactamente igual.
//
// ASINCRONO (`"async": true`): POST devuelve un `searchId` en cuanto arranca y
// el plugin pregunta por el con GET. Existe por una razon concreta:
// `HttpService:RequestAsync` de Roblox devuelve cuando el servidor termina, asi
// que en modo sincrono el plugin NO PUEDE enseñar progreso real durante una
// busqueda de 10-25 segundos — solo puede inventarse un contador. Partirlo en
// arrancar + preguntar es lo que permite una barra que no miente.

// Parser de cuerpo montado SOLO en este router, igual que hacen /admin/groups
// (4kb) y /v1/license/verify (2kb). La API de outfits sigue sin parser a nivel
// de app. 1kb sobra para seis campos.
router.use(express.json({ limit: '1kb' }));

// POST /plugin/outfits/search
//   body: { "amount": 10, "groupId": 59218460, "minPrice": 300, "maxPrice": 3000,
//           "requireCompletePrice": false, "async": true }
//     amount   entero 1..500      OBLIGATORIO — outfits VALIDOS que se quieren,
//                                 no candidatos que se miran
//     groupId  entero positivo    OBLIGATORIO (numero JSON, no cadena)
//     minPrice entero >= 0        opcional (default 0)
//     maxPrice entero >= minPrice opcional (default sin techo)
//     requireCompletePrice booleano opcional (default true, estricto)
//     async    booleano opcional  (default false, sincrono)
//
//   200 (sincrono)  { success, requested, found, outfits[], stats, progress, searchId }
//   202 (asincrono) { success, searchId, status:'queued', pollAfterMs, ... }
//   400 cuerpo mal formado · 401 sin x-plugin-key · 404 grupo inexistente
//   429 queue_full — ya hay demasiadas busquedas esperando turno de ese grupo
//   503 Roblox limitando, PLUGIN_API_KEY sin configurar, o queue_timeout
//
// UNA SOLA BUSQUEDA RECORRE UN GRUPO A LA VEZ. Si llega otra del mismo groupId,
// hace cola y arranca donde termino la anterior; el GET la enseña como
// `queued` con su `queuePosition`. Grupos distintos corren en paralelo sin
// estorbarse.
//
// `found` PUEDE SER MENOR QUE `requested` Y NO ES UN ERROR. La busqueda recorre
// la comunidad sustituyendo candidatos invalidos hasta juntar lo pedido, pero
// tiene presupuestos (tiempo, candidatos, limite de Roblox) y una comunidad
// tiene los miembros que tiene. Devolver 7 de 10 es un resultado, no un fallo.
router.post('/outfits/search', async (req, res) => {
    res.locals.routeLabel = 'POST /plugin/outfits/search';

    let peticion;
    try {
        peticion = parsePluginSearchBody(req.body);
    } catch (err) {
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

    // ── SERVIR DESDE EL INDICE ───────────────────────────────────────────────
    //
    // Con INDEX_SERVE_ENABLED=true esto es TODO: una transaccion contra
    // Postgres y la respuesta, en milisegundos. NO se llama a Roblox por
    // ninguna via, ni siquiera cuando el indice se queda corto — ese respaldo
    // automatico era justo lo que convertia "faltan seis outfits" en una espera
    // de una hora.
    //
    // La respuesta es TERMINAL y no lleva searchId: no hay nada que sondear. El
    // plugin lo reconoce por la ausencia de searchId y rehabilita el boton en
    // el acto.
    if (config.indexServe.enabled) {
        const desdeElIndice = await indexQuery.servir({
            groupId: peticion.groupId,
            amount: peticion.amount,
            minPrice: peticion.minPrice,
            maxPrice: peticion.maxPrice,
            requireCompletePrice: peticion.requireCompletePrice,
        });

        const encontrados = desdeElIndice.outfits.length;
        const completo = encontrados >= peticion.amount;

        logger.info('Busqueda del plugin servida desde el indice', {
            requestId: req.requestId,
            groupId: String(peticion.groupId),
            requested: peticion.amount,
            found: encontrados,
            members: desdeElIndice.coverage.members,
            indexed: desdeElIndice.coverage.indexed,
            tookMs: desdeElIndice.tookMs,
            robloxCalls: 0,
        });

        return res.json({
            success: true,
            status: completo ? 'completed' : 'partial',
            requested: peticion.amount,
            found: encontrados,
            outfits: desdeElIndice.outfits,
            // El plugin lo usa para decir "indexando comunidad" en vez de
            // "no hay outfits": son dos cosas muy distintas para quien mira.
            indexWarming: !completo,
            coverage: desdeElIndice.coverage,
        });
    }

    // Se ESPERA a que el trabajo exista en la base antes de arrancarlo. Era
    // una carrera: la primera escritura vallada del ejecutor podia llegar a
    // Postgres antes que el INSERT, no tocar ninguna fila, y leerse como "otra
    // instancia lo adopto" — el proceso soltaba una busqueda que nadie tenia.
    const trabajo = await jobs.crear({ peticion, requestId: req.requestId });

    // ── Modo asincrono: se responde YA y la busqueda sigue por su cuenta ─────
    if (peticion.async) {
        // Sin await: el trabajo corre en segundo plano y el plugin lo sigue por
        // GET. `arrancar` no rechaza en este modo — captura dentro — asi que no
        // puede dejar una promesa rechazada suelta en el proceso.
        arrancar(trabajo, peticion);
        return res.status(202).json({ success: true, ...jobs.presentar(trabajo) });
    }

    // ── Modo sincrono: el comportamiento de siempre ──────────────────────────
    // Comparte el MISMO motor que el asincrono; lo unico que cambia es que aqui
    // se espera. Dos caminos distintos acabarian divergiendo.
    const resultado = await arrancar(trabajo, peticion, { relanzar: true });

    return res.json({
        success: true,
        requested: peticion.amount,
        found: resultado.outfits.length,
        outfits: resultado.outfits,
        stats: resultado.stats,
        // Aditivo: el mismo bloque de progreso que devuelve el GET, para que el
        // plugin pueda pintar el resumen final sin conocer dos formas distintas.
        progress: resultado.progress,
        searchId: trabajo.searchId,
    });
});

// GET /plugin/outfits/search/:searchId
//
//   200 { searchId, status, requested, found, progress, pollAfterMs, outfits[], stats }
//   404 search_not_found — id desconocido, o el trabajo ya caduco
//
// El plugin consulta cada `pollAfterMs` (lo dice el servidor, para que el
// cliente no tenga que elegirlo ni equivocarse). Mientras `status` sea `queued`
// o `running`, `progress` trae encontrados, examinados y ETA; cuando pasa a
// `completed` o `partial` llegan los outfits.
//
// UN ID DESCONOCIDO ES 404 Y NO UN ERROR RARO: tras un reinicio de Railway los
// trabajos en vuelo se pierden (viven en memoria a proposito, ver jobs.js). El
// plugin lanza otra busqueda y la comunidad continua donde iba, porque LA
// ROTACION si esta en Postgres.
router.get('/outfits/search/:searchId', async (req, res) => {
    res.locals.routeLabel = 'GET /plugin/outfits/search/:searchId';

    const searchId = parseSearchId(req.params.searchId);
    // Busca primero en memoria y, si no esta, en Postgres: asi el GET funciona
    // tras un redeploy y tambien cuando aterriza en otra replica.
    const trabajo = await jobs.obtener(searchId);

    if (!trabajo) {
        throw new NotFoundError('search_not_found', 'Esa busqueda no existe o ya caduco');
    }

    return res.json(jobs.presentar(trabajo));
});

// El motor comun de los dos modos (y de la reanudacion tras un reinicio)
// vive en services/pluginSearch/runner.js: una busqueda adoptada de una
// instancia caida no tiene peticion HTTP detras, asi que el motor no puede
// vivir en la ruta.

module.exports = router;
