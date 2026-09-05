'use strict';

const db = require('./pool');
const config = require('../config');
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
    pausar: 'indexCrawl.pause',
    reanudar: 'indexCrawl.resume',
    listarTodas: 'indexCrawl.listAll',
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
        cycleStartedAt: fila.cycle_started_at ? new Date(fila.cycle_started_at).getTime() : null,
        lapClean: fila.lap_clean === true,
        lastError: fila.last_error ?? null,
        leaseOwner: fila.lease_owner ?? null,
        leaseExpiresAt: fila.lease_expires_at ? new Date(fila.lease_expires_at).getTime() : null,
        enabled: fila.enabled !== false,
        pausedAt: fila.paused_at ? new Date(fila.paused_at).getTime() : null,
        pausedReason: fila.paused_reason ?? null,
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
//
// SOBRE UNA COMUNIDAD CANCELADA NO HACE NADA. El `WHERE` del ON CONFLICT es lo
// que garantiza que buscar en ella no la reactive por la puerta de atras: sin
// el, cada busqueda le subiria la prioridad en silencio y quedaria la primera
// de la cola el dia que alguien la reanudara. Reactivar una comunidad es una
// decision de quien la cancelo, y solo se toma desde el endpoint de reanudar.
// LA SENTENCIA, en un solo sitio. Se exporta porque la transaccion que sirve
// las busquedas la necesita por dentro, con su propio cliente, y no puede
// llamar a esta funcion. Tenerla escrita dos veces ya salio mal una vez: la
// guarda de pausa se anadio a una copia y la otra —la que de verdad corre en
// produccion— se quedo sin ella.
const SQL_DEMANDA = `INSERT INTO plugin_index_crawl (group_id, priority, demands, last_demand_at)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (group_id) DO UPDATE SET
         priority       = LEAST(plugin_index_crawl.priority + $2, 10000),
         demands        = plugin_index_crawl.demands + 1,
         last_demand_at = NOW()
       WHERE plugin_index_crawl.paused_at IS NULL`;

async function registrarDemanda(groupId, { faltan = 1, peso = 1 } = {}) {
    if (!disponible()) return false;
    try {
        const { rowCount } = await db.query(
            SQL_DEMANDA,
            [String(groupId), Math.max(1, Math.round(faltan * peso))],
            OP.demanda
        );
        return (rowCount ?? 0) > 0;
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
async function tomar(instancia, { leaseMs, refrescarCadaMs = null, revisitarCadaMs = null } = {}) {
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
                    -- REVISITA. Sin esta condicion, un grupo a medio indexar y
                    -- sin demanda dejaba de elegirse hasta la siguiente vuelta
                    -- completa (dias), y el worker se quedaba sin trabajo que
                    -- hacer teniendo cientos de usuarios sin mirar.
                    OR ($4::double precision IS NOT NULL
                        AND last_run_at < NOW() - ($4::double precision * INTERVAL '1 millisecond'))
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
        [instancia, leaseMs, refrescarCadaMs, revisitarCadaMs],
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
                cycle_started_at  = CASE WHEN $11::bigint IS NULL THEN cycle_started_at
                                         ELSE to_timestamp($11::bigint / 1000.0) END,
                -- Una comunidad cancelada NO puede acabar con la vuelta dada
                -- por limpia. El ciclo que ya estaba en marcha cuando llego la
                -- cancelacion termina de escribir su avance —el cursor se
                -- conserva, que es lo que se prometio— pero su veredicto sobre
                -- la vuelta se descarta. Sin este CASE, ese ultimo ciclo podia
                -- pisar con TRUE el FALSE que puso la cancelacion, y al
                -- reanudar se marcarian como bajas miembros que nadie llego a
                -- recorrer.
                lap_clean         = CASE WHEN paused_at IS NULL THEN $12 ELSE FALSE END,
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
            avance.cycleStartedAt ?? null,
            avance.lapClean === true,
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

// ── ADMINISTRACION POR COMUNIDAD ────────────────────────────────────────────
//
// Cuatro operaciones que hace una persona desde el plugin, y que hay que
// distinguir con cuidado porque tres de ellas se parecen y una es destructiva:
//
//   PAUSAR    el worker deja de elegir esa comunidad. No se borra NADA: ni
//             cursor, ni miembros, ni avatares, ni precios. Vive en Postgres,
//             asi que sigue pausada despues de un redeploy.
//   REANUDAR  vuelve a la cola por donde iba. No empieza de cero.
//   ELIMINAR  borra el progreso PROPIO de esa comunidad. Lo global no se toca.
//   LISTAR    todas, pausadas incluidas, con sus contadores.

// Cancela la indexacion de una comunidad.
//
// Hace tres cosas en una sola sentencia, y las tres importan:
//   1. `enabled = FALSE` la saca de la seleccion del worker. No hace falta
//      tocar el SQL de `tomar`: ya filtraba por `enabled`, y su indice parcial
//      tambien. La forma mas segura de anadir un filtro es no anadirlo.
//   2. `lap_clean = FALSE` tira la autorizacion para marcar bajas. Una vuelta
//      interrumpida a la mitad NO es una vuelta completa, y dejarla marcada
//      como limpia haria que al reanudar se diera de baja a todo el que aun no
//      se habia recorrido.
// LO QUE NO HACE, y es deliberado: soltar el lease. Soltarlo parecia limpieza
// y era perdida de datos — `guardarCursor` esta vallado por `lease_owner`, asi
// que el ciclo que estuviera en marcha habria escrito cero filas y se habrian
// perdido su cursor, su ciclo, su marca de agua y sus contadores. Dejandolo, ese
// ciclo termina y guarda su avance con normalidad, y `tomar` no la vuelve a
// coger porque filtra por `enabled`.
//
// Tampoco borra el cursor, el ciclo, los miembros ni la prioridad acumulada.
// Todo eso es el progreso que se prometio conservar.
async function pausar(groupId, { motivo = null } = {}) {
    if (!disponible()) return null;
    const { rows } = await db.query(
        `UPDATE plugin_index_crawl
            SET enabled          = FALSE,
                paused_at        = COALESCE(paused_at, NOW()),
                paused_reason    = $2,
                lap_clean        = FALSE
          WHERE group_id = $1
      RETURNING *`,
        [String(groupId), motivo ? String(motivo).slice(0, 200) : null],
        OP.pausar
    );
    return filaAEstado(rows[0]);
}

// Reanuda. Vuelve a ser elegible y continua desde el cursor que tenia.
//
// `lap_clean` se queda en FALSE a proposito: la vuelta que estaba en curso
// cuando se canceló sigue sin ser de fiar, y solo volvera a ser limpia cuando
// el crawler empiece una nueva desde el principio. Reanudar devuelve el
// trabajo a la cola; no reescribe la historia de lo que se recorrio.
async function reanudar(groupId) {
    if (!disponible()) return null;
    const { rows } = await db.query(
        `UPDATE plugin_index_crawl
            SET enabled       = TRUE,
                paused_at     = NULL,
                paused_reason = NULL
          WHERE group_id = $1
      RETURNING *`,
        [String(groupId)],
        OP.reanudar
    );
    return filaAEstado(rows[0]);
}

// Borra el progreso PROPIO de una comunidad. Es la unica operacion destructiva
// de este archivo y se comporta como tal.
//
// LO QUE SE BORRA es lo que solo tiene sentido dentro de esa comunidad: su
// recorrido, su pertenencia, su rotacion de entrega y sus estadisticas. Los
// trabajos de busqueda vivos se retiran antes, para que ninguno siga
// escribiendo sobre una comunidad que ya no existe.
//
// LO QUE NO SE BORRA, Y ES LA PARTE IMPORTANTE: `roblox_user_avatar` y
// `roblox_asset_catalog` son GLOBALES. Un usuario esta en varias comunidades y
// un asset lo llevan miles de usuarios. Borrarlos aqui destruiria trabajo
// ajeno para siempre y a cambio de nada: son exactamente los datos que mas
// cuesta reconstruir, porque cada uno costo una llamada a Roblox contra una
// cuota de tres por segundo.
//
// Se CUENTAN los avatares que quedan huerfanos —sin ninguna pertenencia viva—
// y se devuelve el numero, pero no se tocan. Un huerfano no molesta a nadie y
// mañana puede dejar de serlo con solo que ese usuario entre en otro grupo.
async function eliminar(groupId) {
    if (!disponible()) return null;
    const id = String(groupId);

    return db.withTransaction(async q => {
        // Se cierra el paso ANTES de borrar: el worker pudo coger esta
        // comunidad hace un instante y estar a mitad de un ciclo. Al apagarla
        // y soltarle el lease dentro de la transaccion, lo que ese ciclo
        // escriba despues no encontrara fila que actualizar y se quedara en
        // cero filas tocadas, que es exactamente lo que tiene que pasar.
        await q(
            `UPDATE plugin_index_crawl
                SET enabled = FALSE, lap_clean = FALSE,
                    lease_owner = NULL, lease_expires_at = NULL
              WHERE group_id = $1`,
            [id]
        );

        // Trabajos de busqueda vivos de esta comunidad: se retiran, no se
        // borran. Un plugin que este sondeando uno merece una respuesta con
        // sentido en vez de un 404 a secas.
        const trabajos = await q(
            `UPDATE plugin_search_jobs
                SET status = 'expired', stopped_by = 'expired', error_code = 'group_deleted',
                    instance_id = NULL, updated_at = NOW(), completed_at = NOW(),
                    -- CON FECHA DE CADUCIDAD, como todas las demas retiradas.
                    -- El recolector borra por expires_at; sin ponerlo, estas
                    -- filas serian las unicas de la tabla que no caducan nunca.
                    expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond')
              WHERE group_id = $1 AND status IN ('queued', 'running')`,
            [id, config.pluginJobs.retentionMs]
        );

        const { rows: huerfanos } = await q(
            `SELECT COUNT(*)::int AS n
               FROM roblox_user_avatar a
              WHERE EXISTS (SELECT 1 FROM plugin_group_member m
                             WHERE m.user_id = a.user_id AND m.group_id = $1)
                AND NOT EXISTS (SELECT 1 FROM plugin_group_member m
                                 WHERE m.user_id = a.user_id AND m.group_id <> $1
                                   AND m.left_at IS NULL)`,
            [id]
        );

        const miembros = await q('DELETE FROM plugin_group_member WHERE group_id = $1', [id]);
        await q('DELETE FROM plugin_group_rotation WHERE group_id = $1', [id]);
        await q('DELETE FROM plugin_group_stats WHERE group_id = $1', [id]);
        const recorrido = await q('DELETE FROM plugin_index_crawl WHERE group_id = $1', [id]);

        return {
            groupId: id,
            existia: (recorrido.rowCount ?? 0) > 0,
            miembrosBorrados: miembros.rowCount ?? 0,
            trabajosRetirados: trabajos.rowCount ?? 0,
            // Avatares que se quedan sin ninguna comunidad. NO se borran: se
            // informan para que quien mire sepa que hay y decida, en vez de
            // que un borrado en cascada se lleve por delante trabajo global.
            avataresHuerfanos: Number(huerfanos[0]?.n ?? 0),
        };
    });
}

// TODAS las comunidades conocidas, pausadas incluidas, con sus contadores.
//
// Es la consulta que alimenta el panel, asi que se sondea cada pocos segundos:
// va en UNA sola consulta y solo lee. No escribe `last_delivered_at`, no toca
// la rotacion, no sube prioridad y no llama a Roblox. Mirar un panel no puede
// cambiar lo que el panel esta mirando.
async function listarTodas({ limite = 100, minAccessories = 0 } = {}) {
    if (!disponible()) return [];
    const { rows } = await db.query(
        `SELECT c.*, w.group_name,
                COALESCE(m.conocidos, 0)  AS conocidos,
                COALESCE(m.indexados, 0)  AS indexados,
                COALESCE(m.elegibles, 0)  AS elegibles
           FROM plugin_index_crawl c
           -- El nombre sale de la licencia si la hay. Un LEFT JOIN: una
           -- comunidad puede estar indexandose sin figurar ahi, y en ese caso
           -- se enseña el numero, que es lo unico que se sabe de ella.
           LEFT JOIN group_whitelist w ON w.group_id = c.group_id
           LEFT JOIN LATERAL (
                SELECT COUNT(DISTINCT m.user_id)::int AS conocidos,
                       COUNT(DISTINCT m.user_id) FILTER (WHERE a.user_id IS NOT NULL)::int AS indexados,
                       COUNT(DISTINCT m.user_id) FILTER (
                           WHERE a.state = 'valid' AND a.accessories >= $2
                       )::int AS elegibles
                  FROM plugin_group_member m
                  LEFT JOIN roblox_user_avatar a ON a.user_id = m.user_id
                 WHERE m.group_id = c.group_id AND m.left_at IS NULL
           ) m ON TRUE
          ORDER BY (c.paused_at IS NULL), c.priority DESC, c.last_run_at DESC NULLS LAST
          LIMIT $1`,
        [limite, minAccessories],
        OP.listarTodas
    );
    return rows.map(fila => ({
        ...filaAEstado(fila),
        groupName: fila.group_name ?? null,
        knownMembers: Number(fila.conocidos ?? 0),
        indexed: Number(fila.indexados ?? 0),
        eligible: Number(fila.elegibles ?? 0),
    }));
}

module.exports = {
    SQL_DEMANDA,
    disponible,
    asegurar,
    registrarDemanda,
    tomar,
    guardarCursor,
    renovar,
    soltar,
    leer,
    listar,
    pausar,
    reanudar,
    eliminar,
    listarTodas,
};
