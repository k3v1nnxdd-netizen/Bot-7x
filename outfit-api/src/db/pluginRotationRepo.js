'use strict';

const crypto = require('crypto');
const db = require('./pool');
const config = require('../config');
const logger = require('../observability/logger');

// Persistencia de la rotacion por comunidad y del aprendizaje que alimenta la
// estimacion de tiempo. Es el UNICO modulo que escribe estas dos tablas.
//
// TODO AQUI DEGRADA A NULO SIN BASE DE DATOS. Este servicio lleva desde el
// primer dia funcionando sin Postgres — la API de outfits no depende de el — y
// esa propiedad no se rompe por añadir rotacion: sin DATABASE_URL, `cargar`
// devuelve null y la busqueda vuelve al muestreo aleatorio de siempre. Lo
// mismo si la base tiene un mal rato: se registra y se sigue, porque quedarse
// sin recordar por donde ibas es molesto, y dejar de responder no.

// Identidad de este proceso, para el lease. Cambia en cada arranque a
// proposito: tras un redeploy, el proceso nuevo no debe poder confundirse con
// el viejo al renovar o soltar un lease.
const DUEÑO = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

function disponible() {
    return db.isConfigured();
}

function filaARotacion(fila) {
    if (!fila) return null;
    return {
        groupId: fila.group_id,
        sortOrder: fila.sort_order,
        cursor: fila.current_cursor,
        intraPageOffset: fila.intra_page_offset,
        lastUserId: fila.last_user_id,
        cycle: fila.cycle_number,
        cursorResets: fila.cursor_resets,
    };
}

// ── Lease ────────────────────────────────────────────────────────────────────
//
// UNA sola sentencia atomica hace las tres cosas: crear la fila si es la
// primera busqueda de ese grupo, comprobar que nadie mas la tiene cogida, y
// cogerla. Hacerlo en tres pasos (leer, decidir, escribir) seria justo la
// carrera que hay que evitar: dos busquedas simultaneas leerian el mismo
// cursor y recorrerian el mismo segmento.
//
// El `WHERE` del ON CONFLICT es la pieza clave: si otro proceso tiene el lease
// y no ha caducado, no se actualiza nada y no vuelve ninguna fila. Quien no lo
// consigue NO espera — sigue en modo efimero (ver services/pluginSearch/
// rotation.js), porque bloquear una busqueda interactiva detras de otra es
// peor experiencia que recorrer la comunidad en otro orden.
const SQL_ADQUIRIR = `
    INSERT INTO plugin_group_rotation (group_id, sort_order, lease_owner, lease_expires_at)
    VALUES ($1, $2, $3, NOW() + ($4::bigint * INTERVAL '1 millisecond'))
    ON CONFLICT (group_id) DO UPDATE
        SET lease_owner = EXCLUDED.lease_owner,
            lease_expires_at = EXCLUDED.lease_expires_at
        WHERE plugin_group_rotation.lease_expires_at IS NULL
           OR plugin_group_rotation.lease_expires_at < NOW()
    RETURNING *
`;

// Devuelve el estado de rotacion con el lease ya cogido, o null si otro lo
// tiene (o si no hay base). Nunca lanza.
async function adquirir(groupId, sortOrderInicial) {
    if (!disponible()) return null;

    try {
        const { rows } = await db.query(SQL_ADQUIRIR, [
            String(groupId), sortOrderInicial, DUEÑO, config.pluginRotation.leaseMs,
        ]);
        if (rows.length === 0) return null; // lo tiene otra busqueda viva
        return { ...filaARotacion(rows[0]), owner: DUEÑO };
    } catch (err) {
        logger.warn('No se pudo tomar el lease de rotacion', {
            groupId: String(groupId), detail: err?.message,
        });
        return null;
    }
}

// Guarda el avance Y renueva el lease en la misma sentencia. Lo segundo
// importa tanto como lo primero: una busqueda larga que no renovara acabaria
// con el lease caducado a mitad y otra podria empezar a mover su cursor.
//
// El `WHERE lease_owner = $x` es lo que hace segura la escritura: si el lease
// se perdio (proceso reiniciado, caducidad), esta actualizacion no toca nada
// en vez de pisar el progreso de quien lo tenga ahora.
const SQL_GUARDAR = `
    UPDATE plugin_group_rotation
       SET current_cursor = $2,
           intra_page_offset = $3,
           last_user_id = $4,
           cycle_number = $5,
           cursor_resets = $6,
           lease_expires_at = NOW() + ($7::bigint * INTERVAL '1 millisecond'),
           updated_at = NOW()
     WHERE group_id = $1
       AND lease_owner = $8
`;

async function guardar(estado) {
    if (!disponible()) return false;

    try {
        const { rowCount } = await db.query(SQL_GUARDAR, [
            String(estado.groupId),
            estado.cursor,
            estado.intraPageOffset,
            estado.lastUserId,
            estado.cycle,
            estado.cursorResets,
            config.pluginRotation.leaseMs,
            estado.owner,
        ]);
        return rowCount > 0;
    } catch (err) {
        // Perder el progreso significa repetir un tramo en la siguiente
        // busqueda. Es molesto; tumbar la respuesta que el usuario esta
        // esperando lo es mucho mas.
        logger.warn('No se pudo persistir el avance de rotacion', {
            groupId: String(estado.groupId), detail: err?.message,
        });
        return false;
    }
}

// Suelta el lease dejando el avance ya guardado. Se llama SIEMPRE al terminar,
// haya ido bien o mal: si no, el grupo queda bloqueado hasta que caduque.
const SQL_SOLTAR = `
    UPDATE plugin_group_rotation
       SET lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
     WHERE group_id = $1 AND lease_owner = $2
`;

async function soltar(groupId, owner) {
    if (!disponible()) return;
    try {
        await db.query(SQL_SOLTAR, [String(groupId), owner]);
    } catch (err) {
        // Si esto falla, el lease caduca solo. No hay nada que arreglar aqui.
        logger.debug('No se pudo soltar el lease de rotacion', {
            groupId: String(groupId), detail: err?.message,
        });
    }
}

// Cuanto falta para que caduque el lease del grupo, en milisegundos.
//
// TRES RESPUESTAS DISTINTAS, y la diferencia importa:
//   0     -> el grupo esta LIBRE ahora mismo: reintentar de inmediato.
//   > 0   -> lo tiene alguien y le quedan esos ms: dormir hasta entonces.
//   null  -> NO SE SABE (la base no respondio). Es el caso peligroso: tratarlo
//            como "libre" convierte la espera en un bucle ocupado que
//            reintenta sin pausa. Quien llama tiene que esperar igualmente.
//
// Existe para un caso concreto y raro: varias replicas. Quien ya tiene el turno
// local pero se encuentra el lease cogido por otra instancia necesita saber
// CUANTO esperar para reintentar UNA vez, en vez de sondear. Es una consulta de
// lectura y solo se hace en ese camino.
async function esperaDelLease(groupId) {
    if (!disponible()) return null;
    try {
        const { rows } = await db.query(
            `SELECT GREATEST(0, EXTRACT(EPOCH FROM (lease_expires_at - NOW())) * 1000)::bigint AS espera
               FROM plugin_group_rotation
              WHERE group_id = $1 AND lease_expires_at IS NOT NULL AND lease_expires_at > NOW()`,
            [String(groupId)]
        );
        // Sin fila, o con el lease vencido o libre: el grupo esta disponible.
        if (rows.length === 0) return 0;
        return Number(rows[0].espera);
    } catch (err) {
        logger.debug('No se pudo consultar la caducidad del lease', {
            groupId: String(groupId), detail: err?.message,
        });
        return null;
    }
}

// Posicion GLOBAL en la cola de un grupo: cuantas busquedas hay esperando ese
// groupId ahora mismo, EN CUALQUIER INSTANCIA, mas uno.
//
// La cola no necesita tabla propia: los trabajos en estado 'queued' de
// plugin_search_jobs YA son la cola, y su `created_at` da el orden FIFO. Una
// tabla aparte seria un segundo sitio donde el mismo hecho podria contarse
// distinto.
//
// Se consulta BAJO DEMANDA (cuando el plugin pregunta), no en bucle, y quien la
// llama la cachea unos segundos: el numero cambia despacio y no merece una
// consulta por cada sondeo del plugin.
async function posicionGlobalEnCola(groupId) {
    if (!disponible()) return 1;
    try {
        const { rows } = await db.query(
            `SELECT COUNT(*)::int AS delante
               FROM plugin_search_jobs
              WHERE group_id = $1 AND status = 'queued'`,
            [String(groupId)]
        );
        return (rows[0]?.delante ?? 0) + 1;
    } catch (err) {
        logger.debug('No se pudo calcular la posicion en cola', {
            groupId: String(groupId), detail: err?.message,
        });
        return 1;
    }
}

// ── Aprendizaje por comunidad (EWMA) ─────────────────────────────────────────

async function leerStats(groupId) {
    if (!disponible()) return null;
    try {
        const { rows } = await db.query(
            `SELECT * FROM plugin_group_stats WHERE group_id = $1`, [String(groupId)]
        );
        if (rows.length === 0) return null;
        const fila = rows[0];
        return {
            acceptanceRate: fila.avg_acceptance_rate,
            candidateLatencyMs: fila.avg_candidate_latency_ms,
            candidatesPerResult: fila.avg_candidates_per_result,
            searchDurationMs: fila.avg_search_duration_ms,
            searchesCompleted: fila.searches_completed,
        };
    } catch (err) {
        logger.debug('No se pudieron leer las estadisticas del grupo', {
            groupId: String(groupId), detail: err?.message,
        });
        return null;
    }
}

// La EWMA se calcula EN SQL y no en JavaScript, a proposito: asi la lectura y
// la escritura son una sola sentencia atomica y dos busquedas que terminen a
// la vez no se pisan la media. COALESCE cubre la primera vez, donde no hay
// valor anterior con el que mezclar y el dato nuevo pasa tal cual.
const SQL_STATS = `
    INSERT INTO plugin_group_stats (
        group_id, avg_acceptance_rate, avg_candidate_latency_ms,
        avg_candidates_per_result, avg_search_duration_ms, searches_completed
    )
    VALUES ($1, $2, $3, $4, $5, 1)
    ON CONFLICT (group_id) DO UPDATE SET
        avg_acceptance_rate = COALESCE(plugin_group_stats.avg_acceptance_rate * (1 - $6) + $2 * $6, $2),
        avg_candidate_latency_ms = COALESCE(plugin_group_stats.avg_candidate_latency_ms * (1 - $6) + $3 * $6, $3),
        avg_candidates_per_result = COALESCE(plugin_group_stats.avg_candidates_per_result * (1 - $6) + $4 * $6, $4),
        avg_search_duration_ms = COALESCE(plugin_group_stats.avg_search_duration_ms * (1 - $6) + $5 * $6, $5),
        searches_completed = plugin_group_stats.searches_completed + 1,
        updated_at = NOW()
`;

async function registrarBusqueda(groupId, muestra) {
    if (!disponible()) return;

    // Una busqueda que no examino a nadie no enseña nada, y meterla arrastraria
    // las medias hacia cero sin motivo.
    if (!Number.isFinite(muestra.acceptanceRate) || muestra.candidatesExamined <= 0) return;

    try {
        await db.query(SQL_STATS, [
            String(groupId),
            muestra.acceptanceRate,
            muestra.candidateLatencyMs,
            muestra.candidatesPerResult,
            muestra.durationMs,
            config.pluginEta.ewmaAlpha,
        ]);
    } catch (err) {
        logger.debug('No se pudieron actualizar las estadisticas del grupo', {
            groupId: String(groupId), detail: err?.message,
        });
    }
}

module.exports = {
    disponible,
    adquirir,
    esperaDelLease,
    posicionGlobalEnCola,
    guardar,
    soltar,
    leerStats,
    registrarBusqueda,
    __owner: DUEÑO, // solo para los tests
};
