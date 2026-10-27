'use strict';

// /msg: el bot escribe lo que pone el owner.
//
// Lo que protegen:
//   1. SÓLO EL OWNER: a cualquier otro se le dice que no y no se envía nada.
//   2. SALE COMO MENSAJE DEL BOT: con channel.send, nunca como respuesta a la
//      interacción (eso pondría "X usó /msg" encima). La confirmación es efímera.
//   3. \n ES UN SALTO DE LÍNEA, y se puede elegir otro canal o mandar un archivo.

const fs = require('fs');
const path = require('path');

const { createSuite } = require('./testHarness');
const config = require('../../config');
const commands = require('../../handlers/commands');

const RAIZ = path.join(__dirname, '..', '..');

function canalFalso(id) {
    const c = { id, enviados: [], send: async p => { c.enviados.push(p); return { id: 'm' }; } };
    return c;
}

function interaccion({ userId = config.OWNER_ID, mensaje = null, canal = null, archivo = null, aqui = canalFalso('aqui'), otros = {} } = {}) {
    const it = {
        replied: false, deferred: false, user: { id: userId }, channel: aqui, respuestas: [], publicas: [],
        options: {
            getString: n => (n === 'mensaje' ? mensaje : null),
            getChannel: n => (n === 'canal' ? canal : null),
            getAttachment: n => (n === 'archivo' ? archivo : null),
        },
        client: { channels: { fetch: async id => otros[id] ?? null } },
        reply: async o => { it.replied = true; it.respuestas.push(o); },
        deferReply: async o => { it.deferred = true; it.diferido = o; },
        editReply: async o => { it.respuestas.push(o); },
    };
    return it;
}

const efimera = o => o?.ephemeral === true || ((o?.flags ?? 0) & 64) === 64;

module.exports = async function run() {
    const { assert, finish } = createSuite('msg');

    // ── 1. Sólo el owner ─────────────────────────────────────────────────────
    let it = interaccion({ userId: '999999999999999999', mensaje: 'hola' });
    await commands.handleMsg(it);
    assert(it.channel.enviados.length === 0 && /No tienes permiso/.test(it.respuestas[0]?.content ?? ''),
        'alguien sin permiso no puede hacer hablar al bot');

    // ── 2. Sale como mensaje del bot ─────────────────────────────────────────
    it = interaccion({ mensaje: 'Bienvenidos a **7x**\\nTenemos stock' });
    await commands.handleMsg(it);
    assert(it.channel.enviados.length === 1, 'el owner lo envía en el canal donde está');
    assert(it.channel.enviados[0].content === 'Bienvenidos a **7x**\nTenemos stock', 'tal cual, con \\n convertido en salto de línea');
    assert(efimera(it.diferido) && it.respuestas.every(r => !r.content?.includes('Bienvenidos')),
        'la respuesta a la interacción es efímera y no repite el mensaje');
    assert(/Mensaje enviado/.test(it.respuestas.at(-1)?.content ?? ''), 'y confirma que se envió');

    // ── 3. Otro canal, archivo, vacío ────────────────────────────────────────
    const anuncios = canalFalso('anuncios');
    it = interaccion({ mensaje: 'Nuevo stock', canal: { id: 'anuncios' }, otros: { anuncios } });
    await commands.handleMsg(it);
    assert(anuncios.enviados.length === 1 && it.channel.enviados.length === 0, 'se puede enviar a otro canal');
    assert(it.respuestas.at(-1).content.includes('<#anuncios>'), 'y dice dónde');

    it = interaccion({ archivo: { url: 'https://cdn/x.png', name: 'x.png' } });
    await commands.handleMsg(it);
    assert(it.channel.enviados[0]?.files?.[0]?.attachment === 'https://cdn/x.png' && !('content' in it.channel.enviados[0]),
        'se puede mandar sólo un archivo');

    it = interaccion({ mensaje: '   ' });
    await commands.handleMsg(it);
    assert(it.channel.enviados.length === 0 && /Escribe un mensaje/.test(it.respuestas[0]?.content ?? ''), 'vacío no se envía');

    it = interaccion({ mensaje: 'hola', aqui: canalFalso('x') });
    it.channel.send = async () => { throw new Error('Missing Permissions'); };
    await commands.handleMsg(it);
    assert(/No se pudo enviar.*Missing Permissions/.test(it.respuestas.at(-1)?.content ?? ''), 'si Discord lo rechaza, se le dice al owner');

    const MAIN = fs.readFileSync(path.join(RAIZ, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
    assert(/name: 'msg',\n\s*description:/.test(MAIN) && /commandName === 'msg'/.test(MAIN), '/msg está registrado y enrutado');

    return finish();
};
