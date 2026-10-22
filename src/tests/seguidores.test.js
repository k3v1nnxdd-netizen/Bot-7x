'use strict';

// Tests del interruptor de la venta de seguidores (`config.FEATURES.SEGUIDORES`).
//
// Lo que protegen:
//
//   1. APAGADO SE CIERRAN TODAS LAS ENTRADAS. No basta con quitar el botón: la
//      línea del texto, el botón, el panel del canal y el clic desde un panel
//      viejo sin reeditar son cuatro puertas distintas, y dejarse una deja la
//      venta medio abierta.
//   2. ENCENDIDO VUELVE TODO. Es la mitad de lo que se pidió: una copia que se
//      pueda reactivar. Si volver a venderlos costara algo más que cambiar el
//      interruptor, el "por si después sí" no serviría de nada.
//   3. EL TEXTO Y LOS BOTONES NO PUEDEN DIVERGIR. Antes eran dos listas
//      escritas a mano: apagar una opción habría dejado el panel anunciando
//      algo que ya no tiene botón.
//   4. LOS TICKETS YA ABIERTOS SIGUEN FUNCIONANDO. Se corta la entrada, no lo
//      que ya empezó: quien esté a medio pedido se quedaría con un ticket
//      muerto. El tipo 'seguidores' tiene que seguir leyéndose en el registro
//      de pedidos y en el flujo de reseñas.

const fs = require('fs');
const path = require('path');

const { createSuite } = require('./testHarness');
const config = require('../../config');
const { __test: panel } = require('../../panel');
const { ensureSeguidoresPanel } = require('../../seguidores');
const { startSeguidoresTicket } = require('../../handlers/seguidoresFlow');

const RAIZ = path.join(__dirname, '..', '..');

// Corre `fn` con el interruptor en `valor` y lo deja como estaba.
async function con(valor, fn) {
    const antes = config.FEATURES.SEGUIDORES;
    config.FEATURES.SEGUIDORES = valor;
    try { return await fn(); } finally { config.FEATURES.SEGUIDORES = antes; }
}

function idsDeBotones() {
    return panel.buildButtons().toJSON().components.map(b => b.custom_id);
}

// Panel falso: si se intentara publicar, se nota.
function clienteFalso() {
    const canal = {
        id: config.CHANNELS.SEGUIDORES,
        enviados: 0,
        messages: { fetch: async () => { const m = new Map(); m.find = () => null; return m; } },
        send: async () => { canal.enviados++; return { id: 'm1', pin: async () => {} }; },
    };
    return { canal, client: { user: { id: 'bot' }, channels: { cache: new Map([[canal.id, canal]]), fetch: async () => canal } } };
}

async function clicEnElBoton() {
    const respuestas = [];
    const it = {
        replied: false, deferred: false,
        user: { id: '1' }, guild: {},
        reply: async o => { it.replied = true; respuestas.push(o); },
    };
    await startSeguidoresTicket(it);
    return respuestas;
}

module.exports = async function run() {
    const { assert, finish } = createSuite('seguidores');

    // ── 0. Hoy está apagado ──────────────────────────────────────────────────
    assert(config.FEATURES.SEGUIDORES === false, 'la venta de seguidores viene apagada');

    // ── 1. Apagado: las cuatro entradas cerradas ─────────────────────────────
    await con(false, async () => {
        const texto = panel.buildOpciones();
        assert(!/seguidores/i.test(texto), 'el panel de tickets no menciona seguidores');
        assert(!idsDeBotones().includes('seguidores'), 'y no tiene su botón');

        const { canal, client } = clienteFalso();
        const r = await ensureSeguidoresPanel(client);
        assert(r === null && canal.enviados === 0, 'el panel del canal de seguidores no se publica');

        // La cuarta puerta: un panel viejo sin reeditar todavía.
        const respuestas = await clicEnElBoton();
        assert(respuestas.length === 1, 'pulsar el botón de un panel viejo responde algo');
        assert(/cerrada/i.test(respuestas[0]?.content ?? ''), 'y dice que la venta está cerrada');
        // safeReply convierte `ephemeral: true` en el bit 64 de `flags`.
        assert((respuestas[0]?.flags & 64) === 64, 'en efímero, sin ensuciar el canal');
    });

    // ── 2. Encendido: vuelve todo, sin tocar nada más ────────────────────────
    await con(true, async () => {
        const texto = panel.buildOpciones();
        assert(/seguidores/i.test(texto), 'encendiéndolo, el panel vuelve a ofrecerlo');
        assert(idsDeBotones().includes('seguidores'), 'y el botón vuelve');

        // El botón ya no contesta que está cerrada: sigue su camino normal
        // (sin guild de verdad no llega a crear nada, pero no es el rechazo).
        const respuestas = await clicEnElBoton().catch(() => []);
        const dijoCerrada = respuestas.some(r => /cerrada/i.test(r?.content ?? ''));
        assert(!dijoCerrada, 'y el botón deja de rechazar');
    });

    // El interruptor no se queda pegado: tras las dos pruebas sigue apagado.
    assert(config.FEATURES.SEGUIDORES === false, 'el interruptor vuelve a su sitio');

    // ── 3. Texto y botones, de la misma lista ────────────────────────────────
    for (const valor of [true, false]) {
        await con(valor, async () => {
            const ids = idsDeBotones();
            const texto = panel.buildOpciones();
            assert(ids.length === texto.split('\n').length,
                `con SEGUIDORES=${valor}, hay tantas líneas como botones (${texto.split('\n').length} y ${ids.length})`);
            for (const o of panel.opcionesActivas()) {
                assert(texto.includes(`**${o.label}**`), `con SEGUIDORES=${valor}, "${o.label}" sale en el texto`);
                assert(ids.includes(o.id), `y tiene su botón`);
            }
            assert(ids.length <= 5, 'y caben en una fila de Discord');
        });
    }

    const PANEL = fs.readFileSync(path.join(RAIZ, 'panel.js'), 'utf8');
    assert(/opcionesActivas\(\)\.map/.test(PANEL), 'los botones se derivan de la lista, no están escritos a mano');
    assert(!/setCustomId\('seguidores'\)/.test(PANEL), 'y ya no hay un botón de seguidores suelto en el código');

    // ── 4. Los tickets ya abiertos siguen vivos ──────────────────────────────
    // Se corta la ENTRADA, no el flujo de dentro. Quien esté a medio pedido
    // tiene que poder terminarlo.
    const { TIPO_LABEL } = (() => {
        const orderNotify = fs.readFileSync(path.join(RAIZ, 'utils', 'orderNotify.js'), 'utf8');
        const reviewFlow  = fs.readFileSync(path.join(RAIZ, 'utils', 'reviewFlow.js'), 'utf8');
        const buttons     = fs.readFileSync(path.join(RAIZ, 'handlers', 'buttons.js'), 'utf8');
        const modals      = fs.readFileSync(path.join(RAIZ, 'handlers', 'modals.js'), 'utf8');
        const main        = fs.readFileSync(path.join(RAIZ, 'main.js'), 'utf8');
        return { TIPO_LABEL: { orderNotify, reviewFlow, buttons, modals, main } };
    })();

    assert(/seguidores: 'Seguidores'/.test(TIPO_LABEL.orderNotify), 'el registro de pedidos sigue sabiendo leer un ticket de seguidores');
    assert(/ticketType === 'seguidores'/.test(TIPO_LABEL.reviewFlow), 'y el flujo de reseñas también');
    assert(/isSeg \? handleSeguidoresButton/.test(TIPO_LABEL.buttons), 'los botones seg_* siguen enrutados');
    assert(/isSeg \? handleSeguidoresModal/.test(TIPO_LABEL.modals), 'y sus modales');
    assert(/startsWith\('seg_'\)\) await handleSeguidoresSelect/.test(TIPO_LABEL.main), 'y el desplegable de plataforma');

    // El arranque sigue llamando a la función, que es la que decide: dejar de
    // llamarla la dejaría sin forma de volver cuando se encienda.
    assert(/await ensureSeguidoresPanel\(client\)/.test(TIPO_LABEL.main), 'el arranque sigue llamando al panel, que decide por sí mismo');

    return finish();
};
