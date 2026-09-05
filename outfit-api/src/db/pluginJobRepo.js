'use strict';

const crypto = require('crypto');
const db = require('./pool');
const config = require('../config');
const logger = require('../observability/logger');

// Persistencia de los trabajos de busqueda. Es lo que hace que un `searchId`
// siga existiendo despues de un redeploy y pueda consultarse DESDE OTRA
// INSTANCIA: con el estado solo en memoria, un GET que cae en la replica
// equivocada responde 404 aunque el trabajo exista y este corriendo.
//
// ── PROPIEDAD (ownership) ────────────────────────────────────────────────────
//
// Cada fila lleva `instance_id`: el proceso que la esta EJECUTANDO. Toda
// escritura de ese proceso va vallada (`WHERE instance_id = $me`), asi que dos
// procesos no pueden avanzar el mismo trabajo a la vez: el que perdio la
// propiedad se entera en su siguiente escritura y para.
//
// La propiedad se mantiene con un LATIDO independiente del progreso (ver
// jobs.js): cada pocos segundos, trabaje, espere turno o este estacionado por
// Roblox. Un trabajo cuyo latido lleva `adoptAfterMs` sin renovarse es un
// huerfano y otra instancia puede adoptarlo — y solo entonces.
//
// LA TOLERANCIA A FALLOS TRANSITORIOS de la base esta en la relacion entre el
// intervalo de latido y `adoptAfterMs`: con latidos cada 5 s y adopcion a los
// 90 s hacen falta dieciocho latidos fallidos seguidos para que un trabajo
// vivo parezca muerto. Un bache de Postgres de veinte segundos no le quita el
// trabajo a nadie.
//
// ── EL FALLO QUE ESTO CORRIGE ────────────────────────────────────────────────
//
// La creacion (INSERT) no se esperaba, y la primera escritura vallada del
// ejecutor (UPDATE ... WHERE instance_id = $me) podia llegar a Postgres ANTES
// de que la fila existiera. Cero filas afectadas se interpretaba como "otra
// instancia lo adopto": el proceso soltaba una busqueda que NADIE mas tenia, y
// el trabajo se quedaba en 0 de 10 para siempre. Ahora la creacion se espera,
// y cero filas afectadas se DIAGNOSTICA antes de concluir nada: se lee quien
// es el dueño, y solo si es otra instancia se considera adoptado.

// Identidad de este proceso. Cambia en cada arranque a proposito: tras un
// redeploy, el proceso nuevo no debe poder confundirse con el viejo.
const INSTANCIA = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

const disponible = () => db.isConfigured();

function filaAJob(fila) {
    if (!fila) return null;
    return {
        searchId: fila.search_id,
        groupId: fila.group_id,
        status: fila.status,
        target: fila.requested,
        found: fila.found,
        candidatesExamined: fila.candidates_examined,
        stoppedBy: fila.stopped_by,
        progress: fila.progress ?? null,
        outfits: fila.result?.outfits ?? [],
        stats: fila.result?.stats ?? null,
        error: fila.error_code ? { code: fila.error_code } : null,

        // Park / resume. `params` es lo que hace reanudable a un trabajo;
        // `checkpoint` es desde donde.
        params: fila.params ?? null,
        phase: fila.phase ?? 'working',
        resumeAt: fila.resume_at?.getTime?.() ?? null,
        rateLimitedRoute: fila.rate_limited_route ?? null,
        checkpoint: fila.checkpoint ?? null,

        // Propiedad.
        instanceId: fila.instance_id ?? null,
        previousInstanceId: fila.previous_instance_id ?? null,
        handoffs: fila.handoffs ?? 0,
        adoptedAt: fila.adopted_at?.getTime?.() ?? null,
        heartbeatAt: fila.heartbeat_at?.getTime?.() ?? null,

        createdAt: fila.created_at?.getTime?.() ?? null,
        startedAt: fila.started_at?.getTime?.() ?? null,
        finishedAt: fila.completed_at?.getTime?.() ?? null,
        // Marca de que esta version viene de la base y no de memoria: el GET la
        // usa para no intentar actualizar un trabajo que no es suyo.
        desdeBase: true,
    };
}

// El resultado de toda escritura vallada. `ok: false` significa que la fila NO
// es de este proceso, y `motivo` dice por que — que es lo que decide si hay que
// parar (adoptado) o seguir en memoria (la fila no existe).
const NO_ES_MIO = Object.freeze({
    ADOPTADO: 'adopted',    // otra instancia es la dueña
    SOLTADO: 'released',    // nadie es dueño: se solto (apagado) y aun no se adopto
    AUSENTE: 'missing',     // la fila no existe
    TERMINAL: 'terminal',   // ya termino (o expiro) segun la base
});

// Quien es el dueño de un trabajo segun la base. Se consulta SOLO cuando una
// escritura vallada no toco ninguna fila: es lo que distingue "me lo quitaron"
// de "la fila no esta" — y esa diferencia es la que antes no se hacia.
async function quienEsElDueño(searchId) {
    try {
        const { rows } = await db.query(
            `SELECT instance_id, status, heartbeat_at, previous_instance_id, handoffs
               FROM plugin_search_jobs WHERE search_id = $1`,
            [searchId], 'jobs.owner'
        );
        if (rows.length === 0) return { ok: false, motivo: NO_ES_MIO.AUSENTE, dueño: null, estado: null };
        const fila = rows[0];
        const terminal = !['queued', 'running'].includes(fila.status);
        if (terminal) return { ok: false, motivo: NO_ES_MIO.TERMINAL, dueño: fila.instance_id, estado: fila.status };
        if (fila.instance_id === null) return { ok: false, motivo: NO_ES_MIO.SOLTADO, dueño: null, estado: fila.status };
        return {
            ok: false, motivo: NO_ES_MIO.ADOPTADO, dueño: fila.instance_id, estado: fila.status,
            previo: fila.previous_instance_id ?? null, handoffs: fila.handoffs ?? 0,
        };
    } catch (err) {
        // No se sabe. Se asume que sigue siendo nuestro: parar una busqueda por
        // un bache de la base seria peor que un latido de mas.
        return { ok: true, transitorio: true };
    }
}

// Interpreta el rowCount de una escritura vallada.
async function veredicto(trabajo, rowCount) {
    if (rowCount > 0) return { ok: true };
    const quien = await quienEsElDueño(trabajo.searchId);
    if (quien.ok) return quien;
    // La fila es de OTRA instancia, o de nadie, o ya termino. Si es de este
    // mismo proceso pero el UPDATE no la toco, algo raro paso (una carrera con
    // la propia creacion): se trata como transitorio, no como adopcion.
    if (quien.motivo === NO_ES_MIO.ADOPTADO && quien.dueño === trabajo.instanceId) {
        return { ok: true, transitorio: true };
    }
    return quien;
}

async function crear(trabajo) {
    if (!disponible()) return { persistido: false };
    try {
        await db.query(
            `INSERT INTO plugin_search_jobs
                (search_id, group_id, status, requested, instance_id, heartbeat_at, params, phase)
             VALUES ($1, $2, $3, $4, $5, NOW(), $6, 'working')
             ON CONFLICT (search_id) DO NOTHING`,
            [
                trabajo.searchId, String(trabajo.groupId), trabajo.status, trabajo.target, trabajo.instanceId,
                // La peticion entera: sin ella un trabajo que muera a medias
                // no se puede reanudar en otra instancia.
                trabajo.params ? JSON.stringify(trabajo.params) : null,
            ],
            'jobs.create'
        );
        return { persistido: true };
    } catch (err) {
        // Un trabajo que no se puede persistir sigue sirviendo desde memoria:
        // lo unico que se pierde es poder consultarlo tras un reinicio.
        logger.warn('No se pudo persistir el trabajo de busqueda', {
            searchId: trabajo.searchId, code: err?.code ?? null, detail: err?.message,
        });
        return { persistido: false };
    }
}

// Volcado de estado + latido, VALLADO por instancia. Devuelve { ok } o
// { ok: false, motivo, dueño }: quien llama decide, y solo 'adopted' significa
// "para, otra instancia lo continua".
async function actualizar(trabajo) {
    if (!disponible()) return { ok: true };
    try {
        const { rowCount } = await db.query(
            `UPDATE plugin_search_jobs
                SET status = $2,
                    found = $3,
                    candidates_examined = $4,
                    progress = $5,
                    started_at = COALESCE(started_at, $6),
                    phase = $8,
                    resume_at = $9,
                    rate_limited_route = $10,
                    checkpoint = COALESCE($11, checkpoint),
                    updated_at = NOW(),
                    heartbeat_at = NOW()
              WHERE search_id = $1
                AND instance_id = $7`,
            [
                trabajo.searchId, trabajo.status,
                trabajo.progress?.found ?? 0,
                trabajo.progress?.candidatesExamined ?? 0,
                trabajo.progress ? JSON.stringify(trabajo.progress) : null,
                trabajo.startedAt ? new Date(trabajo.startedAt) : null,
                trabajo.instanceId,
                trabajo.phase ?? 'working',
                trabajo.resumeAt ? new Date(trabajo.resumeAt) : null,
                trabajo.rateLimitedRoute ?? null,
                trabajo.checkpointPendiente ? JSON.stringify(trabajo.checkpointPendiente) : null,
            ],
            'jobs.snapshot'
        );
        return veredicto(trabajo, rowCount);
    } catch (err) {
        // warn, no debug: un volcado fallido es un checkpoint que NO es
        // durable. Pero un bache de la base no le quita el trabajo a nadie.
        logger.warn('No se pudo volcar el progreso del trabajo', {
            searchId: trabajo.searchId, phase: trabajo.phase ?? 'working',
            code: err?.code ?? null, detail: err?.message,
        });
        return { ok: true, transitorio: true };
    }
}

// LATIDO. Es lo que dice "sigo aqui" — trabajando, esperando turno o
// estacionado por Roblox —, independientemente de si hubo progreso que
// contar. Ligero a proposito: fase, cuando reanuda y la foto de progreso (para
// que un GET en otra replica vea el contador de la pausa moverse).
async function latir(trabajo) {
    if (!disponible()) return { ok: true };
    try {
        const { rowCount } = await db.query(
            `UPDATE plugin_search_jobs
                SET heartbeat_at = NOW(),
                    updated_at = NOW(),
                    status = $3,
                    phase = $4,
                    resume_at = $5,
                    rate_limited_route = $6,
                    progress = COALESCE($7, progress)
              WHERE search_id = $1
                AND instance_id = $2`,
            [
                trabajo.searchId, trabajo.instanceId, trabajo.status,
                trabajo.phase ?? 'working',
                trabajo.resumeAt ? new Date(trabajo.resumeAt) : null,
                trabajo.rateLimitedRoute ?? null,
                trabajo.progress ? JSON.stringify(trabajo.progress) : null,
            ],
            'jobs.heartbeat'
        );
        return veredicto(trabajo, rowCount);
    } catch (err) {
        return { ok: true, transitorio: true, error: err?.code ?? null };
    }
}

// Cierre. Aqui SI se guarda el resultado entero, y se fija la caducidad.
async function terminar(trabajo) {
    if (!disponible()) return { ok: true };
    try {
        const { rowCount } = await db.query(
            `UPDATE plugin_search_jobs
                SET status = $2,
                    found = $3,
                    candidates_examined = $4,
                    stopped_by = $5,
                    progress = $6,
                    result = $7,
                    error_code = $8,
                    phase = 'working',
                    resume_at = NULL,
                    rate_limited_route = NULL,
                    updated_at = NOW(),
                    heartbeat_at = NOW(),
                    completed_at = NOW(),
                    expires_at = NOW() + ($9::bigint * INTERVAL '1 millisecond')
              WHERE search_id = $1
                AND instance_id = $10`,
            [
                trabajo.searchId, trabajo.status,
                trabajo.outfits?.length ?? 0,
                trabajo.stats?.candidatesExamined ?? 0,
                trabajo.stoppedBy ?? null,
                trabajo.progress ? JSON.stringify(trabajo.progress) : null,
                JSON.stringify({ outfits: trabajo.outfits ?? [], stats: trabajo.stats ?? null }),
                trabajo.error?.code ?? null,
                config.pluginJobs.retentionMs,
                trabajo.instanceId,
            ],
            'jobs.finish'
        );
        return veredicto(trabajo, rowCount);
    } catch (err) {
        logger.warn('No se pudo persistir el resultado del trabajo', {
            searchId: trabajo.searchId, code: err?.code ?? null, detail: err?.message,
        });
        return { ok: true, transitorio: true };
    }
}

// SOLTAR al apagar. La instancia que recibe SIGTERM deja sus trabajos SIN
// dueño (instance_id NULL) y con su ultimo checkpoint: cualquier instancia viva
// los adopta en su siguiente pasada de recuperacion, sin esperar a que el
// latido caduque. Es lo que hace que un redeploy cueste segundos de pausa en
// vez de un minuto y medio de trabajo aparentemente congelado.
async function soltar(trabajo) {
    if (!disponible()) return { ok: true };
    try {
        const { rowCount } = await db.query(
            `UPDATE plugin_search_jobs
                SET previous_instance_id = instance_id,
                    instance_id = NULL,
                    phase = 'recovering',
                    checkpoint = COALESCE($3, checkpoint),
                    progress = COALESCE($4, progress),
                    updated_at = NOW()
              WHERE search_id = $1
                AND instance_id = $2
                AND status IN ('queued', 'running')`,
            [
                trabajo.searchId, trabajo.instanceId,
                (trabajo.checkpointPendiente ?? trabajo.checkpoint) ? JSON.stringify(trabajo.checkpointPendiente ?? trabajo.checkpoint) : null,
                trabajo.progress ? JSON.stringify(trabajo.progress) : null,
            ],
            'jobs.release'
        );
        return { ok: rowCount > 0 };
    } catch (err) {
        logger.warn('No se pudo soltar el trabajo al apagar', {
            searchId: trabajo.searchId, code: err?.code ?? null, detail: err?.message,
        });
        return { ok: false };
    }
}

async function leer(searchId) {
    if (!disponible()) return null;
    try {
        const { rows } = await db.query(
            `SELECT * FROM plugin_search_jobs WHERE search_id = $1`, [searchId], 'jobs.read'
        );
        return filaAJob(rows[0]);
    } catch (err) {
        logger.debug('No se pudo leer el trabajo de busqueda', { searchId, detail: err?.message });
        return null;
    }
}

// ── Adopcion ─────────────────────────────────────────────────────────────────
//
// Cambia de dueño, ATOMICAMENTE, los trabajos reanudables que de verdad se han
// quedado sin nadie:
//
//   - los SOLTADOS por una instancia que se apago (instance_id NULL), al
//     instante;
//   - los de una instancia que dejo de latir hace mas de adoptAfterMs, sea
//     cual sea su fase: trabajando, en cola o estacionado por Roblox. Un
//     trabajo vivo late en todas ellas, asi que ninguna se confunde con la
//     muerte.
//
// Con varias replicas arrancando a la vez, cada fila la adopta UNA sola
// (FOR UPDATE SKIP LOCKED). Y devuelve, junto con la fila, de quien era, cuanto
// llevaba sin latir y por que se adopto: es lo que el log necesita para que un
// cambio de dueño se pueda explicar despues.
async function adoptarHuerfanos(instancia, limite = 8) {
    if (!disponible()) return [];
    try {
        const { rows } = await db.query(
            `WITH candidatos AS (
                SELECT search_id,
                       instance_id AS previo,
                       EXTRACT(EPOCH FROM (NOW() - COALESCE(heartbeat_at, created_at))) * 1000 AS edad_ms,
                       CASE WHEN instance_id IS NULL THEN 'released' ELSE 'heartbeat_stale' END AS motivo
                  FROM plugin_search_jobs
                 WHERE status IN ('queued', 'running')
                   AND params IS NOT NULL
                   AND (instance_id IS NULL
                        OR COALESCE(heartbeat_at, created_at) < NOW() - ($2::bigint * INTERVAL '1 millisecond'))
                 ORDER BY created_at
                 LIMIT $3
                 FOR UPDATE SKIP LOCKED
             )
             UPDATE plugin_search_jobs j
                SET previous_instance_id = c.previo,
                    instance_id = $1,
                    adopted_at = NOW(),
                    handoffs = j.handoffs + 1,
                    heartbeat_at = NOW(),
                    updated_at = NOW()
               FROM candidatos c
              WHERE j.search_id = c.search_id
          RETURNING j.*, c.previo AS adopted_from, c.edad_ms AS heartbeat_age_ms, c.motivo AS adoption_reason`,
            [instancia, config.pluginJobs.adoptAfterMs, limite],
            'jobs.adopt'
        );
        return rows.map(fila => ({
            ...filaAJob(fila),
            adoptedFrom: fila.adopted_from ?? null,
            heartbeatAgeMs: Math.round(Number(fila.heartbeat_age_ms) || 0),
            adoptionReason: fila.adoption_reason,
        }));
    } catch (err) {
        logger.warn('No se pudieron adoptar los trabajos huerfanos', { code: err?.code ?? null, detail: err?.message });
        return [];
    }
}

// ── Expirar lo que NO se puede reanudar ──────────────────────────────────────
//
// Solo dos casos: filas anteriores a park/resume (sin `params`) cuyo dueño
// dejo de latir, y filas SOLTADAS que ninguna instancia adopto en un plazo
// largo (no hay ninguna viva). Todo lo demas se adopta, no se expira.
async function expirarHuerfanos() {
    if (!disponible()) return 0;
    try {
        const { rowCount } = await db.query(
            `UPDATE plugin_search_jobs
                SET status = 'expired',
                    stopped_by = 'expired',
                    completed_at = NOW(),
                    updated_at = NOW(),
                    expires_at = NOW() + ($1::bigint * INTERVAL '1 millisecond')
              WHERE status IN ('queued', 'running')
                AND (
                      (params IS NULL
                       AND COALESCE(heartbeat_at, created_at) < NOW() - ($2::bigint * INTERVAL '1 millisecond'))
                   OR (instance_id IS NULL
                       AND updated_at < NOW() - ($3::bigint * INTERVAL '1 millisecond'))
                )`,
            [
                config.pluginJobs.retentionMs,
                config.pluginJobs.adoptAfterMs,
                config.pluginJobs.releasedExpireMs,
            ],
            'jobs.expireOrphans'
        );
        if (rowCount > 0) {
            logger.warn('Trabajos de busqueda no reanudables marcados como expirados', { trabajos: rowCount });
        }
        return rowCount;
    } catch (err) {
        logger.warn('No se pudieron expirar los trabajos huerfanos', { detail: err?.message });
        return 0;
    }
}

// Recoleccion por caducidad.
async function limpiarVencidos() {
    if (!disponible()) return 0;
    try {
        const { rowCount } = await db.query(
            `DELETE FROM plugin_search_jobs WHERE expires_at IS NOT NULL AND expires_at < NOW()`,
            [], 'jobs.cleanup'
        );
        if (rowCount > 0) logger.info('Trabajos de busqueda vencidos eliminados', { trabajos: rowCount });
        return rowCount;
    } catch (err) {
        logger.debug('No se pudieron limpiar los trabajos vencidos', { detail: err?.message });
        return 0;
    }
}

module.exports = {
    disponible, crear, actualizar, latir, terminar, soltar, leer,
    adoptarHuerfanos, expirarHuerfanos, limpiarVencidos, quienEsElDueño,
    NO_ES_MIO,
    __instancia: INSTANCIA,
};
