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
                (search_id, group_id, status, requested, instance_id, heartbeat_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (search_id) DO NOTHING`,
            [trabajo.searchId, String(trabajo.groupId), trabajo.status, trabajo.target, INSTANCIA]
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
async function actualizar(trabajo) {
    if (!disponible()) return;
    try {
        await db.query(
            `UPDATE plugin_search_jobs
                SET status = $2,
                    found = $3,
                    candidates_examined = $4,
                    progress = $5,
                    started_at = COALESCE(started_at, $6),
                    updated_at = NOW(),
                    heartbeat_at = NOW(),
                    instance_id = $7
              WHERE search_id = $1`,
            [
                trabajo.searchId, trabajo.status,
                trabajo.progress?.found ?? 0,
                trabajo.progress?.candidatesExamined ?? 0,
                trabajo.progress ? JSON.stringify(trabajo.progress) : null,
                trabajo.startedAt ? new Date(trabajo.startedAt) : null,
                INSTANCIA,
            ]
        );
    } catch (err) {
        logger.debug('No se pudo volcar el progreso del trabajo', {
            searchId: trabajo.searchId, detail: err?.message,
        });
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
                    updated_at = NOW(),
                    heartbeat_at = NOW(),
                    completed_at = NOW(),
                    expires_at = NOW() + ($9::bigint * INTERVAL '1 millisecond')
              WHERE search_id = $1`,
            [
                trabajo.searchId, trabajo.status,
                trabajo.outfits?.length ?? 0,
                trabajo.stats?.candidatesExamined ?? 0,
                trabajo.stoppedBy ?? null,
                trabajo.progress ? JSON.stringify(trabajo.progress) : null,
                JSON.stringify({ outfits: trabajo.outfits ?? [], stats: trabajo.stats ?? null }),
                trabajo.error?.code ?? null,
                config.pluginJobs.retentionMs,
            ]
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
            `SELECT * FROM plugin_search_jobs WHERE search_id = $1`, [searchId]
        );
        return filaAJob(rows[0]);
    } catch (err) {
        logger.debug('No se pudo leer el trabajo de busqueda', { searchId, detail: err?.message });
        return null;
    }
}

// ── Arranque: nada puede quedarse 'running' para siempre ─────────────────────
//
// Un proceso que muere deja sus trabajos en curso escritos como 'running'. Sin
// esto, ese estado seria eterno y el plugin esperaria un resultado que no va a
// llegar nunca. Se comprueba por LATIDO y no por instancia: una replica viva
// sigue latiendo, asi que solo caen los que de verdad estan huerfanos — lo que
// hace este barrido seguro tambien con varias replicas arrancando a la vez.
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
                AND (heartbeat_at IS NULL
                     OR heartbeat_at < NOW() - ($2::bigint * INTERVAL '1 millisecond'))`,
            [config.pluginJobs.retentionMs, config.pluginJobs.heartbeatTimeoutMs]
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
            `DELETE FROM plugin_search_jobs WHERE expires_at IS NOT NULL AND expires_at < NOW()`
        );
        if (rowCount > 0) logger.info('Trabajos de busqueda vencidos eliminados', { trabajos: rowCount });
        return rowCount;
    } catch (err) {
        logger.debug('No se pudieron limpiar los trabajos vencidos', { detail: err?.message });
        return 0;
    }
}

module.exports = {
    disponible, crear, actualizar, terminar, leer, expirarHuerfanos, limpiarVencidos,
    __instancia: INSTANCIA,
};
