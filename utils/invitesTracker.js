'use strict';

const { escapeMarkdown } = require('discord.js');
const config = require('../config');
const inv = require('./invitaciones');
const v2 = require('./panelV2');

// ── Sistema de invitaciones: la parte de Discord ─────────────────────────────
//
// Discord no dice por qué invitación entró alguien. Se averigua así: se guarda
// cuántos usos lleva cada invitación, y cuando alguien entra se vuelven a
// pedir y se mira cuál subió. Hace falta que el bot tenga el permiso
// "Gestionar servidor" (para leer las invitaciones) y el intent GuildInvites
// (para enterarse de las que se crean y se borran).
//
// Todo lo que toca el canal va en una COLA, de uno en uno: dos personas que
// entran a la vez no pueden leer las mismas cifras de usos, ni dos mensajes
// del leaderboard pueden quedarse a la vez al final del canal.

const E = {
    member: '<:member:1501261625523699892>',
    point:  '<:point:1501212595464700104>',
    alert:  '<:alert:1501220021035204658>',
};

// Los iconos blancos propios (scripts/invIconos.js).
const ic = k => `<:inv_${k}:${config.INVITACIONES.ICONOS[k]}>`;

const SIN_MENCIONES = { parse: [] };
const REVISION_MS = 5 * 60_000;

// code -> { uses, inviterId, maxUses }
let cache = new Map();
let vanityUses = null;

let cola = Promise.resolve();
function encolar(fn) {
    cola = cola.then(fn).catch(err => console.error('[invitaciones]', err));
    return cola;
}

// ── Qué invitación se usó ────────────────────────────────────────────────────
//
// Pura, para poder probarla: compara los usos de antes con los de ahora.
//
//   1. Si subió exactamente UNA invitación, es esa.
//   2. Si no subió ninguna pero subió la URL personalizada, fue la vanity.
//   3. Si no subió ninguna y desapareció una que estaba a un uso de su límite,
//      fue esa: Discord borra la invitación en cuanto se gasta su último uso.
//   4. Si subieron varias (dos entradas casi a la vez) o nada encaja, NO se
//      adivina: se registra como desconocida. Atribuir mal una invitación es
//      darle el premio a quien no era.
function detectarInvitacion(antes, despues, vanityAntes = null, vanityDespues = null) {
    const subieron = [];
    for (const [code, d] of despues) {
        if (d.uses > (antes.get(code)?.uses ?? 0)) subieron.push(code);
    }
    if (subieron.length === 1) {
        const code = subieron[0];
        return { tipo: 'invitacion', code, inviterId: despues.get(code).inviterId ?? null };
    }
    if (subieron.length > 1) return { tipo: 'desconocido', code: null, inviterId: null };

    if (vanityAntes !== null && vanityDespues !== null && vanityDespues > vanityAntes) {
        return { tipo: 'vanity', code: null, inviterId: null };
    }

    const gastadas = [...antes].filter(([code, d]) =>
        !despues.has(code) && d.maxUses > 0 && d.uses + 1 >= d.maxUses
    );
    if (gastadas.length === 1) {
        const [code, d] = gastadas[0];
        return { tipo: 'invitacion', code, inviterId: d.inviterId ?? null };
    }
    return { tipo: 'desconocido', code: null, inviterId: null };
}

function aMapa(invites) {
    const m = new Map();
    for (const i of invites.values()) {
        m.set(i.code, { uses: i.uses ?? 0, inviterId: i.inviter?.id ?? i.inviterId ?? null, maxUses: i.maxUses ?? 0 });
    }
    return m;
}

async function leerInvitaciones(guild) {
    const invites = await guild.invites.fetch({ cache: false });
    let vanity = null;
    if (guild.vanityURLCode) {
        vanity = await guild.fetchVanityData().then(v => v.uses).catch(() => null);
    }
    return { mapa: aMapa(invites), vanity };
}

async function cargarCache(guild) {
    try {
        const { mapa, vanity } = await leerInvitaciones(guild);
        cache = mapa;
        vanityUses = vanity;
        console.log(`[invitaciones] ${cache.size} invitación(es) en caché.`);
    } catch (err) {
        console.warn('[invitaciones] No se pudieron leer las invitaciones (¿falta "Gestionar servidor"?):', err.message);
    }
}

// ── Los mensajes ─────────────────────────────────────────────────────────────

const nombreDe = user => escapeMarkdown(user.globalName || user.username || 'Alguien');
const plural = (n, s, p = `${s}s`) => `${n} ${n === 1 ? s : p}`;

function textoEntrada(nombre, reg, resumen) {
    const quien = reg.inviterId ? `<@${reg.inviterId}>` : null;
    switch (reg.estado) {
        case 'valida':
            return `${ic('entra')} **${nombre}** se unió invitado por ${quien} · ahora tiene **${plural(resumen.validas, 'invitación', 'invitaciones')}** (${resumen.semana} esta semana)`;
        case 'repetida':
            return `↩️ **${nombre}** volvió a entrar (invitación de ${quien}) · **no cuenta**: ${reg.motivo}`;
        case 'propia':
            return `${E.alert} **${nombre}** entró con su propia invitación · **no cuenta**`;
        case 'falsa':
            return `${E.alert} **${nombre}** se unió invitado por ${quien} · **no cuenta**: ${reg.motivo}`;
        default:
            return reg.tipo === 'vanity'
                ? `🔗 **${nombre}** se unió con la URL personalizada del servidor.`
                : `${E.member} **${nombre}** se unió · no se pudo detectar con qué invitación.`;
    }
}

const MEDALLAS = [ic(1), ic(2), ic(3)];
function lineasTop(lista, vacio) {
    if (!lista.length) return [vacio];
    return lista.map((u, i) =>
        `${MEDALLAS[i] ?? `\`${String(i + 1).padStart(2, ' ')}.\``} <@${u.userId}> — **${plural(u.invitaciones, 'invitación', 'invitaciones')}**`
    );
}

function textoLeaderboard(ahora = Date.now()) {
    const I = inv.I;
    const fin = Math.floor((inv.inicioSemana(ahora) + 7 * 86_400_000) / 1000);
    const ganador = inv.ultimoGanador();

    return [
        `## ${ic('corona')} Top invitaciones de la semana`,
        `${ic('regalo')} El **Top 1** de cada semana gana **${I.PREMIO_ROBUX} Robux**.`,
        `-# ${ic('reloj')} Se reinicia el lunes a las 00:00 · <t:${fin}:R>`,
        '',
        ...lineasTop(inv.top('semana', ahora), '-# Nadie ha invitado todavía esta semana. ¡El primero en invitar se pone en cabeza!'),
        '',
        `### ${ic('trofeo')} Ganador de la semana pasada`,
        ganador
            ? `<@${ganador.ganadorId}> con **${plural(ganador.invitaciones, 'invitación', 'invitaciones')}** · ganó **${ganador.premio ?? I.PREMIO_ROBUX} Robux**`
            : 'Todavía no hay ganador: esta es la primera semana.',
        `-# ${ic('arena')} Esperando al ganador de esta semana…`,
        '',
        `### ${ic('grafica')} Top de todos los tiempos`,
        ...lineasTop(inv.top('total', ahora), '-# Todavía no hay invitaciones válidas.'),
        '',
        `-# ${ic('escudo')} Solo cuentan invitaciones válidas: cuentas con más de ${I.MIN_DIAS_CUENTA} días, que entran por primera vez y siguen en el servidor. Mira las tuyas con /invitaciones.`,
    ].join('\n');
}

function leaderboardPayload(ahora = Date.now()) {
    return {
        ...v2.tarjetaPayload({ color: 0x2B2D31, texto: textoLeaderboard(ahora), pie: '7x Community • Sistema de invitaciones' }),
        allowedMentions: SIN_MENCIONES,
    };
}

async function canal(client) {
    return client.channels.cache.get(config.CHANNELS.INVITACIONES)
        ?? await client.channels.fetch(config.CHANNELS.INVITACIONES).catch(() => null);
}

// El leaderboard SIEMPRE al final del canal. Si ya es el último mensaje, se
// edita; si no, se manda uno nuevo y DESPUÉS se borra el viejo — en ese orden,
// para que nunca haya un momento sin leaderboard. La referencia se guarda en
// el volumen: tras un reinicio se sigue editando el mismo mensaje.
//
// Si es el último se pregunta a Discord, no a `channel.lastMessageId`: ese dato
// se actualiza con el evento del gateway, que puede llegar DESPUÉS de que
// termine el send de un anuncio. Fiarse de él hacía que, justo tras anunciar
// una entrada, el leaderboard se editara arriba en vez de bajar. Por lo mismo,
// tras un anuncio propio se reenvía siempre (`forzar`).
//
// Nada se pierde al reenviar: el contenido sale entero de los datos guardados.
async function esElUltimo(ch, messageId) {
    const ultimos = await ch.messages.fetch({ limit: 1, cache: false }).catch(() => null);
    const ultimo = ultimos?.first?.();
    return ultimo ? ultimo.id === messageId : false;
}

async function moverLeaderboardAlFinal(client, { forzar = false } = {}) {
    const ch = await canal(client);
    if (!ch) { console.warn('[invitaciones] Canal de invitaciones no encontrado.'); return; }

    const payload = leaderboardPayload();
    const ref = inv.getMensajeRef();

    if (ref?.messageId && !forzar && await esElUltimo(ch, ref.messageId)) {
        try {
            const msg = await ch.messages.fetch(ref.messageId);
            await msg.edit(payload);
            return;
        } catch { /* lo borraron: se manda uno nuevo */ }
    }

    const nuevo = await ch.send(payload);
    inv.setMensajeRef({ channelId: ch.id, messageId: nuevo.id });
    if (ref?.messageId && ref.messageId !== nuevo.id) {
        await ch.messages.delete(ref.messageId).catch(() => {});
    }
}

// ── Los eventos ──────────────────────────────────────────────────────────────

async function alEntrar(member) {
    if (member.guild.id !== config.GUILD_ID || member.user.bot) return;

    return encolar(async () => {
        const antes = cache;
        const vAntes = vanityUses;
        let det = { tipo: 'desconocido', code: null, inviterId: null };
        try {
            const { mapa, vanity } = await leerInvitaciones(member.guild);
            det = detectarInvitacion(antes, mapa, vAntes, vanity);
            cache = mapa;
            vanityUses = vanity;
        } catch (err) {
            console.warn('[invitaciones] No se pudieron leer las invitaciones al entrar alguien:', err.message);
        }

        const reg = inv.registrarEntrada({
            memberId: member.id,
            inviterId: det.inviterId,
            tipo: det.tipo,
            code: det.code,
            cuentaCreada: member.user.createdTimestamp,
            tieneAvatar: !!member.user.avatar,
            ahora: Date.now(),
        });

        const ch = await canal(member.client);
        let anunciado = false;
        if (ch) {
            const resumen = reg.inviterId ? inv.resumenDe(reg.inviterId) : null;
            anunciado = await ch.send({ content: textoEntrada(nombreDe(member.user), reg, resumen), allowedMentions: SIN_MENCIONES })
                .then(() => true)
                .catch(err => { console.warn('[invitaciones] No se pudo anunciar la entrada:', err.message); return false; });
        }
        // Tras un anuncio, el leaderboard ya NO es el último: se reenvía sí o sí.
        await moverLeaderboardAlFinal(member.client, { forzar: anunciado });
    });
}

async function alSalir(member) {
    if (member.guild?.id !== config.GUILD_ID || member.user?.bot) return;
    return encolar(async () => {
        if (inv.registrarSalida(member.id)) await moverLeaderboardAlFinal(member.client);
    });
}

function alCrearInvitacion(invite) {
    if (invite.guild?.id !== config.GUILD_ID) return;
    cache.set(invite.code, { uses: invite.uses ?? 0, inviterId: invite.inviter?.id ?? invite.inviterId ?? null, maxUses: invite.maxUses ?? 0 });
}

// Al borrarse NO se quita de la caché: si se borró porque se gastó su último
// uso, es justo la que hay que encontrar cuando llegue la entrada (paso 3 de
// detectarInvitacion). La caché se rehace con la siguiente entrada.
function alBorrarInvitacion() {}

// Si otro bot o alguien escribe en el canal, el leaderboard baja al final. Con
// una pequeña espera, para mover una sola vez si llegan varios seguidos. Los
// mensajes del propio bot no cuentan: ya mueve el leaderboard él mismo.
let pendiente = null;
function alMensaje(message) {
    if (message.channelId !== config.CHANNELS.INVITACIONES) return;
    if (message.author?.id === message.client.user?.id) return;
    clearTimeout(pendiente);
    pendiente = setTimeout(() => encolar(() => moverLeaderboardAlFinal(message.client)), 3000);
    pendiente.unref?.();
}

// ── El cierre semanal ────────────────────────────────────────────────────────

async function revisarSemana(client, ahora = Date.now()) {
    const cerrada = inv.cerrarSemanaSiToca(ahora);
    if (!cerrada) return null;

    const ch = await canal(client);
    if (ch) {
        const texto = cerrada.ganadorId
            ? [
                `## ${ic('trofeo')} ¡Ganador de la semana!`,
                `<@${cerrada.ganadorId}> fue el **Top 1** con **${plural(cerrada.invitaciones, 'invitación', 'invitaciones')}** y gana **${cerrada.premio} Robux**.`,
                '',
                `${E.point} El staff te contactará para entregarte tu premio.`,
                '-# El top de la semana vuelve a empezar desde cero. ¡A invitar!',
            ].join('\n')
            : [
                `## ${ic('reloj')} Semana cerrada`,
                'Esta semana no hubo invitaciones válidas, así que no hay ganador.',
                '-# El top vuelve a empezar desde cero. ¡A invitar!',
            ].join('\n');
        await ch.send({
            ...v2.tarjetaPayload({ color: 0x2B2D31, texto, pie: '7x Community • Sistema de invitaciones' }),
            // Al ganador sí se le menciona: es a quien hay que avisar.
            allowedMentions: { users: cerrada.ganadorId ? [cerrada.ganadorId] : [] },
        }).catch(err => console.warn('[invitaciones] No se pudo anunciar al ganador:', err.message));
    }
    await moverLeaderboardAlFinal(client, { forzar: !!ch });
    return cerrada;
}

// Al arrancar: caché de invitaciones, salidas de mientras estuvo apagado, el
// cierre de semana si tocaba, el leaderboard al final, y la revisión periódica.
async function iniciar(client) {
    const guild = client.guilds.cache.get(config.GUILD_ID);
    if (!guild) return;

    await cargarCache(guild);

    await encolar(async () => {
        try {
            const miembros = await guild.members.fetch();
            const n = inv.reconciliarSalidas(new Set(miembros.keys()));
            if (n) console.log(`[invitaciones] ${n} salida(s) de mientras el bot estaba apagado.`);
        } catch (err) {
            console.warn('[invitaciones] No se pudo revisar quién sigue en el servidor:', err.message);
        }
        if (!await revisarSemana(client)) await moverLeaderboardAlFinal(client);
    });

    const t = setInterval(() => encolar(() => revisarSemana(client)), REVISION_MS);
    t.unref?.();
    return t;
}

module.exports = {
    iniciar, alEntrar, alSalir, alCrearInvitacion, alBorrarInvitacion, alMensaje,
    moverLeaderboardAlFinal, revisarSemana,
    __test: {
        detectarInvitacion, textoEntrada, textoLeaderboard, leaderboardPayload,
        setCache: (m, v = null) => { cache = m; vanityUses = v; },
        esperar: () => cola,
    },
};
