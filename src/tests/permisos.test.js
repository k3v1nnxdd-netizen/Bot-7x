'use strict';

// Tests de quién puede hacer cosas de owner.
//
// Nace de un cambio concreto: dar permisos de owner a una segunda persona. Ese
// chequeo estaba copiado a mano en once sitios (`interaction.user.id !==
// config.OWNER_ID`), y el problema de eso no es la repetición: es que olvidarse
// de UNO no da ningún error. Esa acción sigue siendo sólo del dueño, en
// silencio, hasta que alguien la necesita y no puede.
//
// Por eso este fichero no se limita a probar la función: RECORRE el código
// buscando comparaciones sueltas contra OWNER_ID. Si alguien añade un comando
// nuevo con el chequeo copiado, el test lo caza.
//
// Lo que protege:
//
//   1. TODO PERMISO PASA POR utils/permisos.js. Ni un `=== config.OWNER_ID`
//      suelto en un handler.
//   2. EL DUEÑO SIEMPRE ES ADMIN. La lista se construye desde OWNER_ID, así que
//      no puede quedarse fuera de sus propios permisos por una errata.
//   3. UN ID CUALQUIERA NO ES ADMIN. Lo obvio, pero es la mitad de la función.
//   4. LOS IDS SE COMPARAN COMO CADENA. Un snowflake de Discord pasa de
//      Number.MAX_SAFE_INTEGER: comparado como número, dos ids distintos pueden
//      dar iguales.

const fs = require('fs');
const path = require('path');

const { createSuite } = require('./testHarness');
const config = require('../../config');
const { esAdmin, esAdminDeInteraccion, puedeGestionarTicket } = require('../../utils/permisos');

const RAIZ = path.join(__dirname, '..', '..');

// Los ficheros donde vive la lógica de permisos. No se recorre el repo entero:
// outfit-api es otro servicio con su propia autenticación.
const CARPETAS = ['handlers', 'utils'];
const SUELTOS = ['main.js', 'config.js'];

function ficherosJs() {
    const out = SUELTOS.map(f => path.join(RAIZ, f));
    for (const carpeta of CARPETAS) {
        const dir = path.join(RAIZ, carpeta);
        for (const f of fs.readdirSync(dir)) {
            if (f.endsWith('.js')) out.push(path.join(dir, f));
        }
    }
    return out;
}

module.exports = async function run() {
    const { assert, finish } = createSuite('permisos');

    const NUEVO = '620310742138224661';

    // ── 1. La lista ──────────────────────────────────────────────────────────
    assert(Array.isArray(config.ADMIN_IDS), 'config.ADMIN_IDS es una lista');
    assert(config.ADMIN_IDS.includes(config.OWNER_ID), 'el dueño SIEMPRE está en ella (se construye desde OWNER_ID)');
    assert(config.ADMIN_IDS.includes(NUEVO), `el id ${NUEVO} tiene permisos de owner`);
    assert(new Set(config.ADMIN_IDS).size === config.ADMIN_IDS.length, 'y no hay ids repetidos');
    assert(
        config.ADMIN_IDS.every(id => /^\d{17,20}$/.test(id)),
        'todos son ids de Discord válidos'
    );

    // ── 2. esAdmin ───────────────────────────────────────────────────────────
    assert(esAdmin(config.OWNER_ID) === true, 'el dueño es admin');
    assert(esAdmin(NUEVO) === true, 'el nuevo también');
    assert(esAdmin('111111111111111111') === false, 'un id cualquiera no');
    assert(esAdmin(null) === false, 'null no es admin');
    assert(esAdmin(undefined) === false, 'undefined tampoco');
    assert(esAdmin('') === false, 'ni la cadena vacía');

    // Un snowflake NO cabe exacto en un número de JavaScript: al convertirlo se
    // redondea, y volverlo a cadena ya no lo recupera. Lo importante es hacia
    // qué lado se equivoca: DENIEGA.
    assert(Number(NUEVO) > Number.MAX_SAFE_INTEGER, 'un id de Discord no cabe en un número exacto');
    assert(String(Number(NUEVO)) !== NUEVO, 'convertirlo a número lo corrompe sin remedio');
    assert(esAdmin(Number(NUEVO)) === false, 'un id ya corrompido por el redondeo no da permisos: falla denegando');
    assert(esAdmin('620310742138224660') === false, 'y un id vecino tampoco se cuela');

    // ── 3. Interacciones y tickets ───────────────────────────────────────────
    assert(esAdminDeInteraccion({ user: { id: NUEVO } }) === true, 'se resuelve desde la interacción');
    assert(esAdminDeInteraccion({ user: { id: '999' } }) === false, 'y rechaza a quien no lo es');
    assert(esAdminDeInteraccion({}) === false, 'una interacción sin usuario no pasa');
    assert(esAdminDeInteraccion(null) === false, 'ni una interacción que no existe');

    const CLIENTE = '555555555555555555';
    assert(puedeGestionarTicket(CLIENTE, CLIENTE) === true, 'el cliente manda sobre SU ticket');
    assert(puedeGestionarTicket(NUEVO, CLIENTE) === true, 'y un admin sobre cualquiera');
    assert(puedeGestionarTicket(config.OWNER_ID, CLIENTE) === true, 'el dueño también');
    assert(puedeGestionarTicket('777777777777777777', CLIENTE) === false, 'un tercero no toca el ticket de otro');
    assert(puedeGestionarTicket(CLIENTE, null) === false, 'sin dueño del ticket, sólo un admin puede');
    assert(puedeGestionarTicket(NUEVO, null) === true, 'y un admin puede aunque el ticket no tenga dueño conocido');

    // ── 4. Ningún permiso suelto por ahí ─────────────────────────────────────
    // Lo que de verdad protege este fichero. Se permite nombrar OWNER_ID para
    // MENCIONAR al dueño (`<@${config.OWNER_ID}>`, el aviso del anti-estafa),
    // pero no para decidir quién puede hacer algo.
    const sospechosas = [];
    for (const fichero of ficherosJs()) {
        const nombre = path.relative(RAIZ, fichero);
        if (nombre === path.join('utils', 'permisos.js') || nombre === 'config.js') continue;

        const src = fs.readFileSync(fichero, 'utf8').replace(/\r\n/g, '\n');
        src.split('\n').forEach((linea, i) => {
            if (linea.trim().startsWith('//')) return;               // comentarios, no código
            if (!/config\.OWNER_ID/.test(linea)) return;
            if (/<@\$\{config\.OWNER_ID\}>/.test(linea)) return;      // una mención, no un permiso
            if (/[=!]==\s*config\.OWNER_ID|config\.OWNER_ID\s*[=!]==/.test(linea)) {
                sospechosas.push(`${nombre}:${i + 1}`);
            }
        });
    }
    assert(
        sospechosas.length === 0,
        sospechosas.length
            ? `hay comparaciones sueltas contra OWNER_ID (usa utils/permisos.js): ${sospechosas.join(', ')}`
            : 'ningún handler compara contra OWNER_ID por su cuenta: todos preguntan a utils/permisos.js'
    );

    // ── 5. Los sitios que DEBEN pedir permiso, lo piden ──────────────────────
    // Si alguien borrara el chequeo de uno de estos, el comando quedaría
    // abierto a cualquiera sin que nada fallara.
    const conPermiso = {
        'handlers/commands.js':      ['handlePagoVerified', 'handleOffer', 'handleClose', 'handleHeadless', 'handleGroupActive'],
        'handlers/buttons.js':       ['onConfirmarPago', 'onCerrarTicket', 'onConfirmarCerrar', 'onCancelarCerrar'],
        'handlers/groupLicenses.js': ['esOwner'],
        'utils/voice.js':            ['handleConnect'],
    };

    for (const [fichero, funciones] of Object.entries(conPermiso)) {
        const src = fs.readFileSync(path.join(RAIZ, fichero), 'utf8').replace(/\r\n/g, '\n');
        assert(src.includes('permisos'), `${fichero} usa utils/permisos.js`);

        for (const fn of funciones) {
            // El cuerpo de la función hasta la siguiente declaración.
            const desde = src.indexOf(`function ${fn}(`);
            assert(desde !== -1, `${fichero} sigue teniendo ${fn}()`);
            const cuerpo = src.slice(desde, desde + 900);
            assert(
                /esAdminDeInteraccion|puedeGestionarTicket|esAdmin\(/.test(cuerpo),
                `${fn}() comprueba permisos antes de hacer nada`
            );
        }
    }

    return finish();
};
