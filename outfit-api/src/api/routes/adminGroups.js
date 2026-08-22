'use strict';

const express = require('express');
const router = express.Router();
const groupWhitelist = require('../../services/groupWhitelistService');
const { parseGroupId, parseGroupListQuery, parseBooleanFlag, ValidationError } = require('../../validation/params');

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

// El UNICO parser de body de todo el servicio, y montado SOLO aqui. La API de
// outfits sigue sin parser: es enteramente de lectura, y no tener parser le
// elimina de raiz una familia entera de problemas (bodies gigantes, JSON
// malformado, content-type inesperado). Este router si necesita uno, asi que
// paga ese coste solo el, y con un limite ridiculo: el cuerpo mas grande que
// se espera aqui es {"groupId":"12345678"}.
router.use(express.json({ limit: '4kb' }));

// POST /admin/groups   body: { "groupId": "35216530" }
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

    const result = await groupWhitelist.addGroup(groupId);
    res.status(result.created ? 201 : 200).json({
        groupId: result.groupId,
        active: result.active,
        createdAt: result.createdAt,
        created: result.created,
        authorized: groupWhitelist.isAuthorized(result),
    });
});

// GET /admin/groups?includeInactive=1&limit=&offset=
//
// Por defecto lista SOLO los autorizados, que es la pregunta habitual.
// `includeInactive=1` añade los dados de baja, para auditoria.
router.get('/', async (req, res) => {
    res.locals.routeLabel = 'GET /admin/groups';
    const query = parseGroupListQuery(req.query);
    res.json(await groupWhitelist.listGroups(query));
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
// "se le retiro la licencia", que no es lo mismo al atender a un cliente.
router.get('/:groupId', async (req, res) => {
    res.locals.routeLabel = 'GET /admin/groups/:groupId';
    const groupId = parseGroupId(req.params.groupId);

    const group = await groupWhitelist.getGroup(groupId);
    res.json({
        groupId,
        authorized: groupWhitelist.isAuthorized(group),
        found: group !== null,
        active: group?.active ?? false,
        createdAt: group?.createdAt ?? null,
    });
});

// DELETE /admin/groups/:groupId?purge=1
//
// Por defecto DESACTIVA (active = false) y conserva la fila: queda constancia
// de que ese grupo estuvo autorizado y desde cuando, que es lo que hace falta
// el dia que alguien reclame. `purge=1` borra la fila de verdad.
//
// Aqui si es 404 cuando el grupo no existe, al contrario que en el GET: dar
// de baja algo que no esta en la lista no es una operacion con resultado
// valido, es una equivocacion que conviene ver.
router.delete('/:groupId', async (req, res) => {
    res.locals.routeLabel = 'DELETE /admin/groups/:groupId';
    const groupId = parseGroupId(req.params.groupId);
    const purge = parseBooleanFlag(req.query.purge, 'purge');

    const result = await groupWhitelist.removeGroup(groupId, { purge });
    res.json({
        groupId: result.groupId,
        active: result.active,
        createdAt: result.createdAt,
        authorized: false,
        purged: result.purged,
    });
});

module.exports = router;
