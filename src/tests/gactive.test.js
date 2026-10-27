'use strict';

// /gactive: el interruptor de las consultas de Check Group's por comunidad.
//
// Lo que protegen:
//   1. POR DEFECTO SE PUEDE CONSULTAR (como antes de existir el interruptor).
//   2. APAGADA, NO SE CONSULTA: ni se abre el formulario, ni se acepta uno que
//      ya estuviera abierto — y no se gasta ninguna petición a Roblox.
//   3. ES INDEPENDIENTE DE /groupactive (estado de envío de Robux).
//   4. SÓLO EL OWNER LO CAMBIA, y sobrevive a un reinicio.

const fs = require('fs');
const path = require('path');

const { createSuite } = require('./testHarness');
const config = require('../../config');
const { dataPath } = require('../../utils/dataDir');
const cq = require('../../utils/consultasGrupo');
const groupActive = require('../../utils/groupActive');
const membership = require('../../utils/groupMembership');
const flow = require('../../handlers/checkGroupFlow');
const commands = require('../../handlers/commands');

const RAIZ = path.join(__dirname, '..', '..');

function limpiar() {
    const f = dataPath('consultasGrupo.json');
    if (fs.existsSync(f)) fs.unlinkSync(f);
}

function interaccion(extra = {}) {
    const it = {
        replied: false, deferred: false, user: { id: '123456789012345678' }, respuestas: [], modales: [],
        reply: async o => { it.replied = true; it.respuestas.push(o); },
        deferReply: async () => { it.deferred = true; },
        editReply: async o => { it.respuestas.push(o); },
        showModal: async m => { it.modales.push(m); },
        ...extra,
    };
    return it;
}

module.exports = async function run() {
    const { assert, finish } = createSuite('gactive');
    const [clave, otra] = Object.keys(config.CHECK_GROUPS);
    const label = config.CHECK_GROUPS[clave].label;

    // ── 1. Por defecto, disponible ───────────────────────────────────────────
    limpiar();
    assert(cq.getState().every(g => g.disponible), 'sin configurar, todas las comunidades se pueden consultar');

    let it = interaccion({ customId: `cg_${clave}` });
    await flow.handleCheckGroupButton(it);
    assert(it.modales.length === 1, 'encendida, el botón abre el formulario');

    // ── 2. Apagada ───────────────────────────────────────────────────────────
    assert(cq.setDisponible(clave, false, 'owner').changed === true, 'se apaga');
    assert(!cq.disponible(clave) && cq.disponible(otra), 'sólo esa comunidad');

    it = interaccion({ customId: `cg_${clave}` });
    await flow.handleCheckGroupButton(it);
    const msg = it.respuestas[0]?.content ?? '';
    assert(it.modales.length === 0, 'apagada, no se abre el formulario');
    assert(msg.includes(`La consulta de ${label} no está disponible en este momento`) && /inconveniente/.test(msg),
        'y se dice, de forma profesional, que no está disponible ahora');
    assert(((it.respuestas[0]?.flags ?? 0) & 64) === 64 || it.respuestas[0]?.ephemeral === true, 'sólo lo ve quien lo intentó');

    // Formulario que ya estaba abierto al apagarla: tampoco consulta.
    const original = membership.checkMembership;
    let consultas = 0;
    membership.checkMembership = async () => { consultas++; throw new Error('no debería llamarse'); };
    try {
        it = interaccion({ customId: `cg_modal_${clave}`, fields: { getTextInputValue: () => 'Builderman' } });
        await flow.handleCheckGroupModal(it);
        assert(consultas === 0 && /no está disponible en este momento/.test(it.respuestas[0]?.content ?? ''),
            'un formulario enviado después de apagarla tampoco consulta a Roblox');
    } finally {
        membership.checkMembership = original;
    }

    // ── 3. Independiente de /groupactive ─────────────────────────────────────
    const envioAntes = groupActive.isActive(clave);
    cq.setDisponible(clave, true);
    cq.setDisponible(clave, false);
    assert(groupActive.isActive(clave) === envioAntes, 'apagar las consultas no cambia el estado de envío de Robux');
    assert(!fs.readFileSync(path.join(RAIZ, 'utils', 'consultasGrupo.js'), 'utf8').includes("groupActive.json"),
        'y se guardan en su propio fichero');

    // ── 4. Reinicio y permisos ───────────────────────────────────────────────
    delete require.cache[require.resolve('../../utils/consultasGrupo')];
    assert(require('../../utils/consultasGrupo').disponible(clave) === false, 'tras un reinicio sigue apagada');
    assert(cq.setDisponible('no-existe', false).ok === false, 'una comunidad que no existe no se guarda');

    const cmd = (estado, userId) => interaccion({
        user: { id: userId }, member: null, guild: null,
        options: { getString: n => (n === 'grupo' ? clave : estado) },
    });
    it = cmd('on', '999999999999999999');
    await commands.handleGActive(it);
    assert(/No tienes permiso/.test(it.respuestas[0]?.content ?? '') && !cq.disponible(clave), 'alguien sin permiso no puede cambiarlo');

    it = cmd('on', config.OWNER_ID);
    await commands.handleGActive(it);
    const r = it.respuestas[0]?.content ?? '';
    assert(cq.disponible(clave) && /ACTIVADAS/.test(r), 'el owner lo vuelve a encender');
    assert(/Estado de las consultas/.test(r) && Object.values(config.CHECK_GROUPS).every(g => r.includes(g.label)),
        'y ve el estado de todas las comunidades');

    const MAIN = fs.readFileSync(path.join(RAIZ, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
    assert(/name: 'gactive',\n\s*description:/.test(MAIN) && /commandName === 'gactive'/.test(MAIN), '/gactive está registrado y enrutado');

    limpiar();
    return finish();
};
