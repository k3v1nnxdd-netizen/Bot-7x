'use strict';

const { Pool } = require('pg');
const config = require('../config');
const logger = require('../observability/logger');
const requestContext = require('../observability/requestContext');

// Unico modulo de todo el servicio que importa `pg`, igual que
// src/roblox/client.js es el unico que importa `axios`. Cualquier consulta
// futura (whitelist de grupos, licencias) pasa por `query()` de aqui; ningun
// otro archivo crea conexiones ni conoce la forma del driver.
//
// TRES INVARIANTES DE ESTE MODULO:
//
//  1. NADA se conecta al cargar el archivo. El pool se crea perezosamente en
//     la primera consulta real. Requerir este modulo desde un test — o desde
//     un proceso sin DATABASE_URL — no abre un solo socket.
//
//  2. Sin DATABASE_URL el servicio NO se cae. La API de outfits no depende de
//     Postgres para nada: es de solo lectura contra Roblox y su cache es en
//     memoria. La base de datos llega para el sistema de licencias, asi que su
//     ausencia desactiva ESO y nada mas — misma politica que ya se aplica a
//     OUTFIT_API_KEY, que tampoco impide arrancar (ver src/config/index.js).
//
//  3. La cadena de conexion NUNCA se registra. Lleva la contraseña dentro.
//     Todo lo que se loguea sale de `describeTarget()`, que extrae host,
//     puerto y nombre de base y descarta el resto — credenciales incluidas.

let pool = null;

const metrics = {
    queries: 0,
    errors: 0,
    lastErrorCode: null,   // SQLSTATE o codigo de red; nunca el detalle crudo
    lastErrorOp: null,     // etiqueta de la operacion que fallo ('rotation.save'...)
    poolErrors: 0,         // fallos de clientes ociosos (los tira el proxy)
};

function isConfigured() {
    return Boolean(config.database.url);
}

// Host / puerto / base SIN credenciales, para poder decir en el log contra
// que estamos hablando sin filtrar la contraseña que viaja en la misma URL.
function describeTarget(url = config.database.url) {
    if (!url) return null;
    try {
        const parsed = new URL(url);
        return {
            host: parsed.hostname,
            port: parsed.port || '5432',
            database: parsed.pathname.replace(/^\//, '') || null,
        };
    } catch {
        // Una URL ilegible no puede tumbar el arranque ni, mucho menos,
        // acabar impresa entera en el log intentando explicar por que lo es.
        return { host: '[url-no-parseable]', port: null, database: null };
    }
}

// Politica TLS. Los dos sabores de Postgres de Railway se comportan distinto
// y por eso el default es `auto` en vez de un booleano fijo:
//
//   - Red privada (`*.railway.internal`): trafico interno del proyecto, NO
//     ofrece TLS. Forzar ssl ahi hace fallar la conexion.
//   - Proxy publico (`*.proxy.rlwy.net`): TLS si, pero con certificado
//     autofirmado. Verificarlo contra las CA del sistema tambien falla.
//
// `auto` resuelve cada caso solo. Los valores explicitos existen para no
// dejar a nadie atrapado si el entorno cambia:
//   disable   -> sin TLS
//   no-verify -> TLS sin validar el certificado (proxy de Railway)
//   verify    -> TLS validando contra las CA del sistema (Postgres propio)
function resolveSsl(mode, url) {
    const normalized = String(mode || 'auto').toLowerCase();

    if (normalized === 'disable') return false;
    if (normalized === 'no-verify') return { rejectUnauthorized: false };
    if (normalized === 'verify') return { rejectUnauthorized: true };

    if (normalized !== 'auto') {
        console.warn(`[db] DATABASE_SSL="${mode}" no es un modo valido — usando "auto"`);
    }

    const host = describeTarget(url)?.host || '';
    const esInterno =
        host.endsWith('.railway.internal') ||
        host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '::1';

    return esInterno ? false : { rejectUnauthorized: false };
}

function getPool() {
    if (!isConfigured()) return null;
    if (pool) return pool;

    const { url, poolMax, connectionTimeoutMs, idleTimeoutMs, statementTimeoutMs } = config.database;

    pool = new Pool({
        connectionString: url,
        ssl: resolveSsl(config.database.ssl, url),

        // Techo bajo a proposito. Este servicio es de LECTURA contra Roblox;
        // Postgres solo atendera comprobaciones de licencia, que son consultas
        // de una fila por clave primaria. Un plan de Railway trae pocas
        // conexiones y varias instancias comparten ese presupuesto: abrir
        // muchas por proceso no acelera nada y agota el limite del servidor.
        max: poolMax,

        // Cerrar los clientes ociosos evita que el proxy los tire por su
        // cuenta y aparezcan errores de socket sin peticion detras.
        idleTimeoutMillis: idleTimeoutMs,

        // Sin esto, pedir un cliente con la base caida espera indefinidamente
        // y se lleva por delante la peticion HTTP que lo pidio.
        connectionTimeoutMillis: connectionTimeoutMs,

        // Corta del lado del SERVIDOR: aunque el proceso se olvide de una
        // consulta, Postgres no se queda con ella colgada ocupando conexion.
        statement_timeout: statementTimeoutMs,

        // Aparece en pg_stat_activity: en el panel de Railway se ve de un
        // vistazo que conexion es nuestra.
        application_name: config.serviceName,
    });

    // OBLIGATORIO. Un cliente OCIOSO que muere (redeploy de la base, corte
    // del proxy, reinicio de Railway) emite 'error' en el pool, fuera del
    // ciclo de cualquier peticion. Sin este listener, Node lo trata como
    // excepcion no capturada. El pool descarta el cliente roto y abre otro
    // solo: aqui solo hay que registrarlo y seguir.
    pool.on('error', err => {
        metrics.poolErrors++;
        metrics.lastErrorCode = err?.code ?? null;
        logger.warn('Cliente ocioso de Postgres cayo', {
            code: err?.code ?? null,
            detail: err?.message,
        });
    });

    logger.info('Pool de Postgres creado', { ...describeTarget(url), max: poolMax });
    return pool;
}

// "No hay base configurada" se señala con un CODIGO, no con un mensaje: quien
// lo captura (src/db/errors.js) decide por codigo, igual que hace con los
// SQLSTATE de Postgres, y nadie tiene que comparar cadenas de texto.
function notConfigured() {
    const err = new Error('Postgres no esta configurado (falta DATABASE_URL)');
    err.code = 'DB_NOT_CONFIGURED';
    return err;
}

// UNICA via de acceso a Postgres del servicio.
//
// `params` no esta ahi por comodidad: es el contrato. Todo valor variable
// viaja SIEMPRE como parametro ($1, $2, ...) y jamas concatenado en el SQL. El
// driver los manda por separado del texto de la consulta, asi que un
// group_id con comillas o punto y coma es un dato y no puede convertirse en
// sintaxis. Ningun call-site debe construir SQL con plantillas.
//
// `op` es una ETIQUETA ESTABLE de la operacion ('rotation.save', 'jobs.finish',
// 'schema.create'...). No es decorativa y no puede salir del call-site como
// texto libre: sin ella, 'Consulta a Postgres fallida' en Railway solo decia el
// SQLSTATE, y ese codigo no distingue si lo que se perdio fue el cursor de una
// comunidad, el snapshot de un trabajo o una lectura de estadisticas — tres
// consecuencias completamente distintas. El SQL NO se registra nunca, ni
// siquiera recortado: la etiqueta dice lo mismo sin arrastrar la sentencia.
async function query(text, params = [], op = null) {
    const activePool = getPool();
    if (!activePool) {
        throw notConfigured();
    }

    metrics.queries++;
    try {
        return await activePool.query(text, params);
    } catch (err) {
        metrics.errors++;
        metrics.lastErrorCode = err?.code ?? null;
        metrics.lastErrorOp = op ?? null;
        // Se registra el SQLSTATE, la operacion y el mensaje; NUNCA los
        // parametros ni el SQL: los primeros pueden llevar datos de usuario y,
        // en otras consultas, secretos.
        // La etiqueta 'repositorio.operacion' se parte en dos campos para
        // poder agregar por repositorio ("¿falla la rotacion o los trabajos?")
        // y filtrar por operacion ("¿solo writeStats?") sin cortar cadenas.
        const [repository, operation] = String(op ?? 'sin-etiquetar.sin-etiquetar').split('.');
        logger.error('Consulta a Postgres fallida', {
            repository,
            operation: operation ?? null,
            op: op ?? 'sin-etiquetar',
            sqlState: err?.code ?? null,
            code: err?.code ?? null,
            // Correlacion con la peticion que la provoco, cuando la hay.
            requestId: requestContext.requestId(),
            detail: err?.message,
        });
        throw err;
    }
}

// Transaccion sobre UN SOLO cliente. Es imprescindible tenerla aparte:
// `query()` pide un cliente al pool en cada llamada, asi que un BEGIN, un
// INSERT y un COMMIT lanzados con `query()` pueden acabar en tres conexiones
// distintas — el BEGIN se quedaria abierto en una y el INSERT se
// autoconfirmaria en otra. Aqui el cliente se reserva, se usa para todo y se
// devuelve pase lo que pase.
//
// `fn` recibe un `q(text, params)` con la misma firma parametrizada de
// siempre. Si lanza, se hace ROLLBACK y el error se propaga intacto.
async function withTransaction(fn) {
    const activePool = getPool();
    if (!activePool) {
        throw notConfigured();
    }

    const client = await activePool.connect();
    const q = (text, params = []) => {
        metrics.queries++;
        return client.query(text, params);
    };

    try {
        await q('BEGIN');
        const result = await fn(q);
        await q('COMMIT');
        return result;
    } catch (err) {
        metrics.errors++;
        metrics.lastErrorCode = err?.code ?? null;
        try {
            await client.query('ROLLBACK');
        } catch (rollbackErr) {
            // La conexion ya estaba rota; release(err) mas abajo la descarta.
            logger.warn('Fallo el ROLLBACK', { detail: rollbackErr?.message });
        }
        throw err;
    } finally {
        client.release();
    }
}

// Cierre limpio en SIGTERM: devuelve las conexiones en vez de dejar que
// Railway las corte a mitad. Nunca lanza — un fallo cerrando no debe impedir
// que el proceso termine.
async function close() {
    if (!pool) return;
    const closing = pool;
    pool = null;
    try {
        await closing.end();
        logger.info('Pool de Postgres cerrado');
    } catch (err) {
        logger.warn('Fallo cerrando el pool de Postgres', { detail: err?.message });
    }
}

function getMetrics() {
    return {
        configured: isConfigured(),
        ...(pool
            ? { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }
            : { total: 0, idle: 0, waiting: 0 }),
        ...metrics,
    };
}

// Cliente DEDICADO y de larga vida, fuera del ciclo de `query()`.
//
// Existe para UNA cosa: LISTEN/NOTIFY. Una suscripcion LISTEN vive en la
// CONEXION, asi que no puede montarse sobre el pool — `query()` pide un cliente
// y lo devuelve, y con el se iria la suscripcion. Quien lo pida es responsable
// de soltarlo (`release()`) y de volver a pedirlo si la conexion se cae.
//
// No se usa para consultas normales: gastaria una de las pocas conexiones del
// plan de Railway sin motivo.
async function conexionDedicada() {
    const activePool = getPool();
    if (!activePool) throw notConfigured();
    return activePool.connect();
}

module.exports = {
    isConfigured,
    query,
    conexionDedicada,
    withTransaction,
    close,
    getMetrics,
    describeTarget,
    resolveSsl,   // exportado para los tests: es pura, no toca la red
};
