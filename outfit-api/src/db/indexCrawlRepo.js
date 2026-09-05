'use strict';

const db = require('./pool');
const logger = require('../observability/logger');

// EL RECORRIDO DEL WORKER: cursor durable, lease y cola por demanda.
//
// Tres cosas que podrian haber sido tres tablas y son una, porque las tres
// responden a la misma pregunta: que grupo toca ahora y por donde iba.
//
//   CURSOR   opaco de Roblox mas el offset dentro de esa pagina, igual que la
//            rotacion de busqueda. Es lo que hace que un reinicio no vuelva a
//            empezar por el principio.
//   LEASE    con caducidad. Dos instancias pueden arrancar a la vez; solo una
//            recorre un grupo. La otra coge otro grupo, no espera.
//   DEMANDA  `priority`, que sube cuando una busqueda se queda corta. Es lo que
//            hace que el worker indexe LO QUE SE BUSCA en vez de la whitelist
//            entera por orden de llegada.
//
// El cursor solo lo mueve quien tiene el lease. Sin ese vallado, dos instancias
// se pisarian el avance y la comunidad se recorreria a saltos.

const OP = {
    asegurar: 'indexCrawl.ensure',
    demanda: 'indexCrawl.demand',
    tomar: 'indexCrawl.lease',
    guardar: 'indexCrawl.save',
    renovar: 'indexCrawl.renew',
    soltar: 'indexCrawl.release',
    leer: 'indexCrawl.read',
    listar: 'indexCrawl.list',
};

function disponible() {
    return db.isConfigured();
}

function filaAEstado(fila) {
    if (!fila) return null;
    return {
        groupId: String(fila.group_id),
        sortOrder: fila.sort_order ?? 'Asc',
        cursor: fila.current_cursor ?? null,
        intraPageOffset: Number(fila.intra_page_offset ?? 0),
        cycle: Number(fila.cycle ?? 1),
        priority: Number(fila.priority ?? 0),
        demands: Number(fila.demands ?? 0),
        lastDemandAt: fila.last_demand_at ? new Date(fila.last_demand_at).getTime() : null,
        membersSeen: Number(fila.members_seen ?? 0),
        usersIndexed: Number(fila.users_indexed ?? 0),
        lastRunAt: fila.last_run_at ? new Date(fila.last_run_at).getTime() : null,
        lastFullPassAt: fila.last_full_pass_at ? new Date(fila.last_full_pass_at).getTime() : null,
        lastError: fila.last_error ?? null,
        leaseOwner: fila.lease_owner ?? null,
        leaseExpiresAt: fila.lease_expires_at ? new Date(fila.lease_expires_at).getTime() : null,
        enabled: fila.enabled !== false,
    };
}

async function asegurar(groupId) {
    if (!disponible()) return null;
    const { rows } = await db.query(
        `INSERT INTO plugin_index_crawl (group_id)
         VALUES ($1)
         ON CONFLICT (group_id) DO UPDATE SET group_id = EXCLUDED.group_id
         RETURNING *`,
        [String(groupId)],
        OP.asegurar
    );
    return filaAEstado(rows[0]);
}

// LA SEÑAL DE DEMANDA. La llama una busqueda que no junto lo que le pidieron:
// ese grupo necesita mas indice, y el worker tiene que ir alli antes que a
// ningun otro. `faltan` pondera cuanto: quedarse a uno no es lo mismo que
// quedarse a nueve.
//
// No lanza NUNCA. Es un efecto lateral de una busqueda que ya termino bien, y
// que se caiga la base no puede convertir un resultado bueno en un error.
async function registrarDemanda(groupId, { faltan = 1, peso = 1 } = {}) {
    if (!disponible()) return false;
    try {
        await db.query(
            `INSERT INTO plugin_index_crawl (group_id, priority, demands, last_demand_at)
             VALUES ($1, $2, 1, NOW())
             ON CONFLICT (group_id) DO UPDATE SET
                 priority       = LEAST(plugin_index_crawl.priority + $2, 10000),
                 demands        = plugin_index_crawl.demands + 1,
                 last_demand_at = NOW()`,
            [String(groupId), Math.max(1, Math.round(faltan * peso))],
            OP.demanda
        );
        return true;
    } catch (err) {
        logger.debug('No se pudo registrar la demanda de indexado', {
            operation: OP.demanda, groupId: String(groupId), sqlState: err?.code ?? null,
        });
        return false;
    }
}

// Coge el grupo mas necesitado que no tenga dueño vivo y le pone lease.
// FOR UPDATE SKIP LOCKED: dos instancias que arranquen a la vez cogen grupos
// DISTINTOS en vez de bloquearse la una a la otra.
//
// `soloConDemanda` es lo que impide recorrer la whitelist entera: sin demanda
// registrada, un grupo solo entra si nunca se ha recorrido o si ya tocaba su
// vuelta de refresco.
async function tomar(instancia, { leaseMs, refrescarCadaMs = null } = {}) {
    if (!disponible()) return null;

    const { rows } = await db.query(
        `WITH elegido AS (
             SELECT group_id
               FROM plugin_index_crawl
              WHERE enabled
                AND (lease_owner IS NULL OR lease_expires_at < NOW())
                AND (
                    priority > 0
                    OR last_run_at IS NULL
                    OR ($3::double precision IS NOT NULL
                        AND (last_full_pass_at IS NULL
                             OR last_full_pass_at < NOW() - ($3::double precision * INTERVAL '1 millisecond')))
                )
              ORDER BY priority DESC, last_run_at ASC NULLS FIRST
              LIMIT 1
                FOR UPDATE SKIP LOCKED
         )
         UPDATE plugin_index_crawl c
            SET lease_owner = $1,
                lease_expires_at = NOW() + ($2::double precision * INTERVAL '1 millisecond'),
                last_run_at = NOW()
           FROM elegido
          WHERE c.group_id = elegido.group_id
      RETURNING c.*`,
        [instancia, leaseMs, refrescarCadaMs],
        OP.tomar
    );

    return filaAEstado(rows[0]);
}

// Guarda el avance. VALLADO: si el lease ya no es nuestro, no escribe y
// devuelve false — quien lo tenga ahora esta moviendo ese mismo cursor, y
// escribir encima haria que la comunidad se recorriera a saltos.
async function guardarCursor(groupId, instancia, avance) {
    if (!disponible()) return false;
    const { rowCount } = await db.query(
        `UPDATE plugin_index_crawl
            SET current_cursor    = $3,
                intra_page_offset = $4,
                cycle             = $5,
                members_seen      = members_seen + $6,
                users_indexed     = users_indexed + $7,
                last_run_at       = NOW(),
                last_full_pass_at = CASE WHEN $8 THEN NOW() ELSE last_full_pass_at END,
                -- La demanda se consume con el trabajo hecho, no de golpe: un
                -- grupo muy pedido sigue teniendo prioridad en la vuelta
                -- siguiente hasta que de verdad se ha recorrido.
                priority          = GREATEST(0, priority - $9),
                lease_expires_at  = NOW() + ($10::double precision * INTERVAL '1 millisecond')
          WHERE group_id = $1 AND lease_owner = $2`,
        [
            String(groupId), instancia,
            avance.cursor ?? null,
            avance.intraPageOffset ?? 0,
            avance.cycle ?? 1,
            avance.membersSeen ?? 0,
            avance.usersIndexed ?? 0,
            avance.vueltaCompleta === true,
            avance.prioridadConsumida ?? 0,
            avance.leaseMs ?? 60_000,
        ],
        OP.guardar
    );
    return (rowCount ?? 0) > 0;
}

async function renovar(groupId, instancia, leaseMs) {
    if (!disponible()) return false;
    const { rowCount } = await db.query(
        `UPDATE plugin_index_crawl
            SET lease_expires_at = NOW() + ($3::double precision * INTERVAL '1 millisecond')
          WHERE group_id = $1 AND lease_owner = $2`,
        [String(groupId), instancia, leaseMs],
        OP.renovar
    );
    return (rowCount ?? 0) > 0;
}

// Suelta el lease. Se llama SIEMPRE al terminar un ciclo, tambien cuando algo
// fallo: un lease sin soltar deja el grupo congelado hasta que caduque.
async function soltar(groupId, instancia, { error = null } = {}) {
    if (!disponible()) return false;
    try {
        const { rowCount } = await db.query(
            `UPDATE plugin_index_crawl
                SET lease_owner = NULL,
                    lease_expires_at = NULL,
                    last_error = $3
              WHERE group_id = $1 AND lease_owner = $2`,
            [String(groupId), instancia, error ? String(error).slice(0, 200) : null],
            OP.soltar
        );
        return (rowCount ?? 0) > 0;
    } catch {
        return false;
    }
}

async function leer(groupId) {
    if (!disponible()) return null;
    const { rows } = await db.query(
        'SELECT * FROM plugin_index_crawl WHERE group_id = $1',
        [String(groupId)],
        OP.leer
    );
    return filaAEstado(rows[0]);
}

// Para /v1/metrics: los grupos que el worker esta atendiendo, mas pedidos
// primero. No devuelve la tabla entera a proposito.
async function listar({ limite = 10 } = {}) {
    if (!disponible()) return [];
    const { rows } = await db.query(
        `SELECT * FROM plugin_index_crawl
          WHERE enabled
          ORDER BY priority DESC, last_run_at DESC NULLS LAST
          LIMIT $1`,
        [limite],
        OP.listar
    );
    return rows.map(filaAEstado);
}

module.exports = {
    disponible,
    asegurar,
    registrarDemanda,
    tomar,
    guardarCursor,
    renovar,
    soltar,
    leer,
    listar,
};
