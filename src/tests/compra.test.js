'use strict';

// Tests del flujo de compra: comunidad y gamepass, desde el botón del panel
// hasta el ticket. Sin red: Roblox, la creación de canales y el resumen de
// comunidades se sustituyen por versiones de mentira.
//
// Es la entrada del dinero, así que lo que protegen es caro:
//
//   1. UN USUARIO QUE NO EXISTE NO ABRE TICKET. Para eso está la confirmación:
//      antes, una letra mal escrita acababa en un ticket y el error no se veía
//      hasta ir a enviar los Robux.
//   2. NADA SE ABRE SIN "CONTINUAR", y "Continuar" dos veces no abre dos.
//   3. EL RESUMEN SE SIGUE LEYENDO. "Usuario de Roblox", "Robux a recibir" y
//      "Precio a pagar" son las etiquetas de las que utils/orderNotify.js saca
//      el registro de pedidos y el RANKING. Se prueban con sus mismas
//      expresiones regulares: si dejan de casar, las compras dejan de contar en
//      silencio.
//   4. EL TIPO SIGUE SIENDO 'comprar'. De él cuelga el botón de "PAGO REALIZADO"
//      del owner; con otro, el ticket se queda sin poder cerrarse como pagado.
//   5. EL CUPÓN NO SE GASTA AL CONFIRMAR. Si la persona cancela, no puede
//      haberse quedado sin un uso.
//   6. EL GAMEPASS SE COMPRUEBA CONTRA EL PEDIDO GUARDADO EN EL TICKET, que
//      sobrevive a un reinicio: precio exacto y cuenta del comprador.
//   7. LA PREGUNTA DE "¿PERTENECES A UNA COMUNIDAD?" YA NO ESTÁ. Se pidió
//      quitarla: el estado de comunidades lo calcula el bot solo.

const fs = require('fs');
const path = require('path');

const { createSuite } = require('./testHarness');
const config = require('../../config');
const roblox = require('../../src/roblox/client');
const tickets = require('../../utils/tickets');
const communityStatus = require('../../utils/communityStatus');
const coupons = require('../../utils/coupons');
const pendientes = require('../../utils/pedidosPendientes');
const gp = require('../../utils/gamepassPrecios');
const gpInfo = require('../../utils/gamepassInfo');
const flujo = require('../../handlers/compraFlow');
const { handleModal } = require('../../handlers/modals');
const { __test: panel } = require('../../panel');
const spam = require('../../utils/spam');

const RAIZ = path.join(__dirname, '..', '..');
const USER = '777000111222333444';
const ROBLOX_ID = 140258990;

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

const textoDe = payload => nodos((payload?.components ?? []).map(c => (typeof c.toJSON === 'function' ? c.toJSON() : c)))
    .filter(n => n.type === 10).map(n => n.content).join('\n');

const botonesDe = payload => nodos((payload?.components ?? []).map(c => (typeof c.toJSON === 'function' ? c.toJSON() : c)))
    .filter(n => n.type === 2);

// ── El mundo de mentira ───────────────────────────────────────────────────────

const originales = {};
function sustituir() {
    originales.getUserByUsername = roblox.getUserByUsername;
    originales.getHeadshot = roblox.getHeadshot;
    originales.createTicket = tickets.createTicket;
    originales.hasActiveTicket = tickets.hasActiveTicket;
    originales.getTicketData = tickets.getTicketData;
    originales.getOwner = tickets.getOwner;
    originales.buildCommunitySummary = communityStatus.buildCommunitySummary;
    originales.fetch = global.fetch;

    roblox.getUserByUsername = async nombre => {
        if (nombre.toLowerCase() !== 'kreekcraft') throw new Error('not_found');
        return { id: ROBLOX_ID, name: 'KreekCraft', displayName: 'Kreek', hasVerifiedBadge: false };
    };
    roblox.getHeadshot = async id => `https://tr.rbxcdn.com/headshot-${id}.png`;
    communityStatus.buildCommunitySummary = async () => ({
        texto: '\n### Estado en las comunidades\n**7x** — elegible',
        comunidades: [{ clave: 'noctra', estado: 'elegible' }],
        avatarURL: null,
        fields: [],
    });
}
function restaurar() {
    Object.assign(roblox, { getUserByUsername: originales.getUserByUsername, getHeadshot: originales.getHeadshot });
    Object.assign(tickets, {
        createTicket: originales.createTicket, hasActiveTicket: originales.hasActiveTicket,
        getTicketData: originales.getTicketData, getOwner: originales.getOwner,
    });
    communityStatus.buildCommunitySummary = originales.buildCommunitySummary;
    global.fetch = originales.fetch;
}

// Un canal de ticket que apunta todo lo que se le manda.
function nuevoMundo({ ticketAbierto = false } = {}) {
    const creados = [];
    tickets.hasActiveTicket = async () => ticketAbierto;
    tickets.createTicket = async (guild, userId, type, name, pedido) => {
        const canal = {
            id: `ch${creados.length + 1}`, name, type, pedido, enviados: [],
            send: async p => { canal.enviados.push(p); return { id: 'm' }; },
            toString: () => `<#${canal.id}>`,
        };
        creados.push(canal);
        return canal;
    };
    return { creados };
}

function interaccionModal(customId, campos) {
    spam.unlock(`modal:${USER}`);
    const r = [];
    const it = {
        replied: false, deferred: false, customId,
        user: { id: USER }, guild: {}, client: {},
        fields: {
            getTextInputValue: id => {
                if (!(id in campos)) throw new Error(`campo ${id} no existe`);
                return campos[id];
            },
        },
        respuestas: r,
        deferReply: async () => { it.deferred = true; },
        editReply: async o => { r.push(o); },
        reply: async o => { r.push(o); },
        followUp: async o => { r.push(o); },
    };
    return it;
}

function interaccionBoton(customId, { userId = USER } = {}) {
    const r = [];
    const it = {
        replied: false, deferred: false, customId,
        user: { id: userId }, guild: {}, client: {},
        respuestas: r,
        deferUpdate: async () => { it.deferred = true; },
        editReply: async o => { r.push(o); },
        followUp: async o => { r.push(o); },
        reply: async o => { r.push(o); },
    };
    return it;
}

const tokenDe = respuesta => botonesDe(respuesta)
    .map(b => b.custom_id).find(id => id?.startsWith('compra_ok:'))?.split(':')[1] ?? null;

// ── Las expresiones de utils/orderNotify.js, tal cual ────────────────────────
// Si el resumen deja de casar con ellas, el pedido sale "No disponible" en el
// registro y no cuenta para el ranking.
const LEE = {
    usuario: /Usuario de Roblox\*\*\n```([^`]+)```/,
    robux:   /Robux a recibir\*\*\n```([^`]+)```/,
    precio:  t => t.match(/Precio final a pagar\*\*\n```\$([^`]+) MXN```/)?.[1] ?? t.match(/Precio a pagar\*\*\n```\$([^`]+) MXN```/)?.[1],
};

module.exports = async function run() {
    const { assert, finish } = createSuite('compra');

    sustituir();
    pendientes._reset();
    try {
        // ── 1. Los formularios ───────────────────────────────────────────────
        const mCom = flujo.buildCompraModal('comunidad').toJSON();
        const mGp  = flujo.buildCompraModal('gamepass').toJSON();
        const campos = m => m.components.map(r => r.components[0].custom_id);

        assert(mCom.custom_id === 'comprar_modal', 'el formulario de comunidad conserva su customId');
        assert(mGp.custom_id === 'gamepass_compra_modal', 'el de gamepass tiene el suyo');
        assert(campos(mCom).join(',') === 'usuario_roblox,cantidad_robux,codigo_descuento',
            `comunidad pide usuario, cantidad y cupón (${campos(mCom).join(', ')})`);
        assert(campos(mGp).join(',') === 'usuario_roblox,cantidad_robux',
            `gamepass pide usuario y cantidad, sin cupón (${campos(mGp).join(', ')})`);

        // La pregunta que se pidió quitar.
        for (const [n, m] of [['comunidad', mCom], ['gamepass', mGp]]) {
            assert(!campos(m).includes('es_miembro'), `el formulario de ${n} ya no pregunta si perteneces a una comunidad`);
            assert(!JSON.stringify(m).includes('Perteneces'), `ni con otras palabras (${n})`);
        }
        const FLUJO = fs.readFileSync(path.join(RAIZ, 'handlers', 'compraFlow.js'), 'utf8');
        const MODALES = fs.readFileSync(path.join(RAIZ, 'handlers', 'modals.js'), 'utf8');
        assert(!/Miembro de comunidad/.test(FLUJO + MODALES), 'y el resumen ya no tiene la línea de "¿Miembro de comunidad?"');

        // ── 2. Usuario que no existe: ni confirmación ni ticket ──────────────
        let mundo = nuevoMundo();
        let it = interaccionModal('comprar_modal', { usuario_roblox: 'noexiste123', cantidad_robux: '1000', codigo_descuento: '' });
        await handleModal(it);
        assert(/No existe ningún usuario de Roblox/.test(it.respuestas[0]?.content ?? ''),
            'un usuario que no existe se dice claramente');
        assert(pendientes._tamano() === 0, 'y no queda ningún pedido esperando');
        assert(mundo.creados.length === 0, 'y no se abre ningún ticket');

        // ── 3. Confirmación por comunidad ────────────────────────────────────
        mundo = nuevoMundo();
        it = interaccionModal('comprar_modal', { usuario_roblox: 'kreekcraft', cantidad_robux: '1000', codigo_descuento: '' });
        await handleModal(it);
        let conf = it.respuestas[0];
        let t = textoDe(conf);

        assert(mundo.creados.length === 0, 'enviar el formulario NO abre el ticket: primero se confirma');
        assert((conf?.flags & 32768) === 32768, 'la confirmación es una tarjeta con los botones dentro');
        assert(/Confirma tu compra/.test(t), 'pide confirmar');
        assert(t.includes('@KreekCraft'), 'con el nombre real de la cuenta, con sus mayúsculas');
        assert(t.includes('**Kreek**'), 'y su nombre visible');
        assert(t.includes(String(ROBLOX_ID)), 'y su ID');
        assert(t.includes(`https://www.roblox.com/users/${ROBLOX_ID}/profile`), 'con enlace a su perfil');
        assert(nodos(conf.components.map(c => c.toJSON())).some(n => n.type === 11 && n.media.url.includes(`headshot-${ROBLOX_ID}`)),
            'y su foto de perfil de Roblox');
        assert(/Estado en las comunidades/.test(t), 'enseña en qué comunidades está');
        assert(/No es tu cuenta/.test(t), 'y qué hacer si no es la suya');

        const ids = botonesDe(conf).map(b => b.custom_id);
        assert(ids.some(i => i.startsWith('compra_ok:')) && ids.some(i => i.startsWith('compra_no:')),
            'con Continuar y Cancelar');
        const token = tokenDe(conf);
        assert(/^[0-9a-f]{16}$/.test(token ?? ''), 'el token del pedido viaja en el botón');

        // ── 4. Continuar abre el ticket ──────────────────────────────────────
        let bt = interaccionBoton(`compra_ok:${token}`);
        await flujo.handleCompraButton(bt);
        assert(mundo.creados.length === 1, 'Continuar abre UN ticket');

        const ch = mundo.creados[0];
        assert(ch.type === 'comprar', "con tipo 'comprar': de él cuelga el botón de PAGO REALIZADO");
        assert(/^robux-comunidad-\d{4}$/.test(ch.name), `el canal se llama robux-comunidad-NNNN (${ch.name})`);
        assert(ch.pedido?.modo === 'comunidad' && ch.pedido?.robux === 1000 && ch.pedido?.robloxUserId === String(ROBLOX_ID),
            'y guarda el pedido en el topic');

        const resumen = textoDe(ch.enviados[0]);
        assert(LEE.usuario.exec(resumen)?.[1] === 'KreekCraft', 'el registro de pedidos lee el usuario (el real, no el tecleado)');
        assert(LEE.robux.exec(resumen)?.[1] === '1,000 Robux', 'y los Robux');
        assert(LEE.precio(resumen) === '133', 'y el precio');
        assert(nodos(ch.enviados[0].components.map(c => c.toJSON())).some(n => n.type === 11 && n.media.url.includes('headshot')),
            'el resumen lleva la foto de Roblox');
        assert(/Entrega por \*\*comunidad\*\*/.test(resumen), 'y dice por dónde se entrega');

        const metodos = ch.enviados.some(p => /Métodos de Pago|metodos|Metodos/i.test(textoDe(p)) || botonesDe(p).some(b => b.custom_id?.startsWith('metodos_')));
        assert(metodos, 'manda el bloque de métodos de pago');
        assert(ch.enviados.some(p => botonesDe(p).some(b => b.custom_id === 'confirmar_pago')),
            'y el botón de PAGO REALIZADO del owner');
        assert(/Ticket creado/.test(textoDe(bt.respuestas.at(-1))), 'y le dice dónde está su ticket');

        // Segundo clic: el pedido ya se consumió.
        bt = interaccionBoton(`compra_ok:${token}`);
        await flujo.handleCompraButton(bt);
        assert(mundo.creados.length === 1, 'pulsar Continuar otra vez NO abre un segundo ticket');
        assert(/caducó/.test(textoDe(bt.respuestas.at(-1))), 'y avisa de que esa confirmación ya no vale');

        // ── 5. Cancelar ──────────────────────────────────────────────────────
        mundo = nuevoMundo();
        it = interaccionModal('comprar_modal', { usuario_roblox: 'kreekcraft', cantidad_robux: '1000', codigo_descuento: '' });
        await handleModal(it);
        const tCancel = tokenDe(it.respuestas[0]);
        await flujo.handleCompraButton(interaccionBoton(`compra_no:${tCancel}`));
        bt = interaccionBoton(`compra_ok:${tCancel}`);
        await flujo.handleCompraButton(bt);
        assert(mundo.creados.length === 0, 'tras Cancelar, ese pedido ya no abre ticket');

        // ── 6. Un token ajeno ────────────────────────────────────────────────
        mundo = nuevoMundo();
        it = interaccionModal('comprar_modal', { usuario_roblox: 'kreekcraft', cantidad_robux: '1000', codigo_descuento: '' });
        await handleModal(it);
        const tAjeno = tokenDe(it.respuestas[0]);
        bt = interaccionBoton(`compra_ok:${tAjeno}`, { userId: '111111111111111111' });
        await flujo.handleCompraButton(bt);
        assert(mundo.creados.length === 0, 'otra persona no puede confirmar tu pedido');
        assert(/no es tuya/.test(textoDe(bt.respuestas.at(-1))), 'y se le dice');
        // El dueño todavía puede: el intento ajeno no lo gastó.
        await flujo.handleCompraButton(interaccionBoton(`compra_ok:${tAjeno}`));
        assert(mundo.creados.length === 1, 'y el intento ajeno no le quita la confirmación al dueño');

        // ── 7. El cupón: se enseña al confirmar, se gasta al abrir ───────────
        coupons.createCoupon('TESTCOMPRA', 20, 1, 100000, 'owner');
        mundo = nuevoMundo();
        it = interaccionModal('comprar_modal', { usuario_roblox: 'kreekcraft', cantidad_robux: '1000', codigo_descuento: 'TESTCOMPRA' });
        await handleModal(it);
        t = textoDe(it.respuestas[0]);
        assert(/TESTCOMPRA/.test(t) && /20%/.test(t), 'la confirmación enseña el cupón aplicado');
        assert(coupons.getCoupon('TESTCOMPRA').uses === 0, 'pero confirmar NO gasta el uso');

        await flujo.handleCompraButton(interaccionBoton(`compra_no:${tokenDe(it.respuestas[0])}`));
        assert(coupons.getCoupon('TESTCOMPRA').uses === 0, 'y cancelar tampoco: el cupón sigue entero');

        it = interaccionModal('comprar_modal', { usuario_roblox: 'kreekcraft', cantidad_robux: '1000', codigo_descuento: 'TESTCOMPRA' });
        await handleModal(it);
        await flujo.handleCompraButton(interaccionBoton(`compra_ok:${tokenDe(it.respuestas[0])}`));
        assert(coupons.getCoupon('TESTCOMPRA').uses === 1, 'se gasta al abrir el ticket');
        const conCupon = textoDe(mundo.creados[0].enviados[0]);
        assert(LEE.precio(conCupon) === String(Math.round(133 * 0.8)), 'y el registro lee el precio con descuento');

        // ── 8. Gamepass ──────────────────────────────────────────────────────
        mundo = nuevoMundo();
        it = interaccionModal('gamepass_compra_modal', { usuario_roblox: 'kreekcraft', cantidad_robux: '1000' });
        await handleModal(it);
        conf = it.respuestas[0];
        t = textoDe(conf);
        assert(/Gamepass de \*\*1,000 Robux\*\*/.test(t), 'la confirmación de gamepass dice el valor del gamepass');
        assert(t.includes(`**${gp.fmtRobux(gp.recibe(1000))} Robux**`), 'y lo que recibe de verdad');
        assert(/no lo cubrimos/.test(t), 'y que la comisión no la cubre 7x');
        assert(!/Estado en las comunidades/.test(t), 'sin el bloque de comunidades, que en gamepass no pinta nada');

        await flujo.handleCompraButton(interaccionBoton(`compra_ok:${tokenDe(conf)}`));
        const gch = mundo.creados[0];
        assert(gch?.type === 'comprar', "el ticket de gamepass también es 'comprar'");
        assert(/^robux-gamepass-\d{4}$/.test(gch?.name ?? ''), `y se llama robux-gamepass-NNNN (${gch?.name})`);
        assert(gch.pedido?.modo === 'gamepass' && gch.pedido?.robux === 1000, 'con el pedido en el topic');

        const gres = textoDe(gch.enviados[0]);
        assert(LEE.usuario.exec(gres)?.[1] === 'KreekCraft', 'el registro lee el usuario del ticket de gamepass');
        assert(LEE.robux.exec(gres)?.[1] === `${gp.fmtRobux(gp.recibe(1000))} Robux`,
            '"Robux a recibir" es lo que de verdad le llega, no el valor del gamepass');
        assert(LEE.precio(gres) === String(gp.precioDe(1000)), 'y el precio es el de gamepass');
        assert(/Valor del gamepass\*\*\n```1,000 Robux```/.test(gres), 'el valor del gamepass va en su propia línea');

        assert(gch.enviados.some(p => botonesDe(p).some(b => b.custom_id === 'gp_link')),
            'el ticket trae el botón para agregar el link del gamepass');
        const paso = gch.enviados.map(textoDe).find(x => /Tu gamepass/.test(x)) ?? '';
        assert(/exactamente 1,000 Robux/.test(paso), 'y dice de cuánto exactamente tiene que ser');
        assert(gch.enviados.some(p => botonesDe(p).some(b => b.custom_id === 'confirmar_pago')),
            'y el botón de PAGO REALIZADO');

        // Fuera de rango
        mundo = nuevoMundo();
        it = interaccionModal('gamepass_compra_modal', { usuario_roblox: 'kreekcraft', cantidad_robux: '100' });
        await handleModal(it);
        assert(/entre \*\*500\*\*/.test(it.respuestas[0]?.content ?? ''), 'un gamepass por debajo del mínimo se rechaza');
        assert(mundo.creados.length === 0 && pendientes._tamano() >= 0, 'sin ticket');

        // ── 9. El enlace del gamepass ────────────────────────────────────────
        for (const escenario of await simularEnlace()) assert(escenario.ok, escenario.msg);

        // ── 10. Ya tiene un ticket abierto ───────────────────────────────────
        mundo = nuevoMundo({ ticketAbierto: true });
        it = interaccionModal('comprar_modal', { usuario_roblox: 'kreekcraft', cantidad_robux: '1000', codigo_descuento: '' });
        await handleModal(it);
        assert(/Ya tienes un ticket abierto/.test(it.respuestas[0]?.content ?? ''), 'con un ticket abierto no deja empezar otro');

        // ── 11. Un formulario viejo enviado tras el despliegue ───────────────
        // Tiene el campo es_miembro de antes y nada más cambia: tiene que
        // funcionar igual, sin reventar por un campo de sobra.
        mundo = nuevoMundo();
        it = interaccionModal('comprar_modal', { usuario_roblox: 'kreekcraft', cantidad_robux: '1000', es_miembro: 'Sí', codigo_descuento: '' });
        await handleModal(it);
        assert(/Confirma tu compra/.test(textoDe(it.respuestas[0])), 'un formulario viejo (con la pregunta) sigue funcionando');
    } finally {
        restaurar();
        pendientes._reset();
    }

    // ── 12. El panel ─────────────────────────────────────────────────────────
    const opciones = Object.fromEntries(panel.OPCIONES.map(o => [o.id, o]));
    assert(opciones.comprar?.label === 'robux-comunidad', 'el botón de comprar se llama robux-comunidad');
    assert(opciones.comprar_gamepass?.label === 'robux-gamepass', 'y hay uno nuevo, robux-gamepass');
    // El customId del de comunidad NO cambia: es por el que isPanelMsg()
    // reconoce el panel para reeditarlo en vez de publicar otro.
    const PANEL = fs.readFileSync(path.join(RAIZ, 'panel.js'), 'utf8');
    assert(/custom_id === 'comprar'/.test(PANEL), "el panel se sigue reconociendo por el botón 'comprar'");
    assert(panel.OPCIONES.findIndex(o => o.id === 'comprar_gamepass') === panel.OPCIONES.findIndex(o => o.id === 'comprar') + 1,
        'gamepass va justo después de comunidad');
    assert(panel.buildButtons().every(f => f.toJSON().components.length <= 5), 'ninguna fila pasa de 5 botones');
    assert(/gamepass/i.test(panel.buildOpciones()), 'y el texto del panel lo explica');

    // ── 13. Enrutado ─────────────────────────────────────────────────────────
    const BOTONES = fs.readFileSync(path.join(RAIZ, 'handlers', 'buttons.js'), 'utf8');
    const MODALES = fs.readFileSync(path.join(RAIZ, 'handlers', 'modals.js'), 'utf8');
    assert(/comprar_gamepass:\s*onComprarGamepass/.test(BOTONES), 'el botón de gamepass está enrutado');
    assert(/PANEL_BUTTONS\s*=\s*new Set\(\[[^\]]*'comprar_gamepass'/.test(BOTONES), 'y sólo funciona desde el panel oficial');
    // Los tres botones de la confirmación: continuar, continuar con el
    // descuento de fidelidad y cancelar.
    const reCompra = BOTONES.match(/const isCompra = (\/.+\/)\.test/)?.[1] ?? '';
    const enrutaCompra = id => { try { return new RegExp(reCompra.slice(1, -1)).test(id); } catch { return false; } };
    for (const id of ['compra_ok:abc', 'compra_no:abc', 'compra_desc:abc']) {
        assert(enrutaCompra(id), `${id.split(':')[0]} está enrutado`);
    }
    assert(!enrutaCompra('compra_otro:abc'), 'y nada más se cuela por ese camino');
    assert(/isCompra \? handleCompraButton/.test(BOTONES), 'hacia el handler de la compra');
    assert(/gp_link:\s*onGpLink/.test(BOTONES), 'el botón del link del gamepass está enrutado');
    assert(/TICKET_BUTTONS\s*=\s*new Set\(\[[^\]]*'gp_link'/.test(BOTONES), 'y sólo funciona dentro de un ticket');
    for (const id of ['comprar_modal', 'gamepass_compra_modal']) {
        assert(new RegExp(`${id}:\\s*handleCompraModal`).test(MODALES), `${id} está enrutado`);
    }
    assert(/gp_link_modal:\s*handleGpLinkModal/.test(MODALES), 'y el del link');

    // ── 14. Pedidos pendientes ───────────────────────────────────────────────
    pendientes._reset();
    const a = pendientes.guardar('u1', { x: 1 });
    const b = pendientes.guardar('u1', { x: 2 });
    assert(!pendientes.obtener(a, 'u1').ok, 'un segundo formulario de la misma persona anula el primero');
    assert(pendientes.obtener(b, 'u1').pedido?.x === 2, 'y vale el último');
    assert(pendientes.obtener(b, 'otro').motivo === 'ajeno', 'otra persona no lo puede usar');
    assert(pendientes.consumir(b, 'u1').ok && !pendientes.consumir(b, 'u1').ok, 'se consume una sola vez');

    const realNow = Date.now;
    const c = pendientes.guardar('u2', { x: 3 });
    Date.now = () => realNow() + pendientes.TTL_MS + 1000;
    try {
        assert(pendientes.obtener(c, 'u2').motivo === 'caducado', `pasados ${pendientes.TTL_MS / 60000} minutos, caduca`);
    } finally {
        Date.now = realNow;
    }
    pendientes._reset();

    // ── 15. El topic del ticket ──────────────────────────────────────────────
    const { buildTopic, parseTopic } = tickets.__test;
    const topic = parseTopic(buildTopic('1', 'comprar', { modo: 'gamepass', robux: 1000, type: 'pirata', userId: '666' }));
    assert(topic.type === 'comprar' && topic.userId === '1', 'el pedido del topic no puede pisar de quién es el ticket ni su tipo');
    assert(topic.pedido.robux === 1000, 'y se guarda entero');
    assert(buildTopic('1', 'comprar', flujo.__test.pedidoTopic({
        tipo: 'gamepass', robux: 100000, robloxUserId: '12345678901234567890', robloxName: 'x'.repeat(20),
    })).length < 1024, 'y cabe en el límite de 1024 caracteres del topic');

    return finish();
};

// ── El enlace del gamepass ───────────────────────────────────────────────────

async function simularEnlace() {
    const out = [];

    const pedido = { modo: 'gamepass', robux: 1000, robloxUserId: String(ROBLOX_ID), robloxName: 'KreekCraft' };
    const canal = { id: 'gp1', enviados: [], send: async p => { canal.enviados.push(p); return {}; } };
    tickets.getTicketData = () => ({ userId: USER, type: 'comprar', pedido });
    tickets.getOwner = () => USER;

    const gamepass = ({ precio = 1000, aLaVenta = true, creador = ROBLOX_ID, tipo = 'User', producto = 'Game Pass' } = {}) => {
        global.fetch = async () => ({
            ok: true, status: 200,
            json: async () => ({
                ProductType: producto, Name: 'Mi pase', PriceInRobux: precio, IsForSale: aLaVenta,
                Creator: { Id: creador, Name: creador === ROBLOX_ID ? 'KreekCraft' : 'otraCuenta', CreatorType: tipo },
            }),
        });
    };

    const enviar = async enlace => {
        canal.enviados.length = 0;
        const it = interaccionModal('gp_link_modal', { enlace });
        it.channel = canal;
        await handleModal(it);
        return { respuesta: it.respuestas[0]?.content ?? '', tarjeta: textoDe(canal.enviados[0]), color: nodos(canal.enviados[0]?.components?.map(c => c.toJSON()) ?? [])[0]?.accent_color };
    };

    // Correcto
    gamepass();
    let r = await enviar('https://www.roblox.com/es/game-pass/123456789/Mi-pase');
    out.push({ ok: /listo para comprar/i.test(r.tarjeta), msg: 'un gamepass correcto sale como listo para comprar' });
    out.push({ ok: /correcto/i.test(r.respuesta), msg: 'y se lo confirma a quien lo envió' });
    out.push({ ok: /Mi pase/.test(r.tarjeta) && /game-pass\/123456789/.test(r.tarjeta), msg: 'con el nombre y el enlace' });

    // Precio distinto: el caso caro
    gamepass({ precio: 1500 });
    r = await enviar('https://www.roblox.com/game-pass/123456789');
    out.push({ ok: /Revisa tu gamepass/.test(r.tarjeta), msg: 'un gamepass de 1.500 en un pedido de 1.000 NO sale como listo' });
    out.push({ ok: /1,500/.test(r.tarjeta) && /1,000/.test(r.tarjeta), msg: 'y dice cuánto cuesta y cuánto tiene que costar' });

    gamepass({ precio: 500 });
    r = await enviar('123456789');
    out.push({ ok: /Revisa tu gamepass/.test(r.tarjeta), msg: 'uno más barato que el pedido tampoco' });

    // De otra cuenta
    gamepass({ creador: 999 });
    r = await enviar('https://www.roblox.com/game-pass/123456789');
    out.push({ ok: /otraCuenta/.test(r.tarjeta) && /irían a esa cuenta/.test(r.tarjeta), msg: 'un gamepass de otra cuenta se avisa' });

    // De un grupo
    gamepass({ tipo: 'Group' });
    r = await enviar('https://www.roblox.com/game-pass/123456789');
    out.push({ ok: /grupo/.test(r.tarjeta), msg: 'uno de un grupo, también' });

    // No a la venta — con el precio CORRECTO a propósito. Con el precio a null
    // el veredicto saldría mal igualmente por el precio, y no se vería que la
    // comprobación de la venta hace algo: un gamepass bien puesto de precio pero
    // con la venta apagada no se puede comprar, y no puede salir como listo.
    gamepass({ aLaVenta: false, precio: 1000 });
    r = await enviar('https://www.roblox.com/game-pass/123456789');
    out.push({ ok: /No está a la venta/.test(r.tarjeta), msg: 'si no está a la venta, se dice' });
    out.push({ ok: /Revisa tu gamepass/.test(r.tarjeta) && !/listo para comprar/i.test(r.tarjeta),
        msg: 'y aunque el precio cuadre, NO sale como listo: no se puede comprar' });

    // Enlace que no es de gamepass
    gamepass();
    r = await enviar('https://www.roblox.com/catalog/123456789');
    out.push({ ok: /no parece un enlace de gamepass/.test(r.respuesta) && canal.enviados.length === 0,
        msg: 'un enlace del catálogo no se toma por un gamepass' });

    // Algo que no es un gamepass según Roblox
    gamepass({ producto: 'Asset' });
    r = await enviar('https://www.roblox.com/game-pass/123456789');
    out.push({ ok: /no existe/.test(r.respuesta) && canal.enviados.length === 0, msg: 'si Roblox dice que no es un gamepass, no se da por bueno' });

    // Roblox caído
    global.fetch = async () => { throw new Error('ENOTFOUND'); };
    r = await enviar('https://www.roblox.com/game-pass/123456789');
    out.push({ ok: /No se pudo comprobar/.test(r.respuesta) && canal.enviados.length === 0,
        msg: 'con Roblox caído no se inventa una revisión' });

    // Un ticket que no es de gamepass
    tickets.getTicketData = () => ({ userId: USER, type: 'comprar', pedido: { modo: 'comunidad', robux: 1000 } });
    gamepass();
    r = await enviar('https://www.roblox.com/game-pass/123456789');
    out.push({ ok: /no es de compra por gamepass/.test(r.respuesta), msg: 'en un ticket de comunidad no se acepta un gamepass' });

    // Un ticket viejo sin pedido en el topic (de antes de este cambio)
    tickets.getTicketData = () => ({ userId: USER, type: 'comprar' });
    r = await enviar('https://www.roblox.com/game-pass/123456789');
    out.push({ ok: /no es de compra por gamepass/.test(r.respuesta), msg: 'ni en un ticket viejo que no guardó pedido' });

    // Botón: sólo el dueño del ticket (o un admin)
    tickets.getOwner = () => USER;
    const ajeno = interaccionBoton('gp_link', { userId: '111111111111111111' });
    ajeno.channel = canal;
    let abrioModal = false;
    ajeno.showModal = async () => { abrioModal = true; };
    await flujo.onGpLink(ajeno);
    out.push({ ok: !abrioModal && /Solo quien abrió el ticket/.test(ajeno.respuestas[0]?.content ?? ''),
        msg: 'otra persona no puede agregar el gamepass de tu ticket' });

    return out;
}
