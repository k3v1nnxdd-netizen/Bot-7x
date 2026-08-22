'use strict';

const db = require('../db/pool');
const { translateDbError } = require('../db/errors');
const { NotFoundError } = require('../roblox/errors');
const licenseToken = require('../security/licenseToken');

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
//
// DOS FECHAS, Y NO ES REDUNDANCIA: `created_at` es el alta original (jamas se
// reescribe) y `linked_at` el ultimo enlace o reactivacion. Una responde
// "desde cuando es cliente" y la otra "desde cuando esta vigente lo que hay
// ahora". Con una sola no se puede contar la historia de una readmision.
//
// Los datos del comprador (discord_user_id, roblox_username) y del
// administrador (added_by) se guardan aqui y no en el bot a proposito: el bot
// no habla con Postgres, solo con esta API, y su almacenamiento en disco no
// sobrevive a un redeploy de Railway. La licencia y quien la compro son el
// mismo hecho y tienen que vivir en la misma fila.
// `license_token_hash` NO esta en esta lista a proposito, y no es un descuido:
// esta constante alimenta el RETURNING de todas las operaciones y de ahi sale
// lo que acaba en las respuestas HTTP. Manteniendo el hash fuera, ninguna ruta
// puede filtrarlo por olvido — el unico sitio que lo lee es findByTokenHash(),
// que lo pide explicitamente y no devuelve nada mas.
const COLUMNS = `group_id, active, created_at, linked_at,
                 discord_user_id, roblox_username, group_name, added_by,
                 deactivated_at, deactivated_by, deactivation_reason`;

const iso = value => (value instanceof Date ? value.toISOString() : value ?? null);

function toGroup(row) {
    if (!row) return null;
    return {
        groupId: row.group_id,
        active: row.active,
        createdAt: iso(row.created_at),
        linkedAt: iso(row.linked_at),
        discordUserId: row.discord_user_id ?? null,
        robloxUsername: row.roblox_username ?? null,
        groupName: row.group_name ?? null,
        addedBy: row.added_by ?? null,
        deactivatedAt: iso(row.deactivated_at),
        deactivatedBy: row.deactivated_by ?? null,
        deactivationReason: row.deactivation_reason ?? null,
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
//
// COALESCE(EXCLUDED.x, tabla.x) en cada dato: lo que el llamador MANDA pisa lo
// guardado — readmitir con otro comprador tiene que actualizar el comprador —
// pero lo que NO manda se conserva, de modo que una llamada suelta sin
// metadatos (un curl, el juego mañana) no puede vaciar la ficha de un cliente.
//
// Los tres campos de la baja se limpian SIEMPRE: si el grupo vuelve a estar
// activo, el motivo por el que se le retiro la licencia ya no describe su
// estado y dejarlo ahi solo serviria para confundir al siguiente que mire.
// EL TOKEN. Se genera SIEMPRE uno nuevo antes de la consulta, aunque casi
// nunca se use, porque la alternativa seria leer primero para ver si ya hay
// uno y escribir despues — dos viajes y una carrera entre ellos. Generar 32
// bytes aleatorios no cuesta nada y deja la operacion en una sola sentencia
// atomica.
//
// Quien decide si ese token nuevo se queda es el COALESCE del ON CONFLICT:
//
//   licencia NUEVA                  -> se guarda el hash del token nuevo.
//   licencia EXISTENTE con token    -> se conserva el suyo. Reactivar NO
//                                      cambia la credencial: el juego del
//                                      cliente sigue funcionando sin tocar
//                                      una linea de codigo.
//   licencia EXISTENTE sin token    -> adopta el nuevo. No es "cambiarle" el
//                                      token a nadie: son las licencias
//                                      anteriores a que esto existiera, y sin
//                                      credencial no podrian verificar nunca.
//
// Y como saber cual de los tres casos ocurrio, sin una segunda consulta: el
// RETURNING trae el hash que quedo en la fila. Si es el que acabamos de
// calcular, el token en claro que tenemos en memoria es el bueno y hay que
// entregarlo; si no, la fila conservo otro y el token generado se descarta sin
// haber salido de esta funcion.
async function addGroup(groupId, meta = {}) {
    const { discordUserId = null, robloxUsername = null, groupName = null, addedBy = null } = meta;

    const token = licenseToken.generateToken();
    const tokenHash = licenseToken.hashToken(token);

    const { rows } = await run(
        `INSERT INTO group_whitelist
                (group_id, discord_user_id, roblox_username, group_name, added_by, linked_at, license_token_hash)
              VALUES ($1, $2, $3, $4, $5, NOW(), $6)
         ON CONFLICT (group_id) DO UPDATE
                 SET active = true,
                     discord_user_id = COALESCE(EXCLUDED.discord_user_id, group_whitelist.discord_user_id),
                     roblox_username = COALESCE(EXCLUDED.roblox_username, group_whitelist.roblox_username),
                     group_name      = COALESCE(EXCLUDED.group_name,      group_whitelist.group_name),
                     added_by        = COALESCE(EXCLUDED.added_by,        group_whitelist.added_by),
                     linked_at       = NOW(),
                     deactivated_at = NULL,
                     deactivated_by = NULL,
                     deactivation_reason = NULL,
                     license_token_hash = COALESCE(group_whitelist.license_token_hash, EXCLUDED.license_token_hash)
           RETURNING ${COLUMNS}, license_token_hash, (xmax = 0) AS inserted`,
        [groupId, discordUserId, robloxUsername, groupName, addedBy, tokenHash]
    );

    const row = rows[0];
    const emitido = row.license_token_hash === tokenHash;

    return {
        ...toGroup(row),
        created: row.inserted === true,
        // El token en claro sale de aqui UNA vez y no se guarda en ningun
        // sitio. Si no se emitio, ni siquiera se menciona: `null` es la unica
        // respuesta honesta a "¿cual es el token de esta licencia?" cuando
        // solo tenemos su hash.
        tokenIssued: emitido,
        token: emitido ? token : null,
    };
}

// Baja. Por defecto DESACTIVA (active = false) en lugar de borrar, y no es
// pereza: conserva la fecha de alta y deja rastro de que ese grupo estuvo
// autorizado alguna vez, que es lo que hace falta para resolver una disputa
// sobre un pago. `purge` existe para el borrado de verdad, cuando lo que se
// quiere es que no quede rastro (una prueba, un alta por error).
//
// El motivo y el autor de la baja se escriben en la MISMA sentencia que la
// desactivacion: si fueran dos, un fallo entre ellas dejaria una licencia
// retirada sin explicacion, que es justo el estado que esto evita.
async function removeGroup(groupId, { purge = false, reason = null, actorId = null } = {}) {
    const { rows } = purge
        ? await run(`DELETE FROM group_whitelist WHERE group_id = $1 RETURNING ${COLUMNS}`, [groupId])
        : await run(
            `UPDATE group_whitelist
                SET active = false,
                    deactivated_at = NOW(),
                    deactivated_by = $2,
                    deactivation_reason = $3
              WHERE group_id = $1
          RETURNING ${COLUMNS}`,
            [groupId, actorId, reason]
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

// La confirmacion de identidad no cuadro con lo que hay guardado. Es una clase
// aparte y no un ValidationError porque no es una peticion mal formada: los
// datos son validos, simplemente NO son los de esta licencia. Sale como 409
// para que el administrador entienda que no se ha hecho nada y por que.
class ConfirmationMismatchError extends Error {
    constructor(message, campos) {
        super(message);
        this.name = 'ConfirmationMismatchError';
        this.code = 'confirmation_mismatch';
        this.campos = campos; // que campos no coincidieron; NUNCA sus valores
    }
}

// Rotacion de la credencial. Emite un token nuevo, guarda solo su SHA-256 y
// PISA el anterior — que queda invalido en el acto, porque la busqueda de
// /v1/license/verify es por hash y ese hash ya no existe en ninguna fila.
//
// LOS DATOS DE CONFIRMACION NO MODIFICAN NADA. `discordUserId` y
// `robloxUsername` entran en el WHERE, no en el SET: sirven para que el
// administrador demuestre que sabe de que licencia esta hablando antes de
// invalidarle el juego a un cliente. Rotar la credencial del grupo equivocado
// deja a alguien fuera de su propio juego sin aviso, y con un id de 9 cifras
// eso es un dedo mal puesto.
//
// SE ACTUALIZA UNA SOLA COLUMNA. created_at, linked_at, discord_user_id,
// roblox_username, group_name, added_by y el rastro de la baja quedan
// EXACTAMENTE como estaban: esto rota una llave, no reescribe la historia de
// la licencia.
//
// La comprobacion va en el WHERE y no en un SELECT previo para que sea
// ATOMICA: entre un SELECT y un UPDATE cabe otra operacion, y aqui lo que se
// decide con esa comprobacion es si se invalida o no la credencial de alguien.
// Solo cuando no se toca ninguna fila se consulta, y unicamente para poder
// decir si el grupo no existe o si lo que no cuadraba era la confirmacion.
async function regenerateToken(groupId, { discordUserId, robloxUsername }) {
    const token = licenseToken.generateToken();
    const tokenHash = licenseToken.hashToken(token);

    const { rows } = await run(
        `UPDATE group_whitelist
            SET license_token_hash = $4
          WHERE group_id = $1
            AND discord_user_id = $2
            AND roblox_username = $3
      RETURNING ${COLUMNS}`,
        [groupId, discordUserId, robloxUsername, tokenHash]
    );

    if (rows.length === 0) {
        const actual = await getGroup(groupId);
        if (actual === null) {
            throw new NotFoundError('group_not_found', `El grupo ${groupId} no esta en la whitelist`);
        }

        // Se dice QUE campo no cuadro, nunca cual era el valor guardado. Quien
        // llama ya tiene la clave de administracion y podria consultarlo, asi
        // que no es un secreto — pero un mensaje de error no es el sitio para
        // sacar datos de un cliente.
        const campos = [];
        if (actual.discordUserId !== discordUserId) campos.push('discord');
        if (actual.robloxUsername !== robloxUsername) campos.push('roblox');

        throw new ConfirmationMismatchError(
            campos.length === 2
                ? 'Ni el usuario de Discord ni el de Roblox coinciden con los enlazados a esta licencia'
                : campos[0] === 'discord'
                    ? 'El usuario de Discord no coincide con el enlazado a esta licencia'
                    : 'El usuario de Roblox no coincide con el enlazado a esta licencia',
            campos
        );
    }

    return { ...toGroup(rows[0]), token, tokenIssued: true };
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

// Atajo pensado para lo que vendra despues (el juego preguntando "este grupo
// puede usar el sistema?"). Aqui ya, para que esa decision tenga UN solo sitio
// donde vivir en lugar de repetirse en cada llamador.
function isAuthorized(group) {
    return group !== null && group.active === true;
}

// Busqueda POR HASH DE TOKEN, para /v1/license/verify. Devuelve un objeto
// minimo — id de grupo, si esta activa y el hash guardado — y NADA mas.
//
// Que devuelva tan poco es la decision importante de esta funcion. Lo que
// consume esto es una ruta que contesta a un juego de Roblox, es decir, a
// codigo que corre en servidores ajenos; no tiene por que enterarse de quien
// compro la licencia, cuando, ni quien la dio de alta. Si esta funcion
// devolviera la fila entera, tarde o temprano alguien reenviaria un campo de
// mas en la respuesta.
//
// El hash SI vuelve, y es a proposito: la ruta lo necesita para confirmar la
// coincidencia en tiempo constante (ver licenseToken.matchesHash). Un
// `WHERE = $1` lo resuelve Postgres con su indice, que no es una comparacion
// pensada para resistir medicion de tiempos.
async function findByTokenHash(tokenHash) {
    const { rows } = await run(
        `SELECT group_id, active, license_token_hash
           FROM group_whitelist
          WHERE license_token_hash = $1`,
        [tokenHash]
    );

    const row = rows[0];
    if (!row) return null;
    return { groupId: row.group_id, active: row.active, tokenHash: row.license_token_hash };
}

// Listado paginado. El total sale de la MISMA consulta con una funcion de
// ventana en vez de un segundo SELECT count(*): dos consultas separadas
// pueden ver estados distintos si alguien escribe entre medias, y ademas
// cuesta el doble de viajes a la base.
//
// El filtro por `active` tambien va parametrizado ($1): construir el WHERE
// concatenando segun el flag seria empezar a montar SQL con cadenas, que es
// exactamente el habito que hace falta no coger.
//
// Los ACTIVOS van primero en el orden: el panel del bot pide vigentes y
// retiradas en la misma respuesta, asi que la primera pagina tiene que traer
// lo que se consulta a diario y no bajas antiguas.
async function listGroups({ includeInactive = false, limit = 100, offset = 0 } = {}) {
    const { rows } = await run(
        `SELECT ${COLUMNS}, (count(*) OVER ())::int AS total
           FROM group_whitelist
          WHERE ($1::boolean OR active)
       ORDER BY active DESC, created_at DESC, group_id
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

module.exports = {
    addGroup,
    removeGroup,
    getGroup,
    listGroups,
    isAuthorized,
    findByTokenHash,
    regenerateToken,
    ConfirmationMismatchError,
};
