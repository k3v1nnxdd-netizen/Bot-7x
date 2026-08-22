'use strict';

const logger = require('../observability/logger');
const { ValidationError } = require('../validation/params');
const {
    NotFoundError, UpstreamRateLimitedError, CircuitOpenError, UpstreamError,
} = require('../roblox/errors');
const { DatabaseUnavailableError } = require('../db/errors');
const { OwnershipUnavailableError } = require('../services/gameOwnershipService');

// UNICO punto de traduccion error -> HTTP de todo el servicio. Los handlers
// de ruta no capturan nada: dejan subir el error y aqui se decide. Asi el
// contrato de errores es imposible de desalinear entre endpoints.
//
// Formato unico de error, siempre: { error: { code, message } }. `code` es
// estable y esta pensado para que el juego haga `if` sobre el; `message` es
// texto para humanos y puede cambiar sin previo aviso.
//
// LA DISTINCION QUE MAS IMPORTA — 429 vs 503:
//   429 rate_limited          -> el limite es NUESTRO. El juego debe bajar su ritmo.
//   503 upstream_rate_limited -> el limite es de ROBLOX. Esperar el Retry-After
//                                y reintentar; bajar el ritmo propio no arregla nada.
// Mezclarlos en un solo codigo dejaria al juego sin poder reaccionar bien a
// ninguno de los dos.

function send(res, status, code, message, extra) {
    res.locals.errorCode = code; // lo recoge el requestLogger
    return res.status(status).json({ error: { code, message, ...extra } });
}

// eslint-disable-next-line no-unused-vars -- Express identifica a un error
// handler por su aridad de 4: quitar `next` lo convertiria en middleware normal.
function errorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);

    if (err instanceof ValidationError) {
        return send(res, 400, err.code, err.message);
    }

    // Errores de express.json(), que solo puede dispararlos POST
    // /admin/groups: es el unico sitio con parser de body. Sin este bloque un
    // JSON mal escrito acabaria de 500, culpando al servidor de un error del
    // cliente. `err.type` lo pone body-parser; no es un instanceof porque
    // reutiliza SyntaxError y otras clases nativas.
    if (err?.type === 'entity.parse.failed') {
        return send(res, 400, 'invalid_request', 'El cuerpo de la peticion debe ser JSON valido');
    }
    if (err?.type === 'entity.too.large') {
        return send(res, 413, 'payload_too_large', 'El cuerpo de la peticion es demasiado grande');
    }

    if (err instanceof NotFoundError) {
        return send(res, 404, err.code, err.message);
    }

    // Limite de Roblox, no nuestro. Se propaga el Retry-After tal cual lo
    // dijo Roblox: es informacion suya sobre cuando volvera a atender, y
    // sustituirla por una estimacion propia solo puede empeorarla.
    if (err instanceof UpstreamRateLimitedError || err instanceof CircuitOpenError) {
        const retryAfterSeconds = err.retryAfterSeconds ?? 5;
        res.set('Retry-After', String(retryAfterSeconds));
        return send(res, 503, err.code, err.message, { retryAfterSeconds });
    }

    // La base no responde (caida, reiniciando, sin conexiones libres). Es un
    // 503 y no un 500 por la misma razon por la que un limite de Roblox no es
    // un 429 nuestro: dice DE QUIEN es el problema y si reintentar sirve de
    // algo. El detalle crudo se registra pero no se devuelve — un error de pg
    // puede arrastrar el host y hasta el fragmento de consulta.
    if (err instanceof DatabaseUnavailableError) {
        logger.error('Postgres no disponible', {
            requestId: req.requestId,
            path: req.originalUrl,
            code: err.cause?.code ?? null,
            detail: err.cause?.message ?? err.message,
        });
        res.set('Retry-After', '5');
        return send(res, 503, err.code, 'La base de datos no esta disponible, reintenta en unos segundos', {
            retryAfterSeconds: 5,
        });
    }

    // No se pudo AVERIGUAR de quien es la experiencia (Roblox caido, limitado
    // o con el breaker abierto). Es 503 y jamas un 403, y esa diferencia es
    // justo lo que impide que un mal rato de Roblox eche a un cliente legitimo
    // de su propio juego: "ahora mismo no lo se, reintenta" no es lo mismo que
    // "no eres el dueño". Ver src/services/gameOwnershipService.js.
    if (err instanceof OwnershipUnavailableError) {
        logger.warn('No se pudo verificar la propiedad del juego', {
            requestId: req.requestId,
            path: req.originalUrl,
            detail: err.cause?.message ?? err.message,
        });
        const retryAfterSeconds = err.retryAfterSeconds ?? 5;
        res.set('Retry-After', String(retryAfterSeconds));
        return send(res, 503, err.code, err.message, { retryAfterSeconds });
    }

    if (err instanceof UpstreamError) {
        // La causa se registra pero NUNCA se devuelve: un error de axios
        // arrastra URLs, cabeceras y configuracion interna.
        logger.error('Fallo hablando con Roblox', {
            requestId: req.requestId,
            path: req.originalUrl,
            detail: err.cause?.message ?? err.message,
            status: err.cause?.response?.status ?? null,
        });
        return send(res, 502, err.code, 'No se pudo obtener la informacion de Roblox');
    }

    // Cualquier cosa no prevista es un fallo NUESTRO: se registra completa
    // (con stack) y al cliente solo le llega el requestId para poder cruzarlo.
    logger.error('Error no controlado', {
        requestId: req.requestId,
        path: req.originalUrl,
        detail: err?.message,
        stack: err?.stack,
    });
    return send(res, 500, 'internal_error', 'Error interno del servidor');
}

function notFoundHandler(req, res) {
    res.locals.routeLabel = 'unmatched';
    return send(res, 404, 'route_not_found', 'Ese endpoint no existe en esta API');
}

module.exports = { errorHandler, notFoundHandler };
