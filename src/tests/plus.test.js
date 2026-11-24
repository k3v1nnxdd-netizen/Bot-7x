'use strict';

// ── Robux por Roblox Plus y gamepass con el tax cubierto ──────────────────────
//
// Lo que no puede romperse:
//
//   1. PLUS SE COBRA A config.PLUS.PRECIO_POR_1K, de MIN a MAX y de MULTIPLO
//      en MULTIPLO (Roblox sólo envía en paquetes de 25, 50, 100 y 200).
//   2. EL PANEL DE PLUS AVISA ANTES DE QUE NADIE PAGUE: cuenta verificada, sin
//      reembolso si no puede recibir, y que depende del stock.
//   3. EL STOCK LO PREGUNTA EL CLIENTE Y LO RESPONDE SÓLO EL OWNER.
//   4. EL TAX CUBIERTO entrega los Robux completos y sólo presume de ahorro
//      frente a comunidad donde lo hay de verdad.

const fs = require('fs');
const path = require('path');

const { createSuite } = require('./testHarness');
const config = require('../../config');
const plus = require('../../utils/plusPrecios');
const gp = require('../../utils/gamepassPrecios');
const precios = require('../../data/prices');
const { __test: panelPlus, ...plusMod } = require('../../plus');
const { __test: panelGp } = require('../../gamepass');
const { __test: panelTickets, OPCIONES } = require('../../panel');
const { handleModal } = require('../../handlers/modals');
const flujo = require('../../handlers/compraFlow');
const tickets = require('../../utils/tickets');
const spam = require('../../utils/spam');

const RAIZ = path.join(__dirname, '..', '..');
const leer = f => fs.readFileSync(path.join(RAIZ, f), 'utf8').replace(/\r\n/g, '\n');

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
const planos = payload => nodos((payload?.components ?? []).map(c => (typeof c.toJSON === 'function' ? c.toJSON() : c)));
const textoDe = payload => planos(payload).filter(n => n.type === 10).map(n => n.content).join('\n');
const botonesDe = payload => planos(payload).filter(n => n.type === 2);

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
    };
}

module.exports = async function run() {
    const { assert, finish } = createSuite('plus');
    const P = config.PLUS;

    // ── 1. Aritmética de Plus ────────────────────────────────────────────────
    assert(P.PRECIO_POR_1K === 140 && P.MAX_ROBUX === 5000, 'Plus: $140 por cada 1.000, máximo 5.000');
    assert(plus.precioDe(1000) === 140 && plus.precioDe(2500) === 350, 'el precio es lineal');
    assert(plus.enRango(5000) && !plus.enRango(5025), 'el máximo entra y lo de encima no');
    assert(plus.enRango(P.MIN_ROBUX) && !plus.enRango(P.MIN_ROBUX - P.MULTIPLO), 'el mínimo entra y lo de debajo no');
    assert(!plus.enRango(1010) && plus.revisar(1010).motivo === 'multiplo', 'lo que no es múltiplo de 25 no se puede enviar');
    assert(/1,000.*1,025/.test(plus.errorCantidad(1010)), 'y el error propone las dos cantidades buenas más cercanas');
    assert(plus.robuxPor(280) === 2000, 'con $280 alcanzan 2.000');
    assert(plus.robuxPor(100000) === P.MAX_ROBUX, 'un presupuesto enorme se topa en el máximo');
    assert(plus.robuxPor(10) === null, 'y uno que no llega al mínimo no da nada');
    for (const malo of [0, -5, NaN, Infinity]) assert(plus.precioDe(malo) === null, `precioDe(${malo}) es null`);

    // ── 2. El panel de Plus ──────────────────────────────────────────────────
    const tp = panelPlus.buildTexto();
    for (const [re, msg] of [
        [/\$140 MXN/, 'dice el precio'],
        [/completos/, 'que llegan completos'],
        [/5,000/, 'el máximo por pedido'],
        [/verificada/, 'que la cuenta tiene que estar verificada'],
        [/no hay reembolso/, 'que sin poder recibir no hay reembolso'],
        [/stock/i, 'y que depende del stock'],
    ]) assert(re.test(tp), `el panel de Plus ${msg}`);
    assert(botonesDe({ components: [panelPlus.buildContainer()] }).map(b => b.custom_id).join(',') === 'plus_dinero,plus_robux',
        'con las dos calculadoras dentro');
    assert(config.CHANNELS.PLUS === '1574643512836755506', 'el canal de precios de Plus está en config');

    // ── 3. Las calculadoras de Plus ──────────────────────────────────────────
    let r = await enviarModal('plus_robux_modal', 'cantidad_robux', '2000');
    assert(r.campos?.['Precio total'] === '$280 MXN' && r.campos?.['Recibes en tu cuenta'] === '2,000 Robux', 'por cantidad: 2.000 = $280');
    r = await enviarModal('plus_robux_modal', 'cantidad_robux', '7000');
    assert(r.campos === null && /5,000/.test(r.texto ?? ''), 'pasar del máximo se explica');
    r = await enviarModal('plus_dinero_modal', 'presupuesto', '300');
    assert(r.campos?.['Recibes en tu cuenta'] === '2,125 Robux' && r.campos?.['Precio exacto'] === '$298 MXN',
        'por presupuesto: lo que alcanza, de 25 en 25');
    assert(/sobran/.test(r.aviso ?? ''), 'y lo que sobra se dice');
    r = await enviarModal('plus_dinero_modal', 'presupuesto', '1000');
    assert(r.campos?.['Recibes en tu cuenta'] === '5,000 Robux' && /máximo/.test(r.aviso ?? ''), 'un presupuesto de más se topa y lo avisa');

    // ── 4. El apartado en el panel de tickets ────────────────────────────────
    const op = OPCIONES.find(o => o.id === 'comprar_plus');
    assert(op?.label === 'robux-plus', 'el panel de tickets tiene el apartado robux-plus');
    assert(OPCIONES.findIndex(o => o.id === 'comprar_plus') === OPCIONES.findIndex(o => o.id === 'comprar_gamepass') + 1,
        'justo después de gamepass');
    assert(panelTickets.buildButtons().every(f => f.toJSON().components.length <= 5), 'ninguna fila pasa de 5 botones');
    assert(/Roblox Plus/.test(panelTickets.buildOpciones()), 'y el texto del panel lo explica');

    // ── 5. Enrutado ──────────────────────────────────────────────────────────
    const BOTONES = leer('handlers/buttons.js');
    const MODALES = leer('handlers/modals.js');
    const MAIN = leer('main.js');
    assert(/comprar_plus:\s*onComprarPlus/.test(BOTONES) && /PANEL_BUTTONS\s*=\s*new Set\(\[[^\]]*'comprar_plus'/.test(BOTONES),
        'el botón del panel está enrutado y sólo funciona desde el panel');
    assert(/buildCompraModal\('plus'\)/.test(BOTONES), 'y abre el formulario de Plus');
    for (const id of ['plus_dinero', 'plus_robux']) assert(new RegExp(`${id}:\\s*onPlus`).test(BOTONES), `${id} está enrutado`);
    assert(/PLUS_BUTTONS/.test(BOTONES) && /CHANNELS\.PLUS/.test(BOTONES), 'las calculadoras sólo desde su canal');
    for (const id of ['plus_stock', 'plus_hay_stock', 'plus_sin_stock']) {
        assert(new RegExp(`${id}:\\s*onPlusStock`).test(BOTONES), `${id} está enrutado`);
        assert(new RegExp(`TICKET_BUTTONS\\s*=\\s*new Set\\(\\[[^\\]]*'${id}'`).test(BOTONES), `y ${id} sólo dentro de un ticket`);
    }
    const reCompra = BOTONES.match(/const isCompra = (\/.+\/)\.test/)?.[1] ?? '';
    for (const id of ['compra_tax:abc:si', 'compra_cambiar:abc']) {
        assert(new RegExp(reCompra.slice(1, -1)).test(id), `${id.split(':')[0]} está enrutado`);
    }
    assert(/plus_compra_modal:\s*handleCompraModal/.test(MODALES), 'el formulario de Plus está enrutado');
    assert(/plus_dinero_modal:\s*handlePlusDineroModal/.test(MODALES) && /plus_robux_modal:\s*handlePlusRobuxModal/.test(MODALES),
        'y los de las calculadoras');
    assert(/await ensurePlusPanel\(client\)/.test(MAIN), 'el panel de Plus se publica al arrancar');

    // ── 6. El stock ──────────────────────────────────────────────────────────
    const orig = { getOwner: tickets.getOwner, getTicketData: tickets.getTicketData };
    const CLIENTE = '555000111222333444';
    try {
        tickets.getOwner = () => CLIENTE;
        tickets.getTicketData = () => ({ pedido: { modo: 'plus', robux: 2000, robloxName: 'KreekCraft' } });

        const enviados = [];
        const canal = { send: async p => { enviados.push(p); return { id: 'm' }; } };
        const boton = (customId, userId) => {
            const res = [];
            const it = {
                customId, user: { id: userId }, member: null, channel: canal, channelId: 'chPlus',
                replied: false, deferred: false, respuestas: res,
                reply: async o => { it.replied = true; res.push(o); },
                deferUpdate: async () => { it.deferred = true; },
                message: { edit: async o => { res.push({ editado: o }); } },
            };
            return it;
        };
        spam.unlock('plusstock:chPlus');

        let b = boton('plus_stock', '999');
        await flujo.onPlusStock(b);
        assert(enviados.length === 0 && /Solo quien abrió/.test(b.respuestas[0]?.content ?? ''), 'otro usuario no puede preguntar el stock');

        b = boton('plus_stock', CLIENTE);
        await flujo.onPlusStock(b);
        const pregunta = enviados[0];
        assert(new RegExp(`<@${config.OWNER_ID}>`).test(textoDe(pregunta)), 'preguntar el stock menciona al owner');
        assert(/2,000 Robux/.test(textoDe(pregunta)), 'con la cantidad del pedido');
        assert(botonesDe(pregunta).map(x => x.custom_id).join(',') === 'plus_hay_stock,plus_sin_stock', 'y los botones para responder');

        b = boton('plus_stock', CLIENTE);
        await flujo.onPlusStock(b);
        assert(enviados.length === 1 && /Ya preguntamos/.test(b.respuestas[0]?.content ?? ''), 'pulsar otra vez no vuelve a mencionar al owner');

        b = boton('plus_hay_stock', CLIENTE);
        await flujo.onPlusStockRespuesta(b);
        assert(enviados.length === 1 && /Solo el owner/.test(b.respuestas[0]?.content ?? ''), 'el cliente no puede responderse a sí mismo');

        b = boton('plus_sin_stock', config.OWNER_ID);
        await flujo.onPlusStockRespuesta(b);
        const respuesta = textoDe(enviados[1]);
        assert(/Sin stock/.test(respuesta) && /en cuanto haya/.test(respuesta), 'sin stock: se avisa que se envía en cuanto haya');
        assert(new RegExp(`<@${CLIENTE}>`).test(respuesta), 'mencionando al cliente');
        assert(botonesDe(b.respuestas[0]?.editado).length === 0, 'y la pregunta se queda sin botones');

        b = boton('plus_stock', CLIENTE);
        await flujo.onPlusStock(b);
        assert(enviados.length === 3, 'con la respuesta dada se puede volver a preguntar');
        b = boton('plus_hay_stock', config.OWNER_ID);
        await flujo.onPlusStockRespuesta(b);
        assert(/Hay stock/.test(textoDe(enviados[3])) && /Ya puedes pagar/.test(textoDe(enviados[3])), 'hay stock: ya puede pagar');

        tickets.getTicketData = () => ({ pedido: { modo: 'gamepass', robux: 1000 } });
        spam.unlock('plusstock:chPlus');
        b = boton('plus_stock', CLIENTE);
        await flujo.onPlusStock(b);
        assert(/no es de compra por Plus/.test(b.respuestas[0]?.content ?? ''), 'en un ticket que no es de Plus no se pregunta');
    } finally {
        Object.assign(tickets, orig);
        spam.unlock('plusstock:chPlus');
    }

    // ── 7. Tax cubierto ──────────────────────────────────────────────────────
    assert(config.GAMEPASS.PRECIO_CUBIERTO_POR_1K === 130, 'tax cubierto: $130 por cada 1.000 recibidos');
    assert(gp.gamepassParaRecibir(1000) === 1429, 'para recibir 1.000 se crea un gamepass de 1.429');
    let bien = true;
    for (let rx = gp.G.MIN_ROBUX; rx <= 60000; rx += 37) {
        const v = gp.gamepassParaRecibir(rx);
        if (gp.recibe(v) < rx || gp.recibe(v - 1) >= rx) { bien = false; break; }
    }
    assert(bien, 'el gamepass cubierto es siempre el MÍNIMO que entrega lo pedido completo');
    assert(gp.precioCubierto(2000) === 260, '2.000 cubiertos cuestan $260');
    assert(!gp.cubiertoEnRango(gp.G.MAX_ROBUX), 'con el tax cubierto el máximo lo pone el gamepass');

    let honesto = true;
    for (let rx = gp.G.MIN_ROBUX; rx <= 20000; rx += 100) {
        const a = gp.ahorroVsComunidad(rx);
        const com = parseFloat(precios.lookup(rx).price.replace(/[$,]/g, ''));
        if (a && !(a.ahorro > 0 && com > gp.precioCubierto(rx))) honesto = false;
        if (!a && com > gp.precioCubierto(rx)) honesto = false;
    }
    assert(honesto, 'el ahorro sólo sale donde la comunidad es de verdad más cara');
    assert(gp.ahorroVsComunidad(5000) === null, 'en 5.000 la comunidad es más barata: no se presume de ahorro');

    const tg = panelGp.buildTexto();
    assert(/\$130 MXN/.test(tg) && /tax cubierto/i.test(tg), 'el panel de gamepass da el precio con tax cubierto');
    assert(/1,429/.test(tg), 'con el gamepass que hay que crear');
    assert(new RegExp(`hasta \\*\\*${gp.fmtRobux(gp.limiteAhorro())} Robux\\*\\*`).test(tg), 'dice hasta cuánto sale más barato que comunidad');
    assert(/ahorras \*\*\$3 MXN\*\*/.test(tg) && /ahorras \*\*\$27 MXN\*\*/.test(tg), 'con lo que se ahorra');
    assert(/Sin cubrir/.test(tg), 'y sigue dando la opción sin cubrir');

    r = await enviarModal('gp_robux_modal', 'cantidad_robux', '1000');
    assert(/1,429/.test(r.campos?.['Con tax cubierto'] ?? '') && /\$130 MXN/.test(r.campos?.['Con tax cubierto'] ?? ''),
        'la calculadora de gamepass también da la opción cubierta');
    assert(/Ahorras \$3/.test(r.campos?.['Con tax cubierto'] ?? ''), 'con el ahorro cuando lo hay');
    r = await enviarModal('gp_robux_modal', 'cantidad_robux', '5000');
    assert(!/Ahorras/.test(r.campos?.['Con tax cubierto'] ?? ''), 'y sin él cuando no lo hay');

    return finish();
};
