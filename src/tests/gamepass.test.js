'use strict';

// Tests del panel y las calculadoras de gamepass.
//
// Aquí lo que se protege es dinero y una expectativa. La venta por gamepass
// tiene DOS cifras, no una:
//
//   - lo que el cliente PAGA, que va por el valor del gamepass que crea;
//   - lo que LLEGA a su cuenta, que es menos, porque Roblox se queda su
//     comisión de la venta y 7x no la cubre.
//
// Por eso:
//
//   1. LAS DOS CIFRAS SE ENSEÑAN SIEMPRE, en el panel y en las dos
//      calculadoras. Dar sólo el precio sería cobrar por 1.000 y entregar 700
//      sin decirlo, y el cliente tendría razón en quejarse.
//   2. EL PRECIO SALE DE config. Está en el panel, en el ejemplo del panel y en
//      las dos calculadoras: escrito a mano en alguno, cambiarlo dejaría al bot
//      cobrando una cosa y anunciando otra.
//   3. EL PRESUPUESTO NO SE PASA NUNCA. "Con $500 te alcanza X" tiene que
//      costar 500 o menos, jamás más.
//   4. UNA ENTRADA IMPOSIBLE NO DA UN PRECIO. Un 0, un negativo o un texto
//      convertidos en "$0 MXN" parecerían una oferta.

const fs = require('fs');
const path = require('path');

const { createSuite } = require('./testHarness');
const config = require('../../config');
const v2 = require('../../utils/panelV2');
const gp = require('../../utils/gamepassPrecios');
const { __test: panel } = require('../../gamepass');
const { handleModal, buildGpDineroModal, buildGpRobuxModal } = require('../../handlers/modals');

const RAIZ = path.join(__dirname, '..', '..');
const G = config.GAMEPASS;

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

// Envía un modal y devuelve { texto, campos, aviso }.
async function enviarModal(customId, campo, valor) {
    const r = [];
    const it = {
        replied: false, deferred: false, customId,
        fields: { getTextInputValue: n => (n === campo ? valor : '') },
        deferReply: async () => { it.deferred = true; },
        editReply: async o => r.push(o),
        reply: async o => r.push(o),
    };
    await handleModal(it);
    const o = r[0] ?? {};
    const e = o.embeds?.[0]?.toJSON?.() ?? o.embeds?.[0] ?? null;
    return {
        texto: o.content ?? null,
        campos: e ? Object.fromEntries(e.fields.map(f => [f.name.replace(/<a?:\w+:\d+>\s*/, ''), f.value])) : null,
        aviso: e?.description ?? null,
        pie: e?.footer?.text ?? null,
    };
}

module.exports = async function run() {
    const { assert, finish } = createSuite('gamepass');

    // ── 1. La aritmética ─────────────────────────────────────────────────────
    assert(gp.precioDe(1000) === G.PRECIO_POR_1K, `1.000 Robux cuestan ${G.PRECIO_POR_1K} MXN`);
    assert(gp.precioDe(2000) === G.PRECIO_POR_1K * 2, 'y 2.000 el doble');
    assert(gp.recibe(1000) === 700, 'de un gamepass de 1.000 llegan 700 tras la comisión de Roblox');
    assert(gp.recibe(1000) < 1000, 'siempre llega menos de lo que se paga: la comisión no la cubre 7x');

    // Nada de precios inventados a partir de basura.
    for (const malo of [0, -100, NaN, null, undefined, 'x']) {
        assert(gp.precioDe(malo) === null, `precioDe(${JSON.stringify(malo)}) no da precio`);
        assert(gp.recibe(malo) === null, `recibe(${JSON.stringify(malo)}) tampoco`);
        assert(gp.robuxPor(malo) === null, `ni robuxPor(${JSON.stringify(malo)})`);
    }

    // ── 2. El presupuesto no se pasa NUNCA ───────────────────────────────────
    // Es la propiedad que de verdad importa de robuxPor: decir "con $X te
    // alcanza Y" y que Y cueste más de X sería cobrar de más.
    let peor = 0;
    for (let dinero = G.PRECIO_POR_1K; dinero <= 20000; dinero += 7) {
        const robux = gp.robuxPor(dinero);
        if (robux === null) continue;
        const precio = gp.precioDe(robux);
        if (precio > dinero) { peor = dinero; break; }
    }
    assert(peor === 0, `en ~2.800 presupuestos distintos, el precio nunca se pasa (falló en ${peor})`);

    // Y lo que sobra es poco: redondear a la baja no puede tirar medio paquete.
    let sobraMax = 0;
    for (let dinero = 200; dinero <= 5000; dinero += 13) {
        const robux = gp.robuxPor(dinero);
        if (robux === null) continue;
        sobraMax = Math.max(sobraMax, dinero - gp.precioDe(robux));
    }
    assert(sobraMax <= Math.ceil(G.PRECIO_POR_1K / 100) + 1, `lo que sobra es calderilla (máximo ${sobraMax} MXN)`);

    assert(gp.robuxPor(G.PRECIO_POR_1K) === 1000, 'con el precio de 1k justo, alcanza exactamente 1.000');
    assert(gp.robuxPor(1) === null, 'con un peso no alcanza el mínimo');

    assert(gp.enRango(G.MIN_ROBUX) && gp.enRango(G.MAX_ROBUX), 'los extremos del rango entran');
    assert(!gp.enRango(G.MIN_ROBUX - 1) && !gp.enRango(G.MAX_ROBUX + 1), 'y lo de fuera no');

    // ── 3. El precio sale de config, no escrito a mano ───────────────────────
    const texto = panel.buildTexto();
    assert(texto.includes(gp.fmtMXN(G.PRECIO_POR_1K)), 'el panel anuncia el precio de config');
    assert(texto.includes(`${Math.round(G.TASA_ROBLOX * 100)}%`), 'y la comisión de Roblox de config');
    // El ejemplo del panel tiene que cuadrar con la calculadora.
    assert(texto.includes(gp.fmtMXN(gp.precioDe(1000))), 'el ejemplo usa el precio calculado');
    assert(texto.includes(`${gp.fmtRobux(gp.recibe(1000))} Robux`), 'y lo que de verdad se recibe');

    const FUENTE = fs.readFileSync(path.join(RAIZ, 'gamepass.js'), 'utf8');
    assert(!/\b115\b/.test(FUENTE), 'el precio no está escrito a mano en el panel');
    assert(!/\b30\s*%/.test(FUENTE), 'ni el porcentaje de la comisión');

    // La prueba de verdad: se cambia el precio en caliente y TODO tiene que
    // seguirlo. Mirar el fichero no basta — un 115 escrito a mano da el mismo
    // resultado mientras config diga 115, y el fallo sólo aparecería el día que
    // se suba el precio, cobrando una cosa y anunciando otra.
    const precioAntes = G.PRECIO_POR_1K;
    const tasaAntes   = G.TASA_ROBLOX;
    try {
        G.PRECIO_POR_1K = 200;
        G.TASA_ROBLOX   = 0.40;

        assert(gp.precioDe(1000) === 200, 'subir el precio en config cambia lo que cuesta');
        assert(gp.recibe(1000) === 600, 'y cambiar la comisión cambia lo que se recibe');

        const otro = panel.buildTexto();
        assert(otro.includes(gp.fmtMXN(200)), 'el panel anuncia el precio nuevo');
        assert(otro.includes('40%'), 'y la comisión nueva');
        assert(!otro.includes(gp.fmtMXN(precioAntes)), 'y ya no el viejo por ningún lado');

        const r = await enviarModal('gp_robux_modal', 'cantidad_robux', '1000');
        assert(r.campos?.['Precio total'] === gp.fmtMXN(200), 'la calculadora cobra el precio nuevo');
        assert(r.campos?.['Recibes en tu cuenta'] === '600 Robux', 'y descuenta la comisión nueva');
        assert(/40%/.test(r.pie ?? ''), 'hasta el pie de la ficha');
    } finally {
        G.PRECIO_POR_1K = precioAntes;
        G.TASA_ROBLOX   = tasaAntes;
    }
    assert(G.PRECIO_POR_1K === precioAntes && G.TASA_ROBLOX === tasaAntes, 'y el precio vuelve a su sitio');

    // ── 4. Lo que el panel tiene que decir ───────────────────────────────────
    const pide = [
        [/gamepass/i,                  'habla de gamepass'],
        [/crea[sr]?\b/i,               'dice que ellos crean el gamepass'],
        [/valor que vas a comprar/i,   'y que es por el valor que van a comprar'],
        [/no la cubrimos/i,            'deja claro que la comisión no la cubre 7x'],
        [/recibes/i,                   'y dice lo que recibe de verdad'],
    ];
    for (const [re, msg] of pide) assert(re.test(texto), msg);

    // ── 5. El bloque: GIF dentro y botones debajo ────────────────────────────
    const json = panel.buildContainer().toJSON();
    const planos = nodos([json]);
    const visibles = planos.filter(n => [10, 12, 2].includes(n.type));
    const iGif = visibles.findIndex(n => n.type === 12);
    const iBtn = visibles.findIndex(n => n.type === 2);

    assert(json.type === 17, 'el panel es un Container, no un embed');
    assert(json.accent_color === panel.ACCENT, 'con la barra gris del resto del bot');
    assert(panel.BANNER.exists, '7xCommunity_Gamepass_Discord.gif está en el repo');
    if (panel.BANNER.exists) {
        assert(iGif !== -1 && iGif < iBtn, 'el GIF va dentro del bloque y encima de los botones');
        assert(visibles[iGif].items?.[0]?.media?.url === `attachment://${panel.BANNER.name}`,
            'referenciado como adjunto, no por una URL que caduca');
        const bytes = fs.statSync(path.join(RAIZ, '7xCommunity_Gamepass_Discord.gif')).size;
        assert(bytes < 10 * 1024 * 1024, `cabe en el límite de subida (${(bytes / 1048576).toFixed(2)} MB < 10 MB)`);
        assert(panel.buildPayload().files?.[0]?.name === panel.BANNER.name, 'y el fichero viaja con el mensaje');
    }

    const ids = planos.filter(n => n.type === 2).map(b => b.custom_id);
    assert(ids.join(',') === 'gp_dinero,gp_robux', `los dos botones, dentro (${ids.join(', ')})`);

    const payload = panel.buildPayload();
    assert((payload.flags & 32768) === 32768, 'el mensaje lleva el flag de Components V2');
    assert(!('content' in payload) && !('embeds' in payload), 'y sin content ni embeds');

    // ── 6. Enrutado y guardas ────────────────────────────────────────────────
    const BOTONES = fs.readFileSync(path.join(RAIZ, 'handlers', 'buttons.js'), 'utf8');
    const MODALES = fs.readFileSync(path.join(RAIZ, 'handlers', 'modals.js'), 'utf8');
    const MAIN    = fs.readFileSync(path.join(RAIZ, 'main.js'), 'utf8');

    for (const id of ids) assert(new RegExp(`${id}:\\s*on`).test(BOTONES), `${id} está enrutado`);
    assert(/GAMEPASS_BUTTONS/.test(BOTONES), 'y atados al canal del panel');
    assert(/gp_dinero_modal:\s*handleGpDineroModal/.test(MODALES), 'el modal del presupuesto está enrutado');
    assert(/gp_robux_modal:\s*handleGpRobuxModal/.test(MODALES), 'y el de la cantidad');
    assert(/await ensureGamepassPanel\(client\)/.test(MAIN), 'el panel se publica al arrancar');

    assert(buildGpDineroModal().toJSON().custom_id === 'gp_dinero_modal', 'los customId de los modales cuadran');
    assert(buildGpRobuxModal().toJSON().custom_id === 'gp_robux_modal', 'los dos');

    // ── 7. Las dos calculadoras ──────────────────────────────────────────────
    const porRobux = await enviarModal('gp_robux_modal', 'cantidad_robux', '1000');
    assert(porRobux.campos?.['Precio total'] === gp.fmtMXN(115), 'por cantidad: el precio es el de config');
    assert(porRobux.campos?.['Recibes en tu cuenta'] === '700 Robux', 'y dice que recibe 700');
    assert(porRobux.campos?.['Gamepass que creas'] === '1,000 Robux', 'y qué gamepass crear');
    assert(/30%/.test(porRobux.pie ?? ''), 'con la comisión en el pie');

    const porDinero = await enviarModal('gp_dinero_modal', 'presupuesto', '500');
    const creado = Number((porDinero.campos?.['Gamepass que creas'] ?? '').replace(/[^0-9]/g, ''));
    const pagado = Number((porDinero.campos?.['Precio exacto'] ?? '').replace(/[^0-9]/g, ''));
    assert(creado > 0 && pagado > 0, 'por presupuesto: devuelve gamepass y precio');
    assert(pagado <= 500, `y el precio no se pasa del presupuesto (${pagado} <= 500)`);
    assert(pagado === gp.precioDe(creado), 'el precio es el de ese gamepass, no otro');
    assert(porDinero.campos?.['Recibes en tu cuenta'] === `${gp.fmtRobux(gp.recibe(creado))} Robux`,
        'y enseña lo que recibe');
    assert(/sobran/i.test(porDinero.aviso ?? ''), 'si sobra dinero, se dice en vez de esconderlo');

    // Entradas imposibles: ni un número.
    for (const [campo, valor, espera] of [
        ['presupuesto', 'abc', /válida/i],
        ['presupuesto', '1', /mínimo/i],
    ]) {
        const r = await enviarModal('gp_dinero_modal', campo, valor);
        assert(r.campos === null, `"${valor}" no devuelve una ficha de precio`);
        assert(espera.test(r.texto ?? ''), `y lo explica: ${valor}`);
    }
    for (const [valor, espera] of [['abc', /válida/i], ['99999999', /entre/i], ['1', /entre/i]]) {
        const r = await enviarModal('gp_robux_modal', 'cantidad_robux', valor);
        assert(r.campos === null, `"${valor}" Robux no devuelve ficha`);
        assert(espera.test(r.texto ?? ''), `y lo explica: ${valor}`);
    }

    // ── 8. Reconocer el panel ────────────────────────────────────────────────
    const propio = { author: { id: 'bot' }, content: '', embeds: [], components: [panel.buildContainer().toJSON()] };
    assert(panel.isGamepassMsg(propio, 'bot'), 'el bot reconoce su propio panel al arrancar');
    assert(!panel.isGamepassMsg(propio, 'otro'), 'y no adopta el de otro autor');
    assert(v2.isUpToDate(propio, panel.buildContainer()), 'un panel recién publicado no se reedita');

    // El canal es el que se pidió.
    assert(config.CHANNELS.GAMEPASS === '1561898653030027335', 'el panel va al canal que se pidió');

    return finish();
};
