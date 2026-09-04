'use strict';

const crypto = require('crypto');
const config = require('../../config');
const logger = require('../../observability/logger');
const repo = require('../../db/pluginJobRepo');

// Registro de trabajos de busqueda. Existe por una razon concreta: una peticion
// HTTP no puede contar como va mientras la esta atendiendo.
//
// EL PROBLEMA. `HttpService:RequestAsync` de Roblox devuelve cuando el servidor
// termina. Con una busqueda de 10-25 segundos, el plugin no puede enseñar
// progreso real: o inventa un contador (mentira) o deja la interfaz congelada.
// Partirlo en arrancar + preguntar es lo que permite una barra que no miente.
//
// ── CALIENTE EN MEMORIA, DURABLE EN POSTGRES ────────────────────────────────
//
// El estado vivo esta en memoria porque cambia varias veces por segundo. Pero
// el trabajo TAMBIEN se baja a Postgres, y eso es lo que resuelve dos cosas que
// solo con memoria no tienen solucion:
//
//   - un GET despues de un redeploy encuentra el trabajo y su resultado;
//   - un GET que aterriza en OTRA REPLICA lo encuentra igual.
//
// Sin convertir la base en un stream de escrituras: se vuelca al crear, al
// arrancar, POR HITOS (cuando sube `found`), como mucho cada
// PLUGIN_JOB_SNAPSHOT_MS — ese volcado hace ademas de latido — y al terminar.
// Una busqueda de 20 segundos son del orden de diez escrituras.

const ESTADO = Object.freeze({
    QUEUED: 'queued',       // esperando turno del grupo, o recien creado
    RUNNING: 'running',     // recorriendo la comunidad
    COMPLETED: 'completed', // llego a `amount`
    PARTIAL: 'partial',     // termino limpiamente con menos de `amount`
    FAILED: 'failed',       // error no previsto
    EXPIRED: 'expired',     // huerfano: su proceso murio y dejo de latir
});

const TERMINALES = new Set([ESTADO.COMPLETED, ESTADO.PARTIAL, ESTADO.FAILED, ESTADO.EXPIRED]);

const trabajos = new Map();

// 128 bits de aleatoriedad criptografica. Va en una URL y es la unica cosa que
// separa el resultado de una busqueda del de otra, asi que tiene que ser
// IMPREDECIBLE y no enumerable: un contador, una marca de tiempo o cualquier
// cosa derivada del groupId dejaria que quien tenga la clave del plugin leyera
// busquedas ajenas simplemente probando.
function nuevoId() {
    return `s_${crypto.randomBytes(16).toString('hex')}`;
}

function limpiar(ahora = Date.now()) {
    for (const [id, trabajo] of trabajos) {
        const terminado = TERMINALES.has(trabajo.status);
        if (terminado && ahora - trabajo.finishedAt > config.pluginJobs.resultTtlMs) {
            // Solo se suelta la copia CALIENTE: en Postgres sigue hasta su
            // retencion, asi que un GET tardio lo encuentra igual.
            trabajos.delete(id);
            continue;
        }

        // DOS PLAZOS DISTINTOS, y no es un detalle. Un trabajo 'running' late en
        // cada segmento: si deja de latir, esta muerto. Un trabajo 'queued' NO
        // LATE, porque esperar turno es exactamente no hacer nada, y con
        // presupuestos de hasta tres minutos una espera legitima detras de una
        // busqueda grande dura mas que el plazo de latido. Compartir reloj
        // convertia esa espera en un 'expired' mentiroso justo cuando el plugin
        // estaba enseñando "esperando turno (2º)".
        const limiteVivo = trabajo.status === ESTADO.QUEUED
            ? config.pluginJobs.queuedTimeoutMs
            : config.pluginJobs.heartbeatTimeoutMs;

        if (!terminado && ahora - trabajo.updatedAt > limiteVivo) {
            trabajo.status = ESTADO.EXPIRED;
            trabajo.finishedAt = ahora;
            trabajo.stoppedBy = 'expired';
            logger.warn('Trabajo de busqueda expirado sin terminar', {
                searchId: id, edadMs: ahora - trabajo.createdAt,
            });
            repo.terminar(trabajo);
        }
    }
}

function crear({ peticion, requestId }) {
    limpiar();

    if (trabajos.size >= config.pluginJobs.maxLive) {
        const masViejo = [...trabajos.entries()]
            .filter(([, t]) => TERMINALES.has(t.status))
            .sort((a, b) => a[1].finishedAt - b[1].finishedAt)[0];
        if (masViejo) trabajos.delete(masViejo[0]);
    }

    const ahora = Date.now();
    const trabajo = {
        searchId: nuevoId(),
        status: ESTADO.QUEUED,
        requestId,
        groupId: peticion.groupId,
        target: peticion.amount,
        createdAt: ahora,
        startedAt: null,
        updatedAt: ahora,
        finishedAt: null,
        // Posicion en la cola del grupo. null = no esta esperando a nadie.
        queuePosition: null,
        progress: null,
        outfits: [],
        stats: null,
        stoppedBy: null,
        error: null,
        // Ultimo volcado a Postgres, para no escribir mas de lo necesario.
        ultimoSnapshot: 0,
        ultimoFound: 0,
    };

    trabajos.set(trabajo.searchId, trabajo);
    repo.crear(trabajo);
    return trabajo;
}

// El grupo esta ocupado: este trabajo espera turno. Se distingue de `running` a
// proposito — el plugin tiene que poder decir "esperando turno (2º)" en vez de
// enseñar una barra de progreso que no se mueve.
function marcarEnCola(id, posicion) {
    const trabajo = trabajos.get(id);
    if (!trabajo || TERMINALES.has(trabajo.status)) return;
    trabajo.status = ESTADO.QUEUED;
    trabajo.queuePosition = posicion;
    trabajo.updatedAt = Date.now();
    repo.actualizar(trabajo);
}

function marcarEnCurso(id) {
    const trabajo = trabajos.get(id);
    if (!trabajo) return;
    trabajo.status = ESTADO.RUNNING;
    trabajo.startedAt = Date.now();
    trabajo.updatedAt = trabajo.startedAt;
    trabajo.queuePosition = null;
    repo.actualizar(trabajo);
}

// Progreso en vivo. Lo llama la busqueda al final de cada segmento.
//
// EL VOLCADO NO ES EN CADA LLAMADA: solo cuando sube `found` (un hito de
// verdad) o cuando ha pasado el intervalo de snapshot. Sin esta condicion,
// una busqueda larga escribiria en Postgres decenas de veces sin que la foto
// cambie de forma apreciable.
function actualizarProgreso(id, progreso) {
    const trabajo = trabajos.get(id);
    if (!trabajo || TERMINALES.has(trabajo.status)) return;

    const ahora = Date.now();
    trabajo.progress = progreso;
    trabajo.updatedAt = ahora;

    const hito = (progreso?.found ?? 0) > trabajo.ultimoFound;
    const tocaSnapshot = ahora - trabajo.ultimoSnapshot >= config.pluginJobs.snapshotMs;

    if (hito || tocaSnapshot) {
        trabajo.ultimoFound = progreso?.found ?? trabajo.ultimoFound;
        trabajo.ultimoSnapshot = ahora;
        repo.actualizar(trabajo);
    }
}

function terminar(id, { outfits, stats, progress }) {
    const trabajo = trabajos.get(id);
    if (!trabajo) return null;

    trabajo.status = outfits.length >= trabajo.target ? ESTADO.COMPLETED : ESTADO.PARTIAL;
    trabajo.finishedAt = Date.now();
    trabajo.updatedAt = trabajo.finishedAt;
    trabajo.outfits = outfits;
    trabajo.stats = stats;
    trabajo.stoppedBy = stats?.stoppedBy ?? null;
    trabajo.progress = progress;
    trabajo.queuePosition = null;

    repo.terminar(trabajo);
    return trabajo;
}

function fallar(id, err) {
    const trabajo = trabajos.get(id);
    if (!trabajo) return null;

    trabajo.status = ESTADO.FAILED;
    trabajo.finishedAt = Date.now();
    trabajo.updatedAt = trabajo.finishedAt;
    // Codigo estable, nunca el mensaje crudo: un error de axios arrastra URLs y
    // configuracion interna, y esto viaja al plugin.
    trabajo.error = { code: err?.code ?? 'internal_error' };
    trabajo.stoppedBy = err?.code === 'queue_timeout' ? 'queueTimeout' : 'failed';
    trabajo.queuePosition = null;

    repo.terminar(trabajo);
    return trabajo;
}

// Busca el trabajo: primero en memoria (la version viva) y, si no esta, en
// Postgres. Esa segunda parte es lo que hace que un GET funcione tras un
// redeploy o cuando aterriza en otra replica.
async function obtener(id) {
    limpiar();
    const caliente = trabajos.get(id);
    if (caliente) return caliente;
    return repo.leer(id);
}

function presentar(trabajo) {
    const terminado = TERMINALES.has(trabajo.status);

    return {
        searchId: trabajo.searchId,
        status: trabajo.status,
        requested: trabajo.target,
        found: terminado ? (trabajo.outfits?.length ?? trabajo.found ?? 0) : (trabajo.progress?.found ?? 0),

        // Mientras espera turno NO hay progreso que enseñar — no ha empezado —,
        // y en su lugar va la posicion en la cola. Mezclar las dos cosas haria
        // que el plugin pintara una barra parada como si fuera lento.
        queuePosition: trabajo.status === ESTADO.QUEUED ? (trabajo.queuePosition ?? null) : null,
        progress: trabajo.status === ESTADO.QUEUED ? null : (trabajo.progress ?? null),

        pollAfterMs: terminado ? null : config.pluginJobs.pollIntervalMs,
        outfits: terminado ? (trabajo.outfits ?? []) : [],
        stats: terminado ? (trabajo.stats ?? null) : null,
        stoppedBy: trabajo.stoppedBy ?? null,
        error: trabajo.error ?? null,
    };
}

// Arranque y mantenimiento. Se llama desde server.js: marcar huerfanos ANTES de
// aceptar trafico es lo que garantiza que ningun trabajo se quede 'running'
// eternamente tras un reinicio.
async function recuperarAlArrancar() {
    const expirados = await repo.expirarHuerfanos();
    const borrados = await repo.limpiarVencidos();
    return { expirados, borrados };
}

function reset() {
    trabajos.clear();
}

module.exports = {
    ESTADO, TERMINALES,
    crear, marcarEnCola, marcarEnCurso, actualizarProgreso, terminar, fallar,
    obtener, presentar, limpiar, recuperarAlArrancar, reset,
    get tamano() { return trabajos.size; },
};
