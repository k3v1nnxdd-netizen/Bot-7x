'use strict';

const crypto = require('crypto');
const config = require('../../config');
const logger = require('../../observability/logger');
const repo = require('../../db/pluginJobRepo');

// Registro de trabajos de busqueda. Existe por una razon concreta: una peticion
// HTTP no puede contar como va mientras la esta atendiendo.
//
// ── CALIENTE EN MEMORIA, DURABLE EN POSTGRES ────────────────────────────────
//
// El estado vivo esta en memoria porque cambia varias veces por segundo. Pero
// el trabajo TAMBIEN se baja a Postgres, y eso es lo que resuelve tres cosas que
// solo con memoria no tienen solucion:
//
//   - un GET despues de un redeploy encuentra el trabajo y su resultado;
//   - un GET que aterriza en OTRA REPLICA lo encuentra igual;
//   - un trabajo cuyo proceso muere (o se apaga en un redeploy) lo ADOPTA otra
//     instancia y sigue exactamente donde se quedo, con el mismo searchId.
//
// ── LA PROPIEDAD, Y LA INVARIANTE QUE ESTE MODULO GARANTIZA ─────────────────
//
//   Todo trabajo no terminal tiene EXACTAMENTE UN ejecutor valido, o esta
//   esperando de forma intencional y recuperable (en cola, o estacionado por
//   Roblox) con un dueño vivo que LATE por el. Nunca queda abandonado.
//
// Tres mecanismos la sostienen, y los tres hacen falta:
//
//   1. LATIDO INDEPENDIENTE. Cada trabajo vivo late cada pocos segundos por su
//      cuenta — trabaje, espere turno o este estacionado —, con un temporizador
//      propio, no "cuando haya progreso". Un trabajo lento no parece muerto.
//
//   2. VALLADO CON DIAGNOSTICO. Toda escritura va con `WHERE instance_id =
//      $me`. Si no toca ninguna fila NO se concluye nada todavia: se lee quien
//      es el dueño. Solo si es OTRA instancia este proceso suelta el trabajo —
//      y lo suelta sabiendo que hay alguien que lo continua. "La fila aun no
//      existe" o "la base tuvo un bache" no son adopciones.
//
//   3. ADOPCION SOLO DE HUERFANOS. Otra instancia solo adopta un trabajo cuyo
//      dueño lleva `adoptAfterMs` sin latir (dieciocho latidos fallidos) o que
//      fue SOLTADO explicitamente al apagarse. Un trabajo vivo, en la fase que
//      sea, no se roba.
//
// ── EL FALLO QUE ESTO CORRIGE ────────────────────────────────────────────────
//
// La creacion no se esperaba, la primera escritura vallada del ejecutor podia
// llegar antes que el INSERT, y "cero filas" se leia como "adoptado". El
// proceso soltaba una busqueda que NADIE tenia: el trabajo se quedaba en 0 de
// 10 para siempre mientras el plugin preguntaba. Ahora la creacion se espera,
// cero filas se diagnostica, y el runner NO arranca una busqueda si no es el
// dueño.

const ESTADO = Object.freeze({
    QUEUED: 'queued',       // esperando turno del grupo, o recien creado
    RUNNING: 'running',     // recorriendo la comunidad (o estacionado: ver `phase`)
    COMPLETED: 'completed', // llego a `amount`
    PARTIAL: 'partial',     // termino limpiamente con menos de `amount`
    FAILED: 'failed',       // error no previsto
    EXPIRED: 'expired',     // huerfano no reanudable: nadie lo pudo continuar
});

// Fase INTERNA de un trabajo vivo. No es un status nuevo — el plugin sigue
// viendo 'queued' / 'running' — sino un detalle aparte:
//   working        recorriendo la comunidad
//   rateLimitWait  estacionado hasta `resumeAt` porque Roblox pidio esperar
//   queued         esperando turno del grupo
//   recovering     soltado por su instancia (apagado): a la espera de adopcion
//   orphaned       su dueño dejo de latir: adoptable por cualquiera
const FASE = Object.freeze({
    TRABAJANDO: 'working',
    ESPERANDO_ROBLOX: 'rateLimitWait',
    EN_COLA: 'queued',
    RECUPERANDO: 'recovering',
    HUERFANO: 'orphaned',
});

const TERMINALES = new Set([ESTADO.COMPLETED, ESTADO.PARTIAL, ESTADO.FAILED, ESTADO.EXPIRED]);

class TrabajoAdoptadoError extends Error {
    constructor(searchId, dueño = null) {
        super(`El trabajo ${searchId} lo continua otra instancia (${dueño ?? 'desconocida'})`);
        this.name = 'TrabajoAdoptadoError';
        this.code = 'job_adopted';
        this.searchId = searchId;
        this.dueño = dueño;
    }
}

// 128 bits de aleatoriedad criptografica. Va en una URL y es la unica cosa que
// separa el resultado de una busqueda del de otra, asi que tiene que ser
// IMPREDECIBLE y no enumerable.
function nuevoId() {
    return `s_${crypto.randomBytes(16).toString('hex')}`;
}

// ── UN REGISTRO POR PROCESO ─────────────────────────────────────────────────
//
// `crearRegistro` existe para que las pruebas puedan levantar DOS instancias en
// el mismo proceso — una "vieja" y una "nueva", como en un redeploy de Railway
// — compartiendo la misma base de mentira y sin compartir memoria. En
// produccion hay uno solo: el de este proceso, exportado abajo.
function crearRegistro({ instancia = repo.__instancia } = {}) {
    const trabajos = new Map();
    const latidos = new Map(); // searchId -> temporizador

    // Quien sabe ARRANCAR una busqueda a partir de un trabajo (el runner). Se
    // inyecta en vez de importarse para no cerrar un ciclo jobs -> runner -> jobs.
    let ejecutor = null;

    // ── Latido ───────────────────────────────────────────────────────────────

    function detenerLatido(id) {
        const t = latidos.get(id);
        if (t) { clearInterval(t); latidos.delete(id); }
    }

    // Marca este trabajo como PERDIDO para este proceso: otra instancia es la
    // dueña. Se deja de latir, se deja constancia, y la busqueda que corra aqui
    // se enterara en su siguiente checkpoint y parara SIN marcar el trabajo
    // como fallido — sigue vivo en otra parte.
    function marcarAdoptado(trabajo, quien) {
        if (trabajo.adoptado) return;
        trabajo.adoptado = true;
        trabajo.adoptadoPor = quien?.dueño ?? null;
        detenerLatido(trabajo.searchId);
        logger.warn('Trabajo de busqueda adoptado por otra instancia: este proceso lo suelta', {
            searchId: trabajo.searchId,
            groupId: String(trabajo.groupId),
            previousInstance: instancia,
            newInstance: quien?.dueño ?? null,
            reason: quien?.motivo ?? null,
            phase: trabajo.phase,
            found: trabajo.progress?.found ?? 0,
            handoffs: quien?.handoffs ?? null,
        });
    }

    // Que hacer con el veredicto de una escritura vallada. SOLO 'adopted'
    // significa que hay que parar. Todo lo demas se registra y se sigue.
    function interpretar(trabajo, resultado, operacion) {
        if (!resultado || resultado.ok) {
            if (resultado?.transitorio) {
                trabajo.latidosFallidos = (trabajo.latidosFallidos ?? 0) + 1;
                if (trabajo.latidosFallidos === 1 || trabajo.latidosFallidos % 6 === 0) {
                    logger.warn('Escritura del trabajo sin confirmar (base transitoriamente indisponible)', {
                        searchId: trabajo.searchId, operacion, seguidas: trabajo.latidosFallidos,
                        toleranciaMs: config.pluginJobs.adoptAfterMs,
                    });
                }
            } else {
                trabajo.latidosFallidos = 0;
            }
            return true;
        }

        switch (resultado.motivo) {
            case repo.NO_ES_MIO.ADOPTADO:
                marcarAdoptado(trabajo, resultado);
                throw new TrabajoAdoptadoError(trabajo.searchId, resultado.dueño);

            case repo.NO_ES_MIO.SOLTADO:
                // Lo soltamos nosotros al apagar (o alguien lo solto por
                // nosotros). Este proceso ya no debe tocarlo.
                marcarAdoptado(trabajo, { ...resultado, dueño: null });
                throw new TrabajoAdoptadoError(trabajo.searchId, null);

            case repo.NO_ES_MIO.AUSENTE:
                // La fila no existe: el trabajo vive solo en memoria (la
                // creacion no se pudo persistir). NO es una adopcion. Se avisa
                // una vez y se sigue: lo unico que se pierde es la
                // recuperabilidad tras un reinicio.
                if (!trabajo.avisadoSinFila) {
                    trabajo.avisadoSinFila = true;
                    logger.warn('El trabajo de busqueda no esta en la base: sigue solo en memoria', {
                        searchId: trabajo.searchId, operacion,
                    });
                }
                return true;

            case repo.NO_ES_MIO.TERMINAL:
                // Segun la base ya termino (por ejemplo, otra instancia lo
                // adopto Y lo termino, o el recolector lo expiro). Parar.
                marcarAdoptado(trabajo, resultado);
                throw new TrabajoAdoptadoError(trabajo.searchId, resultado.dueño);

            default:
                return true;
        }
    }

    // Un latido. Nunca lanza hacia el temporizador; si el trabajo ya no es
    // nuestro, lo marca y la busqueda parara en su siguiente checkpoint.
    async function latidoPeriodico(id) {
        const trabajo = trabajos.get(id);
        if (!trabajo || TERMINALES.has(trabajo.status) || trabajo.adoptado) {
            detenerLatido(id);
            return;
        }
        trabajo.updatedAt = Date.now();
        try {
            interpretar(trabajo, await repo.latir(trabajo), 'heartbeat');
        } catch (err) {
            if (!(err instanceof TrabajoAdoptadoError)) {
                logger.warn('Latido del trabajo fallido', { searchId: id, detail: err?.message });
            }
        }
    }

    function iniciarLatido(trabajo) {
        detenerLatido(trabajo.searchId);
        const t = setInterval(() => { latidoPeriodico(trabajo.searchId); }, config.pluginJobs.heartbeatIntervalMs);
        t.unref?.();
        latidos.set(trabajo.searchId, t);
    }

    // ── Ciclo de vida ────────────────────────────────────────────────────────

    function limpiar(ahora = Date.now()) {
        for (const [id, trabajo] of trabajos) {
            const terminado = TERMINALES.has(trabajo.status);
            if (terminado && ahora - trabajo.finishedAt > config.pluginJobs.resultTtlMs) {
                // Solo se suelta la copia CALIENTE: en Postgres sigue hasta su
                // retencion, asi que un GET tardio lo encuentra igual.
                detenerLatido(id);
                trabajos.delete(id);
                continue;
            }

            // Un trabajo vivo de ESTE proceso late cada pocos segundos, asi
            // que `updatedAt` solo se queda viejo si su ejecutor murio sin
            // cerrar (un bug) o si lo solto. Se expira localmente para que el
            // GET no lo enseñe 'running' para siempre; en la base, si sigue
            // siendo nuestro, se marca igual (vallado).
            if (!terminado && !trabajo.adoptado && ahora - trabajo.updatedAt > config.pluginJobs.adoptAfterMs) {
                trabajo.status = ESTADO.EXPIRED;
                trabajo.finishedAt = ahora;
                trabajo.stoppedBy = 'expired';
                detenerLatido(id);
                logger.warn('Trabajo de busqueda expirado sin terminar', {
                    searchId: id, edadMs: ahora - trabajo.createdAt, instance: instancia,
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
            params,
            instanceId: instancia,
            createdAt,
            startedAt: null,
            updatedAt: createdAt,
            finishedAt: null,
            queuePosition: null,
            progress: null,
            outfits: [],
            stats: null,
            stoppedBy: null,
            error: null,

            // ── Park / resume ────────────────────────────────────────────────
            phase: FASE.TRABAJANDO,
            resumeAt: null,
            rateLimitedRoute: null,
            checkpoint: null,
            checkpointPendiente: null,

            // ── Propiedad ────────────────────────────────────────────────────
            adoptado: false,        // otra instancia se lo llevo: no tocarlo mas
            adoptadoPor: null,
            handoffs: 0,
            previousInstanceId: null,
            durable: true,          // false si el INSERT no se pudo hacer
            latidosFallidos: 0,
            avisadoSinFila: false,

            ultimoSnapshot: 0,
            ultimoFound: 0,
        };
    }

    // Crea el trabajo y ESPERA a que exista en la base antes de devolverlo.
    // Es la correccion de la carrera: la primera escritura vallada del
    // ejecutor tiene que encontrar la fila, o no podria distinguir "aun no
    // existe" de "me lo quitaron".
    async function crear({ peticion, requestId }) {
        limpiar();

        if (trabajos.size >= config.pluginJobs.maxLive) {
            const masViejo = [...trabajos.entries()]
                .filter(([, t]) => TERMINALES.has(t.status))
                .sort((a, b) => a[1].finishedAt - b[1].finishedAt)[0];
            if (masViejo) { detenerLatido(masViejo[0]); trabajos.delete(masViejo[0]); }
        }

        const trabajo = esqueleto({
            searchId: nuevoId(),
            requestId,
            groupId: peticion.groupId,
            target: peticion.amount,
            params: { ...peticion },
        });

        trabajos.set(trabajo.searchId, trabajo);
        const { persistido } = await repo.crear(trabajo);
        trabajo.durable = persistido;
        iniciarLatido(trabajo);
        return trabajo;
    }

    // El unico camino de escritura de progreso. Lanza TrabajoAdoptadoError si
    // el trabajo ya no es de este proceso.
    // Un outfit se ENTREGA (aparece en el GET) solo cuando su checkpoint ya
    // esta en la base: `checkpoint` es la copia servida y solo se promociona
    // desde `checkpointPendiente` cuando la escritura vallada volvio bien. Si
    // el proceso muere entre encontrar un outfit y escribirlo, ningun poll lo
    // habra visto, y la fila (lo que sirve el proceso que adopte) coincide con
    // lo ultimo que se entrego: `found` nunca baja entre dos polls.
    async function volcar(trabajo, operacion = 'snapshot') {
        if (trabajo.adoptado) throw new TrabajoAdoptadoError(trabajo.searchId, trabajo.adoptadoPor);
        const pendiente = trabajo.checkpointPendiente;
        interpretar(trabajo, await repo.actualizar(trabajo), operacion);
        if (pendiente) trabajo.checkpoint = pendiente;
        if (trabajo.checkpointPendiente === pendiente) trabajo.checkpointPendiente = null;
        trabajo.ultimoSnapshot = Date.now();
    }

    function marcarEnCola(id, posicion) {
        const trabajo = trabajos.get(id);
        if (!trabajo || TERMINALES.has(trabajo.status)) return Promise.resolve();
        trabajo.status = ESTADO.QUEUED;
        trabajo.phase = FASE.EN_COLA;
        trabajo.queuePosition = posicion;
        trabajo.updatedAt = Date.now();
        return volcar(trabajo, 'queued').catch(err => {
            // Quien llama (la cola del grupo) no espera esta promesa: una
            // adopcion detectada aqui ya esta marcada y la corta el siguiente
            // volcado esperado de la busqueda.
            if (!(err instanceof TrabajoAdoptadoError)) {
                logger.warn('No se pudo marcar el trabajo como en cola', { searchId: id, code: err?.code ?? null });
            }
        });
    }

    // Lanza si el trabajo NO es nuestro: el runner no arranca una busqueda
    // que otra instancia ya esta ejecutando.
    async function marcarEnCurso(id) {
        const trabajo = trabajos.get(id);
        if (!trabajo) return;
        trabajo.status = ESTADO.RUNNING;
        trabajo.phase = FASE.TRABAJANDO;
        trabajo.startedAt = trabajo.startedAt ?? Date.now();
        trabajo.updatedAt = Date.now();
        trabajo.queuePosition = null;
        await volcar(trabajo, 'start');
    }

    async function actualizarProgreso(id, progreso) {
        const trabajo = trabajos.get(id);
        if (!trabajo || TERMINALES.has(trabajo.status)) return;
        if (trabajo.adoptado) throw new TrabajoAdoptadoError(id, trabajo.adoptadoPor);

        const ahora = Date.now();
        trabajo.progress = progreso;
        trabajo.updatedAt = ahora;

        const hito = (progreso?.found ?? 0) > trabajo.ultimoFound;
        const tocaSnapshot = ahora - trabajo.ultimoSnapshot >= config.pluginJobs.snapshotMs;

        if (hito || tocaSnapshot || trabajo.checkpointPendiente) {
            trabajo.ultimoFound = progreso?.found ?? trabajo.ultimoFound;
            await volcar(trabajo, 'progress');
        }
    }

    function guardarCheckpoint(id, checkpoint) {
        const trabajo = trabajos.get(id);
        if (!trabajo || TERMINALES.has(trabajo.status)) return;
        // Solo pendiente: pasa a ser la copia servida cuando este en la base.
        trabajo.checkpointPendiente = checkpoint;
    }

    async function parquear(id, { route, resumeAt, retryAfterMs, checkpoint, progreso }) {
        const trabajo = trabajos.get(id);
        if (!trabajo || TERMINALES.has(trabajo.status)) return;

        trabajo.phase = FASE.ESPERANDO_ROBLOX;
        trabajo.rateLimitedRoute = route;
        trabajo.resumeAt = resumeAt;
        if (checkpoint) trabajo.checkpointPendiente = checkpoint;
        if (progreso) trabajo.progress = progreso;
        trabajo.updatedAt = Date.now();

        logger.info('Trabajo de busqueda estacionado', {
            searchId: id, route, retryAfterMs,
            resumeAt: new Date(resumeAt).toISOString(),
            found: trabajo.progress?.found ?? 0,
            instance: instancia,
        });

        await volcar(trabajo, 'park');
    }

    async function latir(id, progreso) {
        const trabajo = trabajos.get(id);
        if (!trabajo || TERMINALES.has(trabajo.status)) return;
        if (progreso) trabajo.progress = progreso;
        trabajo.updatedAt = Date.now();
        await volcar(trabajo, 'park-heartbeat');
    }

    async function reanudar(id, progreso) {
        const trabajo = trabajos.get(id);
        if (!trabajo || TERMINALES.has(trabajo.status)) return;
        trabajo.phase = FASE.TRABAJANDO;
        trabajo.rateLimitedRoute = null;
        trabajo.resumeAt = null;
        if (progreso) trabajo.progress = progreso;
        trabajo.updatedAt = Date.now();
        await volcar(trabajo, 'resume');
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

        detenerLatido(id);
        repo.terminar(trabajo);
        return trabajo;
    }

    function fallar(id, err) {
        const trabajo = trabajos.get(id);
        if (!trabajo) return null;

        trabajo.status = ESTADO.FAILED;
        trabajo.finishedAt = Date.now();
        trabajo.updatedAt = trabajo.finishedAt;
        trabajo.error = { code: err?.code ?? 'internal_error' };
        trabajo.stoppedBy = err?.code === 'queue_timeout' ? 'queueTimeout' : 'failed';
        trabajo.queuePosition = null;
        trabajo.phase = FASE.TRABAJANDO;
        trabajo.resumeAt = null;
        trabajo.rateLimitedRoute = null;

        detenerLatido(id);
        repo.terminar(trabajo);
        return trabajo;
    }

    // Busca el trabajo: primero en memoria (la version viva) y, si no esta, en
    // Postgres. Y si la copia en memoria ya NO ES NUESTRA (otra instancia lo
    // adopto, o lo soltamos al apagar), se sirve la de la base: es la unica que
    // refleja lo que el dueño actual esta haciendo. Sin esto, un GET que cayera
    // en la instancia vieja enseñaria para siempre la foto del momento del
    // traspaso.
    // ¿Es ESTA copia la que el registro tiene por el trabajo? Una busqueda
    // arrancada sobre una copia vieja (el proceso perdio el trabajo y lo
    // readopto) no debe tocar la nueva a traves del searchId.
    function esVigente(trabajo) {
        return Boolean(trabajo) && trabajos.get(trabajo.searchId) === trabajo && !trabajo.adoptado;
    }

    async function obtener(id) {
        limpiar();
        const caliente = trabajos.get(id);
        if (caliente && !(caliente.adoptado && !TERMINALES.has(caliente.status))) return caliente;
        const enBase = await repo.leer(id);
        return enBase ?? caliente ?? null;
    }

    // ── Fase y propiedad de cara al GET ──────────────────────────────────────
    //
    // Distingue lo que un trabajo vivo puede estar haciendo, tambien cuando la
    // fila viene de la base (otra replica lo tiene, o nadie):
    //
    //   queued         espera turno del grupo
    //   working        recorriendo la comunidad
    //   rateLimitWait  estacionado por Roblox hasta resumeAt
    //   recovering     su instancia lo solto (apagado): pendiente de adopcion
    //   orphaned       su dueño dejo de latir: cualquier instancia lo adoptara
    function faseDe(trabajo, ahora = Date.now()) {
        if (TERMINALES.has(trabajo.status)) return null;
        if (trabajo.status === ESTADO.QUEUED) return FASE.EN_COLA;
        if (trabajo.desdeBase) {
            if (trabajo.instanceId === null) return FASE.RECUPERANDO;
            const edad = trabajo.heartbeatAt ? ahora - trabajo.heartbeatAt : Infinity;
            if (edad > config.pluginJobs.adoptAfterMs) return FASE.HUERFANO;
        }
        return trabajo.phase ?? FASE.TRABAJANDO;
    }

    // ── Outfits ACUMULADOS, tambien durante running ──────────────────────────
    //
    // El plugin recibe los outfits A MEDIDA QUE SE ENCUENTRAN, no al terminar.
    // Salen del ultimo checkpoint YA ESCRITO en la base (la copia servida se
    // promociona en `volcar`, cuando la escritura vallada volvio bien; si el
    // trabajo es de otra instancia o esta soltado, de la fila). La busqueda
    // lo escribe al cerrar cada ola y al estacionarse. Propiedades:
    //
    //   DURABLE      un outfit que un poll ha visto esta en la base: un
    //                reinicio o un traspaso no puede hacerlo desaparecer.
    //   ACUMULATIVO  la busqueda solo AÑADE a `encontrados`; nunca quita.
    //   ESTABLE      se entrega siempre el prefijo `slice(0, target)`, que es
    //                exactamente lo que devuelve el resultado final: un outfit
    //                entregado en un poll no puede desaparecer en el siguiente.
    //                (La unica poda posible ocurre cuando la ULTIMA ola acepta
    //                mas de los que faltaban; esos sobrantes nunca se entregan,
    //                asi que nunca "desaparecen".)
    //   COHERENTE    `found` es la longitud de esa lista, por construccion.
    function outfitsAcumulados(trabajo, terminado) {
        if (terminado) return trabajo.outfits ?? [];
        const guardados = trabajo.checkpoint?.outfits ?? [];
        return guardados.slice(0, trabajo.target);
    }

    function presentar(trabajo) {
        const terminado = TERMINALES.has(trabajo.status);
        const ahora = Date.now();
        const fase = faseDe(trabajo, ahora);
        const acumulados = outfitsAcumulados(trabajo, terminado);
        const contadores = trabajo.checkpoint?.contadores ?? null;

        // Foto de progreso. Estacionado y leido de la base, el contador de la
        // pausa se recalcula al leer: asi el plugin ve moverse "quedan 20 s"
        // aunque pregunte a una replica que no tiene el trabajo en memoria.
        let progress = trabajo.status === ESTADO.QUEUED ? null : (trabajo.progress ?? null);
        if (progress && fase === FASE.ESPERANDO_ROBLOX && trabajo.resumeAt) {
            const restante = Math.max(0, trabajo.resumeAt - ahora);
            progress = { ...progress, phase: fase, cooldownRemainingMs: restante,
                estimatedRemainingMs: Math.max(progress.estimatedRemainingMs ?? 0, restante) };
        } else if (progress && fase && progress.phase !== fase) {
            progress = { ...progress, phase: fase };
        }
        if (progress) {
            // Lo que el plugin necesita ver DURANTE la busqueda, coherente con
            // la lista que recibe: cuantos lleva, cuantos miro, cuantos salto
            // por pocos accesorios, cuanto trabajo y cuanto espero a Roblox.
            progress = {
                ...progress,
                found: Math.min(acumulados.length, trabajo.target),
                outfitsDelivered: acumulados.length,
                waitingForRoblox: fase === FASE.ESPERANDO_ROBLOX,
                rejectedTooFewAccessories: contadores?.rejectedTooFewAccessories ?? progress.rejectedTooFewAccessories ?? 0,
                rateLimitWaits: contadores?.rateLimitWaits ?? 0,
                rateLimitWaitedMs: Math.round(contadores?.rateLimitWaitedMs ?? 0),
            };
        }

        return {
            searchId: trabajo.searchId,
            status: trabajo.status,
            requested: trabajo.target,
            found: acumulados.length,

            // Aditivo: en que esta el trabajo, y de quien es. El plugin de hoy
            // lo ignora; uno de mañana puede decir "recuperando tras un
            // despliegue" en vez de enseñar 0 candidatos sin explicacion.
            phase: fase,
            ownership: {
                instance: trabajo.instanceId ?? null,
                previousInstance: trabajo.previousInstanceId ?? null,
                handoffs: trabajo.handoffs ?? 0,
                heartbeatAgeMs: terminado ? null
                    : Math.max(0, ahora - (trabajo.desdeBase ? (trabajo.heartbeatAt ?? trabajo.createdAt ?? ahora) : trabajo.updatedAt)),
                servedFrom: trabajo.desdeBase ? 'database' : 'memory',
            },

            queuePosition: trabajo.status === ESTADO.QUEUED ? (trabajo.queuePosition ?? null) : null,
            progress,

            pollAfterMs: terminado ? null : config.pluginJobs.pollIntervalMs,
            // Los encontrados HASTA AHORA, tambien en running: acumulativos y
            // estables (ver outfitsAcumulados). El plugin de hoy los lee al
            // terminar; uno de mañana puede pintarlos segun llegan.
            outfits: acumulados,
            stats: terminado ? (trabajo.stats ?? null) : null,
            stoppedBy: trabajo.stoppedBy ?? null,
            error: trabajo.error ?? null,
        };
    }

    // ── Recuperacion (arranque y periodica) ──────────────────────────────────
    //
    // 1. ADOPTAR lo reanudable sin dueño vivo: soltado por una instancia que se
    //    apago, o cuyo dueño lleva adoptAfterMs sin latir. SOLO si hay un
    //    ejecutor registrado: adoptar sin poder ejecutar seria fabricar
    //    exactamente el huerfano que se quiere evitar.
    // 2. EXPIRAR lo no reanudable.
    // 3. BORRAR lo vencido.
    async function recuperarAlArrancar() {
        let arrancados = 0;
        let adoptados = [];

        // ── EL INDICE SIRVE: EL SISTEMA ANTIGUO NO SE TOCA ──────────────────
        //
        // Con INDEX_SERVE_ENABLED=true una busqueda es una consulta a Postgres y
        // no existe ningun trabajo que reanudar. Adoptar los que quedaron del
        // sistema anterior tendria un solo efecto: ponerlos a recorrer
        // comunidades y a competir con el worker del indice por la MISMA cuota
        // de Roblox, que es exactamente lo escaso.
        //
        // Asi que no se adoptan, no se reanudan y no se ejecutan. Se retiran:
        // se marcan como expirados, que es un estado que el plugin entiende.
        if (config.indexServe.enabled) {
            const retirados = await repo.retirarLegacy();
            const borradosAhora = await repo.limpiarVencidos();
            if (retirados > 0) {
                logger.info('Sistema antiguo de busquedas retirado al arrancar', {
                    instance: instancia, retirados,
                });
            }
            return { adoptados: 0, expirados: retirados, borrados: borradosAhora, legacyRetirado: retirados };
        }

        if (!ejecutor) {
            logger.warn('Recuperacion sin ejecutor registrado: no se adopta ningun trabajo', { instance: instancia });
        } else {
            adoptados = await repo.adoptarHuerfanos(instancia);
            for (const fila of adoptados) {
                const trabajo = hidratar(fila);
                trabajos.set(trabajo.searchId, trabajo);
                // Latir YA, antes de que el runner consiga el turno del grupo:
                // desde este instante el trabajo tiene dueño vivo.
                iniciarLatido(trabajo);

                logger.info('Trabajo de busqueda adoptado', {
                    searchId: trabajo.searchId,
                    groupId: String(trabajo.groupId),
                    previousInstance: fila.adoptedFrom ?? null,
                    newInstance: instancia,
                    reason: fila.adoptionReason,
                    heartbeatAgeMs: fila.heartbeatAgeMs,
                    handoffs: trabajo.handoffs,
                    phase: fila.phase,
                    found: trabajo.checkpoint?.outfits?.length ?? 0,
                    pendingCandidates: trabajo.checkpoint?.pendientes?.length ?? 0,
                    resumeAt: fila.resumeAt ? new Date(fila.resumeAt).toISOString() : null,
                });

                // Sin await: corre en segundo plano igual que un POST asincrono.
                // El ejecutor nunca rechaza.
                ejecutor(trabajo);
                arrancados++;
                logger.info('Runner arrancado tras adoptar', {
                    searchId: trabajo.searchId, newInstance: instancia,
                    resumedFromCheckpoint: Boolean(trabajo.checkpoint),
                });
            }
        }

        const expirados = await repo.expirarHuerfanos();
        const borrados = await repo.limpiarVencidos();
        return { adoptados: arrancados, expirados, borrados };
    }

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
        trabajo.phase = fila.phase === FASE.ESPERANDO_ROBLOX ? FASE.ESPERANDO_ROBLOX : FASE.TRABAJANDO;
        trabajo.resumeAt = fila.resumeAt ?? null;
        trabajo.rateLimitedRoute = fila.rateLimitedRoute ?? null;
        trabajo.handoffs = fila.handoffs ?? 0;
        trabajo.previousInstanceId = fila.adoptedFrom ?? fila.previousInstanceId ?? null;
        trabajo.ultimoFound = fila.checkpoint?.outfits?.length ?? fila.found ?? 0;
        return trabajo;
    }

    // ── Apagado ──────────────────────────────────────────────────────────────
    //
    // Al recibir SIGTERM (cada redeploy de Railway), esta instancia SUELTA sus
    // trabajos vivos: deja en la base su ultimo checkpoint y la fila sin dueño.
    // Cualquier instancia viva los adopta en su siguiente pasada, en segundos,
    // sin esperar a que el latido caduque. Las busquedas que corren aqui se
    // enteran en su siguiente checkpoint y paran sin marcar nada como fallido.
    async function soltarTodos() {
        const vivos = [...trabajos.values()].filter(t => !TERMINALES.has(t.status) && !t.adoptado);
        let soltados = 0;
        for (const trabajo of vivos) {
            detenerLatido(trabajo.searchId);
            const { ok } = await repo.soltar(trabajo);
            trabajo.adoptado = true; // este proceso no lo toca mas, pase lo que pase
            trabajo.adoptadoPor = null;
            if (ok) soltados++;
            logger.info('Trabajo de busqueda soltado al apagar', {
                searchId: trabajo.searchId, groupId: String(trabajo.groupId),
                previousInstance: instancia, phase: trabajo.phase,
                found: trabajo.progress?.found ?? 0, released: ok,
            });
        }
        return { vivos: vivos.length, soltados };
    }

    function registrarEjecutor(fn) {
        ejecutor = fn;
    }

    function reset() {
        for (const id of [...latidos.keys()]) detenerLatido(id);
        trabajos.clear();
    }

    return {
        instancia,
        crear, marcarEnCola, marcarEnCurso, actualizarProgreso, guardarCheckpoint,
        parquear, latir, reanudar, terminar, fallar,
        obtener, presentar, limpiar, recuperarAlArrancar, registrarEjecutor, soltarTodos, reset, esVigente,
        tamano: () => trabajos.size,
        // Solo para pruebas: simula la MUERTE del proceso para sus trabajos —
        // dejan de latir y la busqueda que corra aqui para en su siguiente
        // checkpoint, sin escribir nada mas en la base.
        __simularMuerte() {
            for (const trabajo of trabajos.values()) {
                if (TERMINALES.has(trabajo.status)) continue;
                detenerLatido(trabajo.searchId);
                trabajo.adoptado = true;
                trabajo.adoptadoPor = 'proceso-muerto';
            }
        },
        __congelarLatidos() {
            for (const id of [...latidos.keys()]) detenerLatido(id);
        },
    };
}

const porDefecto = crearRegistro();

module.exports = {
    ...porDefecto,
    ESTADO, FASE, TERMINALES, TrabajoAdoptadoError, crearRegistro,
};
