'use strict';

const db = require('./pool');
const logger = require('../observability/logger');

// EL INDICE DE AVATARES RESUELTOS.
//
// Guarda lo que hoy cuesta una llamada a Roblox por miembro: que lleva puesto
// alguien y cuanto vale. Una fila por USUARIO, no por grupo.
//
// Dos reglas gobiernan todo lo que hay aqui, y las dos existen porque el
// enemigo de este indice no es la falta de datos sino los datos falsos:
//
//   1. UN 429 NO ES UN DATO. Roblox frenandonos no dice nada sobre el avatar de
//      nadie. Ninguna funcion de este modulo se llama cuando Roblox limita, y
//      ninguna degrada una fila por un fallo de red: el worker simplemente no
//      escribe. Lo que ya estaba sigue estando.
//   2. UN TTL VENCIDO NO BORRA. Vencer solo cambia el ORDEN en que el worker
//      refresca (ver `pendientes`). Una fila vieja se sigue sirviendo; lo unico
//      que se pierde con el tiempo es la certeza sobre el precio, y esa se
//      recupera refrescando, no tirando la fila.

const OP = {
    upsert: 'avatarIndex.upsert',
    leer: 'avatarIndex.read',
    pendientes: 'avatarIndex.pending',
    cobertura: 'avatarIndex.coverage',
    error: 'avatarIndex.error',
};

// Estados posibles de una fila. NO existe 'too_few_accessories': el minimo de
// accesorios es configurable y se aplica AL CONSULTAR, sobre la columna
// `accessories`. Guardarlo como estado obligaria a reindexar la comunidad
// entera por cambiar una variable de entorno.
const ESTADO = {
    VALIDO: 'valid',
    AVATAR_VACIO: 'empty_avatar',
    NO_EXISTE: 'not_found',
    SIN_PRECIO: 'unpriceable',
};

const ESTADOS = new Set(Object.values(ESTADO));

function disponible() {
    return db.isConfigured();
}

function filaARegistro(fila) {
    if (!fila) return null;
    return {
        userId: String(fila.user_id),
        username: fila.username ?? null,
        state: fila.state,
        assetIds: Array.isArray(fila.asset_ids) ? fila.asset_ids.map(String) : [],
        assetTypeIds: Array.isArray(fila.asset_type_ids) ? fila.asset_type_ids.map(Number) : [],
        accessories: Number(fila.accessories ?? 0),
        playerAvatarType: fila.player_avatar_type ?? null,
        avatarFetchedAt: fila.avatar_fetched_at ? new Date(fila.avatar_fetched_at).getTime() : null,
        totalPrice: fila.total_price === null || fila.total_price === undefined ? null : Number(fila.total_price),
        priceComplete: fila.price_complete ?? null,
        pricedItems: fila.priced_items ?? null,
        unpricedItems: fila.unpriced_items ?? null,
        limitedItems: fila.limited_items ?? null,
        offSaleItems: fila.off_sale_items ?? null,
        bundledItems: fila.bundled_items ?? null,
        pricedAt: fila.priced_at ? new Date(fila.priced_at).getTime() : null,
        pricingVersion: Number(fila.pricing_version ?? 1),
        consecutiveErrors: Number(fila.consecutive_errors ?? 0),
        lastError: fila.last_error ?? null,
        updatedAt: fila.updated_at ? new Date(fila.updated_at).getTime() : null,
    };
}

// Escribe (o reescribe) lo que se sabe de un usuario. IDEMPOTENTE: llamarla dos
// veces con los mismos datos deja exactamente la misma fila, y por eso el worker
// puede reintentar un tramo entero tras un reinicio sin pensarselo.
//
// `valoracion` es null cuando el usuario no llego a valorarse (avatar vacio,
// borrado). En ese caso las columnas de precio se dejan como estaban en vez de
// ponerlas a NULL: si ayer sabiamos cuanto valia y hoy Roblox no nos deja
// mirarlo, lo de ayer sigue siendo mejor que nada.
async function upsert({
    userId, username = null, state,
    assetIds = [], assetTypeIds = [], accessories = 0, playerAvatarType = null,
    valoracion = null, pricingVersion = 1,
}) {
    if (!disponible()) return false;
    if (!ESTADOS.has(state)) throw new Error(`Estado desconocido para el indice: ${state}`);

    const conPrecio = valoracion !== null;

    try {
        await db.query(
            `INSERT INTO roblox_user_avatar (
                 user_id, username, state,
                 asset_ids, asset_type_ids, accessories, player_avatar_type,
                 avatar_fetched_at,
                 total_price, price_complete, priced_items, unpriced_items,
                 limited_items, off_sale_items, bundled_items, priced_at,
                 pricing_version, consecutive_errors, last_error, updated_at
             ) VALUES (
                 $1, $2, $3,
                 $4::jsonb, $5::jsonb, $6, $7,
                 NOW(),
                 $8, $9, $10, $11,
                 $12, $13, $14, CASE WHEN $15 THEN NOW() ELSE NULL END,
                 $16, 0, NULL, NOW()
             )
             ON CONFLICT (user_id) DO UPDATE SET
                 username           = COALESCE(EXCLUDED.username, roblox_user_avatar.username),
                 state              = EXCLUDED.state,
                 asset_ids          = EXCLUDED.asset_ids,
                 asset_type_ids     = EXCLUDED.asset_type_ids,
                 accessories        = EXCLUDED.accessories,
                 player_avatar_type = EXCLUDED.player_avatar_type,
                 avatar_fetched_at  = NOW(),
                 -- El precio SOLO se pisa cuando hay valoracion nueva. Sin ella
                 -- se conserva la anterior: un dato viejo vale mas que un NULL.
                 total_price    = CASE WHEN $15 THEN EXCLUDED.total_price    ELSE roblox_user_avatar.total_price END,
                 price_complete = CASE WHEN $15 THEN EXCLUDED.price_complete ELSE roblox_user_avatar.price_complete END,
                 priced_items   = CASE WHEN $15 THEN EXCLUDED.priced_items   ELSE roblox_user_avatar.priced_items END,
                 unpriced_items = CASE WHEN $15 THEN EXCLUDED.unpriced_items ELSE roblox_user_avatar.unpriced_items END,
                 limited_items  = CASE WHEN $15 THEN EXCLUDED.limited_items  ELSE roblox_user_avatar.limited_items END,
                 off_sale_items = CASE WHEN $15 THEN EXCLUDED.off_sale_items ELSE roblox_user_avatar.off_sale_items END,
                 bundled_items  = CASE WHEN $15 THEN EXCLUDED.bundled_items  ELSE roblox_user_avatar.bundled_items END,
                 priced_at      = CASE WHEN $15 THEN NOW() ELSE roblox_user_avatar.priced_at END,
                 pricing_version    = EXCLUDED.pricing_version,
                 consecutive_errors = 0,
                 last_error         = NULL,
                 updated_at         = NOW()`,
            [
                String(userId), username, state,
                JSON.stringify(assetIds.map(String)),
                JSON.stringify(assetTypeIds.map(Number)),
                accessories, playerAvatarType,
                conPrecio ? valoracion.totalPrice : null,
                conPrecio ? valoracion.priceComplete : null,
                conPrecio ? valoracion.pricedItems : null,
                conPrecio ? valoracion.unpricedItems : null,
                conPrecio ? valoracion.limitedItems : null,
                conPrecio ? valoracion.offSaleItems : null,
                conPrecio ? valoracion.bundledItems : null,
                conPrecio,
                pricingVersion,
            ],
            OP.upsert
        );
        return true;
    } catch (err) {
        logger.warn('No se pudo escribir en el indice de avatares', {
            operation: OP.upsert, userId: String(userId), sqlState: err?.code ?? null,
        });
        return false;
    }
}

// Deja constancia de un fallo SIN tocar los datos. Es la unica escritura que
// ocurre cuando algo va mal, y no cambia ni el estado ni el avatar ni el
// precio: solo cuenta. Nunca se llama para un 429 — un limite de Roblox no es
// un fallo del usuario y no merece ni este contador.
async function anotarError(userId, detalle) {
    if (!disponible()) return false;
    try {
        await db.query(
            `UPDATE roblox_user_avatar
                SET consecutive_errors = consecutive_errors + 1,
                    last_error = $2,
                    updated_at = NOW()
              WHERE user_id = $1`,
            [String(userId), String(detalle ?? '').slice(0, 200)],
            OP.error
        );
        return true;
    } catch {
        return false;
    }
}

async function leer(userId) {
    if (!disponible()) return null;
    const { rows } = await db.query(
        'SELECT * FROM roblox_user_avatar WHERE user_id = $1',
        [String(userId)],
        OP.leer
    );
    return filaARegistro(rows[0]);
}

async function leerVarios(userIds) {
    if (!disponible() || userIds.length === 0) return new Map();
    const { rows } = await db.query(
        'SELECT * FROM roblox_user_avatar WHERE user_id = ANY($1::text[])',
        [userIds.map(String)],
        OP.leer
    );
    return new Map(rows.map(fila => [String(fila.user_id), filaARegistro(fila)]));
}

// A QUIEN LE TOCA. Devuelve miembros del grupo que necesitan trabajo, en orden
// de necesidad:
//
//   1. los que no tienen fila         (el indice no sabe nada de ellos)
//   2. los de version de precio vieja (cambio la logica: van por delante)
//   3. los de avatar vencido          (se pudo cambiar de ropa)
//   4. los de precio vencido          (el mercado se movio)
//
// Vencer NO es un estado: es una posicion en esta cola. La fila sigue intacta y
// se sigue pudiendo servir mientras espera su turno.
async function pendientes(groupId, { limite = 25, ttlAvatarMs, ttlPrecioMs, pricingVersion = 1 } = {}) {
    if (!disponible()) return [];

    const { rows } = await db.query(
        `SELECT m.user_id, m.username,
                a.user_id IS NULL AS nuevo,
                CASE
                    WHEN a.user_id IS NULL THEN 0
                    WHEN a.pricing_version < $5 THEN 1
                    WHEN a.avatar_fetched_at < NOW() - ($3::double precision * INTERVAL '1 millisecond') THEN 2
                    ELSE 3
                END AS urgencia
           FROM plugin_group_member m
           LEFT JOIN roblox_user_avatar a ON a.user_id = m.user_id
          WHERE m.group_id = $1
            AND m.left_at IS NULL
            AND (
                a.user_id IS NULL
                OR a.pricing_version < $5
                OR a.avatar_fetched_at < NOW() - ($3::double precision * INTERVAL '1 millisecond')
                -- La falta de precio SOLO es motivo de refresco para quien
                -- puede tenerlo. Un usuario borrado o sin avatar nunca tendra
                -- fecha de valoracion, y sin esta condicion la cola lo elegiria
                -- en TODOS los ciclos para siempre: el worker se pasaria la
                -- vida volviendo a preguntar por los mismos usuarios que ya
                -- sabe que no existen. Su avatar se reintenta igual, pero por
                -- el reloj del avatar, que ese si vence.
                OR (a.state = 'valid' AND (
                    a.priced_at IS NULL
                    OR a.priced_at < NOW() - ($4::double precision * INTERVAL '1 millisecond')))
            )
          ORDER BY urgencia ASC, a.avatar_fetched_at ASC NULLS FIRST, m.user_id ASC
          LIMIT $2`,
        [String(groupId), limite, ttlAvatarMs, ttlPrecioMs, pricingVersion],
        OP.pendientes
    );

    return rows.map(fila => ({
        userId: String(fila.user_id),
        username: fila.username ?? null,
        nuevo: fila.nuevo === true,
        urgencia: Number(fila.urgencia),
    }));
}

// COBERTURA Y FRESCURA de un grupo, en una consulta. Es la metrica que decide
// si un grupo esta listo para servirse desde el indice (fase 3) y la que se
// publica en /v1/metrics.
async function cobertura(groupId, { ttlAvatarMs, ttlPrecioMs } = {}) {
    if (!disponible()) return null;

    const { rows } = await db.query(
        `SELECT COUNT(*)::int AS miembros,
                COUNT(a.user_id)::int AS indexados,
                COUNT(*) FILTER (WHERE a.state = 'valid')::int AS validos,
                COUNT(*) FILTER (
                    WHERE a.state = 'valid'
                      AND a.avatar_fetched_at >= NOW() - ($2::double precision * INTERVAL '1 millisecond')
                      AND a.priced_at IS NOT NULL
                      AND a.priced_at >= NOW() - ($3::double precision * INTERVAL '1 millisecond')
                )::int AS frescos
           FROM plugin_group_member m
           LEFT JOIN roblox_user_avatar a ON a.user_id = m.user_id
          WHERE m.group_id = $1 AND m.left_at IS NULL`,
        [String(groupId), ttlAvatarMs, ttlPrecioMs],
        OP.cobertura
    );

    const fila = rows[0] ?? {};
    const miembros = Number(fila.miembros ?? 0);
    return {
        groupId: String(groupId),
        members: miembros,
        indexed: Number(fila.indexados ?? 0),
        valid: Number(fila.validos ?? 0),
        fresh: Number(fila.frescos ?? 0),
        coverage: miembros > 0 ? Number((Number(fila.indexados ?? 0) / miembros).toFixed(4)) : 0,
        freshness: miembros > 0 ? Number((Number(fila.frescos ?? 0) / miembros).toFixed(4)) : 0,
    };
}

module.exports = {
    ESTADO,
    disponible,
    upsert,
    anotarError,
    leer,
    leerVarios,
    pendientes,
    cobertura,
};
