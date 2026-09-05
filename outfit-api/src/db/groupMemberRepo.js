'use strict';

const db = require('./pool');
const logger = require('../observability/logger');

// PERTENENCIA A LA COMUNIDAD.
//
// Quien esta en que grupo, cuando se le vio por ultima vez, y (a partir de la
// fase 3) cuando se le entrego por ultima vez. Es la tabla barata: se llena con
// las paginas de miembros, que no gastan la cuota de avatares.
//
// NADIE SE BORRA. Un usuario que deja de aparecer se marca con `left_at`, y si
// vuelve se le quita la marca. Borrarlo tiraria por la ventana el trabajo de
// haber resuelto su avatar, que vive en otra tabla y sigue siendo valido: la
// gente entra y sale de los grupos constantemente.

const OP = {
    registrar: 'groupMember.upsert',
    marcarBajas: 'groupMember.markLeft',
    contar: 'groupMember.count',
    entregar: 'groupMember.delivered',
};

function disponible() {
    return db.isConfigured();
}

// Registra una pagina de miembros de golpe. IDEMPOTENTE: repetir la misma
// pagina tras un reinicio no duplica nada ni pierde el avance, solo refresca
// `last_seen_at`. Es lo que permite al worker reintentar un tramo sin cuidado.
//
// Un miembro que reaparece pierde su `left_at`: volvio.
async function registrarPagina(groupId, miembros) {
    if (!disponible() || miembros.length === 0) return 0;

    const ids = miembros.map(m => String(m.userId));
    const nombres = miembros.map(m => m.username ?? null);

    try {
        const { rowCount } = await db.query(
            `INSERT INTO plugin_group_member (group_id, user_id, username, discovered_at, last_seen_at)
             SELECT $1, id, nombre, NOW(), NOW()
               FROM UNNEST($2::text[], $3::text[]) AS entrada(id, nombre)
             ON CONFLICT (group_id, user_id) DO UPDATE SET
                 username     = COALESCE(EXCLUDED.username, plugin_group_member.username),
                 last_seen_at = NOW(),
                 left_at      = NULL`,
            [String(groupId), ids, nombres],
            OP.registrar
        );
        return rowCount ?? 0;
    } catch (err) {
        logger.warn('No se pudo registrar la pagina de miembros', {
            operation: OP.registrar, groupId: String(groupId),
            miembros: miembros.length, sqlState: err?.code ?? null,
        });
        return 0;
    }
}

// Marca como bajas a quien no aparecio en la ultima vuelta COMPLETA. Se llama
// solo al cerrar un ciclo entero, nunca a mitad: a mitad de recorrido "no le he
// visto" significa "aun no he llegado a el", que no es lo mismo.
async function marcarBajas(groupId, desde) {
    if (!disponible()) return 0;
    const { rowCount } = await db.query(
        `UPDATE plugin_group_member
            SET left_at = NOW()
          WHERE group_id = $1
            AND left_at IS NULL
            AND last_seen_at < $2`,
        [String(groupId), new Date(desde)],
        OP.marcarBajas
    );
    return rowCount ?? 0;
}

async function contar(groupId) {
    if (!disponible()) return { miembros: 0, bajas: 0 };
    const { rows } = await db.query(
        `SELECT COUNT(*) FILTER (WHERE left_at IS NULL)::int AS activos,
                COUNT(*) FILTER (WHERE left_at IS NOT NULL)::int AS bajas
           FROM plugin_group_member WHERE group_id = $1`,
        [String(groupId)],
        OP.contar
    );
    return { miembros: Number(rows[0]?.activos ?? 0), bajas: Number(rows[0]?.bajas ?? 0) };
}

// Sella la entrega. NO SE USA TODAVIA: el POST no lee el indice hasta la fase
// 3. Vive aqui desde ahora para que la columna y su semantica sean una sola
// decision y no dos, tomadas con meses de diferencia.
async function marcarEntregados(groupId, userIds) {
    if (!disponible() || userIds.length === 0) return 0;
    const { rowCount } = await db.query(
        `UPDATE plugin_group_member
            SET last_delivered_at = NOW(), deliveries = deliveries + 1
          WHERE group_id = $1 AND user_id = ANY($2::text[])`,
        [String(groupId), userIds.map(String)],
        OP.entregar
    );
    return rowCount ?? 0;
}

module.exports = {
    disponible,
    registrarPagina,
    marcarBajas,
    contar,
    marcarEntregados,
};
