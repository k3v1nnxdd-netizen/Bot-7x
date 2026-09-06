'use strict';

const express = require('express');
const router = express.Router();
const observability = require('../../observability/metrics');
const cacheStore = require('../../cache/cacheStore');
const robloxRateLimiter = require('../../roblox/rateLimiter');
const ownRateLimit = require('../../security/rateLimit');
const db = require('../../db/pool');
const indexWorker = require('../../services/indexWorker/worker');
const dbSchema = require('../../db/schema');

// Protegida por la misma API key que el resto de /v1: expone detalle
// operativo interno (tasas de acierto, estado de los circuitos, memoria) que
// no tiene por que ser publico.
//
// Es la unica forma de comprobar DESDE FUERA del proceso, y bajo carga real,
// que el diseño esta cumpliendo. Que mirar en una prueba de carga:
//   cache.hitRate              -> deberia subir hacia 1 conforme se repite el trafico
//   singleFlight.joined        -> cuantas estampidas se colapsaron en una sola llamada
//   roblox.byRoute.*.calls     -> deberia mantenerse PLANO aunque el trafico crezca
//   roblox.byRoute.*.circuit   -> 'closed' en operacion normal
//   roblox.concurrency.queued  -> si vive alto, el gate es el cuello de botella
//   db.configured / schemaReady-> unica forma de confirmar DESDE FUERA que la
//                                 base esta enlazada y la tabla creada
//
// No contiene ningun secreto: ni la API key ni la cadena de conexion de
// Postgres aparecen aqui ni en ninguna otra respuesta del servicio. Del bloque
// `db` solo salen booleanos, contadores y SQLSTATEs.
router.get('/', (req, res) => {
    res.locals.routeLabel = '/v1/metrics';
    res.json({
        process: observability.getProcessMetrics(),
        http: observability.getHttpMetrics(),
        // Lote de outfits: cuanto se pidio y cuanto se evito pedirle a Roblox.
        // Si `upstreamCalls` se acerca a `idsRequested`, el lote esta ahorrando
        // peticiones del juego pero no cuota de Roblox — y eso hay que verlo.
        outfitsBatch: observability.getBatchMetrics(),
        cache: cacheStore.getMetrics(),
        ownRateLimit: ownRateLimit.getMetrics(),
        roblox: robloxRateLimiter.getMetrics(),
        db: { ...db.getMetrics(), ...dbSchema.getStatus() },
        // Worker del indice: cobertura y frescura del ultimo grupo recorrido,
        // velocidad, cuantas veces corto Roblox y cuanto se espero por ello.
        // Es la unica forma de saber DESDE FUERA si el indice esta listo para
        // empezar a servir busquedas.
        indexWorker: indexWorker.metricas,
    });
});

module.exports = router;
