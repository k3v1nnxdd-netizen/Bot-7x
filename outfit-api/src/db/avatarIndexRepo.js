'use strict';

const db = require('./pool');
const logger = require('../observability/logger');

// EL INDICE DE AVATARES RESUELTOS.
//
// Guarda lo que hoy cuesta una llamada a Roblox por miembro: que lleva puesto
// alguien y cuanto vale. Una fila por USUARIO, no por grupo.
//
// LAS DOS MITADES SE ESCRIBEN POR SEPARADO, y esa separacion es el diseño:
//
//   `upsertAvatar`       lo que dijo la ruta del avatar. Una llamada por usuario.
//   `upsertValoraciones` lo que dijo el catalogo. UNA pasada para MUCHOS
//                        usuarios, porque comparten assets.
//
// Escribirlas juntas obligaria a pedir catalogo usuario a usuario, que es
// exactamente lo caro. Separadas, cien usuarios caben en unos pocos lotes.
//
// Tres reglas gobiernan todo lo que hay aqui:
//
//   1. UN 429 NO ES UN DATO. Roblox frenandonos no dice nada del avatar de
//      nadie. Ninguna funcion de aqui se llama en ese caso.
//   2. UN TTL VENCIDO NO BORRA. Vencer solo cambia el ORDEN de refresco.
//   3. UN ERROR TEMPORAL NO ES UN VEREDICTO. `unpriceable` significa "Roblox
//      contesto y estos assets no tienen precio", nunca "no pudimos preguntar".

const OP = {
    upsertAvatar: 'avatarIndex.upsertAvatar',
    upsertPrecio: 'avatarIndex.upsertPricing',
    leer: 'avatarIndex.read',
    pendientesAvatar: 'avatarIndex.pendingAvatar',
    pendientesPrecio: 'avatarIndex.pendingPricing',
    cobertura: 'avatarIndex.coverage',
    error: 'avatarIndex.error',
};

// Estados de una fila. NO existe 'too_few_accessories': el minimo de accesorios
// es CONFIGURABLE y se aplica al consultar, sobre la columna `accessories`.
// Guardarlo como estado obligaria a reindexar la comunidad entera por cambiar
// una variable de entorno — y bajarlo de 4 a 3, como se acaba de hacer, habria
// dejado fuera para siempre a usuarios que ahora si valen.
const ESTADO = {
    // Avatar conocido Y valorado. Es el UNICO estado servible.
    VALIDO: 'valid',
    // Avatar conocido, todavia sin valorar. Aqui caen los que esperan turno de
    // catalogo y los que no llegan al minimo de accesorios (a esos no se les
    // gasta ni un lote). Si el minimo baja, entran solos en la cola de precios.
    SOLO_AVATAR: 'avatar_only',
    // Roblox contesto: no lleva nada puesto.
    AVATAR_VACIO: 'empty_avatar',
    // Roblox contesto 404: el usuario no existe.
    NO_EXISTE: 'not_found',
    // Roblox contesto y sus assets NO tienen precio averiguable. Es un
    // veredicto, no un fallo: un timeout o un 429 JAMAS dejan este estado.
    SIN_PRECIO: 'unpriceable',
};

const ESTADOS = new Set(Object.values(ESTADO));

// Estados que pueden llegar a valorarse. Un borrado o un avatar vacio no: no
// tienen assets, asi que la cola de precios no debe mirarlos nunca.
const VALORABLES = [ESTADO.VALIDO, ESTADO.SOLO_AVATAR, ESTADO.SIN_PRECIO];

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

// ── ESCRITURA 1: lo que dijo la ruta del avatar ─────────────────────────────
//
// Escribe SOLO los hechos del avatar. Nunca toca las columnas de precio: la
// valoracion la escribe la otra pasada, y pisarla aqui tiraria un precio bueno
// cada vez que alguien se cambia de gorro.
async function upsertAvatar({
    userId, username = null, state,
    assetIds = [], assetTypeIds = [], accessories = 0, playerAvatarType = null,
}) {
    if (!disponible()) return false;
    if (!ESTADOS.has(state)) throw new Error(`Estado desconocido para el indice: ${state}`);

    try {
        await db.query(
            `INSERT INTO roblox_user_avatar (
                 user_id, username, state,
                 asset_ids, asset_type_ids, accessories, player_avatar_type,
                 avatar_fetched_at, consecutive_errors, last_error, updated_at
             ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, NOW(), 0, NULL, NOW())
             ON CONFLICT (user_id) DO UPDATE SET
                 username           = COALESCE(EXCLUDED.username, roblox_user_avatar.username),
                 state              = EXCLUDED.state,
                 asset_ids          = EXCLUDED.asset_ids,
                 asset_type_ids     = EXCLUDED.asset_type_ids,
                 accessories        = EXCLUDED.accessories,
                 player_avatar_type = EXCLUDED.player_avatar_type,
                 avatar_fetched_at  = NOW(),
                 consecutive_errors = 0,
                 last_error         = NULL,
                 updated_at         = NOW()`,
            [
                String(userId), username, state,
                JSON.stringify(assetIds.map(String)),
                JSON.stringify(assetTypeIds.map(Number)),
                accessories, playerAvatarType,
            ],
            OP.upsertAvatar
        );
        return true;
    } catch (err) {
        logger.warn('No se pudo escribir el avatar en el indice', {
            operation: OP.upsertAvatar, userId: String(userId), sqlState: err?.code ?? null,
        });
        return false;
    }
}

// ── ESCRITURA 2: lo que dijo el catalogo, para MUCHOS usuarios de una vez ───
//
// `valoraciones` es una lista de { userId, state, valoracion|null }. Se escribe
// en una sola sentencia porque viene de una sola pasada de catalogo: cien
// usuarios valorados con los mismos pocos lotes.
//
// Con `valoracion` null (el usuario no llego a valorarse) se cambia el estado
// pero NO se borra el precio anterior: un dato viejo vale mas que un NULL.
async function upsertValoraciones(valoraciones, { pricingVersion = 1 } = {}) {
    if (!disponible() || valoraciones.length === 0) return 0;

    const ids = valoraciones.map(v => String(v.userId));
    const estados = valoraciones.map(v => v.state);
    const con = valoraciones.map(v => v.valoracion !== null && v.valoracion !== undefined);
    const campo = extraer => valoraciones.map(v => (v.valoracion ? extraer(v.valoracion) ?? null : null));

    for (const estado of estados) {
        if (!ESTADOS.has(estado)) throw new Error(`Estado desconocido para el indice: ${estado}`);
    }

    try {
        const { rowCount } = await db.query(
            `UPDATE roblox_user_avatar a SET
                 state          = entrada.state,
                 total_price    = CASE WHEN entrada.con THEN entrada.total_price    ELSE a.total_price END,
                 price_complete = CASE WHEN entrada.con THEN entrada.price_complete ELSE a.price_complete END,
                 priced_items   = CASE WHEN entrada.con THEN entrada.priced_items   ELSE a.priced_items END,
                 unpriced_items = CASE WHEN entrada.con THEN entrada.unpriced_items ELSE a.unpriced_items END,
                 limited_items  = CASE WHEN entrada.con THEN entrada.limited_items  ELSE a.limited_items END,
                 off_sale_items = CASE WHEN entrada.con THEN entrada.off_sale_items ELSE a.off_sale_items END,
                 bundled_items  = CASE WHEN entrada.con THEN entrada.bundled_items  ELSE a.bundled_items END,
                 priced_at      = CASE WHEN entrada.con THEN NOW() ELSE a.priced_at END,
                 pricing_version = $11,
                 consecutive_errors = 0,
                 last_error     = NULL,
                 updated_at     = NOW()
             FROM UNNEST(
                 $1::text[], $2::text[], $3::boolean[],
                 $4::bigint[], $5::boolean[], $6::integer[], $7::integer[],
                 $8::integer[], $9::integer[], $10::integer[]
             ) AS entrada(
                 user_id, state, con,
                 total_price, price_complete, priced_items, unpriced_items,
                 limited_items, off_sale_items, bundled_items
             )
             WHERE a.user_id = entrada.user_id`,
            [
                ids, estados, con,
                campo(v => v.totalPrice), campo(v => v.priceComplete),
                campo(v => v.pricedItems), campo(v => v.unpricedItems),
                campo(v => v.limitedItems), campo(v => v.offSaleItems), campo(v => v.bundledItems),
                pricingVersion,
            ],
            OP.upsertPrecio
        );
        return rowCount ?? 0;
    } catch (err) {
        logger.warn('No se pudieron escribir las valoraciones en el indice', {
            operation: OP.upsertPrecio, usuarios: valoraciones.length, sqlState: err?.code ?? null,
        });
        return 0;
    }
}

// Deja constancia de un fallo SIN tocar los datos. No cambia estado, ni avatar,
// ni precio: solo cuenta. Nunca se llama para un 429.
async function anotarError(userId, detalle) {
    if (!disponible()) return false;
    try {
        await db.query(
            `UPDATE roblox_user_avatar
                SET consecutive_errors = consecutive_errors + 1,
                    last_error = $2, updated_at = NOW()
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
        [String(userId)], OP.leer
    );
    return filaARegistro(rows[0]);
}

async function leerVarios(userIds) {
    if (!disponible() || userIds.length === 0) return new Map();
    const { rows } = await db.query(
        'SELECT * FROM roblox_user_avatar WHERE user_id = ANY($1::text[])',
        [userIds.map(String)], OP.leer
    );
    return new Map(rows.map(f => [String(f.user_id), filaARegistro(f)]));
}

// ── COLA 1: AVATARES ────────────────────────────────────────────────────────
//
// El orden ES la politica de prioridades, y es deliberado:
//
//   0. NUNCA INDEXADO   ampliar cobertura va primero. Un usuario del que no se
//                       sabe nada no puede salir en ninguna busqueda; uno con
//                       datos viejos si.
//   1. AVATAR VENCIDO   refrescar lo que pudo cambiar.
//
// La falta de precio NO entra aqui: eso es trabajo de la otra cola, y meterlo
// gastaria una llamada de avatar para arreglar algo que solo necesita catalogo.
async function pendientesDeAvatar(groupId, { limite = 25, ttlAvatarMs } = {}) {
    if (!disponible()) return [];

    const { rows } = await db.query(
        `SELECT m.user_id, m.username,
                (a.user_id IS NULL) AS nuevo,
                CASE WHEN a.user_id IS NULL THEN 0 ELSE 1 END AS urgencia
           FROM plugin_group_member m
           LEFT JOIN roblox_user_avatar a ON a.user_id = m.user_id
          WHERE m.group_id = $1
            AND m.left_at IS NULL
            AND (
                a.user_id IS NULL
                OR a.avatar_fetched_at < NOW() - ($3::double precision * INTERVAL '1 millisecond')
            )
          ORDER BY urgencia ASC, a.avatar_fetched_at ASC NULLS FIRST, m.user_id ASC
          LIMIT $2`,
        [String(groupId), limite, ttlAvatarMs],
        OP.pendientesAvatar
    );

    return rows.map(f => ({
        userId: String(f.user_id), username: f.username ?? null,
        nuevo: f.nuevo === true, urgencia: Number(f.urgencia),
    }));
}

// ── COLA 2: PRECIOS ─────────────────────────────────────────────────────────
//
// Quien tiene avatar y le falta valoracion. Devuelve TAMBIEN sus assetIds,
// porque quien llama va a unirlos todos y deduplicarlos antes de pedir nada:
// ese es el paso donde cien usuarios se convierten en unos pocos lotes.
//
// EL MINIMO DE ACCESORIOS SE APLICA AQUI, y es lo que impide gastar catalogo en
// alguien que no puede salir en un resultado. Como el minimo llega por
// parametro desde la config, bajarlo mete solos en la cola a los que antes
// quedaban fuera, sin reindexar ni tocar una fila.
async function pendientesDePrecio(groupId, {
    limite = 60, ttlPrecioMs, pricingVersion = 1, minAccessories = 0,
} = {}) {
    if (!disponible()) return [];

    const { rows } = await db.query(
        `SELECT a.user_id, a.username, a.asset_ids, a.accessories, a.state,
                CASE
                    WHEN a.priced_at IS NULL THEN 0
                    WHEN a.pricing_version < $4 THEN 1
                    ELSE 2
                END AS urgencia
           FROM plugin_group_member m
           JOIN roblox_user_avatar a ON a.user_id = m.user_id
          WHERE m.group_id = $1
            AND m.left_at IS NULL
            AND a.state = ANY($5::text[])
            AND a.accessories >= $6
            AND jsonb_array_length(a.asset_ids) > 0
            AND (
                a.priced_at IS NULL
                OR a.pricing_version < $4
                OR a.priced_at < NOW() - ($3::double precision * INTERVAL '1 millisecond')
            )
          ORDER BY urgencia ASC, a.priced_at ASC NULLS FIRST, a.user_id ASC
          LIMIT $2`,
        [String(groupId), limite, ttlPrecioMs, pricingVersion, VALORABLES, minAccessories],
        OP.pendientesPrecio
    );

    return rows.map(f => ({
        userId: String(f.user_id),
        username: f.username ?? null,
        assetIds: Array.isArray(f.asset_ids) ? f.asset_ids.map(String) : [],
        accessories: Number(f.accessories ?? 0),
        state: f.state,
        urgencia: Number(f.urgencia),
    }));
}

// COBERTURA Y FRESCURA. `eligible` cuenta los que de verdad podrian salir en un
// resultado: validos, con precio y con accesorios suficientes. Es el numero que
// decide si un grupo esta listo para servirse desde el indice, y el que el
// plugin enseña mientras la comunidad se indexa.
async function cobertura(groupId, { ttlAvatarMs, ttlPrecioMs, minAccessories = 0 } = {}) {
    if (!disponible()) return null;

    // `members` es COUNT(DISTINCT user_id) de la pertenencia activa: usuarios
    // distintos, nunca filas de un join ni paginas recorridas.
    const { rows } = await db.query(
        `SELECT COUNT(DISTINCT m.user_id)::int AS miembros,
                COUNT(DISTINCT a.user_id)::int AS indexados,
                COUNT(DISTINCT a.user_id) FILTER (WHERE a.state = 'valid')::int AS validos,
                COUNT(DISTINCT a.user_id) FILTER (WHERE a.state = 'valid' AND a.accessories >= $4)::int AS elegibles,
                COUNT(DISTINCT a.user_id) FILTER (WHERE a.accessories < $4)::int AS bajoMinimo,
                COUNT(DISTINCT a.user_id) FILTER (
                    WHERE a.state = 'valid'
                      AND a.avatar_fetched_at >= NOW() - ($2::double precision * INTERVAL '1 millisecond')
                      AND a.priced_at IS NOT NULL
                      AND a.priced_at >= NOW() - ($3::double precision * INTERVAL '1 millisecond')
                )::int AS frescos
           FROM plugin_group_member m
           LEFT JOIN roblox_user_avatar a ON a.user_id = m.user_id
          WHERE m.group_id = $1 AND m.left_at IS NULL`,
        [String(groupId), ttlAvatarMs, ttlPrecioMs, minAccessories],
        OP.cobertura
    );

    const f = rows[0] ?? {};
    const miembros = Number(f.miembros ?? 0);
    const indexados = Number(f.indexados ?? 0);
    return {
        groupId: String(groupId),
        members: miembros,
        knownMembers: miembros,
        indexed: indexados,
        valid: Number(f.validos ?? 0),
        eligible: Number(f.elegibles ?? 0),
        belowMinAccessories: Number(f.bajominimo ?? f.bajoMinimo ?? 0),
        fresh: Number(f.frescos ?? 0),
        coverage: miembros > 0 ? Number((indexados / miembros).toFixed(4)) : 0,
        freshness: miembros > 0 ? Number((Number(f.frescos ?? 0) / miembros).toFixed(4)) : 0,
    };
}

module.exports = {
    ESTADO,
    VALORABLES,
    disponible,
    upsertAvatar,
    upsertValoraciones,
    anotarError,
    leer,
    leerVarios,
    pendientesDeAvatar,
    pendientesDePrecio,
    cobertura,
};
