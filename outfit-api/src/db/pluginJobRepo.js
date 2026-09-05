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
// NO CONVIERTE LA BASE EN UN STREAM DE ESCRITURAS, que es el error facil aqui.
// El estado caliente vive en memoria (ver services/pluginSearch/jobs.js) y a
// Postgres solo se baja:
//   - al crear (queued) y al arrancar (running);
//   - por HITOS: cuando sube `found`, que es lo que de verdad cambia la foto;
//   - cada PLUGIN_JOB_SNAPSHOT_MS como maximo, aunque no haya hitos — ese
//     volcado hace ademas de latido;
//   - al terminar, ya con el resultado completo.
// Una busqueda de 20 segundos son del orden de 10 escrituras, no cientos.
//
// SIN BASE DE DATOS TODO ESTO ES NULO y el servicio sigue funcionando con los
// trabajos en memoria, igual que la API de outfits lleva funcionando sin
// Postgres desde el primer dia.

// Identidad de este proceso. Sirve para saber, al arrancar, si un trabajo
// 'running' era NUESTRO (y por tanto esta muerto tras el reinicio) o de otra
// replica que sigue viva y latiendo.
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
        instanceId: fila.instance_id ?? null,

        createdAt: fila.created_at?.getTime?.() ?? null,
        startedAt: fila.started_at?.getTime?.() ?? null,
        finishedAt: fila.completed_at?.getTime?.() ?? null,
        // Marca de que esta version viene de la base y no de memoria: el GET la
        // usa para no intentar actualizar un trabajo que no es suyo.
        desdeBase: true,
    };
}

async function crear(trabajo) {
    if (!disponible()) return;
    try {
        await db.query(
            `INSERT INTO plugin_search_jobs
                (search_id, group_id, status, requested, instance_id, heartbeat_at, params, phase)
             VALUES ($1, $2, $3, $4, $5, NOW(), $6, 'working')
             ON CONFLICT (search_id) DO NOTHING`,
            [
                trabajo.searchId, String(trabajo.groupId), trabajo.status, trabajo.target, INSTANCIA,
                // La peticion entera: sin ella un trabajo que muera a medias
                // no se puede reanudar en otra instancia.
                trabajo.params ? JSON.stringify(trabajo.params) : null,
            ],
            'jobs.create'
        );
    } catch (err) {
        // Un trabajo que no se puede persistir sigue sirviendo desde memoria:
        // lo unico que se pierde es poder consultarlo tras un reinicio.
        logger.warn('No se pudo persistir el trabajo de busqueda', {
            searchId: trabajo.searchId, detail: err?.message,
        });
    }
}

// Volcado de estado + latido. `updated_at` y `heartbeat_at` van juntos: mientras
// haya volcados, el trabajo esta vivo.
//
// ── FENCING POR INSTANCIA ────────────────────────────────────────────────────
// El UPDATE solo toca la fila si el trabajo SIGUE SIENDO DE ESTE PROCESO. Si
// otra instancia lo adopto (porque nuestro latido se quedo viejo: una pausa de
// GC, una red partida, un despliegue a medias), esta escritura no hace nada y
// devuelve `false` — y quien llama tiene que PARAR, porque a partir de ese
// momento hay otro proceso avanzando la misma busqueda. Dos dueños escribiendo
// el mismo checkpoint es la unica forma de corromperlo; esta valla es lo que
// lo impide.
//
// Devuelve true si la fila sigue siendo nuestra (o si no hay base, o si la
// base tuvo un bache: ahi no se puede afirmar lo contrario y parar una
// busqueda por eso seria peor).
async function actualizar(trabajo) {
    if (!disponible()) return true;
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
                INSTANCIA,
                trabajo.phase ?? 'working',
                trabajo.resumeAt ? new Date(trabajo.resumeAt) : null,
                trabajo.rateLimitedRoute ?? null,
                // COALESCE: si este volcado no trae checkpoint, se conserva el
                // ultimo. Solo se manda cuando cambio (ver jobs.js).
                trabajo.checkpointPendiente ? JSON.stringify(trabajo.checkpointPendiente) : null,
            ],
            'jobs.snapshot'
        );
        return rowCount > 0;
    } catch (err) {
        // warn, no debug: un volcado fallido es un checkpoint que NO es
        // durable, y si el proceso muere ahora el trabajo no se podra
        // reanudar desde aqui. Tiene que verse. (La linea de pool.js ya trae
        // repositorio, operacion y SQLSTATE; esta añade el contexto del job.)
        logger.warn('No se pudo volcar el progreso del trabajo', {
            searchId: trabajo.searchId, phase: trabajo.phase ?? 'working',
            code: err?.code ?? null, detail: err?.message,
        });
        return true;
    }
}

// Cierre. Aqui SI se guarda el resultado entero, y se fija la caducidad: es la
// unica escritura grande de todo el ciclo y ocurre una vez.
async function terminar(trabajo) {
    if (!disponible()) return;
    try {
        await db.query(
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
                INSTANCIA,
            ],
            'jobs.finish'
        );
    } catch (err) {
        logger.warn('No se pudo persistir el resultado del trabajo', {
            searchId: trabajo.searchId, detail: err?.message,
        });
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

// ── Arranque: ADOPTAR lo reanudable, expirar solo lo que no lo es ────────────
//
// Un trabajo que estaba estacionado esperando a Roblox cuando su proceso murio
// NO es un huerfano que haya que dar por perdido: tiene su peticion y su
// checkpoint en la fila, y otra instancia puede seguir exactamente donde se
// quedo. Eso es lo que hace esta consulta, y lo hace ATOMICAMENTE: el UPDATE
// solo cambia de dueño las filas cuyo latido esta viejo, y devuelve las que
// cambio. Si dos replicas arrancan a la vez, cada fila la adopta UNA sola.
//
// Se limita a un puñado por pasada: adoptar significa arrancar una busqueda,
// y una instancia recien levantada no deberia arrancar cincuenta a la vez.
async function adoptarHuerfanos(limite = 8) {
    if (!disponible()) return [];
    try {
        const { rows } = await db.query(
            `UPDATE plugin_search_jobs
                SET instance_id = $1,
                    heartbeat_at = NOW(),
                    updated_at = NOW()
              WHERE search_id IN (
                    SELECT search_id
                      FROM plugin_search_jobs
                     WHERE status IN ('queued', 'running')
                       AND params IS NOT NULL
                       AND (heartbeat_at IS NULL
                            OR heartbeat_at < NOW() - (
                                CASE WHEN status = 'queued' THEN $3::bigint ELSE $2::bigint END
                                * INTERVAL '1 millisecond'))
                     ORDER BY created_at
                     LIMIT $4
                     FOR UPDATE SKIP LOCKED)
              RETURNING *`,
            [
                INSTANCIA,
                config.pluginJobs.heartbeatTimeoutMs,
                config.pluginJobs.queuedTimeoutMs,
                limite,
            ],
            'jobs.adopt'
        );
        if (rows.length > 0) {
            logger.info('Trabajos de busqueda adoptados de una instancia caida', {
                trabajos: rows.length,
                searchIds: rows.map(r => r.search_id).join(','),
            });
        }
        return rows.map(filaAJob);
    } catch (err) {
        logger.warn('No se pudieron adoptar los trabajos huerfanos', { code: err?.code ?? null, detail: err?.message });
        return [];
    }
}

// ── Arranque: nada puede quedarse 'running' para siempre ─────────────────────
//
// Un proceso que muere deja sus trabajos en curso escritos como 'running'. Sin
// esto, ese estado seria eterno y el plugin esperaria un resultado que no va a
// llegar nunca. Se comprueba por LATIDO y no por instancia: una replica viva
// sigue latiendo, asi que solo caen los que de verdad estan huerfanos — lo que
// hace este barrido seguro tambien con varias replicas arrancando a la vez.
//
// SOLO LOS NO REANUDABLES (sin `params`: filas anteriores a park/resume). Los
// que tienen peticion se ADOPTAN (ver adoptarHuerfanos), no se expiran.
//
// DOS PLAZOS, y no uno, porque son dos situaciones distintas. Un trabajo
// 'running' late en cada segmento: si deja de latir un par de minutos, esta
// muerto. Un trabajo 'queued' NO LATE — esperar turno es exactamente no hacer
// nada — y con presupuestos de hasta tres minutos, una espera legitima detras
// de una busqueda grande dura mas que el plazo de latido. Compartir reloj
// convertia esa espera en un 'expired' mentiroso.
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
                AND params IS NULL
                AND (heartbeat_at IS NULL
                     OR heartbeat_at < NOW() - (
                         CASE WHEN status = 'queued' THEN $3::bigint ELSE $2::bigint END
                         * INTERVAL '1 millisecond'))`,
            [
                config.pluginJobs.retentionMs,
                config.pluginJobs.heartbeatTimeoutMs,
                config.pluginJobs.queuedTimeoutMs,
            ],
            'jobs.expireOrphans'
        );
        if (rowCount > 0) {
            logger.warn('Trabajos de busqueda huerfanos marcados como expirados', { trabajos: rowCount });
        }
        return rowCount;
    } catch (err) {
        logger.warn('No se pudieron expirar los trabajos huerfanos', { detail: err?.message });
        return 0;
    }
}

// Recoleccion por caducidad. Un trabajo terminado se conserva lo justo para que
// el plugin recoja su resultado aunque haya habido un redeploy por medio; a
// partir de ahi es basura que solo engorda la tabla.
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
    disponible, crear, actualizar, terminar, leer, adoptarHuerfanos, expirarHuerfanos, limpiarVencidos,
    __instancia: INSTANCIA,
};
