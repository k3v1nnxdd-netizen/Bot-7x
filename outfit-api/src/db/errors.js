'use strict';

// Taxonomia de fallos de Postgres, con el mismo criterio que ya tiene la capa
// de Roblox (src/roblox/errors.js): quien captura decide por CLASE y la unica
// traduccion a HTTP vive en src/api/errorHandler.js.
//
// LA DISTINCION QUE IMPORTA AQUI es "la base no esta" contra "la consulta
// esta mal". Son 503 y 500, y mezclarlas dejaria al administrador sin saber
// si tiene que mirar el estado de Railway o abrir un ticket:
//
//   503 database_unavailable -> la base no responde (caida, reiniciando,
//                               limite de conexiones, red). Reintentar tiene
//                               sentido. NO es culpa de quien llama.
//   500 internal_error       -> SQL invalido, restriccion violada, un bug
//                               nuestro. Reintentar no arregla nada.
class DatabaseUnavailableError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'DatabaseUnavailableError';
        this.code = 'database_unavailable';
        this.cause = cause;
    }
}

// Codigos que significan "no se pudo hablar con la base", no "la consulta
// estaba mal". Los SQLSTATE los emite Postgres; los ERR* los emite el socket
// de Node antes de que exista conexion alguna.
const UNAVAILABLE_CODES = new Set([
    // SQLSTATE (clase 08 = fallo de conexion, clase 57 = intervencion del operador)
    '08000', '08003', '08006', '08001', '08004', '08007', '08P01',
    '57P01', '57P02', '57P03',
    '53300', // too_many_connections
    '57014', // query_canceled: aqui llega por statement_timeout, no por un bug del SQL
    // Errores de socket de Node (no hay SQLSTATE porque no hubo conexion)
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE',
    // Nuestro propio marcador: falta DATABASE_URL (ver src/db/pool.js)
    'DB_NOT_CONFIGURED',
]);

// Traduce un error crudo de `pg` a nuestra taxonomia. Lo que no es un fallo de
// disponibilidad se devuelve TAL CUAL para que suba como error no controlado:
// un 500 con su stack en el log es exactamente lo que queremos ante un bug
// nuestro, y disfrazarlo de 503 solo serviria para no enterarnos.
function translateDbError(err) {
    if (err instanceof DatabaseUnavailableError) return err;

    if (UNAVAILABLE_CODES.has(err?.code)) {
        return new DatabaseUnavailableError(
            'La base de datos no esta disponible en este momento',
            err
        );
    }

    return err;
}

module.exports = { DatabaseUnavailableError, translateDbError, UNAVAILABLE_CODES };
