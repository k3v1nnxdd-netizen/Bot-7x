'use strict';

const fs = require('fs');
const { ChannelType } = require('discord.js');
const config = require('../config');
const { dataPath, ensureDataDir } = require('./dataDir');
const tickets = require('./tickets');
const fidelidad = require('./fidelidad');
const v2 = require('./panelV2');

// ── Tickets de compra inactivos ──────────────────────────────────────────────
//
// Un ticket de compra que nadie usa ocupa un canal y despista al staff. Así
// que:
//
//   1. Durante ESPERA_HORAS después de abrirse, nada.
//   2. Pasado eso, si el cliente NO ha escrito ningún mensaje y NO hay un pago
//      pendiente o confirmado, se le avisa (con mención) con una barra que se
//      vacía durante PLAZO_HORAS.
//   3. Si escribe lo que sea, o su pago pasa a revisión, el contador se
//      DETIENE para siempre: el ticket ya no es inútil.
//   4. Si el plazo se acaba sin nada de eso, el ticket se cierra y se le dice
//      por DM que puede abrir otro cuando quiera.
//
// El plazo cuenta desde que se publica el aviso, no desde que se abrió el
// ticket: así el cliente SIEMPRE tiene sus 12 horas completas a la vista, también
// si el bot estuvo apagado cuando tocaba avisar.
//
// Nada de setTimeout de horas: el bot se reinicia en cada despliegue. Se
// revisa cada REVISION_MIN minutos a partir de lo guardado en
// DATA_DIR/ticketsInactivos.json (el volumen).

const C = config.TICKET_INACTIVO;
const HORA = 3600_000;
const ESPERA_MS = C.ESPERA_HORAS * HORA;
const PLAZO_MS = C.PLAZO_HORAS * HORA;

const FILE = dataPath('ticketsInactivos.json');
const TMP = FILE + '.tmp';

const E = {
    alert: '<:alert:1501220021035204658>',
    point: '<:point:1501212595464700104>',
    ok:    '<:true:1501213776878501899>',
};

function load() {
    try {
        const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    } catch {
        return {};
    }
}
function save(d) {
    ensureDataDir();
    fs.writeFileSync(TMP, JSON.stringify(d, null, 2), 'utf8');
    fs.renameSync(TMP, FILE);
}
function guardar(channelId, datos) {
    const d = load();
    if (datos === null) delete d[channelId];
    else d[channelId] = { ...d[channelId], ...datos };
    save(d);
}

// ── Las reglas, puras ────────────────────────────────────────────────────────

// Cuántas horas (segmentos de la barra) quedan, redondeando hacia arriba: con
// 11h 10m quedan "12", y la barra no se vacía antes de tiempo.
function horasRestantes(avisadoEn, ahora) {
    const resta = avisadoEn + PLAZO_MS - ahora;
    return Math.max(0, Math.min(C.PLAZO_HORAS, Math.ceil(resta / HORA)));
}

// Qué toca hacer con un ticket, sin efectos. `st` es lo guardado de ese canal.
//
//   'nada'     — aún en la hora de espera, o ya detenido
//   'revisar'  — toca mirar si el cliente escribió o pagó (y avisar si no)
//   'actualizar' — contando: hay que mover la barra
//   'cerrar'   — se acabó el plazo
function accion(st, creado, ahora) {
    if (st?.estado === 'detenido') return 'nada';
    if (!st) return ahora - creado >= ESPERA_MS ? 'revisar' : 'nada';
    if (ahora >= st.avisadoEn + PLAZO_MS) return 'cerrar';
    return horasRestantes(st.avisadoEn, ahora) !== st.horas ? 'actualizar' : 'nada';
}

// Si el ticket ya no es "inútil": hay un pago en marcha o el cliente escribió.
// Devuelve el motivo, o null. Mira también el nombre del canal porque las
// marcas de pago viven en memoria y se pierden al reiniciar, y el canal se
// renombra en los dos casos (pago-revision / pago-<usuario>).
async function motivoParaSeguir(channel, ownerId) {
    const nombre = channel.name ?? '';
    if (tickets.isConfirmed(channel.id) || /^pago-/.test(nombre)) return 'pago';
    if (tickets.isPaymentReview(channel.id) || /revision|pendiente/.test(nombre)) return 'pago';

    const mensajes = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!mensajes) return 'error';   // sin poder mirar, NO se cierra nada
    if (mensajes.some(m => m.author?.id === ownerId && !m.author.bot)) return 'mensaje';
    return null;
}

// ── Los mensajes ─────────────────────────────────────────────────────────────

function avisoPayload(ownerId, avisadoEn, ahora) {
    const horas = horasRestantes(avisadoEn, ahora);
    const fin = Math.floor((avisadoEn + PLAZO_MS) / 1000);
    return {
        ...v2.tarjetaPayload({
            color: 0xF59E0B,
            mencion: `<@${ownerId}>`,
            texto: [
                `## ${E.alert} Tu ticket se cerrará por inactividad`,
                'Todavía no recibimos tu pago ni ningún mensaje tuyo en este ticket.',
                '',
                `${fidelidad.barra(horas, C.PLAZO_HORAS)}`,
                `**${horas} ${horas === 1 ? 'hora restante' : 'horas restantes'}** · se cierra <t:${fin}:R> (<t:${fin}:t>)`,
                '',
                `${E.point} Si ya pagaste, envía aquí tu comprobante.`,
                `${E.point} Si tienes dudas, escribe cualquier mensaje y el ticket seguirá abierto.`,
                '-# En cuanto escribas en el ticket, el contador se detiene.',
            ].join('\n'),
            pie: '7x Community • Tickets',
        }),
        allowedMentions: { users: [ownerId] },
    };
}

function detenidoPayload(motivo) {
    return {
        ...v2.tarjetaPayload({
            color: 0x22C55E,
            texto: [
                `## ${E.ok} Contador detenido`,
                motivo === 'pago'
                    ? 'Tu pago está en proceso: el ticket seguirá abierto hasta que el staff lo confirme.'
                    : 'Gracias por escribir: el ticket seguirá abierto y el staff te atenderá aquí.',
            ].join('\n'),
            pie: '7x Community • Tickets',
        }),
        allowedMentions: { parse: [] },
    };
}

function cierrePayload() {
    return {
        ...v2.tarjetaPayload({
            color: 0xEF4444,
            texto: [
                `## ${E.alert} Ticket cerrado por inactividad`,
                `Pasaron ${C.PLAZO_HORAS} horas sin pago ni mensajes. Este canal se eliminará en unos segundos.`,
                '-# Puedes abrir otro ticket cuando quieras desde el panel.',
            ].join('\n'),
            pie: '7x Community • Tickets',
        }),
        allowedMentions: { parse: [] },
    };
}

// ── Los pasos ────────────────────────────────────────────────────────────────

async function editarAviso(channel, st, payload) {
    if (!st?.mensajeId) return;
    try {
        const msg = await channel.messages.fetch(st.mensajeId);
        await msg.edit(payload);
    } catch { /* lo borraron: no pasa nada */ }
}

async function detener(channel, st, motivo) {
    guardar(channel.id, { estado: 'detenido', motivo, detenidoEn: Date.now() });
    if (st?.mensajeId) await editarAviso(channel, st, detenidoPayload(motivo));
}

async function cerrar(client, channel, ownerId) {
    guardar(channel.id, null);
    await channel.send(cierrePayload()).catch(() => {});
    try {
        const user = await client.users.fetch(ownerId);
        await user.send(v2.tarjetaPayload({
            color: 0x2B2D31,
            texto: [
                '## Tu ticket de compra se cerró',
                `Lo cerramos porque pasaron ${C.PLAZO_HORAS} horas sin pago ni mensajes.`,
                '',
                `${E.point} Si todavía quieres comprar, abre otro ticket desde el panel cuando quieras.`,
            ].join('\n'),
            pie: '7x Community • Tickets',
        }));
    } catch { /* DMs cerrados */ }
    setTimeout(() => channel.delete('Ticket de compra inactivo').catch(err =>
        console.error('[ticketInactivo] No se pudo borrar el canal:', err.message)), config.TIMEOUTS.MANUAL_CLOSE_MS).unref?.();
}

async function revisarCanal(client, channel, ahora = Date.now()) {
    const data = tickets.getTicketData(channel);
    if (!data?.userId || data.type !== 'comprar') return 'nada';

    const st = load()[channel.id];
    const creado = Number(data.ts) || channel.createdTimestamp;
    const a = accion(st, creado, ahora);
    if (a === 'nada') return a;

    const motivo = await motivoParaSeguir(channel, data.userId);
    if (motivo === 'error') return 'nada';
    if (motivo) {
        await detener(channel, st, motivo);
        return 'detenido';
    }

    if (a === 'revisar') {
        const msg = await channel.send(avisoPayload(data.userId, ahora, ahora)).catch(() => null);
        if (msg) guardar(channel.id, { estado: 'contando', mensajeId: msg.id, avisadoEn: ahora, horas: horasRestantes(ahora, ahora) });
        return msg ? 'avisado' : 'nada';
    }
    if (a === 'actualizar') {
        await editarAviso(channel, st, avisoPayload(data.userId, st.avisadoEn, ahora));
        guardar(channel.id, { horas: horasRestantes(st.avisadoEn, ahora) });
        return 'actualizado';
    }
    await cerrar(client, channel, data.userId);
    return 'cerrado';
}

let revisando = false;
async function revisar(client, ahora = Date.now()) {
    if (revisando) return;
    revisando = true;
    try {
        const guild = client.guilds.cache.get(config.GUILD_ID);
        if (!guild) return;
        const canales = guild.channels.cache.filter(ch =>
            ch.parentId === config.CATEGORIES.TICKETS && ch.type === ChannelType.GuildText);
        for (const ch of canales.values()) {
            await revisarCanal(client, ch, ahora).catch(err =>
                console.warn(`[ticketInactivo] Falló la revisión de ${ch.id}:`, err.message));
        }
        // Lo guardado de canales que ya no existen sobra.
        const d = load();
        const vivos = Object.keys(d).filter(id => guild.channels.cache.has(id));
        if (vivos.length !== Object.keys(d).length) save(Object.fromEntries(vivos.map(id => [id, d[id]])));
    } finally {
        revisando = false;
    }
}

// Si el cliente escribe mientras corre el contador, se detiene al momento, sin
// esperar a la siguiente revisión.
async function alMensaje(message) {
    if (message.author?.bot) return;
    const st = load()[message.channelId];
    if (st?.estado !== 'contando') return;
    if (tickets.getOwner(message.channel) !== message.author.id) return;
    await detener(message.channel, st, 'mensaje');
}

function iniciar(client) {
    revisar(client).catch(err => console.warn('[ticketInactivo] Revisión falló:', err.message));
    const t = setInterval(() => revisar(client).catch(err =>
        console.warn('[ticketInactivo] Revisión falló:', err.message)), C.REVISION_MIN * 60_000);
    t.unref?.();
    return t;
}

module.exports = {
    iniciar, revisar, revisarCanal, alMensaje,
    __test: { accion, horasRestantes, motivoParaSeguir, avisoPayload, load },
};
