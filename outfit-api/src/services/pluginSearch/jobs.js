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
// el trabajo TAMBIEN se baja a Postgres, y eso es lo que resuelve tres cosas que
// solo con memoria no tienen solucion:
//
//   - un GET despues de un redeploy encuentra el trabajo y su resultado;
//   - un GET que aterriza en OTRA REPLICA lo encuentra igual;
//   - un trabajo ESTACIONADO esperando a Roblox cuando su proceso muere lo
//     ADOPTA otra instancia y sigue exactamente donde se quedo, en vez de morir
//     como huerfano y obligar al plugin a empezar de cero.
//
// Sin convertir la base en un stream de escrituras: se vuelca al crear, al
// arrancar, POR HITOS (cuando sube `found`), como mucho cada
// PLUGIN_JOB_SNAPSHOT_MS — ese volcado hace ademas de latido —, al estacionar
// y reanudar, en cada latido de una pausa, y al terminar.
//
// ── FENCING ──────────────────────────────────────────────────────────────────
//
// Cada volcado lleva la identidad de este proceso y solo escribe si la fila
// sigue siendo suya (ver pluginJobRepo.actualizar). Si otra instancia adopto el
// trabajo — porque nuestro latido se quedo viejo — el volcado devuelve "no es
// tuyo" y este proceso lanza TrabajoAdoptadoError: la busqueda que corria aqui
// PARA, y no marca el trabajo como fallido, porque el trabajo sigue vivo en
// otra parte. Dos dueños escribiendo el mismo checkpoint es la unica forma de
// corromperlo, y esta valla es lo que lo impide.

const ESTADO = Object.freeze({
    QUEUED: 'queued',       // esperando turno del grupo, o recien creado
    RUNNING: 'running',     // recorriendo la comunidad (o estacionado: ver `phase`)
    COMPLETED: 'completed', // llego a `amount`
    PARTIAL: 'partial',     // termino limpiamente con menos de `amount`
    FAILED: 'failed',       // error no previsto
    EXPIRED: 'expired',     // huerfano: su proceso murio y dejo de latir
});

// Fase INTERNA de un trabajo 'running'. No es un status nuevo — el plugin
// sigue viendo 'running' — sino un detalle dentro de `progress`:
//   working        recorriendo la comunidad
//   rateLimitWait  estacionado hasta `resumeAt` porque Roblox pidio esperar
const FASE = Object.freeze({
    TRABAJANDO: 'working',
    ESPERANDO_ROBLOX: 'rateLimitWait',
});

const TERMINALES = new Set([ESTADO.COMPLETED, ESTADO.PARTIAL, ESTADO.FAILED, ESTADO.EXPIRED]);

class TrabajoAdoptadoError extends Error {
    constructor(searchId) {
        super(`El trabajo ${searchId} fue adoptado por otra instancia`);
        this.name = 'TrabajoAdoptadoError';
        this.code = 'job_adopted';
        this.searchId = searchId;
    }
}

const trabajos = new Map();

// Quien sabe ARRANCAR una busqueda a partir de un trabajo (el runner). Se
// inyecta en vez de importarse para no cerrar un ciclo jobs -> runner -> jobs.
let ejecutor = null;
function registrarEjecutor(fn) {
    ejecutor = fn;
}

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
        // cada segmento — y, estacionado, en cada latido de la pausa. Un
        // trabajo 'queued' NO LATE, porque esperar turno es exactamente no
        // hacer nada, y con presupuestos largos una espera legitima detras de
        // una busqueda grande dura mas que el plazo de latido.
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

function esqueleto({ searchId, requestId, groupId, target, params, createdAt = Date.now() }) {
    return {
        searchId,
        status: ESTADO.QUEUED,
        requestId,
        groupId,
        target,
        // La peticion entera. Es lo que hace REANUDABLE al trabajo: sin ella,
        // otra instancia no sabria ni que precios filtrar.
        params,
        createdAt,
        startedAt: null,
        updatedAt: createdAt,
        finishedAt: null,
        // Posicion en la cola del grupo. null = no esta esperando a nadie.
        queuePosition: null,
        progress: null,
        outfits: [],
        stats: null,
        stoppedBy: null,
        error: null,

        // ── Park / resume ────────────────────────────────────────────────────
        phase: FASE.TRABAJANDO,
        resumeAt: null,
        rateLimitedRoute: null,
        // Ultimo checkpoint conocido, y el que aun no se ha bajado a la base.
        checkpoint: null,
        checkpointPendiente: null,
        // Otra instancia se lo llevo: este proceso no debe volver a tocarlo.
        adoptado: false,

        // Ultimo volcado a Postgres, para no escribir mas de lo necesario.
        ultimoSnapshot: 0,
        ultimoFound: 0,
    };
}

function crear({ peticion, requestId }) {
    limpiar();

    if (trabajos.size >= config.pluginJobs.maxLive) {
        const masViejo = [...trabajos.entries()]
            .filter(([, t]) => TERMINALES.has(t.status))
            .sort((a, b) => a[1].finishedAt - b[1].finishedAt)[0];
        if (masViejo) trabajos.delete(masViejo[0]);
    }

    const trabajo = esqueleto({
        searchId: nuevoId(),
        requestId,
        groupId: peticion.groupId,
        target: peticion.amount,
        params: { ...peticion },
    });

    trabajos.set(trabajo.searchId, trabajo);
    repo.crear(trabajo);
    return trabajo;
}

// ── El unico camino de escritura a la base para un trabajo vivo ─────────────
//
// Devuelve cuando la base ha contestado, y si la base dice que el trabajo ya no
// es nuestro, LANZA. Que lance aqui y no mas arriba es a proposito: todo lo que
// vuelca (progreso, latido, checkpoint) pasa por aqui, asi que no hay forma de
// que una busqueda adoptada siga escribiendo sin enterarse.
async function volcar(trabajo) {
    if (trabajo.adoptado) throw new TrabajoAdoptadoError(trabajo.searchId);

    const mio = await repo.actualizar(trabajo);
    if (mio === false) {
        trabajo.adoptado = true;
        logger.warn('Trabajo de busqueda adoptado por otra instancia: este proceso lo suelta', {
            searchId: trabajo.searchId,
        });
        throw new TrabajoAdoptadoError(trabajo.searchId);
    }
    trabajo.checkpointPendiente = null;
    trabajo.ultimoSnapshot = Date.now();
}

// El grupo esta ocupado: este trabajo espera turno. Se distingue de `running` a
// proposito — el plugin tiene que poder decir "esperando turno (2º)" en vez de
// enseñar una barra de progreso que no se mueve.
function marcarEnCola(id, posicion) {
    const trabajo = trabajos.get(id);
    if (!trabajo || TERMINALES.has(trabajo.status)) return Promise.resolve();
    trabajo.status = ESTADO.QUEUED;
    trabajo.queuePosition = posicion;
    trabajo.updatedAt = Date.now();
    // Quien llama (la cola del grupo) no espera esta promesa, asi que una
    // adopcion detectada aqui no puede quedar como rechazo sin dueño: se
    // registra y el siguiente volcado de la busqueda — ese si esperado — es el
    // que la corta.
    return volcar(trabajo).catch(err => {
        logger.warn('No se pudo marcar el trabajo como en cola', { searchId: id, code: err?.code ?? null });
    });
}

function marcarEnCurso(id) {
    const trabajo = trabajos.get(id);
    if (!trabajo) return;
    trabajo.status = ESTADO.RUNNING;
    trabajo.phase = FASE.TRABAJANDO;
    trabajo.startedAt = trabajo.startedAt ?? Date.now();
    trabajo.updatedAt = Date.now();
    trabajo.queuePosition = null;
    return volcar(trabajo);
}

// Progreso en vivo. Lo llama la busqueda al final de cada segmento.
//
// EL VOLCADO NO ES EN CADA LLAMADA: solo cuando sube `found` (un hito de
// verdad), cuando hay un checkpoint nuevo que bajar, o cuando ha pasado el
// intervalo de snapshot. Sin esta condicion, una busqueda larga escribiria en
// Postgres decenas de veces sin que la foto cambie de forma apreciable.
async function actualizarProgreso(id, progreso) {
    const trabajo = trabajos.get(id);
    if (!trabajo || TERMINALES.has(trabajo.status)) return;
    if (trabajo.adoptado) throw new TrabajoAdoptadoError(id);

    const ahora = Date.now();
    trabajo.progress = progreso;
    trabajo.updatedAt = ahora;

    const hito = (progreso?.found ?? 0) > trabajo.ultimoFound;
    const tocaSnapshot = ahora - trabajo.ultimoSnapshot >= config.pluginJobs.snapshotMs;

    if (hito || tocaSnapshot || trabajo.checkpointPendiente) {
        trabajo.ultimoFound = progreso?.found ?? trabajo.ultimoFound;
        await volcar(trabajo);
    }
}

// Checkpoint nuevo: se recuerda y baja en el siguiente volcado. No fuerza uno
// por si solo — al final de cada ola ya hay un progreso que lo arrastra.
function guardarCheckpoint(id, checkpoint) {
    const trabajo = trabajos.get(id);
    if (!trabajo || TERMINALES.has(trabajo.status)) return;
    trabajo.checkpoint = checkpoint;
    trabajo.checkpointPendiente = checkpoint;
}

// ── Park ─────────────────────────────────────────────────────────────────────
//
// Roblox pidio esperar. Se deja constancia DURABLE de la pausa antes de
// empezarla: fase, ruta, cuando reanudar y el checkpoint con todo lo necesario
// para seguir. Si este proceso muere durante la espera, esa fila es lo que
// otra instancia lee para adoptar el trabajo y continuar. El volcado es
// forzado: aqui no aplica ninguna economia de escrituras.
async function parquear(id, { route, resumeAt, retryAfterMs, checkpoint, progreso }) {
    const trabajo = trabajos.get(id);
    if (!trabajo || TERMINALES.has(trabajo.status)) return;

    trabajo.phase = FASE.ESPERANDO_ROBLOX;
    trabajo.rateLimitedRoute = route;
    trabajo.resumeAt = resumeAt;
    if (checkpoint) {
        trabajo.checkpoint = checkpoint;
        trabajo.checkpointPendiente = checkpoint;
    }
    if (progreso) trabajo.progress = progreso;
    trabajo.updatedAt = Date.now();

    logger.info('Trabajo de busqueda estacionado', {
        searchId: id, route, retryAfterMs,
        resumeAt: new Date(resumeAt).toISOString(),
        found: trabajo.progress?.found ?? 0,
    });

    await volcar(trabajo);
}

// Latido de un trabajo estacionado. Es lo que lo distingue de uno muerto: sin
// esto, una pausa de 25 s se pareceria a un proceso caido y el recolector lo
// adoptaria — o lo expiraria — a mitad.
async function latir(id, progreso) {
    const trabajo = trabajos.get(id);
    if (!trabajo || TERMINALES.has(trabajo.status)) return;
    if (progreso) trabajo.progress = progreso;
    trabajo.updatedAt = Date.now();
    await volcar(trabajo);
}

async function reanudar(id, progreso) {
    const trabajo = trabajos.get(id);
    if (!trabajo || TERMINALES.has(trabajo.status)) return;
    trabajo.phase = FASE.TRABAJANDO;
    trabajo.rateLimitedRoute = null;
    trabajo.resumeAt = null;
    if (progreso) trabajo.progress = progreso;
    trabajo.updatedAt = Date.now();
    await volcar(trabajo);
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
    trabajo.phase = FASE.TRABAJANDO;
    trabajo.resumeAt = null;
    trabajo.rateLimitedRoute = null;

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
    trabajo.phase = FASE.TRABAJANDO;
    trabajo.resumeAt = null;
    trabajo.rateLimitedRoute = null;

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
        //
        // Estacionado por Roblox, `progress` lleva `phase: 'rateLimitWait'`,
        // `rateLimitedRoute`, `resumeAt` y `retryAfterMs` (los pone el
        // estimador): el status sigue siendo 'running' y el mismo searchId, asi
        // que el plugin de hoy lo sigue igual y uno de mañana puede decir
        // "esperando a Roblox, 20 s".
        queuePosition: trabajo.status === ESTADO.QUEUED ? (trabajo.queuePosition ?? null) : null,
        progress: trabajo.status === ESTADO.QUEUED ? null : (trabajo.progress ?? null),

        pollAfterMs: terminado ? null : config.pluginJobs.pollIntervalMs,
        outfits: terminado ? (trabajo.outfits ?? []) : [],
        stats: terminado ? (trabajo.stats ?? null) : null,
        stoppedBy: trabajo.stoppedBy ?? null,
        error: trabajo.error ?? null,
    };
}

// ── Recuperacion al arrancar (y en cada pasada del recolector) ───────────────
//
// TRES cosas, en este orden, y el orden importa:
//
//   1. ADOPTAR los trabajos reanudables de instancias caidas (tienen peticion
//      y, si estaban estacionados, checkpoint). Se vuelven a arrancar aqui,
//      con el MISMO searchId, desde donde se quedaron. El plugin que los estaba
//      siguiendo no nota mas que un latido tardio.
//   2. EXPIRAR lo que no se puede reanudar (filas antiguas sin peticion).
//   3. BORRAR lo vencido.
//
// Marcar huerfanos ANTES de aceptar trafico es lo que garantiza que ningun
// trabajo se quede 'running' eternamente tras un reinicio.
async function recuperarAlArrancar() {
    const adoptados = await repo.adoptarHuerfanos();
    let arrancados = 0;

    for (const fila of adoptados) {
        const trabajo = hidratar(fila);
        trabajos.set(trabajo.searchId, trabajo);

        if (!ejecutor) {
            logger.warn('Trabajo adoptado sin ejecutor registrado: no se puede reanudar', {
                searchId: trabajo.searchId,
            });
            continue;
        }

        logger.info('Reanudando trabajo de busqueda adoptado', {
            searchId: trabajo.searchId,
            groupId: String(trabajo.groupId),
            found: trabajo.checkpoint?.outfits?.length ?? 0,
            pendientes: trabajo.checkpoint?.pendientes?.length ?? 0,
            estabaEstacionado: fila.phase === FASE.ESPERANDO_ROBLOX,
            resumeAt: fila.resumeAt ? new Date(fila.resumeAt).toISOString() : null,
        });

        // Sin await: cada reanudacion corre en segundo plano igual que un POST
        // asincrono. El ejecutor nunca rechaza.
        ejecutor(trabajo);
        arrancados++;
    }

    const expirados = await repo.expirarHuerfanos();
    const borrados = await repo.limpiarVencidos();
    return { adoptados: arrancados, expirados, borrados };
}

// De una fila de la base a un trabajo en memoria listo para reanudarse.
function hidratar(fila) {
    const trabajo = esqueleto({
        searchId: fila.searchId,
        requestId: null,
        groupId: fila.groupId,
        target: fila.target,
        params: fila.params,
        createdAt: fila.createdAt ?? Date.now(),
    });
    trabajo.status = ESTADO.RUNNING;
    trabajo.startedAt = fila.startedAt ?? null;
    trabajo.progress = fila.progress ?? null;
    trabajo.checkpoint = fila.checkpoint ?? null;
    trabajo.phase = fila.phase ?? FASE.TRABAJANDO;
    trabajo.resumeAt = fila.resumeAt ?? null;
    trabajo.rateLimitedRoute = fila.rateLimitedRoute ?? null;
    trabajo.ultimoFound = fila.checkpoint?.outfits?.length ?? fila.found ?? 0;
    return trabajo;
}

function reset() {
    trabajos.clear();
}

module.exports = {
    ESTADO, FASE, TERMINALES, TrabajoAdoptadoError,
    crear, marcarEnCola, marcarEnCurso, actualizarProgreso, guardarCheckpoint,
    parquear, latir, reanudar, terminar, fallar,
    obtener, presentar, limpiar, recuperarAlArrancar, registrarEjecutor, reset,
    get tamano() { return trabajos.size; },
};
