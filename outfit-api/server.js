'use strict';

const config = require('./src/config');
const logger = require('./src/observability/logger');
const { createApp } = require('./src/app');
const db = require('./src/db/pool');
const { ensureSchema } = require('./src/db/schema');
const jobs = require('./src/services/pluginSearch/jobs');

const app = createApp();

const server = app.listen(config.port, () => {
    logger.info('outfit-api escuchando', {
        port: config.port,
        cacheDriver: config.cacheDriver,
        apiKeyConfigured: Boolean(config.apiKey),   // booleano, NUNCA la key
        databaseConfigured: db.isConfigured(),      // booleano, NUNCA la URL
    });
});

// Esquema de Postgres, DESPUES de escuchar y sin bloquear el arranque: el
// healthcheck de Railway responde desde el primer segundo y la API de outfits
// atiende con normalidad mientras esto ocurre. Si falla no se lanza nada —
// ensureSchema() ya lo registra y deja constancia en /v1/metrics — porque la
// API de outfits no depende de la base para nada y no tiene por que caer con
// ella.
ensureSchema().then(async () => {
    // NINGUN TRABAJO PUEDE QUEDARSE 'running' PARA SIEMPRE. Un proceso que
    // muere deja los suyos escritos como en curso, y sin esto el plugin
    // esperaria un resultado que no va a llegar nunca. Se decide por LATIDO y no
    // por instancia, asi que un redeploy con dos replicas solapadas no mata los
    // trabajos vivos de la que sigue en pie.
    //
    // Va DESPUES del esquema (las tablas tienen que existir) y sin bloquear el
    // arranque: si falla, se registra y el servicio sigue sirviendo.
    const recuperacion = await jobs.recuperarAlArrancar();
    if (recuperacion.adoptados > 0 || recuperacion.expirados > 0 || recuperacion.borrados > 0) {
        logger.info('Trabajos de busqueda recuperados al arrancar', recuperacion);
    }
}).catch(err => {
    logger.warn('No se pudo recuperar el estado de los trabajos al arrancar', { detail: err?.message });
});

// Recolector de trabajos vencidos. `unref` para que no impida apagar el
// proceso: es mantenimiento, no trabajo pendiente.
const limpiezaDeTrabajos = setInterval(() => {
    jobs.recuperarAlArrancar().catch(() => { /* ya se registra dentro */ });
}, config.pluginJobs.cleanupIntervalMs);
limpiezaDeTrabajos.unref();

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

    // Primero se dejan terminar las peticiones vivas y solo despues se
    // devuelven las conexiones a Postgres: al reves, una peticion en curso se
    // quedaria sin base a mitad. close() nunca lanza.
    clearInterval(limpiezaDeTrabajos);

    server.close(async () => {
        await db.close();
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
