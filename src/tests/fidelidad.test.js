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

const { ButtonStyle } = require('discord.js');
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

// Los pedidos llevan ids de mensaje de Discord de verdad (snowflakes): su fecha
// va dentro, y la fidelidad cuenta los de desde FIDELIDAD.INICIO.
let orden = 0;
const historial = [];
const snowflake = (ms, seq) => String(((BigInt(ms) - 1420070400000n) << 22n) + BigInt(seq % 4096));
const comprarEn = (ms, userId, n = 1, opciones = {}) => {
    for (let i = 0; i < n; i++) {
        const id = snowflake(ms, ++orden);
        historial.push({ userId, id, opciones });
        lb.recordPurchase(userId, 1000, 133, id, opciones);
    }
};
const comprar = (userId, n = 1, opciones = {}) => comprarEn(Date.now(), userId, n, opciones);

module.exports = async function run() {
    const { assert, finish } = createSuite('fidelidad');

    assert(
        !path.resolve(dataPath('fidelidad.json')).startsWith(path.resolve(RAIZ, 'data')),
        'el estado de prueba va a un DATA_DIR temporal, nunca al ./data del proyecto'
    );

    // ── 1. La aritmética ─────────────────────────────────────────────────────
    limpiar();
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
    lb.resetUsers();
    for (const h of historial) lb.recordPurchase(h.userId, 1000, 133, h.id, h.opciones);  // como el backfill
    e = fidelidad.estado(U);
    assert(e.usados === usadosAntes, `tras reconstruir el ranking, los usados siguen siendo ${usadosAntes}`);
    assert(e.compras === comprasAntes, 'y las compras vuelven a ser las mismas');

    // ── 3. Cuentan las de después de activarlo ───────────────────────────────
    limpiar();
    const INICIO = Date.parse(F.INICIO);
    comprarEn(INICIO - 86400_000, 'veterano', 12);
    e = fidelidad.estado('veterano');
    assert(e.compras === 0 && e.comprasTotales === 12, 'sus 12 compras de antes de INICIO no regalan descuentos');
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

    // ── 3b. Un reinicio o un despliegue no reinicia el progreso ──────────────
    // Lo que pasa en cada arranque: el ranking se borra y se rehace desde el
    // canal de pedidos. Aunque además se perdiera fidelidad.json, el progreso
    // y los descuentos usados tienen que quedar exactamente igual.
    limpiar();
    historial.length = 0;
    comprar('kev', 3);
    assert(fidelidad.estado('kev').progreso === 3, 'tres compras: 3/5');
    comprar('kev', 2);
    fidelidad.usar('kev');
    comprar('kev', 1, { descuentoFidelidad: true });   // la compra en que lo gastó
    const antesReinicio = fidelidad.estado('kev');
    lb.resetUsers();
    fs.unlinkSync(dataPath('fidelidad.json'));
    for (const h of historial) lb.recordPurchase(h.userId, 1000, 133, h.id, h.opciones);
    const trasReinicio = fidelidad.estado('kev');
    assert(trasReinicio.compras === 6 && trasReinicio.progreso === 1,
        `tras reiniciar sigue en ${antesReinicio.progreso}/5 con ${antesReinicio.compras} compras (${trasReinicio.progreso}/5, ${trasReinicio.compras})`);
    assert(trasReinicio.usados === 1 && trasReinicio.disponibles === 0,
        'y el descuento gastado sigue gastado aunque se perdiera el fichero');

    // El backfill lee la marca de descuento del canal de pedidos.
    const BACKFILL = fs.readFileSync(path.join(RAIZ, 'utils', 'robuxLeaderboardBackfill.js'), 'utf8');
    const reMarca = BACKFILL.match(/const descuentoFidelidad = (\/.*\/)\.test\(desc\)/)?.[1];
    const marca = reMarca ? eval(reMarca) : null;
    const NOTIFY = fs.readFileSync(path.join(RAIZ, 'utils', 'orderNotify.js'), 'utf8');
    assert(/name: 'Descuento', value: `Fidelidad/.test(NOTIFY), 'el pedido apunta "Descuento: Fidelidad"');
    assert(marca && marca.test("**Precio**\n`$113 MXN`\n\n**Descuento**\n`Fidelidad 15%`"), 'y el backfill la reconoce');
    assert(marca && !marca.test("**Precio**\n`$133 MXN`"), 'un pedido sin descuento no cuenta como usado');
    assert(fidelidad.fechaPedido(snowflake(Date.parse(F.INICIO), 1)) === Date.parse(F.INICIO), 'la fecha sale del id del mensaje');
    assert(fidelidad.fechaPedido('orden-1') === null, 'un id que no es de Discord no tiene fecha (y no cuenta)');

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

    // Ya no hay una "base" que se tome al arrancar: el progreso se recalcula
    // desde el canal de pedidos y una fecha fija.
    assert(!/fidelidad.inicializar/.test(MAIN), 'el arranque no toma ninguna base que pueda reiniciar el progreso');
    assert(!Number.isNaN(Date.parse(F.INICIO)), 'FIDELIDAD.INICIO es una fecha válida');
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

        // Sólo en compras de hasta FIDELIDAD.MAX_ROBUX.
        const MAXR = fidelidad.F.MAX_ROBUX;
        out.push({ ok: MAXR === 5000, msg: 'el descuento vale hasta 5,000 Robux' });
        out.push({ ok: fidelidad.valeParaRobux(MAXR) && !fidelidad.valeParaRobux(MAXR + 1) && !fidelidad.valeParaRobux(0),
            msg: 'justo 5,000 sí; 5,001 ya no' });
        conf = await enviar({ usuario_roblox: 'c', cantidad_robux: String(MAXR), codigo_descuento: '' });
        out.push({ ok: botonesDe(conf).some(b => b.custom_id.startsWith('compra_desc:')), msg: 'en una compra de 5,000 se ofrece' });
        conf = await enviar({ usuario_roblox: 'c', cantidad_robux: '10000', codigo_descuento: '' });
        out.push({ ok: !botonesDe(conf).some(b => b.custom_id.startsWith('compra_desc:')), msg: 'en una de 10,000 no se ofrece' });
        out.push({ ok: /válido en compras de hasta \*\*5,000 Robux\*\*/.test(textoDe(conf)), msg: 'y se le dice por qué, y que sigue guardado' });
        // Aunque alguien pulse un botón de descuento en una compra grande, no se aplica.
        const tGrande = botonesDe(conf).find(b => b.custom_id.startsWith('compra_ok:'))?.custom_id?.split(':')[1] ?? 'sin-token';
        await pulsar(`compra_desc:${tGrande}`);
        out.push({ ok: !creados.at(-1).pedido?.descuentoFidelidad, msg: 'un botón de descuento forzado en una compra grande no lo aplica' });
        out.push({ ok: fidelidad.estado(USER).disponibles === 1, msg: 'y el descuento sigue guardado' });
        out.push({ ok: /hasta 5,000 Robux/.test(cmd.buildMisComprasTexto(USER)), msg: '/miscompras avisa del límite' });
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

    // Los cinco botones, en UNA fila y con el emoji dentro de cada botón.
    const filaEstrellas = reviewFlow.buildEstrellas('t', 'abierta').toJSON();
    const fila = filaEstrellas.components;
    out.push({ ok: filaEstrellas.type === 1 && fila.length === 5 && fila.every(b => b?.type === 2),
        msg: 'la valoración son cinco botones en una sola fila' });
    out.push({ ok: fila.map(b => b.label).join('|') === '1/5|2/5|3/5|4/5|5/5', msg: 'de 1/5 a 5/5' });
    out.push({ ok: fila.slice(0, 4).every(b => b.emoji?.id === '1190502686886481991'),
        msg: 'del 1 al 4, el emoji de estadísticas dentro del botón' });
    out.push({ ok: fila[4].emoji?.id === '1514369366878064650' && fila[4].emoji?.animated === true,
        msg: 'y en el 5, la estrella animada' });
    out.push({ ok: !JSON.stringify(fila).includes('⭐'), msg: 'ninguna ⭐ de Unicode' });

    // Las frases de un clic
    const FRASES = config.RESENAS.FRASES;
    const frasesDe = p => botonesDe(p).filter(b => b.custom_id?.startsWith('review_frase:'));
    const frasesAbierta = frasesDe(reviewFlow.buildReviewPayload('u', 't', 'abierta'));
    out.push({ ok: FRASES.length === 5 && frasesAbierta.map(b => b.label).join('|') === FRASES.join('|'),
        msg: 'la tarjeta trae las cinco frases recomendadas' });
    out.push({ ok: frasesAbierta.every((b, i) => b.custom_id === `review_frase:t:${i}` && !b.disabled && b.label.length <= 80),
        msg: 'cada una con su índice y activa' });
    out.push({ ok: aJson(reviewFlow.buildReviewPayload('u', 't', 'abierta'))[0].components.filter(c => c.type === 1).every(f => f.components.length <= 5),
        msg: 'ninguna fila pasa de 5 botones' });
    const conFrase = frasesDe(reviewFlow.buildReviewPayload('u', 't', 'calificada', 5, FRASES[2]));
    out.push({ ok: conFrase.every(b => b.disabled) && conFrase.filter(b => b.style === ButtonStyle.Success).map(b => b.label).join() === FRASES[2],
        msg: 'al elegir una, se apagan y la elegida queda en verde' });
    out.push({ ok: frasesDe(reviewFlow.buildReviewPayload('u', 't', 'cerrada')).every(b => b.disabled), msg: 'cerrada por plazo, apagadas' });

    limpiar();
    reviews.createReviewRequest('tf', 'comprador', '1,000 Robux');
    reviews.setDmMessageRef('tf', 'dm', 'msg-dm');
    reviews.setAnnounceMessageRef('tf', 'resenas', 'msg-anuncio');
    const respuestas = [];
    const clic = (userId, i) => ({
        customId: `review_frase:tf:${i}`, user: { id: userId }, replied: false, deferred: false,
        client: clienteFalso(), channel: { isDMBased: () => true },
        reply: async o => { respuestas.push(o.content); },
        isRepliable: () => true,
    });
    const btn = require('../../handlers/buttons');
    await btn.handleButton(clic('otro', 0));
    out.push({ ok: !reviews.getReview('tf').comment, msg: 'otra persona no puede usar las frases' });
    const bueno = clic('comprador', 1);
    await btn.handleButton(bueno);
    out.push({ ok: reviews.getReview('tf').comment === FRASES[1], msg: 'el comprador toca una frase y queda como su comentario' });
    const anuncioFrase = bueno.client.ediciones.find(x => x.id === 'msg-anuncio')?.p?.embeds?.[0]?.toJSON?.()?.description ?? '';
    out.push({ ok: anuncioFrase.includes(`**Comentario:** ${FRASES[1]}`), msg: 'y se publica en el anuncio' });
    const dmFrase = bueno.client.ediciones.find(x => x.id === 'msg-dm')?.p;
    out.push({ ok: frasesDe(dmFrase).find(b => b.label === FRASES[1])?.style === ButtonStyle.Success,
        msg: 'y en el DM queda resaltada' });
    await btn.handleButton(clic('comprador', 0));
    out.push({ ok: reviews.getReview('tf').comment === FRASES[1], msg: 'no se cambia por otra: una sola vez' });

    const comentar = botonesDe(reviewFlow.buildReviewPayload('u', 't', 'abierta')).find(b => b.custom_id === 'review_comment:t');
    out.push({ ok: comentar?.style === 2 && comentar?.emoji?.id === '1501217620437897227',
        msg: 'el botón de comentario es gris y con su emoji' });

    // El botón de comentario
    const conCom = p => botonesDe(p).find(b => b.custom_id?.startsWith('review_comment:'));
    const abierta = reviewFlow.buildReviewPayload('u', 't', 'abierta');
    out.push({ ok: conCom(abierta)?.custom_id === 'review_comment:t' && !conCom(abierta).disabled && /Agregar comentario/.test(conCom(abierta).label),
        msg: 'la tarjeta trae "Agregar comentario"' });
    out.push({ ok: !conCom(reviewFlow.buildReviewPayload('u', 't', 'calificada', 5)).disabled, msg: 'que sigue activo después de las estrellas' });
    const yaCom = conCom(reviewFlow.buildReviewPayload('u', 't', 'calificada', 5, true));
    out.push({ ok: yaCom.disabled && /enviado/.test(yaCom.label), msg: 'y se apaga cuando ya comentó' });
    out.push({ ok: conCom(reviewFlow.buildReviewPayload('u', 't', 'cerrada')).disabled, msg: 'y también si el plazo terminó' });

    limpiar();
    reviews.createReviewRequest('tc', 'comprador', '1,000 Robux');
    reviews.setDmMessageRef('tc', 'dm', 'msg-dm');
    reviews.setAnnounceMessageRef('tc', 'resenas', 'msg-anuncio');
    const PLAZO = config.RESENAS.PLAZO_HORAS * 3600_000;
    out.push({ ok: reviews.addComment('tc', 'otro', 'hola', PLAZO) === 'ajeno', msg: 'otra persona no puede comentar' });
    out.push({ ok: reviews.addComment('tc', 'comprador', 'Muy rápido', PLAZO, Date.now() + PLAZO + 1) === 'plazo', msg: 'ni se comenta pasado el plazo' });
    out.push({ ok: reviews.addComment('tc', 'comprador', 'Muy rápido', PLAZO) === 'ok', msg: 'el comprador comenta antes de valorar' });
    out.push({ ok: reviews.addComment('tc', 'comprador', 'otra vez', PLAZO) === 'ya-comentado', msg: 'una sola vez' });
    let cli = clienteFalso();
    await reviewFlow.actualizarComentario(cli, 'tc');
    const anuncioCom = cli.ediciones.find(x => x.id === 'msg-anuncio')?.p?.embeds?.[0]?.toJSON?.()?.description ?? '';
    out.push({ ok: /Comentario:\*\* Muy rápido/.test(anuncioCom) && /Esperando la valoración/.test(anuncioCom),
        msg: 'el anuncio enseña el comentario mientras espera las estrellas' });
    const dmCom = cli.ediciones.find(x => x.id === 'msg-dm')?.p;
    out.push({ ok: conCom(dmCom)?.disabled && botonesDe(dmCom).filter(b => b.custom_id.startsWith('review_star:')).every(b => !b.disabled),
        msg: 'en el DM se apaga el comentario y las estrellas siguen activas' });
    reviews.submitRating('tc', 'comprador', 4, null, 'dm');
    out.push({ ok: reviews.getReview('tc').comment === 'Muy rápido', msg: 'valorar después no borra el comentario' });
    cli = clienteFalso();
    await reviewFlow.finalizeReview(cli, 'tc', 4, null);
    const anuncioFinal = cli.ediciones.find(x => x.id === 'msg-anuncio')?.p?.embeds?.[0]?.toJSON?.()?.description ?? '';
    out.push({ ok: /\(4\/5\)/.test(anuncioFinal) && /Muy rápido/.test(anuncioFinal), msg: 'y el anuncio final lleva las estrellas y el comentario' });

    const BOT = fs.readFileSync(path.join(RAIZ, 'handlers', 'buttons.js'), 'utf8');
    const MOD = fs.readFileSync(path.join(RAIZ, 'handlers', 'modals.js'), 'utf8');
    out.push({ ok: /isComment \? onReviewComment/.test(BOT) && /isComentario \? handleComentarioModal/.test(MOD),
        msg: 'el botón y el formulario del comentario están enrutados' });
    out.push({ ok: fila.every((b, i) => b.custom_id === `review_star:t:${i + 1}`), msg: 'cada uno con su puntuación en el customId' });

    // Un ticket donde ya se pidió la reseña de OTRO comprador (el ticket del
    // staff, con /pagoverified @cliente): la del nuevo también se envía.
    limpiar();
    const enviadas = [];
    const canalStaff = { id: 'soporte-1', topic: 'ticket:{"userId":"staff","type":"soporte","ts":1}', send: async p => { enviadas.push(p); return { channelId: 'soporte-1', id: `m${enviadas.length}` }; } };
    const cliStaff = clienteFalso();
    await reviewFlow.requestReview(cliStaff, canalStaff, 'soporte-1', 'cliente-a');
    await reviewFlow.requestReview(cliStaff, canalStaff, 'soporte-1', 'cliente-a');
    out.push({ ok: enviadas.length === 1, msg: 'el mismo comprador dos veces en el mismo ticket: una sola reseña' });
    await reviewFlow.requestReview(cliStaff, canalStaff, 'soporte-1', 'cliente-b');
    const recB = reviews.getReview('soporte-1-cliente-b');
    out.push({ ok: enviadas.length === 2 && recB?.buyerId === 'cliente-b' && reviews.getReview('soporte-1').buyerId === 'cliente-a',
        msg: 'otro comprador en ese ticket: se le envía su propia reseña sin pisar la anterior' });
    out.push({ ok: botonesDe(enviadas[1]).filter(b => b.custom_id?.startsWith('review_star:soporte-1-cliente-b:')).length === 5,
        msg: 'y sus botones apuntan a la reseña nueva' });
    await reviewFlow.requestReview(cliStaff, canalStaff, 'soporte-1', 'cliente-b');
    out.push({ ok: enviadas.length === 2, msg: 'repetirlo con ese comprador no la duplica' });

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
    const estrellasDm = botonesDe(dm).filter(b => b.custom_id?.startsWith('review_star:'));
    out.push({ ok: estrellasDm.every(b => b.disabled) && estrellasDm.length === 5, msg: 'y las estrellas del DM se apagan' });

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
