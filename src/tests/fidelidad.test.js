'use strict';

// Tests del descuento por fidelidad, de /compras, /robuxgastados y /miscompras,
// y de la valoración con estrellas que se cierra a las 12 horas. Sin red.
//
// Lo que protegen:
//
//   1. UN DESCUENTO NO SE GASTA DOS VECES NI SE GASTA SIN TENERLO.
//   2. SE GASTA AL CONFIRMARSE EL PAGO, NO AL ABRIR EL TICKET. Un ticket cerrado
//      sin pagar no puede costarle el descuento a nadie.
//   3. LOS USADOS SOBREVIVEN A LA RECONSTRUCCIÓN DEL RANKING. El ranking se
//      borra y se rehace desde el canal de pedidos en cada arranque: si los
//      usados vivieran ahí, cada despliegue los devolvería.
//   4. CUENTAN LAS COMPRAS DE DESPUÉS DE ACTIVARLO. Contar todo el historial
//      regalaría varios descuentos de golpe a los clientes viejos.
//   5. EL PRECIO CON DESCUENTO SE APUNTA BIEN en el registro de pedidos y el
//      ranking: se prueba con las mismas expresiones que usa orderNotify.
//   6. NUNCA SE INVENTA UNA RESEÑA. Si el cliente no valora, a las 12 horas se
//      cierra y el canal de reseñas dice "Entrega verificada" — que es cierto —
//      y no una valoración que el cliente no escribió.

const fs = require('fs');
const path = require('path');

const { createSuite } = require('./testHarness');
const config = require('../../config');
const { dataPath } = require('../../utils/dataDir');
const lb = require('../../utils/robuxLeaderboard');
const fidelidad = require('../../utils/fidelidad');
const reviews = require('../../utils/reviews');
const reviewFlow = require('../../utils/reviewFlow');
const roblox = require('../../src/roblox/client');
const tickets = require('../../utils/tickets');
const communityStatus = require('../../utils/communityStatus');
const pendientes = require('../../utils/pedidosPendientes');
const spam = require('../../utils/spam');
const flujo = require('../../handlers/compraFlow');
const { handleModal } = require('../../handlers/modals');
const { __test: cmd } = require('../../handlers/commands');

const RAIZ = path.join(__dirname, '..', '..');
const F = config.FIDELIDAD;

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
const aJson = p => (p?.components ?? []).map(c => (typeof c.toJSON === 'function' ? c.toJSON() : c));
const textoDe = p => nodos(aJson(p)).filter(n => n.type === 10).map(n => n.content).join('\n');
const botonesDe = p => nodos(aJson(p)).filter(n => n.type === 2);

// Borra el estado de fidelidad y del ranking para empezar limpio.
function limpiar() {
    for (const f of ['fidelidad.json', 'robuxLeaderboard.json', 'reviews.json']) {
        const ruta = dataPath(f);
        if (fs.existsSync(ruta)) fs.unlinkSync(ruta);
    }
}

let orden = 0;
const comprar = (userId, n = 1) => { for (let i = 0; i < n; i++) lb.recordPurchase(userId, 1000, 133, `orden-${++orden}`); };

module.exports = async function run() {
    const { assert, finish } = createSuite('fidelidad');

    assert(
        !path.resolve(dataPath('fidelidad.json')).startsWith(path.resolve(RAIZ, 'data')),
        'el estado de prueba va a un DATA_DIR temporal, nunca al ./data del proyecto'
    );

    // ── 1. La aritmética ─────────────────────────────────────────────────────
    limpiar();
    fidelidad.inicializar();
    const U = 'cliente-1';

    let e = fidelidad.estado(U);
    assert(e.compras === 0 && e.disponibles === 0 && e.faltan === F.CADA, 'sin compras: 0 y le faltan todas');

    comprar(U, F.CADA - 1);
    e = fidelidad.estado(U);
    assert(e.progreso === F.CADA - 1 && e.faltan === 1 && e.disponibles === 0, `a ${F.CADA - 1} compras le falta 1 y aún no tiene descuento`);

    comprar(U);
    e = fidelidad.estado(U);
    assert(e.disponibles === 1, `a las ${F.CADA} compras gana un descuento`);
    assert(e.progreso === 0 && e.faltan === F.CADA, 'y el progreso vuelve a empezar');

    assert(fidelidad.usar(U) === true, 'se puede usar');
    assert(fidelidad.estado(U).disponibles === 0, 'y ya no lo tiene');
    assert(fidelidad.usar(U) === false, 'no se puede usar dos veces');
    assert(fidelidad.usar('nadie') === false, 'ni usar uno que no se ha ganado');

    // La compra en la que se usa el descuento cuenta para el siguiente.
    comprar(U, F.CADA);
    e = fidelidad.estado(U);
    assert(e.disponibles === 1 && e.usados === 1, `${F.CADA} compras más dan otro, aunque una fuera con descuento`);

    // Varios guardados: se usan de uno en uno.
    comprar(U, F.CADA);
    assert(fidelidad.estado(U).disponibles === 2, 'se pueden acumular');
    fidelidad.usar(U);
    assert(fidelidad.estado(U).disponibles === 1, 'y se gastan de uno en uno');

    // ── 2. Los usados sobreviven a la reconstrucción del ranking ─────────────
    // backfillFromOrderLog llama a resetUsers() y rehace el ranking desde el
    // canal de pedidos en CADA arranque. Las compras vuelven (vienen del canal),
    // pero si los usados vivieran ahí se perderían.
    const usadosAntes = fidelidad.estado(U).usados;
    const comprasAntes = fidelidad.estado(U).compras;
    const ordenesU = orden;
    lb.resetUsers();
    for (let i = 1; i <= ordenesU; i++) lb.recordPurchase(U, 1000, 133, `orden-${i}`);  // como el backfill
    e = fidelidad.estado(U);
    assert(e.usados === usadosAntes, `tras reconstruir el ranking, los usados siguen siendo ${usadosAntes}`);
    assert(e.compras === comprasAntes, 'y las compras vuelven a ser las mismas');

    // ── 3. Cuentan las de después de activarlo ───────────────────────────────
    limpiar();
    comprar('veterano', 12);
    assert(fidelidad.estado('veterano').disponibles === 0, 'antes de activar el programa no cuenta nada');
    fidelidad.inicializar();
    e = fidelidad.estado('veterano');
    assert(e.compras === 0 && e.comprasTotales === 12, 'al activarlo, sus 12 compras viejas no regalan descuentos');
    assert(fidelidad.inicializar() === false, 'activarlo otra vez no rehace la base');
    comprar('veterano', F.CADA);
    assert(fidelidad.estado('veterano').disponibles === 1, `y gana su descuento con ${F.CADA} compras nuevas`);
    comprar('nuevo', 1);
    assert(fidelidad.estado('nuevo').compras === 1, 'un cliente nuevo cuenta desde su primera compra');

    const antes = F.RETROACTIVO;
    try {
        F.RETROACTIVO = true;
        assert(fidelidad.estado('veterano').ganados === Math.floor(17 / F.CADA),
            'con RETROACTIVO, cuenta todo el historial');
    } finally {
        F.RETROACTIVO = antes;
    }
    assert(F.RETROACTIVO === false, 'y por defecto NO es retroactivo');

    // ── 4. La barra y el precio ──────────────────────────────────────────────
    // La barra son emojis de la aplicación: inicio, medio y fin, llenos o
    // vacíos. Se comprueba la secuencia de piezas, no los ids.
    const piezas = n => [...fidelidad.barra(n).matchAll(/<:barra7x_(\w+?)_(on|off):(\d+)>/g)].map(m => `${m[1]}_${m[2]}`);
    assert(piezas(3).join(',') === 'ini_on,med_on,med_on,med_off,fin_off', 'la barra pinta lleno lo hecho y vacío lo que falta');
    assert(piezas(0).join(',') === 'ini_off,med_off,med_off,med_off,fin_off', 'vacía: todo apagado');
    assert(piezas(9).join(',') === 'ini_on,med_on,med_on,med_on,fin_on', 'y no se sale de sus 5 casillas');
    assert(piezas(F.CADA).length === F.CADA, 'una pieza por compra del ciclo');
    for (const [clave, id] of Object.entries(F.BARRA)) {
        assert(/^\d{17,20}$/.test(id), `la pieza ${clave} tiene un id de emoji válido`);
    }
    assert(fidelidad.barra(2).includes(`:${F.BARRA.ini_on}>`) && fidelidad.barra(2).includes(`:${F.BARRA.fin_off}>`),
        'cada pieza usa su id de config');
    assert(!/🟩|⬜/.test(fidelidad.barra(3)), 'ya no usa los cuadrados de antes');
    assert(fidelidad.aplicar(133) === Math.round(133 * (1 - F.DESCUENTO / 100)), `el ${F.DESCUENTO}% se redondea al peso`);
    assert(fidelidad.aplicar(0) === null && fidelidad.aplicar(NaN) === null, 'y no inventa precio con basura');

    // ── 5. Los comandos ──────────────────────────────────────────────────────
    limpiar();
    fidelidad.inicializar();
    comprar('a', 7);
    comprar('b', 1);
    const t = fidelidad.totalesServidor();
    assert(t.compras === 8 && t.clientes === 2 && t.robux === 8000, 'los totales del servidor salen del ranking');

    const compras = cmd.buildComprasTexto('a');
    assert(compras.includes('**8**') && compras.includes('**2**'), '/compras dice las compras y los clientes del servidor');
    assert(/Tú has comprado \*\*7,000 Robux\*\* en 7 compras/.test(compras), 'y las tuyas: Robux y compras');
    assert(/Tú \(kəv\) has comprado/.test(cmd.buildComprasTexto('a', 'kəv')), 'con el nombre de quien pregunta');
    assert(/Todavía no has comprado/.test(cmd.buildComprasTexto('desconocido')), 'y si no has comprado, lo dice sin quedarse vacío');

    const robux = cmd.buildRobuxGastadosTexto('a');
    assert(robux.includes('8,000 Robux'), '/robuxgastados dice los Robux del servidor');
    assert(robux.includes('7,000 Robux'), 'y los tuyos');

    const mias = cmd.buildMisComprasTexto('a');
    assert(mias.includes(fidelidad.barra(2)) && mias.includes('**2/5**'), '/miscompras pinta la barra verde');
    assert(/faltan \*\*3\*\*/.test(mias), 'y cuántas faltan');
    assert(/Tienes \*\*1\*\* descuento/.test(mias), 'y los descuentos guardados');
    assert(/Compras completadas: \*\*7\*\*/.test(mias), 'y sus totales');
    assert(/Fidelidad de kəv en 7x/.test(cmd.buildMisComprasTexto('a', 'kəv')), 'publicado, el título dice de quién es');

    // /miscompras se publica en el canal, no sólo para quien lo usa.
    const enviado = [];
    await require('../../handlers/commands').handleMisCompras({
        user: { id: 'a', username: 'kev', globalName: null }, member: { displayName: 'kəv' },
        replied: false, deferred: false, reply: async o => enviado.push(o),
    });
    assert(enviado.length === 1 && (enviado[0].flags & 64) !== 64, '/miscompras se publica, no es efímero');

    const MAIN = fs.readFileSync(path.join(RAIZ, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
    for (const nombre of ['compras', 'robuxgastados', 'miscompras']) {
        assert(new RegExp(`name: '${nombre}',\\n\\s*description:`).test(MAIN), `/${nombre} está registrado`);
        assert(new RegExp(`commandName === '${nombre}'`).test(MAIN), `y enrutado`);
    }

    // El programa se activa DESPUÉS de reconstruir el ranking.
    const iBackfill = MAIN.indexOf('await backfillFromOrderLog(client)');
    const iInicio = MAIN.indexOf('fidelidad.inicializar()');
    assert(iInicio > iBackfill && iBackfill > 0, 'la fidelidad se activa después de reconstruir el ranking, no antes');
    assert(/iniciarCaducidad\(client\)/.test(MAIN), 'y la revisión de plazos de las reseñas arranca con el bot');

    // ── 6. El descuento dentro de la compra ──────────────────────────────────
    for (const escenario of await simularCompra()) assert(escenario.ok, escenario.msg);

    // ── 7. Se gasta al confirmar el pago ─────────────────────────────────────
    const BOTONES = fs.readFileSync(path.join(RAIZ, 'handlers', 'buttons.js'), 'utf8');
    const deConfirmar = BOTONES.match(/async function onConfirmarPago[\s\S]*?\n\}/)?.[0] ?? '';
    assert(/pedido\?\.descuentoFidelidad[\s\S]{0,80}fidelidad\.usar\(ownerId\)/.test(deConfirmar),
        'PAGO REALIZADO gasta el descuento cuando el ticket lo lleva');
    assert(deConfirmar.indexOf('fidelidad.usar') > deConfirmar.indexOf('isConfirmed'),
        'y sólo después de comprobar que el pago no estaba ya confirmado');

    // ── 8. Las estrellas y el plazo ──────────────────────────────────────────
    for (const escenario of await simularResenas()) assert(escenario.ok, escenario.msg);

    limpiar();
    return finish();
};

// ── La compra con descuento ──────────────────────────────────────────────────

async function simularCompra() {
    const out = [];
    const USER = 'comprador-fid';
    const LEE_PRECIO = t => t.match(/Precio final a pagar\*\*\n```\$([^`]+) MXN```/)?.[1] ?? t.match(/Precio a pagar\*\*\n```\$([^`]+) MXN```/)?.[1];

    const orig = {
        getUserByUsername: roblox.getUserByUsername, getHeadshot: roblox.getHeadshot,
        createTicket: tickets.createTicket, hasActiveTicket: tickets.hasActiveTicket,
        buildCommunitySummary: communityStatus.buildCommunitySummary,
    };
    roblox.getUserByUsername = async () => ({ id: 1, name: 'Comprador', displayName: 'Comprador' });
    roblox.getHeadshot = async () => 'https://x/h.png';
    communityStatus.buildCommunitySummary = async () => ({ texto: '', comunidades: [] });
    const creados = [];
    tickets.hasActiveTicket = async () => false;
    tickets.createTicket = async (g, u, type, name, pedido) => {
        const ch = { id: `c${creados.length}`, name, type, pedido, enviados: [], send: async p => { ch.enviados.push(p); return {}; }, toString: () => '#t' };
        creados.push(ch);
        return ch;
    };

    const enviar = async (campos, customId = 'comprar_modal') => {
        spam.unlock(`modal:${USER}`);
        const r = [];
        const it = {
            replied: false, deferred: false, customId, user: { id: USER }, guild: {}, client: {},
            fields: { getTextInputValue: id => { if (!(id in campos)) throw new Error('x'); return campos[id]; } },
            deferReply: async () => { it.deferred = true; }, editReply: async o => r.push(o), reply: async o => r.push(o),
        };
        await handleModal(it);
        return r[0];
    };
    const pulsar = async customId => {
        const r = [];
        const it = { replied: false, deferred: false, customId, user: { id: USER }, guild: {}, client: {},
            deferUpdate: async () => { it.deferred = true; }, editReply: async o => r.push(o), followUp: async o => r.push(o) };
        await flujo.handleCompraButton(it);
        return r;
    };

    try {
        limpiar();
        pendientes._reset();
        fidelidad.inicializar();

        // Sin descuento guardado: dos botones, y la barra de progreso.
        comprar(USER, 3);
        let conf = await enviar({ usuario_roblox: 'c', cantidad_robux: '1000', codigo_descuento: '' });
        let ids = botonesDe(conf).map(b => b.custom_id.split(':')[0]);
        out.push({ ok: !ids.includes('compra_desc'), msg: 'sin descuento guardado no se ofrece' });
        out.push({ ok: textoDe(conf).includes(fidelidad.barra(3)), msg: 'la confirmación enseña su barra de fidelidad' });

        // Con uno guardado: se ofrece.
        comprar(USER, 2);
        conf = await enviar({ usuario_roblox: 'c', cantidad_robux: '1000', codigo_descuento: '' });
        ids = botonesDe(conf).map(b => b.custom_id.split(':')[0]);
        out.push({ ok: ids.join(',') === 'compra_desc,compra_ok,compra_no', msg: 'con uno guardado: usarlo, continuar sin él, o cancelar' });
        out.push({ ok: /Tienes un descuento de fidelidad/.test(textoDe(conf)), msg: 'y se le explica' });
        out.push({ ok: textoDe(conf).includes(`$${fidelidad.aplicar(133)} MXN`), msg: 'con lo que pagaría usándolo' });

        // Continuar SIN usarlo: se queda guardado.
        const token = botonesDe(conf).find(b => b.custom_id.startsWith('compra_ok:'))?.custom_id?.split(':')[1] ?? 'sin-token';
        await pulsar(`compra_ok:${token}`);
        let ch = creados.at(-1);
        out.push({ ok: LEE_PRECIO(textoDe(ch.enviados[0])) === '133', msg: 'sin usarlo, el ticket cobra el precio normal' });
        out.push({ ok: !ch.pedido.descuentoFidelidad, msg: 'y no lo marca en el ticket' });
        out.push({ ok: fidelidad.estado(USER).disponibles === 1, msg: 'y el descuento sigue guardado' });
        const resumen = textoDe(ch.enviados[0]);
        out.push({ ok: /Tu fidelidad/.test(resumen) && resumen.includes(fidelidad.barra(0)), msg: 'el ticket lleva la barra verde de fidelidad' });

        // Usándolo.
        conf = await enviar({ usuario_roblox: 'c', cantidad_robux: '1000', codigo_descuento: '' });
        const tDesc = botonesDe(conf).find(b => b.custom_id.startsWith('compra_desc:'))?.custom_id?.split(':')[1] ?? 'sin-token';
        await pulsar(`compra_desc:${tDesc}`);
        ch = creados.at(-1);
        const conDesc = textoDe(ch.enviados[0]);
        out.push({ ok: LEE_PRECIO(conDesc) === String(fidelidad.aplicar(133)), msg: 'usándolo, el registro de pedidos lee el precio con descuento' });
        out.push({ ok: /Descuento de fidelidad/.test(conDesc), msg: 'y el resumen lo dice' });
        out.push({ ok: ch.pedido.descuentoFidelidad === true, msg: 'el ticket lo lleva marcado en su topic' });
        // Abrir el ticket NO lo gasta: se gasta al confirmar el pago.
        out.push({ ok: fidelidad.estado(USER).disponibles === 1, msg: 'abrir el ticket NO lo gasta: si no paga, lo conserva' });
        out.push({ ok: /Estás usando tu/.test(conDesc), msg: 'y la barra del ticket dice que lo está usando' });

        // Gamepass también.
        conf = await enviar({ usuario_roblox: 'c', cantidad_robux: '1000' }, 'gamepass_compra_modal');
        out.push({ ok: botonesDe(conf).some(b => b.custom_id.startsWith('compra_desc:')), msg: 'también se ofrece en compras por gamepass' });

        // Con un cupón válido no se ofrece: no se combinan.
        require('../../utils/coupons').createCoupon('FIDTEST', 20, 5, 100000, 'owner');
        conf = await enviar({ usuario_roblox: 'c', cantidad_robux: '1000', codigo_descuento: 'FIDTEST' });
        out.push({ ok: !botonesDe(conf).some(b => b.custom_id.startsWith('compra_desc:')), msg: 'con un cupón válido no se ofrece: no se combinan' });
        out.push({ ok: /no se combina con cupones/.test(textoDe(conf)), msg: 'y se le dice que se queda guardado' });

        // Si al pulsar ya no lo tiene, el ticket se abre sin él y se avisa.
        conf = await enviar({ usuario_roblox: 'c', cantidad_robux: '1000', codigo_descuento: '' });
        const tTarde = botonesDe(conf).find(b => b.custom_id.startsWith('compra_desc:'))?.custom_id?.split(':')[1] ?? 'sin-token';
        fidelidad.usar(USER);  // lo gastó en otro sitio entre medias
        const r = await pulsar(`compra_desc:${tTarde}`);
        ch = creados.at(-1);
        out.push({ ok: !ch.pedido.descuentoFidelidad && LEE_PRECIO(textoDe(ch.enviados[0])) === '133', msg: 'si al pulsar ya no lo tiene, el ticket se abre sin él' });
        out.push({ ok: /ya no estaba disponible/.test(textoDe(r.at(-1))), msg: 'y se le avisa' });
    } finally {
        Object.assign(roblox, { getUserByUsername: orig.getUserByUsername, getHeadshot: orig.getHeadshot });
        Object.assign(tickets, { createTicket: orig.createTicket, hasActiveTicket: orig.hasActiveTicket });
        communityStatus.buildCommunitySummary = orig.buildCommunitySummary;
        pendientes._reset();
    }

    return out;
}

// ── Las reseñas ──────────────────────────────────────────────────────────────

function clienteFalso() {
    const ediciones = [];
    const mensaje = id => ({ id, edit: async p => { ediciones.push({ id, p }); return {}; } });
    return {
        ediciones,
        channels: { fetch: async id => ({ messages: { fetch: async mid => mensaje(mid) }, send: async () => mensaje('nuevo') }) },
        users: { fetch: async () => ({ displayAvatarURL: () => 'https://x/a.png', createDM: async () => ({ messages: { fetch: async mid => mensaje(mid) } }) }) },
    };
}

async function simularResenas() {
    const out = [];
    const { buildAnnounceEmbed } = reviewFlow.__test;

    // Los cinco botones
    const fila = reviewFlow.buildReviewRow('t', 'abierta').toJSON().components;
    out.push({ ok: fila.length === 5, msg: 'la valoración son cinco botones' });
    out.push({ ok: fila.map(b => b.label).join('|') === '⭐|⭐⭐|⭐⭐⭐|⭐⭐⭐⭐|⭐⭐⭐⭐⭐', msg: 'de una a cinco estrellas' });
    out.push({ ok: fila.every((b, i) => b.custom_id === `review_star:t:${i + 1}`), msg: 'cada uno con su puntuación en el customId' });

    // El anuncio pendiente ya no es "???"
    const pendiente = buildAnnounceEmbed('u', null, null, '1,000 Robux').toJSON().description;
    out.push({ ok: !pendiente.includes('???'), msg: 'el anuncio pendiente ya no dice "???"' });
    out.push({ ok: /Esperando la valoración/.test(pendiente), msg: 'dice que espera la valoración' });

    // El anuncio cerrado por plazo: verdad, no una reseña inventada
    const cerrado = buildAnnounceEmbed('u', null, null, '1,000 Robux', null, true).toJSON().description;
    out.push({ ok: /Entrega verificada/.test(cerrado), msg: 'cerrada por plazo dice "Entrega verificada", que es cierto' });
    out.push({ ok: /no dejó valoración/.test(cerrado), msg: 'y que el cliente no dejó valoración' });
    out.push({ ok: !/legit|rapid|excelente|⭐|\(\d\/5\)/i.test(cerrado) && !cerrado.includes('<a:star:'),
        msg: 'y NO se inventa una valoración ni estrellas a nombre del cliente' });

    // Valorar a tiempo
    limpiar();
    reviews.createReviewRequest('ticket-ok', 'comprador', '1,000 Robux');
    reviews.setDmMessageRef('ticket-ok', 'dm', 'msg-dm');
    reviews.setAnnounceMessageRef('ticket-ok', 'resenas', 'msg-anuncio');
    let cliente = clienteFalso();
    reviews.submitRating('ticket-ok', 'comprador', 5, null, 'dm');
    await reviewFlow.finalizeReview(cliente, 'ticket-ok', 5, null);
    const anuncio = cliente.ediciones.find(x => x.id === 'msg-anuncio')?.p?.embeds?.[0]?.toJSON?.()?.description ?? '';
    out.push({ ok: /\(5\/5\)/.test(anuncio), msg: 'al valorar, el anuncio enseña la puntuación real' });
    const dm = cliente.ediciones.find(x => x.id === 'msg-dm')?.p;
    out.push({ ok: botonesDe(dm).every(b => b.disabled) && botonesDe(dm).length === 5, msg: 'y las estrellas del DM se apagan' });

    // El plazo: vencida, se cierra sola
    limpiar();
    reviews.createReviewRequest('ticket-viejo', 'comprador', '1,000 Robux');
    reviews.setDmMessageRef('ticket-viejo', 'dm', 'msg-dm');
    reviews.setAnnounceMessageRef('ticket-viejo', 'resenas', 'msg-anuncio');

    cliente = clienteFalso();
    out.push({ ok: (await reviewFlow.cerrarVencidas(cliente, Date.now())) === 0, msg: 'recién pedida no se cierra' });
    const once = Date.now() + (config.RESENAS.PLAZO_HORAS - 1) * 3600_000;
    out.push({ ok: (await reviewFlow.cerrarVencidas(cliente, once)) === 0, msg: `a las ${config.RESENAS.PLAZO_HORAS - 1} horas todavía no` });

    const tarde = Date.now() + config.RESENAS.PLAZO_HORAS * 3600_000 + 1000;
    out.push({ ok: (await reviewFlow.cerrarVencidas(cliente, tarde)) === 1, msg: `a las ${config.RESENAS.PLAZO_HORAS} horas se cierra sola` });

    const dmCerrado = cliente.ediciones.find(x => x.id === 'msg-dm')?.p;
    out.push({ ok: botonesDe(dmCerrado).every(b => b.disabled), msg: 'las estrellas del DM se apagan' });
    out.push({ ok: /plazo para valorar esta compra terminó/.test(textoDe(dmCerrado)), msg: 'y dice que el plazo terminó' });
    const anuncioCerrado = cliente.ediciones.find(x => x.id === 'msg-anuncio')?.p?.embeds?.[0]?.toJSON?.()?.description ?? '';
    out.push({ ok: /Entrega verificada/.test(anuncioCerrado), msg: 'el anuncio pasa a "Entrega verificada"' });
    out.push({ ok: reviews.getReview('ticket-viejo').rating === null, msg: 'y la valoración se queda VACÍA: no se rellena por el cliente' });

    out.push({ ok: (await reviewFlow.cerrarVencidas(cliente, tarde)) === 0, msg: 'una ya cerrada no se vuelve a cerrar' });
    out.push({ ok: reviews.submitRating('ticket-viejo', 'comprador', 5, null, 'dm') === false, msg: 'y ya no se puede valorar' });

    // El botón de estrellas tras el plazo, aunque la revisión aún no haya pasado.
    const BOTONES = fs.readFileSync(path.join(RAIZ, 'handlers', 'buttons.js'), 'utf8');
    const deStar = BOTONES.match(/async function onReviewStar[\s\S]*?\n\}/)?.[0] ?? '';
    out.push({ ok: /estaVencida\(review, PLAZO_RESENA_MS\)/.test(deStar), msg: 'pulsar una estrella vencida dice que el plazo terminó, sin esperar a la revisión' });
    out.push({ ok: /interaction\.user\.id !== review\.buyerId/.test(deStar), msg: 'y sólo el comprador puede valorar' });
    out.push({ ok: /isStar \? onReviewStar/.test(BOTONES), msg: 'las estrellas están enrutadas' });

    // El botón viejo de los DMs ya enviados enseña las estrellas, no el formulario.
    const deRate = BOTONES.match(/async function onReviewRate[\s\S]*?\n\}/)?.[0] ?? '';
    out.push({ ok: !/safeShowModal/.test(deRate) && /buildReviewPayload/.test(deRate), msg: 'el botón viejo de "Calificar atención" ahora enseña las estrellas' });

    return out;
}
