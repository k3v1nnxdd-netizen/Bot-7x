'use strict';

const config = require('./src/config');
const logger = require('./src/observability/logger');
const { createApp } = require('./src/app');

const app = createApp();

const server = app.listen(config.port, () => {
    logger.info('outfit-api escuchando', {
        port: config.port,
        cacheDriver: config.cacheDriver,
        apiKeyConfigured: Boolean(config.apiKey), // booleano, NUNCA la key
    });
});

// keepAliveTimeout debe SUPERAR el idle timeout del proxy que tengamos
// delante (el edge de Railway ronda los 60s, como casi todos). Si nuestro
// servidor cerrara antes un socket keep-alive todavia bueno, el proxy podria
// intentar reutilizarlo justo en ese instante: es la causa clasica de resets
// de conexion esporadicos bajo carga. headersTimeout debe quedar por encima
// de keepAliveTimeout (lo exige Node).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

// Techo absoluto por peticion. Nuestras rutas ya se autolimitan (timeout
// saliente + techo de espera en linea), asi que esto solo caza lo patologico
// — un cliente que abre la conexion y no termina de mandar la peticion — en
// lugar de dejar el socket ocupado los 5 minutos que Node permite por defecto.
server.requestTimeout = 15_000;

// Apagado limpio. Railway manda SIGTERM en cada redeploy: dejar de aceptar
// conexiones nuevas y esperar a que terminen las vivas evita cortar
// respuestas a mitad. No hay nada que volcar a disco — la cache es
// deliberadamente efimera y en memoria — asi que esto es puro drenaje.
let shuttingDown = false;

function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Apagando', { signal });

    server.close(() => {
        logger.info('Servidor cerrado limpiamente');
        process.exit(0);
    });

    // Si algo se queda colgado, no se espera indefinidamente: Railway acabaria
    // mandando SIGKILL de todas formas, y salir por nuestro pie deja un log
    // que lo explica en vez de una muerte silenciosa.
    setTimeout(() => {
        logger.warn('Cierre forzado tras el periodo de gracia');
        process.exit(1);
    }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Red de seguridad a nivel de proceso: se registra y se sigue. Una promesa
// rechazada suelta en una ruta ya la recoge el error handler de Express; esto
// cubre lo que ocurra fuera del ciclo de una peticion.
process.on('unhandledRejection', reason => {
    logger.error('unhandledRejection', { detail: reason?.message ?? String(reason) });
});
process.on('uncaughtException', err => {
    logger.error('uncaughtException', { detail: err?.message, stack: err?.stack });
});

module.exports = { server };
