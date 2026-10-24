'use strict';

// Tests del sistema de invitaciones. Sin red: Discord se simula.
//
// Lo que protegen:
//
//   1. SE DETECTA BIEN QUIÉN INVITÓ, y cuando no se puede saber NO se adivina:
//      atribuir mal una invitación es darle el premio a quien no era.
//   2. LAS INVITACIONES FALSAS NO SUMAN: cuentas nuevas, sin foto, ráfagas,
//      la propia invitación y quien sale y vuelve a entrar.
//   3. LAS SEMANAS VAN DE LUNES A LUNES EN HORA DE MÉXICO, y el ganador se
//      apunta con sus cifras del cierre.
//   4. NADA SE PIERDE AL REINICIAR: todo vive en el fichero del volumen.
//   5. EL LEADERBOARD QUEDA SIEMPRE AL FINAL DEL CANAL, sin duplicarse.

const fs = require('fs');
const path = require('path');

const { createSuite } = require('./testHarness');
const config = require('../../config');
const { dataPath } = require('../../utils/dataDir');
const inv = require('../../utils/invitaciones');
const tracker = require('../../utils/invitesTracker');
const { __test: cmd } = require('../../handlers/commands');

const RAIZ = path.join(__dirname, '..', '..');
const DIA = 86_400_000;
const I = config.INVITACIONES;

function limpiar() {
    const f = dataPath('invitaciones.json');
    if (fs.existsSync(f)) fs.unlinkSync(f);
}

// Una entrada con una cuenta normal (de un año, con foto).
let seq = 0;
function entra(inviterId, ahora = Date.now(), extra = {}) {
    return inv.registrarEntrada({
        memberId: extra.memberId ?? `m${++seq}`,
        inviterId, tipo: inviterId ? 'invitacion' : 'vanity', code: 'abc',
        cuentaCreada: ahora - 365 * DIA, tieneAvatar: true, ahora, ...extra,
    });
}

// Un canal de Discord simulado, con su último mensaje.
function canalFalso() {
    const ch = {
        id: config.CHANNELS.INVITACIONES, mensajes: new Map(), lastMessageId: null, n: 0, borrados: [], editados: [],
        async send(p) {
            const id = String(1_000_000 + ++ch.n);
            const msg = { id, p, edit: async q => { msg.p = q; ch.editados.push(id); return msg; } };
            ch.mensajes.set(id, msg);
            ch.lastMessageId = id;
            return msg;
        },
        messages: {
            fetch: async id => { const m = ch.mensajes.get(id); if (!m) throw new Error('Unknown Message'); return m; },
            delete: async id => { ch.mensajes.delete(id); ch.borrados.push(id); },
        },
    };
    return ch;
}
const clienteCon = ch => ({ channels: { cache: new Map([[ch.id, ch]]), fetch: async () => ch }, user: { id: 'bot' } });
const ultimos = ch => [...ch.mensajes.values()];

module.exports = async function run() {
    const { assert, finish } = createSuite('invitaciones');
    const { detectarInvitacion } = tracker.__test;

    assert(!path.resolve(dataPath('invitaciones.json')).startsWith(path.resolve(RAIZ, 'data')),
        'el estado de prueba va a un DATA_DIR temporal');

    // ── 1. Qué invitación se usó ─────────────────────────────────────────────
    const m = o => new Map(Object.entries(o));
    const antes = m({ aaa: { uses: 3, inviterId: 'kev' }, bbb: { uses: 1, inviterId: 'ana' }, ult: { uses: 4, maxUses: 5, inviterId: 'leo' } });

    let d = detectarInvitacion(antes, m({ aaa: { uses: 4, inviterId: 'kev' }, bbb: { uses: 1, inviterId: 'ana' }, ult: { uses: 4, maxUses: 5, inviterId: 'leo' } }));
    assert(d.tipo === 'invitacion' && d.inviterId === 'kev' && d.code === 'aaa', 'la invitación que subió de usos es la que se usó');

    d = detectarInvitacion(antes, m({ aaa: { uses: 3, inviterId: 'kev' }, bbb: { uses: 1, inviterId: 'ana' } }));
    assert(d.inviterId === 'leo' && d.code === 'ult', 'si desaparece una a un uso de su límite, fue esa (Discord la borra al gastarse)');

    d = detectarInvitacion(antes, m({ aaa: { uses: 3, inviterId: 'kev' }, bbb: { uses: 1, inviterId: 'ana' }, ult: { uses: 4, maxUses: 5, inviterId: 'leo' } }), 10, 11);
    assert(d.tipo === 'vanity' && d.inviterId === null, 'si sólo subió la URL personalizada, fue la vanity');

    d = detectarInvitacion(antes, m({ aaa: { uses: 4, inviterId: 'kev' }, bbb: { uses: 2, inviterId: 'ana' }, ult: { uses: 4, maxUses: 5, inviterId: 'leo' } }));
    assert(d.tipo === 'desconocido' && d.inviterId === null, 'si subieron dos a la vez NO se adivina');

    d = detectarInvitacion(antes, antes);
    assert(d.tipo === 'desconocido', 'si no cambió nada, desconocida');

    d = detectarInvitacion(antes, m({ ...Object.fromEntries(antes), nueva: { uses: 1, inviterId: 'sol' } }));
    assert(d.inviterId === 'sol', 'una invitación recién creada que aún no estaba en caché también se detecta');

    // ── 2. Las que cuentan y las que no ──────────────────────────────────────
    limpiar();
    const ahora = Date.now();
    assert(entra('kev', ahora).estado === 'valida', 'una cuenta normal cuenta');
    assert(entra('kev', ahora, { cuentaCreada: ahora - 2 * DIA }).estado === 'falsa', `una cuenta de 2 días no cuenta (mínimo ${I.MIN_DIAS_CUENTA})`);
    assert(/hace 2 días/.test(entra('kev', ahora, { cuentaCreada: ahora - 2 * DIA }).motivo), 'y se dice por qué');
    assert(entra('kev', ahora, { cuentaCreada: ahora - 15 * DIA, tieneAvatar: false }).estado === 'falsa', 'una cuenta de 15 días sin foto no cuenta');
    // (Con otro invitador: kev ya lleva tres cuentas jóvenes y sería ráfaga.)
    assert(entra('lia', ahora, { cuentaCreada: ahora - 15 * DIA, tieneAvatar: true }).estado === 'valida', 'una de 15 días con foto sí');
    assert(entra('kev', ahora, { memberId: 'kev' }).estado === 'propia', 'entrar con tu propia invitación no cuenta');

    const r1 = entra('ana', ahora, { memberId: 'vuelve' });
    inv.registrarSalida('vuelve', ahora + 1000);
    const r2 = entra('ana', ahora + 2000, { memberId: 'vuelve' });
    assert(r1.estado === 'valida' && r2.estado === 'repetida', 'salir y volver a entrar no cuenta otra vez');
    assert(inv.resumenDe('ana', ahora + 3000).validas === 0 && inv.resumenDe('ana', ahora + 3000).salieron === 1,
        'y la que salió deja de sumar');

    // Ráfaga de cuentas jóvenes por la misma persona.
    limpiar();
    const joven = { cuentaCreada: ahora - 20 * DIA, tieneAvatar: true };
    const rafaga = [0, 1, 2, 3].map(i => entra('raf', ahora + i * 60_000, joven).estado);
    assert(rafaga.join(',') === `valida,valida,falsa,falsa`, `a la ${I.RAFAGA.CUENTAS}ª cuenta joven en ${I.RAFAGA.VENTANA_MIN} min se marca ráfaga (${rafaga})`);
    assert(entra('raf', ahora + 5 * 60_000).estado === 'valida', 'una cuenta vieja en medio de la ráfaga sí cuenta');
    assert(entra('raf', ahora + 60 * 60_000, joven).estado === 'valida', 'y pasada la ventana, una cuenta joven vuelve a contar');

    // Sin autor
    assert(entra(null, ahora).estado === 'sin_autor', 'la vanity se registra pero no suma a nadie');

    // ── 3. Las semanas ───────────────────────────────────────────────────────
    // Domingo 25 oct 2026 23:59 hora de México = lunes 26 05:59 UTC.
    const dom = Date.parse('2026-10-26T05:59:00Z');
    const lun = Date.parse('2026-10-26T06:00:00Z');
    assert(inv.claveSemana(dom) === '2026-10-19', 'el domingo a las 23:59 (México) sigue siendo la semana del lunes 19');
    assert(inv.claveSemana(lun) === '2026-10-26', 'el lunes a las 00:00 (México) empieza la semana nueva');
    assert(inv.inicioSemana(lun + 3 * DIA) === lun, 'la semana empieza el lunes a medianoche de México');

    limpiar();
    inv.cerrarSemanaSiToca(dom - 3 * DIA);          // se fija la semana del 19
    entra('ana', dom - 2 * DIA); entra('ana', dom - DIA); entra('kev', dom - DIA);
    entra('kev', lun + 1000);                       // de la semana nueva
    assert(inv.top('semana', dom)[0]?.userId === 'ana', 'el top de la semana cuenta sólo esa semana');
    assert(inv.cerrarSemanaSiToca(dom) === null, 'antes del lunes no se cierra');

    const cerrada = inv.cerrarSemanaSiToca(lun + 5000);
    assert(cerrada?.ganadorId === 'ana' && cerrada.invitaciones === 2 && cerrada.semana === '2026-10-19',
        'el lunes se cierra y gana el Top 1 de la semana pasada');
    assert(cerrada.premio === I.PREMIO_ROBUX && I.PREMIO_ROBUX === 250, 'con su premio de 250 Robux');
    assert(inv.cerrarSemanaSiToca(lun + 10_000) === null, 'y no se cierra dos veces');
    assert(inv.top('semana', lun + 10_000).map(u => u.userId).join() === 'kev', 'la semana nueva empieza desde cero');
    assert(inv.top('total', lun + 10_000)[0]?.invitaciones === 2, 'el top de siempre no se reinicia');
    inv.registrarSalida(inv.load().registros[0].memberId, lun + 20_000);
    assert(inv.ultimoGanador().invitaciones === 2, 'que luego se le vaya alguien no le cambia una semana ya ganada');

    // Empate: gana quien llegó antes.
    limpiar();
    entra('tarde', ahora + 5000); entra('pronto', ahora);
    assert(inv.top('total', ahora + 6000)[0].userId === 'pronto', 'en un empate gana quien llegó antes a esa cifra');

    // ── 4. Sobrevive al reinicio ─────────────────────────────────────────────
    limpiar();
    entra('kev', ahora); entra('kev', ahora);
    inv.setMensajeRef({ channelId: 'c', messageId: '42' });
    delete require.cache[require.resolve('../../utils/invitaciones')];
    const inv2 = require('../../utils/invitaciones');
    assert(inv2.resumenDe('kev', ahora).validas === 2 && inv2.getMensajeRef()?.messageId === '42',
        'tras recargar el módulo (un reinicio), las cifras y el mensaje del leaderboard siguen');
    const vol = fs.readFileSync(path.join(RAIZ, 'utils', 'invitaciones.js'), 'utf8');
    assert(/dataPath\('invitaciones\.json'\)/.test(vol), 'los datos van al DATA_DIR (el volumen de Railway)');

    assert(inv.reconciliarSalidas(new Set([]), ahora) === 2 && inv.resumenDe('kev', ahora).validas === 0,
        'al arrancar, los que se fueron con el bot apagado dejan de sumar');

    // ── 5. El leaderboard siempre al final ───────────────────────────────────
    limpiar();
    entra('kev', ahora); entra('kev', ahora); entra('ana', ahora);
    const ch = canalFalso();
    const cli = clienteCon(ch);

    await tracker.moverLeaderboardAlFinal(cli);
    assert(ch.mensajes.size === 1 && inv.getMensajeRef()?.messageId === ch.lastMessageId, 'la primera vez se publica y se guarda');

    await tracker.moverLeaderboardAlFinal(cli);
    assert(ch.mensajes.size === 1 && ch.editados.length === 1, 'si ya es el último, se edita: no se duplica');

    await ch.send({ content: 'abi joined' });
    const viejo = inv.getMensajeRef().messageId;
    await tracker.moverLeaderboardAlFinal(cli);
    assert(ch.lastMessageId === inv.getMensajeRef().messageId && ch.lastMessageId !== viejo, 'si llegó otro mensaje, baja al final');
    assert(ch.borrados.includes(viejo) && ultimos(ch).filter(x => x.p.flags).length === 1, 'y el viejo se borra: sólo hay uno');

    // Una entrada real, de punta a punta.
    tracker.__test.setCache(m({ code1: { uses: 0, inviterId: 'kev' } }));
    const guild = {
        id: config.GUILD_ID, vanityURLCode: null,
        invites: { fetch: async () => new Map([['code1', { code: 'code1', uses: 1, inviter: { id: 'kev' }, maxUses: 0 }]]) },
    };
    await tracker.alEntrar({
        id: 'nuevo1', guild, client: cli,
        user: { bot: false, username: 'abi_', globalName: 'abi', avatar: 'x', createdTimestamp: ahora - 400 * DIA },
    });
    await tracker.__test.esperar();
    const msgs = ultimos(ch);
    const anuncio = msgs.at(-2)?.p;
    assert(/\*\*abi\*\* se unió invitado por <@kev> · ahora tiene \*\*3 invitaciones\*\*/.test(anuncio?.content ?? ''),
        `la entrada se anuncia con quién invitó y sus invitaciones (${anuncio?.content})`);
    assert(anuncio?.allowedMentions?.parse?.length === 0, 'sin hacer ping a nadie');
    assert(msgs.at(-1).id === inv.getMensajeRef().messageId, 'y el leaderboard queda por debajo, al final');
    assert(inv.load().registros.at(-1).inviterId === 'kev', 'la entrada queda registrada a nombre de quien invitó');

    // Que escriba otro (p. ej. el bot de invitaciones de antes) también lo baja.
    await ch.send({ content: 'otro bot' });
    tracker.alMensaje({ channelId: ch.id, author: { id: 'otro' }, client: cli });
    await new Promise(r => setTimeout(r, 3200));
    await tracker.__test.esperar();
    assert(ch.lastMessageId === inv.getMensajeRef().messageId, 'si escribe otro en el canal, el leaderboard vuelve al final');

    // ── 6. Lo que dice el leaderboard ────────────────────────────────────────
    const texto = tracker.__test.textoLeaderboard(ahora);
    assert(/Top invitaciones de la semana/.test(texto) && /250 Robux/.test(texto), 'enseña el top de la semana y el premio');
    assert(/<t:\d+:R>/.test(texto) && /lunes/.test(texto), 'y cuándo se reinicia');
    assert(/Ganador de la semana pasada/.test(texto) && /Esperando al ganador de esta semana/.test(texto), 'el ganador anterior, esperando al nuevo');
    assert(/Top de todos los tiempos/.test(texto), 'y el top de siempre');
    assert(texto.indexOf('🥇 <@kev>') > 0, 'con medallas para los primeros');

    // ── 7. El comando ────────────────────────────────────────────────────────
    const t = cmd.buildInvitacionesTexto('kev', 'kəv');
    assert(/Invitaciones de kəv/.test(t) && /Esta semana: \*\*3\*\*/.test(t), '/invitaciones dice las de la semana');
    assert(/Válidas: \*\*3\*\*/.test(t) && /Falsas o sospechosas/.test(t) && /Repetidas/.test(t), 'y el detalle de las que no cuentan');
    assert(/Entró invitado por <@kev>/.test(cmd.buildInvitacionesTexto('nuevo1', 'abi')), 'y quién invitó a cada uno');

    const MAIN = fs.readFileSync(path.join(RAIZ, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
    assert(/name: 'invitaciones',\n\s*description:/.test(MAIN) && /commandName === 'invitaciones'/.test(MAIN), '/invitaciones está registrado y enrutado');
    assert(/GatewayIntentBits\.GuildInvites/.test(MAIN), 'el bot pide el intent de invitaciones');
    for (const ev of ['GuildMemberRemove', 'InviteCreate', 'InviteDelete']) {
        assert(new RegExp(`Events\\.${ev}`).test(MAIN), `escucha ${ev}`);
    }
    assert(/invitesTracker\.alEntrar\(member\)/.test(MAIN) && /invitesTracker\.iniciar\(client\)/.test(MAIN), 'y las entradas y el arranque');
    assert(config.CHANNELS.INVITACIONES === '1180665539580936213', 'publica en el canal pedido');

    limpiar();
    return finish();
};
