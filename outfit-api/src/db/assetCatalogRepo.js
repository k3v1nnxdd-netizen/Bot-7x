'use strict';

const db = require('./pool');
const logger = require('../observability/logger');

// EL CATALOGO PERSISTENTE.
//
// La ficha de cada asset —precio, disponibilidad, bundle— guardada en Postgres
// en vez de solo en la memoria del proceso.
//
// POR QUE EXISTE: Railway reinicia en cada despliegue. Con la ficha solo en
// memoria, el primer recorrido despues de un reinicio volvia a pedirle a Roblox
// miles de assets que ya conociamos y cuyo precio no habia cambiado en dias.
// Eso es cuota tirada, y la cuota es justo lo escaso.
//
// Y ES COMPARTIDA. Una comunidad entera lleva mas o menos los mismos gorros:
// cien usuarios con seis assets cada uno no son seiscientas fichas, son las
// pocas docenas distintas que de verdad hay. Ese factor de reutilizacion es lo
// que hace que las llamadas al catalogo sean una fraccion de las del avatar.
//
// UN 429 NO BORRA NADA. Igual que en el indice de avatares: cuando Roblox
// frena, este modulo simplemente no se llama. Ninguna funcion de aqui degrada
// ni elimina una ficha por un fallo.

const OP = {
    leer: 'assetCatalog.read',
    guardar: 'assetCatalog.upsert',
    contar: 'assetCatalog.count',
};

function disponible() {
    return db.isConfigured();
}

// De fila a la MISMA forma que devuelve roblox.getCatalogItemDetails, para que
// `pricing.clasificar` y `pricing.valorar` no sepan de donde vino la ficha.
// Esa indiferencia es lo que permite reutilizar el valorador tal cual.
function filaAFicha(fila) {
    return {
        available: fila.available === true,
        assetTypeId: fila.asset_type_id ?? null,
        isLimited: fila.is_limited === true,
        offSale: fila.off_sale === true,
        price: fila.price === null || fila.price === undefined ? null : Number(fila.price),
        lowestPrice: fila.lowest_price === null || fila.lowest_price === undefined ? null : Number(fila.lowest_price),
        lowestResalePrice: fila.lowest_resale_price === null || fila.lowest_resale_price === undefined
            ? null : Number(fila.lowest_resale_price),
        // Datos de bundle, para que el valorador no tenga que volver a pedirlos.
        bundleId: fila.bundle_id ?? null,
        bundlePrice: fila.bundle_price === null || fila.bundle_price === undefined ? null : Number(fila.bundle_price),
        bundleAvailable: fila.bundle_available === null || fila.bundle_available === undefined
            ? null : fila.bundle_available === true,
        missing: fila.missing === true,
        fetchedAt: fila.fetched_at ? new Date(fila.fetched_at).getTime() : null,
    };
}

// Lee de golpe las fichas que se conocen y siguen frescas.
//
// Devuelve DOS cosas y las dos importan: las fichas utiles y la lista de lo que
// falta. Quien llama pide a Roblox EXACTAMENTE lo segundo, que es todo el
// ahorro: sin esto se pediria el lote entero para descubrir que casi todo ya se
// sabia.
async function leerFrescos(assetIds, { ttlMs }) {
    const pedidos = [...new Set(assetIds.map(String))];
    if (!disponible() || pedidos.length === 0) {
        return { fichas: new Map(), faltan: pedidos, aciertos: 0 };
    }

    try {
        const { rows } = await db.query(
            `SELECT * FROM roblox_asset_catalog
              WHERE asset_id = ANY($1::text[])
                AND fetched_at >= NOW() - ($2::double precision * INTERVAL '1 millisecond')`,
            [pedidos, ttlMs],
            OP.leer
        );

        const fichas = new Map();
        for (const fila of rows) fichas.set(String(fila.asset_id), filaAFicha(fila));

        return {
            fichas,
            faltan: pedidos.filter(id => !fichas.has(id)),
            aciertos: fichas.size,
        };
    } catch (err) {
        // Si la lectura falla se pide todo a Roblox: peor, pero correcto. Un
        // fallo de la cache nunca puede dejar sin precio a un usuario.
        logger.warn('No se pudo leer el catalogo persistente', {
            operation: OP.leer, assets: pedidos.length, sqlState: err?.code ?? null,
        });
        return { fichas: new Map(), faltan: pedidos, aciertos: 0 };
    }
}

// Guarda un puñado de fichas de una vez. IDEMPOTENTE: repetir el mismo lote
// deja la tabla igual, solo con la fecha renovada.
//
// `fichas` es un Map assetId -> ficha con la forma de Roblox. `missing` marca
// los que Roblox no devolvio: eso es un dato real (borrado, moderado) y merece
// guardarse, porque volver a preguntar daria lo mismo.
async function guardar(fichas, { faltantes = [] } = {}) {
    if (!disponible()) return 0;

    const entradas = [...fichas.entries()];
    const ids = entradas.map(([id]) => String(id)).concat(faltantes.map(String));
    if (ids.length === 0) return 0;

    const columna = (extraer, porDefecto = null) => entradas.map(([, f]) => extraer(f) ?? porDefecto)
        .concat(faltantes.map(() => porDefecto));
    const ausente = entradas.map(() => false).concat(faltantes.map(() => true));

    try {
        const { rowCount } = await db.query(
            `INSERT INTO roblox_asset_catalog (
                 asset_id, available, asset_type_id, is_limited, off_sale,
                 price, lowest_price, lowest_resale_price,
                 bundle_id, bundle_price, bundle_available,
                 missing, fetched_at, updated_at
             )
             SELECT * FROM UNNEST(
                 $1::text[], $2::boolean[], $3::integer[], $4::boolean[], $5::boolean[],
                 $6::bigint[], $7::bigint[], $8::bigint[],
                 $9::text[], $10::bigint[], $11::boolean[],
                 $12::boolean[]
             ) AS entrada(
                 asset_id, available, asset_type_id, is_limited, off_sale,
                 price, lowest_price, lowest_resale_price,
                 bundle_id, bundle_price, bundle_available, missing
             ),
             LATERAL (SELECT NOW() AS fetched_at, NOW() AS updated_at) AS reloj
             ON CONFLICT (asset_id) DO UPDATE SET
                 available           = EXCLUDED.available,
                 asset_type_id       = EXCLUDED.asset_type_id,
                 is_limited          = EXCLUDED.is_limited,
                 off_sale            = EXCLUDED.off_sale,
                 price               = EXCLUDED.price,
                 lowest_price        = EXCLUDED.lowest_price,
                 lowest_resale_price = EXCLUDED.lowest_resale_price,
                 -- El bundle es ESTRUCTURAL: si ya se sabia y ahora no viene,
                 -- se conserva. Un lote que no pregunto por bundles no puede
                 -- borrar lo que otro averiguo.
                 bundle_id           = COALESCE(EXCLUDED.bundle_id, roblox_asset_catalog.bundle_id),
                 bundle_price        = COALESCE(EXCLUDED.bundle_price, roblox_asset_catalog.bundle_price),
                 bundle_available    = COALESCE(EXCLUDED.bundle_available, roblox_asset_catalog.bundle_available),
                 missing             = EXCLUDED.missing,
                 fetched_at          = NOW(),
                 updated_at          = NOW()`,
            [
                ids,
                columna(f => f.available),
                columna(f => f.assetTypeId),
                columna(f => f.isLimited),
                columna(f => f.offSale),
                columna(f => f.price),
                columna(f => f.lowestPrice),
                columna(f => f.lowestResalePrice),
                columna(f => f.bundleId),
                columna(f => f.bundlePrice),
                columna(f => f.bundleAvailable),
                ausente,
            ],
            OP.guardar
        );
        return rowCount ?? ids.length;
    } catch (err) {
        logger.warn('No se pudo guardar en el catalogo persistente', {
            operation: OP.guardar, assets: ids.length, sqlState: err?.code ?? null,
        });
        return 0;
    }
}

async function contar() {
    if (!disponible()) return { fichas: 0 };
    const { rows } = await db.query(
        'SELECT COUNT(*)::int AS n FROM roblox_asset_catalog',
        [],
        OP.contar
    );
    return { fichas: Number(rows[0]?.n ?? 0) };
}

module.exports = { disponible, leerFrescos, guardar, contar, filaAFicha };
