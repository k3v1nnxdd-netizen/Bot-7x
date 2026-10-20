'use strict';

// Tests del panel de la calculadora, al pasarlo de embed a tarjeta.
//
// Lo que protegen:
//
//   1. UN MENSAJE V2 NO TIENE `embeds`. La comprobación de antes exigía
//      `msg.embeds.length > 0` para reconocer el panel. Con la tarjeta nueva eso
//      no se cumple nunca, así que CADA arranque publicaría otro panel y el
//      canal se llenaría de calculadoras. Es el fallo que no avisa: el bot
//      arranca bien, no hay error en consola y el canal se va llenando.
//   2. EL PANEL VIEJO TIENE QUE ENCONTRARSE IGUAL. El que ya está publicado y
//      fijado es un embed clásico. Si no se reconoce, se queda ahí huérfano al
//      lado del nuevo en vez de convertirse en sitio.
//   3. LOS customId NO CAMBIAN. `calc_dinero` y `calc_robux` son los que enruta
//      handlers/buttons.js; renombrarlos deja los botones sin responder.
//   4. LOS BOTONES VAN DENTRO DEL BLOQUE, que es lo que se pidió.

const fs = require('fs');
const path = require('path');

const { createSuite } = require('./testHarness');
const config = require('../../config');
const v2 = require('../../utils/panelV2');
const { ensureCalcPanel, __test: calc } = require('../../calc');

const RAIZ = path.join(__dirname, '..', '..');
const BOT = 'bot-de-prueba';

function nodos(json) {
    const out = [];
    (function rec(n) {
        if (Array.isArray(n)) return n.forEach(rec);
        if (!n || typeof n !== 'object') return;
        out.push(n);
        rec(n.components);
        rec(n.accessory);
    })(json);
    return out;
}

module.exports = async function run() {
    const { assert, finish } = createSuite('calc');

    const json = calc.buildContainer().toJSON();
    const planos = nodos([json]);

    // ── 1. Los botones, dentro del bloque ────────────────────────────────────
    assert(json.type === 17, 'el panel es un Container, no un embed');
    assert(json.accent_color === calc.ACCENT, 'con la barra gris del resto del bot');

    const botones = planos.filter(n => n.type === 2);
    assert(botones.length === 2, `hay dos botones (${botones.length})`);
    assert(botones.every(b => b.custom_id?.startsWith('calc_')), 'y los dos van DENTRO del contenedor');

    // ── 2. Los customId no cambian ───────────────────────────────────────────
    const ids = botones.map(b => b.custom_id);
    for (const id of ['calc_dinero', 'calc_robux']) {
        assert(ids.includes(id), `el botón ${id} conserva su customId`);
    }
    const BOTONES = fs.readFileSync(path.join(RAIZ, 'handlers', 'buttons.js'), 'utf8');
    for (const id of ids) {
        assert(new RegExp(`${id}:\\s*on`).test(BOTONES), `${id} sigue enrutado en handlers/buttons.js`);
    }
    // El guard los ata al canal de la calculadora: si cambiaran de nombre, la
    // guarda dejaría de reconocerlos y responderían desde cualquier canal.
    assert(/CALC_BUTTONS\s*=\s*new Set\(\['calc_dinero', 'calc_robux'\]\)/.test(BOTONES),
        'y la guarda de canal sigue nombrándolos a los dos');

    // ── 3. El mensaje que se envía ───────────────────────────────────────────
    const payload = calc.buildPayload();
    assert((payload.flags & 32768) === 32768, 'el mensaje lleva el flag de Components V2');
    assert(!('content' in payload) && !('embeds' in payload),
        'y sin content ni embeds, que Discord rechazaría con ese flag');

    // ── 4. El texto no se pierde en la conversión ────────────────────────────
    const texto = calc.buildTexto();
    for (const trozo of [
        calc.TITULO,
        'cuántos Robux puedes comprar',
        'cantidad de dinero que tienes',
        'cantidad de Robux que deseas',
        'Cálculo instantáneo y automático',
        'Precios actualizados',
        'Fácil y rápido',
        'Presiona uno de los botones',
    ]) {
        assert(texto.includes(trozo), `el panel sigue diciendo: ${trozo.slice(0, 38)}…`);
    }
    assert(texto.startsWith('# '), 'el título va como encabezado del texto, donde Discord sí pinta los emojis');

    // ── 5. Reconocer los DOS formatos ────────────────────────────────────────
    const nuevo = { author: { id: BOT }, content: '', embeds: [], components: [calc.buildContainer().toJSON()] };
    assert(calc.isCalcMsg(nuevo, BOT), 'reconoce el panel nuevo (tarjeta, sin embeds)');
    assert(!calc.isCalcMsg(nuevo, 'otro-bot'), 'y no adopta el de otro autor');

    // El que ya está publicado en el canal: embed clásico con la fila colgando.
    const viejo = {
        author: { id: BOT },
        content: '',
        embeds: [{ description: `# ${calc.TITULO}\n\nTexto viejo`, title: null }],
        components: [{ type: 1, components: [{ type: 2, custom_id: 'calc_dinero', style: 2 }] }],
    };
    assert(calc.isCalcMsg(viejo, BOT), 'y reconoce el panel VIEJO, para convertirlo en vez de duplicarlo');

    // Y el formato aún más viejo, con el nombre en el título del embed.
    const antiguo = {
        author: { id: BOT }, content: '', components: [],
        embeds: [{ title: calc.TITULO, description: 'algo' }],
    };
    assert(calc.isCalcMsg(antiguo, BOT), 'incluido el que llevaba el nombre en el título');

    // Un mensaje cualquiera del bot en ese canal NO es el panel.
    const ajeno = { author: { id: BOT }, content: 'hola', embeds: [], components: [] };
    assert(!calc.isCalcMsg(ajeno, BOT), 'un mensaje suelto del bot no se confunde con el panel');

    assert(v2.isUpToDate(nuevo, calc.buildContainer()), 'un panel recién publicado ya está al día: no se reedita');

    // ── 6. Reiniciar no duplica, y el panel viejo se migra ───────────────────
    for (const escenario of await simularReinicios()) assert(escenario.ok, escenario.msg);

    return finish();
};

// Canal de Discord falso, lo justo para ensureCalcPanel.
function canalFalso() {
    const mensajes = [];
    let n = 0;
    const canal = {
        id: config.CHANNELS.CALC,
        enviados: 0,
        editados: 0,
        sinFetchPins: false,
        messages: {
            fetchPins: async () => {
                if (canal.sinFetchPins) throw new Error('403 Missing Access');
                return { items: mensajes.filter(m => m.pinned).map(message => ({ message })), hasMore: false };
            },
            fetch: async ({ limit }) => {
                const recientes = mensajes.slice(-limit).reverse();
                const col = new Map(recientes.map(m => [m.id, m]));
                col.find = fn => recientes.find(fn);
                return col;
            },
        },
        send: async payload => {
            canal.enviados++;
            const msg = nuevoMensaje(`m${++n}`, payload);
            mensajes.push(msg);
            return msg;
        },
        // Mete en el canal el panel VIEJO: embed clásico, fijado, como el que
        // hay publicado ahora mismo.
        plantarViejo: () => {
            const msg = {
                id: `v${++n}`, pinned: true, author: { id: BOT },
                content: '', channel: canal,
                embeds: [{ description: `# ${require('../../calc').__test.TITULO}\n\nTexto viejo`, title: null }],
                components: [{ type: 1, components: [{ type: 2, custom_id: 'calc_dinero', style: 2 }] }],
                edit: async p => { canal.editados++; Object.assign(msg, normaliza(p)); return msg; },
                pin: async () => { msg.pinned = true; },
                delete: async () => {},
            };
            mensajes.push(msg);
            return msg;
        },
        ruido: cantidad => {
            for (let i = 0; i < cantidad; i++) {
                mensajes.push({ id: `r${++n}`, pinned: false, author: { id: 'humano' }, content: 'hola', embeds: [], components: [] });
            }
        },
        despinnear: () => mensajes.forEach(m => { m.pinned = false; }),
    };

    function normaliza(p) {
        return {
            components: (p.components ?? []).map(c => (typeof c.toJSON === 'function' ? c.toJSON() : c)),
            embeds: p.embeds ?? [],
            content: p.content ?? '',
        };
    }

    function nuevoMensaje(id, payload) {
        const msg = {
            id, pinned: false, author: { id: BOT }, channel: canal,
            ...normaliza(payload),
            pin: async () => { msg.pinned = true; },
            edit: async p => { canal.editados++; Object.assign(msg, normaliza(p)); return msg; },
            delete: async () => {},
        };
        return msg;
    }

    return canal;
}

async function simularReinicios() {
    const nuevo = () => {
        const canal = canalFalso();
        const client = { user: { id: BOT }, channels: { cache: new Map([[canal.id, canal]]), fetch: async () => canal } };
        return { canal, client };
    };

    const out = [];

    // Cuatro arranques seguidos: un panel y ni un edit de más.
    const a = nuevo();
    for (let i = 0; i < 4; i++) await ensureCalcPanel(a.client);
    out.push({ ok: a.canal.enviados === 1, msg: `4 arranques publican UN panel (fueron ${a.canal.enviados})` });
    out.push({ ok: a.canal.editados === 0, msg: 'y no reeditan nada si ya está al día' });

    // El panel VIEJO, el que hay publicado hoy: se convierte en sitio.
    const b = nuevo();
    const viejo = b.canal.plantarViejo();
    await ensureCalcPanel(b.client);
    out.push({ ok: b.canal.enviados === 0, msg: 'el panel viejo no se duplica: se reaprovecha' });
    out.push({ ok: b.canal.editados === 1, msg: 'se convierte en tarjeta en su sitio' });
    out.push({
        ok: nodos(viejo.components).some(n => n.type === 2 && n.custom_id === 'calc_dinero'),
        msg: 'y queda con los botones dentro del contenedor',
    });
    out.push({ ok: viejo.embeds.length === 0, msg: 'sin el embed viejo, que Discord rechazaría junto al flag V2' });
    // Y un segundo arranque ya no lo toca.
    await ensureCalcPanel(b.client);
    out.push({ ok: b.canal.editados === 1 && b.canal.enviados === 0, msg: 'el arranque siguiente ya no lo vuelve a tocar' });

    // Enterrado bajo mensajes de gente: 150 y 400 son los casos que se escapan
    // al mirar sólo los últimos 100.
    for (const ruido of [99, 150, 400]) {
        const { canal, client } = nuevo();
        await ensureCalcPanel(client);
        canal.ruido(ruido);
        await ensureCalcPanel(client);
        out.push({ ok: canal.enviados === 1, msg: `con ${ruido} mensajes encima, el reinicio no lo duplica` });
    }

    // Sin poder leer los fijados: el respaldo de 100 lo encuentra igual.
    const c = nuevo();
    await ensureCalcPanel(c.client);
    c.canal.sinFetchPins = true;
    c.canal.ruido(20);
    await ensureCalcPanel(c.client);
    out.push({ ok: c.canal.enviados === 1, msg: 'sin acceso a los fijados, el respaldo de 100 lo encuentra' });

    // Desfijado a mano: se reaprovecha y se vuelve a fijar.
    const d = nuevo();
    await ensureCalcPanel(d.client);
    d.canal.despinnear();
    await ensureCalcPanel(d.client);
    out.push({ ok: d.canal.enviados === 1, msg: 'un panel desfijado a mano se reaprovecha' });

    // Canal inaccesible: no tumba el arranque.
    const sinCanal = { user: { id: BOT }, channels: { cache: new Map(), fetch: async () => { throw new Error('404'); } } };
    let exploto = false;
    try { await ensureCalcPanel(sinCanal); } catch { exploto = true; }
    out.push({ ok: !exploto, msg: 'un canal inaccesible no tumba el arranque del bot' });

    return out;
}
