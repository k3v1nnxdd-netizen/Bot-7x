'use strict';

const express = require('express');
const router = express.Router();
const catalogService = require('../../services/catalogService');
const logger = require('../../observability/logger');
const { requireLicense } = require('../../security/licenseGuard');
const { parseCatalogBatchBody } = require('../../validation/params');

// Inteligencia de catalogo por lotes. Es la pieza que se saca del .rbxl: el
// juego deja de saber que es una Dynamic Head, que assets forman Korblox o si
// algo esta fuera de venta — solo pregunta, y con la respuesta se limita a
// comprobar propiedad.
//
// DOBLE PUERTA, y las dos hacen falta:
//   x-api-key  -> "esto viene de un juego que usa el sistema" (esta en el .rbxl)
//   token      -> "este grupo ha pagado"                      (unico por licencia)
// La primera la pone el montaje en /v1 (src/app.js); la segunda, requireLicense,
// que reutiliza tal cual la cadena de /v1/license/verify — token, licencia
// activa y propiedad REAL del juego resuelta contra Roblox.

// Parser montado SOLO aqui, como en /admin/groups y /v1/license/verify. 8 kb:
// 80 ids ocupan ~1 kb y el limite convierte un cuerpo desmedido en un 413
// barato en vez de en memoria ocupada.
router.use(express.json({ limit: '8kb' }));

// POST /v1/catalog/batch
//   body: { token, gameId, placeId, assetIds[], bundleIds[]?, resolveBundles? }
//
// Respuestas:
//   200 { assets, bundles, ownershipChecks, ... }  — resuelto (quiza parcial)
//   403 { ok:false, motivo }                       — la licencia no autoriza
//   400 { error }                                  — peticion mal formada
//   503 { error }                                  — no se pudo resolver NADA
//
// El 503 con `partial` es la distincion que importa: si algo se resolvio se
// devuelve 200 con lo que hay y la lista de lo que falto, porque el juego
// puede pintar el outfit igual. Si no se resolvio nada y no habia nada en
// cache, un 200 vacio le diria "estos items no existen" — que es falso, y
// dejaria al jugador viendo un armario roto por un bache de Roblox.
router.post('/batch', requireLicense, async (req, res) => {
    res.locals.routeLabel = 'POST /v1/catalog/batch';

    const { assetIds, bundleIds, resolveBundles } = parseCatalogBatchBody(req.body);
    const resultado = await catalogService.resolveBatch({ assetIds, bundleIds, resolveBundles });

    logger.info('Catalogo por lotes', {
        groupId: res.locals.license?.groupId ?? null,
        placeId: res.locals.license?.placeId ?? null,
        pedidos: assetIds.length + bundleIds.length,
        resueltos: resultado.counts.assets + resultado.counts.bundles,
        reverseLookups: resultado.counts.reverseLookups,
        partial: resultado.partial,
    });

    if (resultado.nothingResolved) {
        res.locals.errorCode = 'upstream_unavailable';
        res.set('Retry-After', '5');
        return res.status(503).json({
            error: {
                code: 'upstream_unavailable',
                message: 'No se pudo resolver ningun item del catalogo en este momento, reintenta en unos segundos',
                retryAfterSeconds: 5,
            },
        });
    }

    return res.json({
        resolvedAt: new Date().toISOString(),
        partial: resultado.partial,
        counts: resultado.counts,
        assets: resultado.assets,
        bundles: resultado.bundles,
        ownershipChecks: resultado.ownershipChecks,
        unresolved: resultado.unresolved,
    });
});

module.exports = router;
