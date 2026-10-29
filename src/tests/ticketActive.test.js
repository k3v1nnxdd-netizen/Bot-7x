'use strict';

// /ticketactive: apagar un apartado del panel de tickets con una razón.
//
// Lo que protegen:
//   1. POR DEFECTO TODO SE PUEDE ABRIR (como antes de existir el interruptor).
//   2. APAGADO, NO SE ABRE EL TICKET y quien lo pulsa lee el motivo; los demás
//      apartados siguen igual.
//   3. EL PANEL LO MARCA, pero el botón sigue ahí (si no, nadie leería el motivo).
//   4. SÓLO EL OWNER LO CAMBIA, y sobrevive a un reinicio.

const fs = require('fs');
const path = require('path');

const { createSuite } = require('./testHarness');
const config = require('../../config');
const { dataPath } = require('../../utils/dataDir');
const apartados = require('../../utils/apartadosTicket');
const panel = require('../../panel');
const { handleButton } = require('../../handlers/buttons');
const commands = require('../../handlers/commands');

const RAIZ = path.join(__dirname, '..', '..');

function limpiar() {
    const f = dataPath('apartadosTicket.json');
    if (fs.existsSync(f)) fs.unlinkSync(f);
}

function interaccion(extra = {}) {
    const it = {
        replied: false, deferred: false, user: { id: '123456789012345678' }, respuestas: [],
        channelId: config.CHANNELS.PANEL, message: { id: 'panel' },
        client: { channels: { cache: { get: () => null } } },
        reply: async o => { it.replied = true; it.respuestas.push(o); },
        deferReply: async () => { it.deferred = true; },
        editReply: async o => { it.respuestas.push(o); },
        showModal: async () => { it.modal = true; },
        ...extra,
    };
    return it;
}

const textoPanel = () => JSON.stringify(panel.__test.buildContainer().toJSON());
const botonesPanel = () => panel.__test.buildButtons().flatMap(f => f.toJSON().components.map(b => b.custom_id));

module.exports = async function run() {
    const { assert, finish } = createSuite('ticketactive');

    // ── 1. Por defecto, todo abierto ─────────────────────────────────────────
    limpiar();
    assert(panel.OPCIONES.every(o => apartados.disponible(o.id)), 'sin configurar, todos los apartados se pueden abrir');
    assert(!textoPanel().includes('No disponible'), 'y el panel no marca ninguno');

    // ── 2. Apagado ───────────────────────────────────────────────────────────
    apartados.setEstado('comprar_gamepass', false, 'Sin stock de Robux por gamepass hasta el viernes.', 'owner');
    let it = interaccion({ customId: 'comprar_gamepass', message: { id: 'p1' } });
    await handleButton(it);
    const msg = it.respuestas[0]?.content ?? '';
    assert(!it.modal && /Los tickets de robux-gamepass no están disponibles en este momento/.test(msg),
        'pulsarlo apagado no abre nada y dice que no está disponible');
    assert(msg.includes('**Motivo:** Sin stock de Robux por gamepass hasta el viernes.'), 'con el motivo que puso el owner');
    assert(/Otra cosa/.test(msg), 'y ofrece Otra cosa si sigue abierto');
    assert(((it.respuestas[0]?.flags ?? 0) & 64) === 64 || it.respuestas[0]?.ephemeral === true, 'sólo lo ve quien lo pulsó');
    assert(apartados.disponible('comprar') && apartados.disponible('otra_cosa'), 'los demás apartados siguen abiertos');

    apartados.setEstado('duels', false, '', 'owner');
    assert(apartados.estado('duels').razon === apartados.RAZON_POR_DEFECTO, 'sin razón, sale una por defecto');

    // ── 3. El panel lo marca, y el botón sigue ───────────────────────────────
    const lineaGp = textoPanel().split('\\n').find(l => l.includes('**robux-gamepass**')) ?? '';
    assert(/No disponible/.test(lineaGp), 'el panel marca el apartado como no disponible');
    assert(botonesPanel().includes('comprar_gamepass'), 'pero su botón sigue, para que se lea el motivo');

    // ── 4. Reinicio, encender y permisos ─────────────────────────────────────
    delete require.cache[require.resolve('../../utils/apartadosTicket')];
    assert(require('../../utils/apartadosTicket').disponible('comprar_gamepass') === false, 'tras un reinicio sigue apagado');

    const cmd = (userId, estado, razon = null) => interaccion({
        user: { id: userId },
        options: { getString: n => ({ apartado: 'comprar_gamepass', estado, razon }[n] ?? null) },
    });
    it = cmd('999999999999999999', 'on');
    await commands.handleTicketActive(it);
    assert(/No tienes permiso/.test(it.respuestas[0]?.content ?? '') && !apartados.disponible('comprar_gamepass'),
        'alguien sin permiso no puede cambiarlo');

    it = cmd(config.OWNER_ID, 'on');
    await commands.handleTicketActive(it);
    const r = it.respuestas.at(-1)?.content ?? '';
    assert(apartados.disponible('comprar_gamepass') && /ACTIVADOS/.test(r), 'el owner lo vuelve a encender');
    assert(/Estado de los apartados/.test(r) && r.includes('Duels — off'), 'y ve el estado de todos');
    assert(!textoPanel().split('\\n').find(l => l.includes('**robux-gamepass**')).includes('No disponible'), 'el panel deja de marcarlo');

    it = cmd(config.OWNER_ID, 'off', 'Mantenimiento');
    await commands.handleTicketActive(it);
    assert(apartados.estado('comprar_gamepass').razon === 'Mantenimiento' && /Motivo que verán:\*\* Mantenimiento/.test(it.respuestas.at(-1)?.content ?? ''),
        'apagarlo desde el comando guarda la razón y se la enseña al owner');

    const MAIN = fs.readFileSync(path.join(RAIZ, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
    assert(/name: 'ticketactive',\n\s*description:/.test(MAIN) && /commandName === 'ticketactive'/.test(MAIN),
        '/ticketactive está registrado y enrutado');

    limpiar();
    return finish();
};
