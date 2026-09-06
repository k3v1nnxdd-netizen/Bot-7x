'use strict';

const crypto = require('crypto');
const logger = require('./logger');

// Una linea por peticion, al terminar. Lleva lo que de verdad sirve para
// diagnosticar bajo carga y nada mas:
//   requestId  — devuelto tambien en la cabecera X-Request-Id, para que el
//                juego pueda citar un id exacto al reportar un problema.
//   cache      — de donde salio la respuesta ('hit', 'miss', 'negative-hit').
//                Es la señal mas util del servicio: si bajo carga esto no es
//                mayoritariamente 'hit', algo esta mal en los TTLs.
//   durationMs — latencia real vista por el llamador.
//
// LO QUE NO SE LOGUEA, A PROPOSITO: las cabeceras. Ni todas ni ninguna en
// bloque. `x-api-key` viaja ahi y es el unico secreto del servicio, asi que
// los campos se eligen de uno en uno y jamas se pasa `req.headers` entero.
// El logger ademas redacta por nombre cualquier campo que suene a credencial
// (ver logger.js), como segunda barrera por si alguien añade un campo nuevo
// sin reparar en esto.
function requestLogger(req, res, next) {
    const requestId = crypto.randomUUID();
    const startedAt = process.hrtime.bigint();

    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    // Instante de entrada, en milisegundos de reloj. `startedAt` de arriba es
    // un hrtime y sirve para medir la duracion con precision; este es para que
    // un handler pueda saber CUANTO tardo todo lo anterior a el — la cadena de
    // licencia, sin ir mas lejos — sin volver a medirla por su cuenta.
    res.locals.startedAtMs = Date.now();

    // Los servicios empujan aqui de donde salio cada dato. Es un array (y no
    // un solo valor) porque el endpoint compuesto consulta dos entidades y
    // conviene ver ambas: "hit,miss" dice mucho mas que un unico estado.
    res.locals.cache = [];

    res.on('finish', () => {
        const durationMs = +(Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(1);
        const fields = {
            requestId,
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
            durationMs,
            ip: req.ip,
        };
        if (res.locals.cache.length) fields.cache = res.locals.cache.join(',');
        if (res.locals.errorCode) fields.errorCode = res.locals.errorCode;

        // Un 5xx es un problema nuestro y merece nivel error; un 4xx es el
        // llamador equivocandose y satura el log a poco trafico que haya.
        const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
        logger[level]('request', fields);
    });

    next();
}

module.exports = { requestLogger };
