'use strict';

const express = require('express');
const router = express.Router();

const config = require('../../config');
const logger = require('../../observability/logger');
const eventos = require('../../observability/indexEvents');
const rateLimiter = require('../../roblox/rateLimiter');
const crawlRepo = require('../../db/indexCrawlRepo');
const indexWorker = require('../../services/indexWorker/worker');
const { parseGroupId, ValidationError } = require('../../validation/params');
const { translateDbError } = require('../../db/errors');

// ADMINISTRACION DEL INDICE, para el panel del plugin.
//
// Router propio y no un anadido a plugin.js por una razon de contrato: ahi vive
// la busqueda, que es lo que el plugin lleva usando desde el principio y lo que
// no se puede romper. Esto es otra cosa —mirar y administrar— y separarlo deja
// que la busqueda siga siendo un archivo que nadie tiene que volver a tocar.
//
// Cuelga de /plugin/index y comparte credencial con la busqueda: `x-plugin-key`,
// comprobada en src/app.js antes de llegar aqui.
//
// ── LA REGLA QUE GOBIERNA TODO ESTE ARCHIVO ──────────────────────────────────
//
// NINGUNA de estas rutas llama a Roblox. Ni una. El panel se abre y se queda
// sondeando cada cinco segundos mientras alguien tiene Studio abierto, y la
// cuota de Roblox es de tres peticiones por segundo para el proceso entero: un
// panel que gastara de ahi competiria con el worker por el unico recurso
// escaso que hay, y lo haria justo cuando alguien esta mirando para ver por
// que el worker no avanza.
//
// Todo sale de Postgres (una consulta de solo lectura) o de memoria del proceso
// (los contadores del worker y el estado del limitador). Y de Postgres solo se
// LEE: no se toca `last_delivered_at`, no se rota nada, no se sube prioridad y
// no se crea ningun trabajo. Mirar el panel no puede cambiar lo que enseña.

router.use(express.json({ limit: '1kb' }));

// El estado que se le pinta a cada comunidad. Se deriva aqui y no se guarda en
// la base porque es una lectura del momento, no un hecho: la misma fila es
// "cooldown" o "indexando" segun lo que este haciendo Roblox ahora mismo.
const ESTADO = {
    CANCELADA: 'cancelled',
    INDEXANDO: 'indexing',
    COOLDOWN: 'cooldown',
    ESPERANDO: 'waiting',
    AL_DIA: 'up_to_date',
    ERROR: 'error',
};

const RUTAS_VIGILADAS = ['userAvatarV2', 'catalogDetails', 'groupMembers'];

function cooldowns() {
    const salida = {};
    for (const ruta of RUTAS_VIGILADAS) {
        try {
            const estado = rateLimiter.getThrottleState(ruta);
            salida[ruta] = {
                throttled: estado.throttled === true,
                remainingMs: estado.cooldownRemainingMs ?? 0,
                circuitOpen: estado.circuitOpen === true,
            };
        } catch {
            // Una ruta que no exista en el limitador no es motivo para que el
            // panel entero devuelva un error. Se omite y se sigue.
        }
    }
    return salida;
}

function cooldownMaximoMs(mapa) {
    return Object.values(mapa).reduce((max, r) => Math.max(max, r.remainingMs ?? 0), 0);
}

// El ultimo error se enseña, pero no en crudo. Por esas ramas pasan tanto
// errores de axios como de `pg`, y un error de `pg` puede arrastrar el host, el
// usuario y hasta un fragmento de la consulta. El detalle completo sigue
// estando en el log del servidor, que es donde le corresponde estar; aqui va lo
// justo para saber que fue.
const DELATORES = /(password|user(name)?|host|port|dbname|postgres:\/\/|sslmode)/gi;

function mensajeSeguro(texto) {
    if (texto == null) return null;
    return String(texto).replace(DELATORES, '···').slice(0, 120);
}

// Traduce una fila de recorrido al estado que ve la persona.
//
// El orden de las comprobaciones ES la logica: cancelada gana sobre todo lo
// demas (es una decision explicita), y "al dia" es lo ultimo porque solo se
// puede afirmar cuando no hay ninguna otra cosa pasando.
function estadoDe(fila, { activaAhora, cooldownMs }) {
    if (fila.pausedAt != null) return ESTADO.CANCELADA;

    // El cooldown es del PROCESO, no de la comunidad: los tres buckets del
    // limitador son por ruta y los comparte todo el mundo. Aplicarlo a cada
    // fila pintaba las cien comunidades en "cooldown" a la vez por un solo 429,
    // y de paso tapaba las que estaban al dia y las que tenian un error real.
    // Solo se le atribuye a la que el worker esta atendiendo ahora, que es la
    // unica a la que ese freno le esta impidiendo avanzar de verdad.
    if (activaAhora) return cooldownMs > 0 ? ESTADO.COOLDOWN : ESTADO.INDEXANDO;

    if (fila.lastError) return ESTADO.ERROR;

    // Al dia = ha completado una vuelta entera y todos sus miembros conocidos
    // tienen avatar. Sin la segunda condicion, una comunidad recorrida a medias
    // se anunciaria como terminada.
    const completa = fila.lastFullPassAt != null;
    const todosIndexados = fila.knownMembers > 0 && fila.indexed >= fila.knownMembers;
    if (completa && todosIndexados) return ESTADO.AL_DIA;

    return ESTADO.ESPERANDO;
}

// ── GET /plugin/index/status ────────────────────────────────────────────────
//
// Lo barato: solo memoria del proceso. Es lo que el panel sondea mas a menudo,
// asi que no toca Postgres siquiera.
router.get('/status', (req, res) => {
    res.locals.routeLabel = '/plugin/index/status';

    const vida = indexWorker.vida;
    const metricas = indexWorker.metricas;
    const frenos = cooldowns();

    res.json({
        success: true,
        worker: {
            enabled: config.indexWorker.enabled === true,
            instance: metricas.instance,
            // `idle` cuando no hay comunidad cogida. El panel enseña
            // "Worker en espera" y no un hueco en blanco.
            etapa: vida.etapa,
            groupId: vida.groupId,
            pendingAvatars: vida.pendientesAvatar,
            pendingPrices: vida.pendientesPrecio,
            lastProgressAt: vida.ultimoProgresoAt,
            lastProgressAgoMs: vida.ultimoProgresoAt != null
                ? Math.max(0, Date.now() - vida.ultimoProgresoAt) : null,
            startedAt: vida.arrancadoAt,
            cyclesWithoutProgress: vida.ciclosSinProgreso,
        },
        counters: {
            cycles: metricas.cycles,
            groupsVisited: metricas.groupsVisited,
            memberRowsSeen: metricas.memberRowsSeen,
            avatarsRequested: metricas.avatarsRequested,
            avatarsIndexed: metricas.avatarsIndexed,
            usersPriced: metricas.usersPriced,
            catalogBatches: metricas.catalogBatches,
            cooldowns: metricas.cooldowns,
            errors: metricas.errors,
            stalls: metricas.stalls,
            leavers: metricas.leavers,
            avatarsPerMinute: metricas.avatarsPerMinute,
            lastCycleAt: metricas.lastCycleAt,
            lastCycleMs: metricas.lastCycleMs,
            lastGroupId: metricas.lastGroupId,
            lastError: mensajeSeguro(metricas.lastError),
        },
        cooldowns: frenos,
        cooldownMs: cooldownMaximoMs(frenos),
        // Cuando toca el siguiente ciclo. Es un dato del reloj del worker, no
        // una promesa: si hay cooldown, el ciclo llega y no hace nada.
        nextCycleInMs: metricas.lastCycleAt != null
            ? Math.max(0, config.indexWorker.tickMs - (Date.now() - metricas.lastCycleAt))
            : 0,
        events: eventos.listar({ limite: 20 }),
        robloxCalls: 0,
    });
});

// ── GET /plugin/index/groups ────────────────────────────────────────────────
//
// Lo caro, y aun asi barato: UNA consulta de solo lectura con los contadores de
// todas las comunidades. Es la que el panel sondea mas espaciada.
router.get('/groups', async (req, res, next) => {
    res.locals.routeLabel = '/plugin/index/groups';

    if (!crawlRepo.disponible()) {
        return res.status(503).json({
            error: { code: 'index_unavailable', message: 'No hay base de datos: el indice no se puede consultar.' },
        });
    }

    try {
        const vida = indexWorker.vida;
        const frenos = cooldowns();
        const cdMs = cooldownMaximoMs(frenos);

        const filas = await crawlRepo.listarTodas({
            // Las canceladas van primero en el ORDER BY precisamente porque son
            // las unicas sobre las que hay algo que pulsar. Aun asi el limite es
            // holgado: la tabla crece una fila por comunidad buscada y nadie la
            // poda, asi que quedarse corto significa que una comunidad
            // cancelada deje de poder reanudarse desde el panel.
            limite: 500,
            minAccessories: config.pluginSearch.minAccessories,
        });

        const ahora = Date.now();
        const grupos = filas.map(fila => {
            const activaAhora = vida.groupId != null && String(vida.groupId) === fila.groupId
                && vida.etapa !== 'idle';
            return {
                groupId: fila.groupId,
                // Sale de la licencia cuando la hay. Puede ser null: una
                // comunidad se puede estar indexando sin figurar ahi, y
                // entonces el panel enseña el numero, que es lo unico que
                // se sabe de ella.
                groupName: fila.groupName ?? null,
                status: estadoDe(fila, { activaAhora, cooldownMs: cdMs }),
                paused: fila.pausedAt != null,
                pausedAt: fila.pausedAt,
                pausedReason: fila.pausedReason,
                stage: activaAhora ? vida.etapa : null,
                knownMembers: fila.knownMembers,
                indexed: fila.indexed,
                eligible: fila.eligible,
                cycle: fila.cycle,
                priority: fila.priority,
                demands: fila.demands,
                lastRunAt: fila.lastRunAt,
                lastProgressAgoMs: fila.lastRunAt != null ? Math.max(0, ahora - fila.lastRunAt) : null,
                lastFullPassAt: fila.lastFullPassAt,
                lapClean: fila.lapClean,
                lastError: mensajeSeguro(fila.lastError),
                hasCursor: fila.cursor != null,
            };
        });

        res.json({
            success: true,
            groups: grupos,
            current: vida.groupId != null && vida.etapa !== 'idle'
                ? { groupId: String(vida.groupId), stage: vida.etapa }
                : null,
            robloxCalls: 0,
        });
    } catch (err) {
        // Una base caida es un 503 con Retry-After, no un 500. El panel sondea
        // cada diez segundos: sin traducir, un reinicio de Postgres llenaba el
        // log de "Error no controlado" con stack, una vez por sondeo, y le
        // decia al plugin que el fallo era del servidor.
        next(translateDbError(err));
    }
});

// Comun a las tres acciones: validar el id y exigir que la comunidad exista.
// Actuar sobre una que no existe seria crearla por accidente, que es justo lo
// contrario de lo que hace cada una de estas rutas.
async function comunidadDe(req) {
    const groupId = parseGroupId(req.params.groupId);
    if (!crawlRepo.disponible()) {
        const err = new Error('sin base');
        err.__sinBase = true;
        throw err;
    }
    const fila = await crawlRepo.leer(groupId);
    return { groupId, fila };
}

function responderSinBase(res) {
    return res.status(503).json({
        error: { code: 'index_unavailable', message: 'No hay base de datos: el indice no se puede administrar.' },
    });
}

function responderNoExiste(res, groupId) {
    return res.status(404).json({
        error: { code: 'group_not_indexed', message: `La comunidad ${groupId} no esta en el indice.` },
    });
}

// ── POST /plugin/index/groups/:groupId/cancel ───────────────────────────────
//
// Cancela la indexacion de UNA comunidad. No toca ninguna otra, no para el
// worker y no borra nada. Persiste en Postgres, asi que sigue cancelada
// despues de un redeploy de Railway.
router.post('/groups/:groupId/cancel', async (req, res, next) => {
    res.locals.routeLabel = '/plugin/index/groups/:groupId/cancel';
    try {
        const { groupId, fila } = await comunidadDe(req);
        if (!fila) return responderNoExiste(res, groupId);

        const motivo = typeof req.body?.reason === 'string' ? req.body.reason : 'cancelada desde el plugin';
        const actualizada = await crawlRepo.pausar(groupId, { motivo });

        eventos.registrar(eventos.TIPO.GRUPO_CANCELADO, { groupId, detalle: motivo });
        logger.info('Indexacion cancelada para una comunidad', {
            requestId: req.requestId, groupId: String(groupId), operation: 'index.cancel',
        });

        res.json({
            success: true,
            groupId: String(groupId),
            paused: true,
            pausedAt: actualizada?.pausedAt ?? null,
            // Se dice explicitamente lo que NO ha pasado. Quien lee esto desde
            // el plugin necesita poder confiar en que cancelar no borro nada.
            preserved: { cursor: true, members: true, avatars: true, prices: true },
        });
    } catch (err) {
        if (err?.__sinBase) return responderSinBase(res);
        next(translateDbError(err));
    }
});

// ── POST /plugin/index/groups/:groupId/resume ───────────────────────────────
router.post('/groups/:groupId/resume', async (req, res, next) => {
    res.locals.routeLabel = '/plugin/index/groups/:groupId/resume';
    try {
        const { groupId, fila } = await comunidadDe(req);
        if (!fila) return responderNoExiste(res, groupId);

        const actualizada = await crawlRepo.reanudar(groupId);

        eventos.registrar(eventos.TIPO.GRUPO_REANUDADO, { groupId });
        logger.info('Indexacion reanudada para una comunidad', {
            requestId: req.requestId, groupId: String(groupId), operation: 'index.resume',
        });

        res.json({
            success: true,
            groupId: String(groupId),
            paused: false,
            // Continua por donde iba: se devuelve la prueba de que el progreso
            // sigue ahi en vez de pedir que se confie en la palabra.
            resumedFrom: {
                hasCursor: actualizada?.cursor != null,
                cycle: actualizada?.cycle ?? null,
                membersSeen: actualizada?.membersSeen ?? 0,
                usersIndexed: actualizada?.usersIndexed ?? 0,
            },
        });
    } catch (err) {
        if (err?.__sinBase) return responderSinBase(res);
        next(translateDbError(err));
    }
});

// ── DELETE /plugin/index/groups/:groupId ────────────────────────────────────
//
// La unica destructiva. Exige que quien la llama repita el groupId en
// `confirm`: es una confirmacion de servidor, no de interfaz. Una confirmacion
// que solo vive en el plugin la esquiva cualquiera que llame a la ruta a mano,
// y esta operacion no se puede deshacer.
router.delete('/groups/:groupId', async (req, res, next) => {
    res.locals.routeLabel = '/plugin/index/groups/:groupId';
    try {
        const { groupId, fila } = await comunidadDe(req);
        if (!fila) return responderNoExiste(res, groupId);

        const confirmacion = req.body?.confirm ?? req.query?.confirm;
        if (String(confirmacion ?? '') !== String(groupId)) {
            return res.status(400).json({
                error: {
                    code: 'confirmation_required',
                    message: 'Para eliminar hay que repetir el groupId en el campo confirm.',
                },
            });
        }

        const resultado = await crawlRepo.eliminar(groupId);

        eventos.registrar(eventos.TIPO.GRUPO_ELIMINADO, {
            groupId,
            detalle: `${resultado?.miembrosBorrados ?? 0} miembros`,
        });
        logger.warn('Comunidad eliminada del indice', {
            requestId: req.requestId, groupId: String(groupId), operation: 'index.delete',
            members: resultado?.miembrosBorrados ?? 0,
            orphanAvatars: resultado?.avataresHuerfanos ?? 0,
        });

        res.json({
            success: true,
            groupId: String(groupId),
            deleted: resultado,
            // Los datos globales se conservan, y se dice cuantos avatares se
            // quedaron sin comunidad. Borrarlos destruiria trabajo de otras
            // comunidades: el mismo usuario puede estar en varias, y cada
            // avatar costo una llamada contra una cuota de tres por segundo.
            keptGlobal: {
                robloxUserAvatar: true,
                robloxAssetCatalog: true,
                orphanAvatars: resultado?.avataresHuerfanos ?? 0,
            },
        });
    } catch (err) {
        if (err?.__sinBase) return responderSinBase(res);
        if (err instanceof ValidationError) return next(err);
        next(translateDbError(err));
    }
});

module.exports = router;
