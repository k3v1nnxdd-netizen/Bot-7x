'use strict';

// Tests del cierre de tickets de compra inactivos. Sin red.
//
// Lo que protegen:
//
//   1. LA PRIMERA HORA NO PASA NADA, y después se avisa con la barra de 12 h.
//   2. NUNCA SE CIERRA un ticket donde el cliente escribió o hay un pago
//      pendiente o confirmado — tampoco tras un reinicio, cuando esas marcas
//      ya no están en memoria.
//   3. EL CLIENTE TIENE SIEMPRE SUS 12 HORAS completas desde el aviso.
//   4. Si no se pueden leer los mensajes, NO se cierra.
//   5. TODO SOBREVIVE A UN REINICIO.

const fs = require('fs');
const path = require('path');

const { createSuite } = require('./testHarness');
const config = require('../../config');
const { dataPath } = require('../../utils/dataDir');
const tickets = require('../../utils/tickets');
const ti = require('../../utils/ticketInactivo');
const fidelidad = require('../../utils/fidelidad');

const RAIZ = path.join(__dirname, '..', '..');
const HORA = 3600_000;
const C = config.TICKET_INACTIVO;
const OWNER = '700000000000000001';

function limpiar() {
    const f = dataPath('ticketsInactivos.json');
    if (fs.existsSync(f)) fs.unlinkSync(f);
}

let n = 0;
function canal({ creado, mensajes = [], nombre = 'robux-kev', tipo = 'comprar', leerFalla = false } = {}) {
    const id = `80000000000000${String(++n).padStart(4, '0')}`;
    const ch = {
        id, name: nombre, parentId: config.CATEGORIES.TICKETS, type: 0, createdTimestamp: creado,
        topic: config.TOPIC_PREFIX + JSON.stringify({ userId: OWNER, type: tipo, ts: creado }),
        historial: mensajes.map((m, i) => ({ id: `h${i}`, author: m })),
        enviados: [], editados: [], borrado: false,
        async send(p) {
            const msg = { id: `m${ch.enviados.length}`, p, edit: async q => { msg.p = q; ch.editados.push(q); } };
            ch.enviados.push(msg);
            return msg;
        },
        messages: {
            fetch: async arg => {
                if (typeof arg === 'string') { const m = ch.enviados.find(x => x.id === arg); if (!m) throw new Error('x'); return m; }
                if (leerFalla) throw new Error('Missing Access');
                const mapa = new Map(ch.historial.map(h => [h.id, h]));
                mapa.some = fn => [...mapa.values()].some(fn);
                return mapa;
            },
        },
        delete: async () => { ch.borrado = true; },
    };
    return ch;
}
const dms = [];
const cliente = { users: { fetch: async () => ({ send: async p => dms.push(p) }) } };
const textoDe = p => JSON.stringify(p?.components?.map(c => c.toJSON()) ?? []);

module.exports = async function run() {
    const { assert, finish } = createSuite('ticketInactivo');
    const { accion, horasRestantes } = ti.__test;
    const t0 = Date.parse('2026-10-24T12:00:00Z');

    assert(C.ESPERA_HORAS === 1 && C.PLAZO_HORAS === 12, 'espera 1 hora y luego da 12 horas');

    // ── Las reglas puras ─────────────────────────────────────────────────────
    assert(accion(null, t0, t0 + 59 * 60_000) === 'nada', 'antes de la hora, nada');
    assert(accion(null, t0, t0 + HORA) === 'revisar', 'a la hora, toca revisar y avisar');
    const st = { estado: 'contando', avisadoEn: t0 + HORA, horas: 12 };
    assert(accion(st, t0, t0 + HORA + 30 * 60_000) === 'nada', 'media hora después la barra sigue igual');
    assert(accion(st, t0, t0 + 2 * HORA + 1) === 'actualizar', 'cada hora la barra baja');
    assert(accion(st, t0, t0 + 13 * HORA) === 'cerrar', 'a las 12 horas del aviso, se cierra');
    assert(accion({ estado: 'detenido' }, t0, t0 + 100 * HORA) === 'nada', 'uno detenido no se vuelve a tocar nunca');
    assert(horasRestantes(t0, t0 + 10 * 60_000) === 12 && horasRestantes(t0, t0 + 11.5 * HORA) === 1 && horasRestantes(t0, t0 + 13 * HORA) === 0,
        'las horas restantes redondean hacia arriba: la barra no se vacía antes de tiempo');

    // ── 1. Aviso, barra y cierre de punta a punta ────────────────────────────
    limpiar(); dms.length = 0;
    let ch = canal({ creado: t0 });
    assert(await ti.revisarCanal(cliente, ch, t0 + 30 * 60_000) === 'nada' && ch.enviados.length === 0, 'en la primera hora no se publica nada');
    assert(await ti.revisarCanal(cliente, ch, t0 + HORA) === 'avisado', 'pasada la hora, se avisa');
    const aviso = ch.enviados[0].p;
    assert(aviso.allowedMentions?.users?.[0] === OWNER && textoDe(aviso).includes(`<@${OWNER}>`), 'mencionando al cliente');
    assert(textoDe(aviso).includes('se cerrará por inactividad') && textoDe(aviso).includes('12 horas restantes'), 'con lo que pasa y el tiempo que queda');
    assert(textoDe(aviso).includes(JSON.stringify(fidelidad.barra(12, 12)).slice(1, -1)), 'y la barra llena de 12 horas');

    assert(await ti.revisarCanal(cliente, ch, t0 + HORA + 20 * 60_000) === 'nada', 'sin cambio de hora no se edita');
    assert(await ti.revisarCanal(cliente, ch, t0 + 7 * HORA + 1) === 'actualizado', 'la barra baja con las horas');
    assert(textoDe(ch.editados.at(-1)).includes('6 horas restantes'), 'y dice las que quedan');

    // Un reinicio a mitad: se recarga todo desde el fichero.
    delete require.cache[require.resolve('../../utils/ticketInactivo')];
    const ti2 = require('../../utils/ticketInactivo');
    assert(ti2.__test.load()[ch.id]?.avisadoEn === t0 + HORA, 'tras un reinicio sigue sabiendo cuándo avisó');

    assert(await ti2.revisarCanal(cliente, ch, t0 + 13 * HORA) === 'cerrado', 'a las 12 horas del aviso se cierra');
    assert(textoDe(ch.enviados.at(-1).p).includes('cerrado por inactividad'), 'diciendo por qué en el canal');
    assert(dms.length === 1 && textoDe(dms[0]).includes('Tu ticket de compra se cerró'), 'y al cliente por DM');
    await new Promise(r => setTimeout(r, config.TIMEOUTS.MANUAL_CLOSE_MS + 200));
    assert(ch.borrado, 'y el canal se borra');

    // ── 2. Lo que lo mantiene abierto ────────────────────────────────────────
    limpiar();
    ch = canal({ creado: t0, mensajes: [{ id: OWNER, bot: false }] });
    assert(await ti.revisarCanal(cliente, ch, t0 + HORA) === 'detenido' && ch.enviados.length === 0, 'si el cliente escribió, no hay aviso');
    assert(await ti.revisarCanal(cliente, ch, t0 + 50 * HORA) === 'nada', 'ni cierre, nunca');

    ch = canal({ creado: t0, mensajes: [{ id: 'staff', bot: false }, { id: 'bot', bot: true }] });
    assert(await ti.revisarCanal(cliente, ch, t0 + HORA) === 'avisado', 'los mensajes del staff o del bot no cuentan como del cliente');

    for (const nombre of ['⚠-pago-revision', 'pago-kev', 'pago-pendiente']) {
        const c = canal({ creado: t0, nombre });
        assert(await ti.revisarCanal(cliente, c, t0 + HORA) === 'detenido', `con el pago en marcha (${nombre}) no se avisa, aunque se haya reiniciado`);
    }
    const enRevision = canal({ creado: t0 });
    tickets.markPaymentReview(enRevision.id);
    assert(await ti.revisarCanal(cliente, enRevision, t0 + HORA) === 'detenido', 'ni con el pago marcado en revisión');

    // Escribe a mitad del contador: se detiene al momento.
    ch = canal({ creado: t0 });
    await ti.revisarCanal(cliente, ch, t0 + HORA);
    tickets.getTicketData(ch);   // el dueño en caché, como en el bot
    await ti.alMensaje({ channelId: ch.id, channel: ch, author: { id: OWNER, bot: false } });
    assert(ti.__test.load()[ch.id]?.estado === 'detenido', 'si escribe con el contador en marcha, se detiene al momento');
    assert(textoDe(ch.editados.at(-1)).includes('Contador detenido'), 'y el aviso lo dice');
    assert(await ti.revisarCanal(cliente, ch, t0 + 20 * HORA) === 'nada' && !ch.borrado, 'y ya no se cierra');

    await ti.alMensaje({ channelId: 'otro', channel: {}, author: { id: 'x', bot: false } });
    assert(true, 'un mensaje en un canal sin contador no hace nada');

    // Otro tipo de ticket no se toca.
    const alianza = canal({ creado: t0, tipo: 'alianza' });
    assert(await ti.revisarCanal(cliente, alianza, t0 + 30 * HORA) === 'nada', 'sólo los tickets de compra');

    // Sin poder leer los mensajes, no se cierra.
    const ciego = canal({ creado: t0, leerFalla: true });
    assert(await ti.revisarCanal(cliente, ciego, t0 + 30 * HORA) === 'nada' && ciego.enviados.length === 0, 'si no se pueden leer los mensajes, no se hace nada');

    // ── 3. Doce horas completas desde el aviso ───────────────────────────────
    limpiar();
    ch = canal({ creado: t0 });
    await ti.revisarCanal(cliente, ch, t0 + 30 * HORA);   // el bot estuvo apagado
    assert(ch.enviados.length === 1, 'un ticket viejo también recibe su aviso');
    assert(await ti.revisarCanal(cliente, ch, t0 + 31 * HORA) !== 'cerrado', 'y no se cierra enseguida');
    assert(await ti.revisarCanal(cliente, ch, t0 + 42 * HORA) === 'cerrado', 'sino a las 12 horas de avisar');

    // ── 4. Cableado ──────────────────────────────────────────────────────────
    const MAIN = fs.readFileSync(path.join(RAIZ, 'main.js'), 'utf8');
    assert(/ticketInactivo\.iniciar\(client\)/.test(MAIN) && /ticketInactivo\.alMensaje\(message\)/.test(MAIN), 'arranca con el bot y escucha los mensajes');

    limpiar();
    return finish();
};
