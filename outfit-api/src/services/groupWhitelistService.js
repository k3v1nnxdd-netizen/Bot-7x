'use strict';

const db = require('../db/pool');
const { translateDbError } = require('../db/errors');
const { NotFoundError } = require('../roblox/errors');

// Toda la logica de la whitelist de grupos, y el UNICO modulo que sabe como
// esta guardada. Las rutas de src/api/routes/adminGroups.js validan, llaman
// aqui y responden; no escriben una sola linea de SQL.
//
// REGLA ABSOLUTA DE ESTE ARCHIVO: cada valor variable viaja como PARAMETRO
// ($1, $2, ...). Ni un solo `${}` dentro de una consulta, ni siquiera con
// valores ya validados por src/validation/params.js. La validacion cuida la
// coherencia de los datos; la parametrizacion cuida la seguridad. Son dos
// defensas independientes y ninguna sustituye a la otra: la validacion de hoy
// puede relajarse mañana, y el SQL parametrizado seguiria siendo seguro.
//
// NotFoundError se reutiliza tal cual de roblox/errors.js. Vive ahi por
// historia, pero es generica: transporta un `code` y src/api/errorHandler.js
// ya la traduce a 404. Duplicar una clase equivalente solo serviria para
// tener dos sitios donde el mapeo a HTTP pueda desalinearse.

// `active` distingue "nunca estuvo autorizado" de "lo estuvo y se le retiro",
// y eso importa: al readmitir un grupo se conserva su `created_at` original,
// asi que la fecha de alta sigue siendo real y no la del ultimo repunte.
const COLUMNS = 'group_id, active, created_at';

function toGroup(row) {
    if (!row) return null;
    return {
        groupId: row.group_id,
        active: row.active,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    };
}

// Envoltorio comun: traduce el error crudo de `pg` a nuestra taxonomia (503
// si la base no esta, el error original si es un bug nuestro) sin que cada
// funcion tenga que acordarse.
async function run(text, params) {
    try {
        return await db.query(text, params);
    } catch (err) {
        throw translateDbError(err);
    }
}

// Alta. Es un UPSERT y no un INSERT a secas porque "agregar un grupo que ya
// estaba" no es un error del administrador: es la operacion que quiere hacer
// cuando readmite a alguien que se dio de baja. Reactivar en vez de fallar
// hace la operacion IDEMPOTENTE — repetir la llamada deja el mismo estado —
// que es justo lo que se espera de un panel administrativo.
//
// `xmax = 0` es la forma canonica de saber si la fila fue INSERTADA o
// ACTUALIZADA en un ON CONFLICT: en una fila recien insertada xmax vale 0.
// Sirve para responder 201 (creado) o 200 (ya existia) con la verdad, en vez
// de tener que hacer un SELECT previo que ademas seria una carrera.
async function addGroup(groupId) {
    const { rows } = await run(
        `INSERT INTO group_whitelist (group_id)
              VALUES ($1)
         ON CONFLICT (group_id) DO UPDATE SET active = true
           RETURNING ${COLUMNS}, (xmax = 0) AS inserted`,
        [groupId]
    );

    const row = rows[0];
    return { ...toGroup(row), created: row.inserted === true };
}

// Baja. Por defecto DESACTIVA (active = false) en lugar de borrar, y no es
// pereza: conserva la fecha de alta y deja rastro de que ese grupo estuvo
// autorizado alguna vez, que es lo que hace falta para resolver una disputa
// sobre un pago. `purge` existe para el borrado de verdad, cuando lo que se
// quiere es que no quede rastro (una prueba, un alta por error).
async function removeGroup(groupId, { purge = false } = {}) {
    const { rows } = purge
        ? await run(`DELETE FROM group_whitelist WHERE group_id = $1 RETURNING ${COLUMNS}`, [groupId])
        : await run(
            `UPDATE group_whitelist
                SET active = false
              WHERE group_id = $1
          RETURNING ${COLUMNS}`,
            [groupId]
        );

    if (rows.length === 0) {
        throw new NotFoundError('group_not_found', `El grupo ${groupId} no esta en la whitelist`);
    }

    // En un purge, RETURNING devuelve la fila TAL COMO ESTABA antes de
    // borrarse, asi que `active` vendria a true si el grupo estaba vigente.
    // Se fuerza a false: la fila ya no existe y decir "active: true" de algo
    // que se acaba de borrar solo puede confundir a quien lea la respuesta.
    const group = toGroup(rows[0]);
    return { ...group, active: purge ? false : group.active, purged: purge };
}

// Consulta puntual. Devuelve null si el grupo no esta en la tabla; es la ruta
// quien decide que significa eso en HTTP (ver adminGroups.js: un grupo no
// listado NO es un 404, es un "no autorizado" perfectamente valido).
async function getGroup(groupId) {
    const { rows } = await run(
        `SELECT ${COLUMNS} FROM group_whitelist WHERE group_id = $1`,
        [groupId]
    );
    return toGroup(rows[0]);
}

// Atajo pensado para lo que vendra despues (el juego preguntando "¿este grupo
// puede usar el sistema?"). Aqui ya, para que esa decision tenga UN solo sitio
// donde vivir en lugar de repetirse en cada llamador.
function isAuthorized(group) {
    return group !== null && group.active === true;
}

// Listado paginado. El total sale de la MISMA consulta con una funcion de
// ventana en vez de un segundo SELECT count(*): dos consultas separadas
// pueden ver estados distintos si alguien escribe entre medias, y ademas
// cuesta el doble de viajes a la base.
//
// El filtro por `active` tambien va parametrizado ($1): construir el WHERE
// concatenando segun el flag seria empezar a montar SQL con cadenas, que es
// exactamente el habito que hace falta no coger.
async function listGroups({ includeInactive = false, limit = 100, offset = 0 } = {}) {
    const { rows } = await run(
        `SELECT ${COLUMNS}, (count(*) OVER ())::int AS total
           FROM group_whitelist
          WHERE ($1::boolean OR active)
       ORDER BY created_at DESC, group_id
          LIMIT $2 OFFSET $3`,
        [includeInactive, limit, offset]
    );

    // Sin filas no hay ventana de la que sacar el total: cero es el total.
    const total = rows[0]?.total ?? 0;

    return {
        total,
        count: rows.length,
        limit,
        offset,
        includeInactive,
        hasMore: offset + rows.length < total,
        groups: rows.map(toGroup),
    };
}

module.exports = { addGroup, removeGroup, getGroup, listGroups, isAuthorized };
