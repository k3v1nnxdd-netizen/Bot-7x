'use strict';

const express = require('express');
const router = express.Router();
const outfitService = require('../../services/outfitService');
const config = require('../../config');
const logger = require('../../observability/logger');
const requestContext = require('../../observability/requestContext');
const observability = require('../../observability/metrics');
const { parseOutfitId, parseBooleanFlag, parseOutfitBatchBody } = require('../../validation/params');

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

// ── POST /v1/outfits/batch ──────────────────────────────────────────────────
//
// Parser de cuerpo montado SOLO para esta ruta, igual que hacen /admin/groups y
// /v1/license/verify. La API de outfits sigue sin parser a nivel de app: las
// demas rutas son GET y no ganan superficie porque esta exista. 8kb sobran para
// cuarenta ids y convierten un cuerpo desmedido en un 413 barato.
router.use('/batch', express.json({ limit: '8kb' }));

// POST /v1/outfits/batch
//   body: { "outfitIds": [123, 456, 789] }
//
//   200 { requested, unique, succeeded, failed,
//         results: [ { outfitId, ok: true,  outfit }
//                  | { outfitId, ok: false, error: { code, message } } ],
//         stats: { ... } }
//
// MISMA SEGURIDAD QUE LA RUTA INDIVIDUAL, Y SE COMPRUEBA UNA SOLA VEZ. Esta
// ruta cuelga del mismo router que /v1/outfits/:outfitId, asi que hereda tal
// cual la cadena que monta src/app.js — limitador por IP, x-license-token,
// licencia activa y propiedad REAL del juego contra Roblox — antes de llegar
// aqui. Un lote no relaja nada: lo que cambia es que esa cadena se paga una vez
// en lugar de veinticuatro.
//
// EL ESTADO HTTP ES 200 AUNQUE ALGUN OUTFIT FALLE. El lote se atendio; que un
// outfit concreto este borrado o que Roblox limitara una llamada es informacion
// de ESE id, no un fallo de la peticion. Cada resultado lleva su veredicto, y
// el juego decide. Un 4xx global obligaria a descartar los veintitres que si
// llegaron.
router.post('/batch', async (req, res) => {
    res.locals.routeLabel = 'POST /v1/outfits/batch';

    const { outfitIds, catalog } = parseOutfitBatchBody(req.body, {
        maxIds: config.outfitsBatch.maxIds,
    });

    // El reparto del tiempo se acumula en el contexto: el limitador suma ahi lo
    // que se va en esperar y lo que se va en Roblox, sin que haya que enhebrar
    // un objeto por las cuatro capas que hay hasta el (ver observability/
    // requestContext.js). `licenseMs` es lo que tardo todo lo anterior a este
    // handler: limitador por IP, token, licencia y propiedad del juego.
    const medidor = requestContext.nuevoMedidor();
    const empezado = Date.now();
    const licenseMs = res.locals.startedAtMs ? empezado - res.locals.startedAtMs : null;

    // Se PARTE del contexto que ya hay abierto en vez de empezar uno nuevo:
    // `ejecutarCon` sustituye el almacen entero, y el que viene de fuera trae la
    // fecha limite del presupuesto de la peticion (ver api/requestBudget.js).
    // Abrir uno limpio aqui dejaria al lote sin presupuesto y con ello sin el
    // corte de reintentos, que es justo lo que evita que veinticuatro outfits
    // contra un Roblox colgado se conviertan en una espera eterna.
    const { results, medidas } = await requestContext.ejecutarCon(
        { ...requestContext.actual(), requestId: req.requestId, medidor },
        () => outfitService.getOutfitsBatch(outfitIds, { catalog }, res.locals.cache)
    );

    const totalMs = Date.now() - empezado;

    const stats = {
        requested: medidas.requested,
        unique: medidas.unique,
        succeeded: medidas.succeeded,
        failed: medidas.failed,
        cacheHits: medidas.cacheHits,
        cacheMisses: medidas.cacheMisses,
        singleFlightJoins: medidas.singleFlightJoins,
        upstreamCalls: medidor.llamadasUpstream,
        // Catalogo: si se pidio, cuantos assets DISTINTOS hubo que mirar entre
        // todos los outfits y cuantos quedaron sin ficha. `catalogAssets` muy
        // por debajo de la suma de assets del lote es la deduplicacion
        // haciendo su trabajo.
        catalog,
        catalogAssets: medidas.catalogAssets,
        catalogUnresolved: medidas.catalogUnresolved,
        timings: {
            // Lo que tardo la cadena de licencia, medido desde que entro la
            // peticion hasta que empezo este handler.
            licenseMs,
            // Lectura de cache de todos los ids.
            cacheMs: medidas.cacheMs,
            // Suma de espera en NUESTRO limitador (slot, marcapasos, cooldown,
            // gate) sobre todas las llamadas salientes del lote.
            rateLimiterWaitMs: medidor.esperaLimitadorMs,
            // Suma del tiempo dentro de Roblox. Con concurrencia, la suma puede
            // superar `totalMs`: dice cuanto TRABAJO hubo, no cuanto reloj paso.
            robloxMs: medidor.robloxMs,
            // Resolver los precios de todo el lote, de golpe.
            catalogMs: medidas.catalogMs,
            totalMs,
        },
    };

    // Acumulado del proceso, para poder verlo desde /v1/metrics sin depender de
    // que alguien pegue la respuesta de una peticion concreta.
    observability.recordBatch({ ...stats, upstreamCalls: medidor.llamadasUpstream });

    // Una linea por lote, agregada. Nunca una por outfit: veinticuatro lineas
    // por peticion ahogarian el log sin decir mas. Ni un token, ni un id de
    // licencia: solo cuantos, cuanto y de donde salieron.
    logger.info('Lote de outfits', {
        requestId: req.requestId,
        ...stats,
        ...stats.timings,
        timings: undefined,
    });

    res.json({
        requested: medidas.requested,
        unique: medidas.unique,
        succeeded: medidas.succeeded,
        failed: medidas.failed,
        results,
        stats,
    });
});

// Un solo outfit. Se declara DESPUES del lote a proposito: '/batch' es un GET
// distinto de este, pero mantener el orden explicito evita que un cambio futuro
// de metodo convierta "batch" en un outfitId.
router.get('/:outfitId', async (req, res) => {
    res.locals.routeLabel = '/v1/outfits/:outfitId';
    const outfitId = parseOutfitId(req.params.outfitId);
    const catalog = parseBooleanFlag(req.query.catalog, 'catalog');
    const bundles = parseBooleanFlag(req.query.bundles, 'bundles');
    res.json(await outfitService.getOutfitDetailsWithOptions(outfitId, { catalog, bundles }, res.locals.cache));
});

module.exports = router;
