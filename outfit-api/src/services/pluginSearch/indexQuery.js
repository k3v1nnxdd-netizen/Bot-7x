'use strict';

const db = require('../../db/pool');
const config = require('../../config');
const logger = require('../../observability/logger');
const requestContext = require('../../observability/requestContext');

// SERVIR UNA BUSQUEDA DESDE POSTGRES.
//
// Con INDEX_SERVE_ENABLED=true esto es TODO lo que hace un POST del plugin: una
// transaccion, y la respuesta. No llama a Roblox. Ni al avatar, ni al catalogo,
// ni como respaldo si el indice se queda corto.
//
// Ese respaldo automatico es exactamente el fallo que esta arquitectura existe
// para eliminar: era lo que convertia "faltan seis outfits" en una espera de
// una hora contra una ruta que Roblox tenia cerrada. Si Postgres no puede
// responder, la respuesta es un 503 honesto y el plugin lo dice; nunca una
// busqueda en vivo por la puerta de atras.
//
// POR QUE UNA TRANSACCION Y NO DOS CONSULTAS. Entre elegir a los diez usuarios
// y marcarlos como entregados hay una ventana, y dos busquedas simultaneas del
// mismo grupo caerian las dos en ella y devolverian LA MISMA gente.
// `FOR UPDATE OF m SKIP LOCKED` cierra esa ventana: la primera bloquea sus
// filas, la segunda las salta y se lleva las siguientes. Ni esperan ni chocan.

const OP = 'indexQuery.serve';

class IndiceNoDisponibleError extends Error {
    constructor(causa) {
        super('El indice de outfits no esta disponible');
        this.name = 'IndiceNoDisponibleError';
        this.code = 'index_unavailable';
        this.status = 503;
        this.causa = causa ?? null;
    }
}

function filaAOutfit(fila) {
    return {
        userId: Number(fila.user_id),
        username: fila.username ?? null,
        totalPrice: Number(fila.total_price ?? 0),
        priceComplete: fila.price_complete === true,
        pricedItems: Number(fila.priced_items ?? 0),
        unpricedItems: Number(fila.unpriced_items ?? 0),
        limitedItems: Number(fila.limited_items ?? 0),
        offSaleItems: Number(fila.off_sale_items ?? 0),
        bundledItems: Number(fila.bundled_items ?? 0),
    };
}

// Sirve `amount` outfits del grupo y los marca como entregados, todo dentro de
// una transaccion. Devuelve { outfits, coverage }.
async function servir({
    groupId, amount, minPrice, maxPrice, requireCompletePrice,
}) {
    if (!db.isConfigured()) throw new IndiceNoDisponibleError('sin base de datos');

    const minAccesorios = config.pluginSearch.minAccessories;
    const arranque = Date.now();

    try {
        return await db.withTransaction(async q => {
            // ── 1. Elegir y BLOQUEAR ────────────────────────────────────────
            //
            // El orden de entrega es `last_delivered_at NULLS FIRST`: quien
            // nunca salio va primero, y luego el que lleva mas tiempo sin
            // salir. `user_id` desempata para que el orden sea ESTABLE — sin
            // desempate, dos filas con la misma fecha podrian alternarse entre
            // ejecuciones y el resultado dejaria de ser reproducible.
            //
            // El bloqueo es `OF m`: se bloquean las filas de PERTENENCIA, que
            // son las que se van a actualizar. La fila del avatar se lee y no
            // se toca, y bloquearla estorbaria al worker sin ganar nada.
            const { rows } = await q(
                `SELECT m.user_id, a.username,
                        a.total_price, a.price_complete, a.priced_items, a.unpriced_items,
                        a.limited_items, a.off_sale_items, a.bundled_items
                   FROM plugin_group_member m
                   JOIN roblox_user_avatar a ON a.user_id = m.user_id
                  WHERE m.group_id = $1
                    AND m.left_at IS NULL
                    AND a.state = 'valid'
                    AND a.accessories >= $2
                    AND a.total_price IS NOT NULL
                    AND a.total_price >= $3
                    AND ($4::bigint IS NULL OR a.total_price <= $4)
                    AND ($5::boolean IS FALSE OR a.price_complete IS TRUE)
                  ORDER BY m.last_delivered_at ASC NULLS FIRST, m.user_id ASC
                  LIMIT $6
                    FOR UPDATE OF m SKIP LOCKED`,
                [
                    String(groupId), minAccesorios,
                    minPrice ?? 0,
                    maxPrice ?? null,
                    requireCompletePrice === true,
                    amount,
                ]
            );

            const outfits = rows.map(filaAOutfit);

            // ── 2. Sellar la entrega, EN LA MISMA TRANSACCION ───────────────
            // Es lo que hace que la siguiente busqueda no repita a nadie, y lo
            // que hace que dos simultaneas no se pisen.
            if (outfits.length > 0) {
                await q(
                    `UPDATE plugin_group_member
                        SET last_delivered_at = NOW(), deliveries = deliveries + 1
                      WHERE group_id = $1 AND user_id = ANY($2::text[])`,
                    [String(groupId), rows.map(f => String(f.user_id))]
                );
            }

            // ── 3. Si faltan, se pide mas indice ────────────────────────────
            // Tambien aqui dentro: la demanda es consecuencia de esta entrega y
            // no debe perderse si algo falla despues.
            const faltan = amount - outfits.length;
            if (faltan > 0) {
                await q(
                    `INSERT INTO plugin_index_crawl (group_id, priority, demands, last_demand_at)
                     VALUES ($1, $2, 1, NOW())
                     ON CONFLICT (group_id) DO UPDATE SET
                         priority       = LEAST(plugin_index_crawl.priority + $2, 10000),
                         demands        = plugin_index_crawl.demands + 1,
                         last_demand_at = NOW()`,
                    [String(groupId), Math.min(faltan, 10000)]
                );
            }

            // ── 4. La foto de la comunidad, para el plugin ──────────────────
            //
            // EL DENOMINADOR ES "MIEMBROS CONOCIDOS", y significa exactamente
            // una cosa: cuantos usuarios DISTINTOS de este grupo tenemos en la
            // tabla de pertenencia sin marca de baja. Ni paginas recorridas, ni
            // filas vistas, ni nada acumulado.
            //
            // Antes era un COUNT(*) sobre un LEFT JOIN. Con la clave primaria
            // actual no habia duplicados, pero contaba FILAS DE UN JOIN y no
            // usuarios, que es una forma fragil de contar lo que el plugin
            // enseña. Aqui cada numero es su propio COUNT(DISTINCT user_id),
            // sin join que pueda multiplicarlo.
            const { rows: fotoFilas } = await q(
                `SELECT
                     (SELECT COUNT(DISTINCT user_id)
                        FROM plugin_group_member
                       WHERE group_id = $1 AND left_at IS NULL)::int AS conocidos,
                     (SELECT COUNT(DISTINCT m.user_id)
                        FROM plugin_group_member m
                        JOIN roblox_user_avatar a ON a.user_id = m.user_id
                       WHERE m.group_id = $1 AND m.left_at IS NULL)::int AS indexados,
                     (SELECT COUNT(DISTINCT m.user_id)
                        FROM plugin_group_member m
                        JOIN roblox_user_avatar a ON a.user_id = m.user_id
                       WHERE m.group_id = $1 AND m.left_at IS NULL
                         AND a.state = 'valid' AND a.accessories >= $2)::int AS elegibles`,
                [String(groupId), minAccesorios]
            );

            const foto = fotoFilas[0] ?? {};
            const conocidos = Number(foto.conocidos ?? 0);
            const indexados = Number(foto.indexados ?? 0);

            return {
                outfits,
                coverage: {
                    // `members` se conserva con ese nombre porque es el que lee
                    // el plugin instalado; `knownMembers` es el nombre honesto
                    // de lo mismo y el que debe usarse de aqui en adelante.
                    members: conocidos,
                    knownMembers: conocidos,
                    indexed: indexados,
                    eligible: Number(foto.elegibles ?? 0),
                    ratio: conocidos > 0 ? Number((indexados / conocidos).toFixed(4)) : 0,
                },
                tookMs: Date.now() - arranque,
            };
        });
    } catch (err) {
        // Cualquier fallo de Postgres es un 503. NUNCA un respaldo a Roblox.
        logger.warn('No se pudo servir la busqueda desde el indice', {
            requestId: requestContext.requestId(),
            operation: OP, groupId: String(groupId),
            sqlState: err?.code ?? null, detail: err?.message,
        });
        throw new IndiceNoDisponibleError(err?.code ?? err?.message ?? null);
    }
}

module.exports = { servir, IndiceNoDisponibleError };
