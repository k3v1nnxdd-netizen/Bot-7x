'use strict';

// ── Promociones por MD ────────────────────────────────────────────────────────
//
// Lo que no puede romperse:
//
//   1. QUIEN SE DA DE BAJA NO RECIBE NADA MÁS, y puede volver a darse de alta.
//   2. NADIE RECIBE UNA RÁFAGA: un mensaje por persona y ronda, el recordatorio
//      como mucho cada DIAS_ENTRE_AVISOS, y la ronda limitada a MAX_POR_RONDA.
//   3. EL PRIMER ARRANQUE NO MANDA RESÚMENES DE COMPRAS VIEJAS.
//   4. UN FALLO (MDs cerrados) SE APUNTA: no se reintenta en cada ronda.
//   5. TODO ENVÍO, FALLO Y BAJA QUEDA EN EL REGISTRO, con la mención y el id.
//   6. EL AHORRO SÓLO SE ENSEÑA SI ES DE VERDAD (positivo).

const fs = require('fs');
const path = require('path');

const { createSuite } = require('./testHarness');
const config = require('../../config');
const promos = require('../../utils/promociones');
const leaderboard = require('../../utils/robuxLeaderboard');
const logCanales = require('../../utils/logCanales');

const RAIZ = path.join(__dirname, '..', '..');
const leer = f => fs.readFileSync(path.join(RAIZ, f), 'utf8').replace(/\r\n/g, '\n');
const t = promos.__test;
const DIA = t.DIA;

// Un id de pedido (snowflake) con la fecha dentro, como los del registro.
const idEn = ms => String((BigInt(Math.floor(ms)) - 1420070400000n) << 22n);

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
const planos = p => nodos((p?.components ?? []).map(c => (typeof c.toJSON === 'function' ? c.toJSON() : c)));
const textoDe = p => planos(p).filter(n => n.type === 10).map(n => n.content).join('\n');
const botonesDe = p => planos(p).filter(n => n.type === 2);

function comprador(userId, fechas, { robux = 1000, precio = 133 } = {}) {
    const ordenes = fechas.map(idEn);
    return {
        userId, totalRobux: robux * fechas.length, totalSpent: precio * fechas.length, purchases: fechas.length,
        ordenes, detalle: Object.fromEntries(ordenes.map(id => [id, { robux, precio }])),
    };
}

// Un cliente de Discord de mentira: quién está en el servidor, quién tiene
// los MDs cerrados, y lo que se manda.
function clienteFalso({ fuera = [], cerrados = [] } = {}) {
    const mds = [];
    const usuario = id => ({
        id,
        send: async p => {
            if (cerrados.includes(id)) { const e = new Error('Cannot send messages to this user'); e.code = 50007; throw e; }
            mds.push({ id, p });
        },
    });
    return {
        mds,
        guilds: { cache: { get: () => ({
            id: config.GUILD_ID,
            members: { fetch: async id => (fuera.includes(id) ? Promise.reject(new Error('Unknown Member')) : { user: usuario(id) }) },
        }) } },
        users: { fetch: async id => usuario(id) },
    };
}

module.exports = async function run() {
    const { assert, finish } = createSuite('promociones');
    const P = config.PROMOS;
    const ahora = Date.parse('2026-11-23T18:00:00Z');

    const registro = [];
    const origEnviar = logCanales.enviar;
    const origRanked = leaderboard.getRanked;
    const origPromos = { ...P };
    logCanales.enviar = async (guild, tipo, payload) => { registro.push({ tipo, texto: payload.content }); return { id: 'log' }; };

    try {
        // ── 1. El ahorro ─────────────────────────────────────────────────────
        assert(P.PRECIO_ROBLOX_POR_1K === 249, 'la referencia es $249 MXN por 1.000 Robux');
        const a = promos.ahorro(1000, 133);
        assert(a?.roblox === 249 && a.ahorrado === 116 && a.pct === 47, '1.000 Robux a $133: ahorra $116 (47%)');
        assert(promos.ahorro(1000, 300) === null, 'si no hay ahorro, no se inventa');
        assert(promos.ahorro(0, 0) === null && promos.ahorro(NaN, 10) === null, 'ni con datos imposibles');

        // ── 2. Qué toca mandar ───────────────────────────────────────────────
        const inicio = ahora - 10 * DIA;
        const datos = { inicio, bajas: { baja: 1 }, avisos: {}, resumenes: {} };
        const lista = [
            comprador('viejo', [ahora - 20 * DIA]),
            comprador('reciente', [ahora - 8 * DIA]),
            comprador('ayer', [ahora - 1.5 * DIA]),
            comprador('antes', [inicio - 2 * DIA, inicio - 1 * DIA]),
            comprador('baja', [ahora - 40 * DIA]),
            comprador('sinfecha', []),
        ];
        let pend = t.pendientes(ahora, datos, lista);
        const de = id => pend.filter(x => x.userId === id);
        assert(de('viejo').length === 1 && de('viejo')[0].tipo === 'inactivo', '20 días sin comprar: recordatorio');
        assert(de('reciente').length === 0, '8 días sin comprar y su resumen ya fuera de plazo: nada');
        assert(de('ayer')[0]?.tipo === 'resumen', 'una compra de ayer: su resumen');
        assert(de('antes').length === 0, 'compras de antes de que existiera el sistema: sin resumen (y aún no 14 días)');
        assert(de('baja').length === 0, 'quien se dio de baja: nada');
        assert(de('sinfecha').length === 0, 'un comprador sin pedidos con fecha: nada');

        // El recordatorio, como mucho cada DIAS_ENTRE_AVISOS.
        datos.avisos.viejo = ahora - 5 * DIA;
        assert(t.pendientes(ahora, datos, lista).every(x => x.userId !== 'viejo'), 'con un aviso hace 5 días, no se repite');
        datos.avisos.viejo = ahora - 15 * DIA;
        assert(t.pendientes(ahora, datos, lista).some(x => x.userId === 'viejo'), 'pasados 14 días del aviso, sí');
        datos.avisos = {};

        // Un resumen ya mandado no se repite, y uno caducado no se manda.
        datos.resumenes[lista[2].ordenes[0]] = ahora;
        assert(t.pendientes(ahora, datos, lista).every(x => x.userId !== 'ayer'), 'un resumen ya mandado no se repite');
        datos.resumenes = {};
        const caducado = comprador('caducado', [ahora - (P.DIAS_RESUMEN * DIA + t.VENTANA_RESUMEN_MS + DIA)]);
        assert(!t.pendientes(ahora, datos, [caducado]).some(x => x.tipo === 'resumen'), 'un resumen fuera de plazo ya no se manda');

        // Uno por persona y ronda: con resumen pendiente, el recordatorio espera.
        const ambos = comprador('ambos', [ahora - 30 * DIA, ahora - 1.2 * DIA]);
        pend = t.pendientes(ahora, datos, [ambos]);
        assert(pend.length === 1 && pend[0].tipo === 'resumen', 'un mensaje por persona y ronda, el resumen primero');

        // ── 3. Los textos ────────────────────────────────────────────────────
        const ti = t.textoInactivo(lista[0], ahora - 20 * DIA, ahora);
        assert(/Hace \*\*20 días\*\*/.test(ti), 'el recordatorio dice cuántos días lleva');
        assert(/\$133 MXN/.test(ti) && /\$115 MXN/.test(ti) && /\$140 MXN/.test(ti), 'con los precios de hoy');
        assert(/ahorrados/.test(ti) && /\$249 MXN/.test(ti), 'y su ahorro frente a Roblox, con la referencia');
        const caro = { userId: 'x', totalRobux: 1000, totalSpent: 400, purchases: 1 };
        assert(!/ahorr/i.test(t.textoInactivo(caro, ahora - 20 * DIA, ahora)), 'sin ahorro real, no se habla de ahorro');
        const tr = t.textoResumen(lista[2], { robux: 1000, precio: 133 });
        assert(/ahorraste \*\*\$116 MXN\*\*/.test(tr), 'el resumen dice lo que ahorró en esa compra');

        const pl = t.payload('hola', true);
        const bs = botonesDe(pl);
        assert(bs.some(b => b.style === 5 && b.url === `https://discord.com/channels/${config.GUILD_ID}/${config.CHANNELS.PANEL}`),
            'el botón lleva directo al panel de compra');
        assert(bs.some(b => b.custom_id === 'promo_baja'), 'y otro para no recibir más');
        assert(botonesDe(t.payload('hola', false)).some(b => b.url === config.INVITE_URL), 'si ya no está en el servidor, lleva a la invitación');

        // ── 4. Enviar ────────────────────────────────────────────────────────
        t.save({ inicio, bajas: {}, avisos: {}, resumenes: {} });
        let cli = clienteFalso();
        let envio = { tipo: 'inactivo', userId: '111', entry: comprador('111', [ahora - 20 * DIA]), ultima: ahora - 20 * DIA };
        assert(await t.enviar(cli, envio, ahora) === true, 'se manda el MD');
        assert(cli.mds.length === 1 && /Te extrañamos/.test(textoDe(cli.mds[0].p)), 'con el recordatorio');
        assert(t.load().avisos['111'] === ahora, 'y se apunta');
        let log = registro.at(-1);
        assert(log?.tipo === 'promociones' && /<@111>/.test(log.texto) && /`111`/.test(log.texto) && /Recordatorio/.test(log.texto),
            'el registro dice a quién (mención e id) y qué se le mandó');

        cli = clienteFalso({ cerrados: ['222'] });
        envio = { tipo: 'inactivo', userId: '222', entry: comprador('222', [ahora - 20 * DIA]), ultima: ahora - 20 * DIA };
        assert(await t.enviar(cli, envio, ahora) === false, 'con los MDs cerrados no se entrega');
        assert(t.load().avisos['222'] === ahora, 'pero se apunta, para no reintentar en cada ronda');
        assert(/no se pudo entregar/.test(registro.at(-1).texto) && /MDs cerrados/.test(registro.at(-1).texto), 'y el registro lo dice');

        cli = clienteFalso({ fuera: ['333'] });
        const p333 = comprador('333', [ahora - 1.5 * DIA]);
        envio = { tipo: 'resumen', userId: '333', entry: p333, pedido: { id: p333.ordenes[0], robux: 1000, precio: 133 } };
        await t.enviar(cli, envio, ahora);
        assert(botonesDe(cli.mds[0]?.p).some(b => b.url === config.INVITE_URL), 'a quien se fue, el botón lleva a la invitación');
        assert(t.load().resumenes[p333.ordenes[0]] === ahora, 'el resumen se apunta por pedido');

        // ── 5. La ronda ──────────────────────────────────────────────────────
        t.save({ inicio: null, bajas: {}, avisos: {}, resumenes: {} });
        leaderboard.getRanked = () => Array.from({ length: 10 }, (_, i) => comprador(`u${i}`, [ahora - (20 + i) * DIA]));
        cli = clienteFalso();
        t._reset();
        const r = await promos.revisar(cli, ahora);
        assert(r.enviados === P.MAX_POR_RONDA && cli.mds.length === P.MAX_POR_RONDA, `una ronda manda como mucho ${P.MAX_POR_RONDA}`);
        assert(t.load().inicio === ahora, 'la primera ronda apunta desde cuándo existe el sistema');
        assert(cli.mds[0].id === 'u9', 'el más atrasado primero');
        const r2 = await promos.revisar(cli, ahora);
        assert(r2.enviados === P.MAX_POR_RONDA && new Set(cli.mds.map(m => m.id)).size === cli.mds.length, 'la siguiente sigue con otros, sin repetir');

        P.ACTIVO = false;
        assert((await promos.revisar(cli, ahora)).enviados === 0, 'desactivadas en config, no se manda nada');
        P.ACTIVO = true;

        // ── 6. Baja y alta ───────────────────────────────────────────────────
        const boton = customId => {
            const it = { customId, user: { id: '444' }, client: cli, respuestas: [], reply: async o => it.respuestas.push(o) };
            return it;
        };
        let b = boton('promo_baja');
        await promos.alBoton(b);
        assert(promos.estaDeBaja('444'), 'el botón da de baja');
        assert(/ya no te mandaremos/.test(b.respuestas[0]?.content ?? ''), 'y se le confirma');
        assert(b.respuestas[0]?.components?.[0]?.toJSON().components[0].custom_id === 'promo_alta', 'con el botón para volver');
        assert(/se dio de baja/.test(registro.at(-1).texto) && /<@444>/.test(registro.at(-1).texto), 'la baja queda en el registro');
        leaderboard.getRanked = () => [comprador('444', [ahora - 60 * DIA])];
        assert(t.pendientes(ahora, t.load()).length === 0, 'dado de baja, no le toca nada');
        b = boton('promo_alta');
        await promos.alBoton(b);
        assert(!promos.estaDeBaja('444') && /volvió a darse de alta/.test(registro.at(-1).texto), 'y puede volver a darse de alta');
        assert(t.pendientes(ahora, t.load()).length === 1, 'y vuelve a recibir');
    } finally {
        logCanales.enviar = origEnviar;
        leaderboard.getRanked = origRanked;
        Object.assign(P, origPromos);
        t._reset();
    }

    // ── 7. El detalle de cada pedido ─────────────────────────────────────────
    const oid = idEn(ahora);
    leaderboard.recordPurchase('555', 1500, 206, oid);
    assert(leaderboard.getEntry('555')?.detalle?.[oid]?.robux === 1500 && leaderboard.getEntry('555').detalle[oid].precio === 206,
        'el ranking guarda Robux y precio de cada pedido (para el resumen)');

    // ── 8. Enrutado ──────────────────────────────────────────────────────────
    const BOTONES = leer('handlers/buttons.js');
    const MAIN = leer('main.js');
    assert(/promo_baja:/.test(BOTONES) && /promo_alta:/.test(BOTONES), 'los botones de baja y alta están enrutados');
    assert(/name: 'promos'/.test(MAIN) && /commandName === 'promos'/.test(MAIN), '/promos está registrado y enrutado');
    assert(/require\('\.\/utils\/promociones'\)\.iniciar\(client\)/.test(MAIN), 'y las promociones arrancan con el bot');
    assert(config.LOGS.CANALES.promociones?.nombre, 'hay un canal de registro de promociones');

    return finish();
};
