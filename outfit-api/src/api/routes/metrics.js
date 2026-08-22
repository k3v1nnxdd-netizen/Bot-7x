'use strict';

const express = require('express');
const router = express.Router();
const observability = require('../../observability/metrics');
const cacheStore = require('../../cache/cacheStore');
const robloxRateLimiter = require('../../roblox/rateLimiter');
const ownRateLimit = require('../../security/rateLimit');
const db = require('../../db/pool');
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
        cache: cacheStore.getMetrics(),
        ownRateLimit: ownRateLimit.getMetrics(),
        roblox: robloxRateLimiter.getMetrics(),
        db: { ...db.getMetrics(), ...dbSchema.getStatus() },
    });
});

module.exports = router;
