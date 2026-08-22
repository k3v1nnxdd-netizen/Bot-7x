'use strict';

const express = require('express');
const router = express.Router();
const groupWhitelist = require('../../services/groupWhitelistService');
const {
    parseGroupId, parseGroupListQuery, parseGroupMeta, parseGroupRemovalQuery, ValidationError,
} = require('../../validation/params');

// Administracion de la whitelist de grupos. Mismos adaptadores finos que el
// resto de rutas: validar, llamar al servicio, responder. Sin try/catch —
// Express 5 propaga el rechazo de un handler async al error handler central,
// que es el unico sitio donde se traduce un error a HTTP.
//
// Protegida por `x-admin-key` (ADMIN_API_KEY), NUNCA por la key del juego.
// El montaje esta en src/app.js; aqui no se asume nada sobre el prefijo.
//
// Va FUERA de /v1 a proposito: /v1 es el contrato publico que consume Roblox
// y que se versiona pensando en no romper el juego. Esto es un panel interno,
// con otro secreto, otro publico y otro ritmo de cambio.
//
// EL CLIENTE DE ESTAS RUTAS ES EL BOT DE DISCORD (/addgroup, /deletegroup,
// /checkgroup, /groups). El bot NO habla con Postgres: todo pasa por aqui, que
// es lo que mantiene un unico sitio donde se decide quien tiene licencia.

// El UNICO parser de body de todo el servicio, y montado SOLO aqui. La API de
// outfits sigue sin parser: es enteramente de lectura, y no tener parser le
// elimina de raiz una familia entera de problemas (bodies gigantes, JSON
// malformado, content-type inesperado). Este router si necesita uno, asi que
// paga ese coste solo el, y con un limite ridiculo: el cuerpo mas grande que
// se espera aqui son un id de grupo, dos ids de Discord, un usuario de Roblox
// y el nombre del grupo.
router.use(express.json({ limit: '4kb' }));

// Forma UNICA de una licencia en las respuestas. Existe para que el alta, la
// consulta, la baja y el listado devuelvan exactamente los mismos nombres de
// campo: el bot pinta el mismo embed con lo que le devuelva cualquiera de los
// cuatro, y basta con que uno se desvie para que aparezca un "undefined" en
// mitad de un mensaje publico.
function presentar(group) {
    return {
        groupId: group.groupId,
        active: group.active,
        createdAt: group.createdAt,
        linkedAt: group.linkedAt,
        discordUserId: group.discordUserId,
        robloxUsername: group.robloxUsername,
        groupName: group.groupName,
        addedBy: group.addedBy,
        deactivatedAt: group.deactivatedAt,
        deactivatedBy: group.deactivatedBy,
        deactivationReason: group.deactivationReason,
    };
}

// Licencia ausente: la misma forma, entera, con nulls. Devolver un objeto con
// menos claves obligaria a quien lo consume a distinguir "no esta" de "no lo
// sabemos" antes de leer cada campo.
const VACIA = {
    active: false,
    createdAt: null,
    linkedAt: null,
    discordUserId: null,
    robloxUsername: null,
    groupName: null,
    addedBy: null,
    deactivatedAt: null,
    deactivatedBy: null,
    deactivationReason: null,
};

// POST /admin/groups
//   body: { "groupId": "35216530", "discordUserId": "...", "robloxUsername": "...",
//           "groupName": "...", "addedBy": "..." }
//
// Solo `groupId` es obligatorio; el resto son los datos de la licencia y son
// opcionales (ver src/validation/params.js). Quien exige que vengan completos
// es el bot, que es quien conoce al usuario de Discord y quien ha comprobado
// antes contra Roblox que el grupo existe de verdad.
//
// Idempotente: repetirlo no falla ni duplica. 201 la primera vez, 200 si el
// grupo ya estaba (reactivandolo si se le habia dado de baja), para que el
// cliente pueda distinguir un alta real de un no-op sin adivinar.
router.post('/', async (req, res) => {
    res.locals.routeLabel = 'POST /admin/groups';

    // Sin Content-Type: application/json, express.json() no parsea nada y
    // req.body queda vacio. El mensaje lo dice explicitamente porque es el
    // error mas comun probando desde curl o PowerShell.
    const body = req.body;
    if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new ValidationError(
            'Manda un cuerpo JSON con {"groupId": "..."} y la cabecera Content-Type: application/json'
        );
    }

    // Se acepta numero ademas de cadena por comodidad del cliente, pero se
    // normaliza a texto ANTES de validar: la columna es TEXT y el id tiene que
    // entrar siempre con la misma forma, venga como venga.
    const raw = typeof body.groupId === 'number' ? String(body.groupId) : body.groupId;
    const groupId = parseGroupId(raw);
    const meta = parseGroupMeta(body);

    const result = await groupWhitelist.addGroup(groupId, meta);
    res.status(result.created ? 201 : 200).json({
        ...presentar(result),
        created: result.created,
        authorized: groupWhitelist.isAuthorized(result),
    });
});

// GET /admin/groups?includeInactive=1&limit=&offset=
//
// Por defecto lista SOLO los autorizados, que es la pregunta habitual.
// `includeInactive=1` añade los dados de baja, para auditoria — y es lo que
// pide /groups en el bot, que muestra las dos cosas separadas y con totales.
router.get('/', async (req, res) => {
    res.locals.routeLabel = 'GET /admin/groups';
    const query = parseGroupListQuery(req.query);
    const listado = await groupWhitelist.listGroups(query);

    res.json({ ...listado, groups: listado.groups.map(presentar) });
});

// GET /admin/groups/:groupId
//
// Un grupo que no esta en la tabla responde 200 con authorized:false, NO 404.
// Es deliberado: la pregunta de este endpoint es "¿esta autorizado?", y "no"
// es una respuesta valida, no un recurso ausente. Ademas el 404 ya significa
// otra cosa en esta API (route_not_found), y quien consuma esto — el bot o el
// juego, mas adelante — necesita un booleano fiable sin tener que tratar un
// codigo de error como si fuera un dato.
//
// `found` va aparte de `authorized` para poder distinguir "nunca estuvo" de
// "se le retiro la licencia", que no es lo mismo al atender a un cliente: es
// justo lo que separa los tres colores de /checkgroup en el bot.
router.get('/:groupId', async (req, res) => {
    res.locals.routeLabel = 'GET /admin/groups/:groupId';
    const groupId = parseGroupId(req.params.groupId);

    const group = await groupWhitelist.getGroup(groupId);
    res.json({
        groupId,
        authorized: groupWhitelist.isAuthorized(group),
        found: group !== null,
        ...(group ? presentar(group) : VACIA),
    });
});

// DELETE /admin/groups/:groupId?purge=1&reason=...&actor=...
//
// Por defecto DESACTIVA (active = false) y conserva la fila: queda constancia
// de que ese grupo estuvo autorizado y desde cuando, que es lo que hace falta
// el dia que alguien reclame. `purge=1` borra la fila de verdad.
//
// `reason` y `actor` se guardan con la baja para poder responder meses despues
// a "¿por que se le quito?" sin depender de que alguien recuerde el ticket.
// Van por query y no en el cuerpo porque hay clientes y proxies que descartan
// el cuerpo de un DELETE en silencio, y perder el motivo sin enterarse es peor
// que llevarlo en la URL — no es un secreto.
//
// Aqui si es 404 cuando el grupo no existe, al contrario que en el GET: dar
// de baja algo que no esta en la lista no es una operacion con resultado
// valido, es una equivocacion que conviene ver.
router.delete('/:groupId', async (req, res) => {
    res.locals.routeLabel = 'DELETE /admin/groups/:groupId';
    const groupId = parseGroupId(req.params.groupId);
    const { purge, reason, actorId } = parseGroupRemovalQuery(req.query);

    const result = await groupWhitelist.removeGroup(groupId, { purge, reason, actorId });
    res.json({
        ...presentar(result),
        authorized: false,
        purged: result.purged,
    });
});

module.exports = router;
