'use strict';

const config = require('./src/config');
const logger = require('./src/observability/logger');
const { createApp } = require('./src/app');
const db = require('./src/db/pool');
const { ensureSchema } = require('./src/db/schema');
const indexWorker = require('./src/services/indexWorker/worker');
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

// Worker del indice de avatares. En la fase 1 SOLO ESCRIBE: ninguna respuesta
// depende de el, asi que arranca detras de todo lo demas y apagarlo (borrando
// INDEX_WORKER_ENABLED) devuelve el servicio exactamente a como estaba.
indexWorker.arrancar();

// Recolector de trabajos vencidos. `unref` para que no impida apagar el
// proceso: es mantenimiento, no trabajo pendiente.
// Cada pasada ADOPTA lo que otra instancia solto al apagarse o dejo de latir,
// ademas de limpiar lo vencido. Es corta a proposito: tras un redeploy, el
// trabajo que la instancia vieja solto tiene que estar corriendo aqui en
// segundos, no cuando caduque un latido.
const limpiezaDeTrabajos = setInterval(() => {
    jobs.recuperarAlArrancar().catch(() => { /* ya se registra dentro */ });
}, config.pluginJobs.recoveryIntervalMs);
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

    // LOS TRABAJOS VIVOS SE SUELTAN ANTES DE CERRAR NADA. Cada uno deja en la
    // base su ultimo checkpoint y la fila sin dueño: la instancia nueva del
    // redeploy los adopta en su siguiente pasada, en segundos, con el mismo
    // searchId y desde donde estaban. Sin esto, un trabajo a medias esperaria
    // a que caducara el latido para que alguien lo continuara, y el plugin
    // veria minuto y medio de "0 candidatos" sin explicacion.
    jobs.soltarTodos()
        .then(r => logger.info('Trabajos de busqueda soltados para el relevo', r))
        .catch(err => logger.warn('No se pudieron soltar los trabajos al apagar', { detail: err?.message }))
        .finally(() => {
            server.close(async () => {
                await db.close();
                logger.info('Servidor cerrado limpiamente');
                process.exit(0);
            });
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
