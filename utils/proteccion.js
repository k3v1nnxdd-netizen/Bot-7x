'use strict';

const { EmbedBuilder, AttachmentBuilder, AuditLogEvent } = require('discord.js');
const config = require('../config');
const logCanales = require('./logCanales');
const archivo = require('./archivo');
const { ui } = require('./uiIconos');
const { esAdmin } = require('./permisos');

// ── Protección de los registros y anti-nuke ──────────────────────────────────
//
// Los registros (mensajes, transcripciones, seguridad) son la prueba ante una
// disputa, así que borrarlos no puede servir de nada, lo haga quien lo haga:
//
//   · Borran un MENSAJE de registro → se vuelve a publicar desde el archivo en
//     disco (utils/archivo.js) con una nota de quién lo borró.
//   · Borran un CANAL de registro → se recrea al momento y se vuelve a
//     publicar todo su contenido desde el archivo.
//   · Borran la CATEGORÍA → se recrea y los canales vuelven dentro, privados.
//   · En todos los casos: aviso en seguridad-log y por MD a los owners con
//     quién fue (registro de auditoría).
//
// El archivo vive en el Volume de Railway, fuera del alcance de Discord: ni un
// owner puede borrarlo desde el servidor.
//
// ANTI-NUKE: quien borra muchos canales seguidos (config.PROTECCION) se queda
// sin roles al instante, salvo los owners de config.ADMIN_IDS (a ellos sólo se
// les avisa: quitarle los roles a un owner por error sería peor). Los tickets
// no cuentan: borrarlos es trabajo normal del staff.

const P = () => config.PROTECCION;
const ESPERA_AUDITORIA_MS = 1500;
const espera = ms => new Promise(r => setTimeout(r, ms));

async function ejecutorDe(guild, tipoAuditoria, filtro) {
    await espera(ESPERA_AUDITORIA_MS);
    const logs = await guild.fetchAuditLogs({ type: tipoAuditoria, limit: 10 }).catch(() => null);
    const entry = logs?.entries.find(e => filtro(e) && Date.now() - e.createdTimestamp < 30_000);
    return entry?.executor ?? null;
}

const nombre = u => (u ? `<@${u.id}> (\`${u.username ?? u.id}\`)` : 'desconocido');

async function avisar(guild, embed) {
    await logCanales.enviar(guild, 'seguridad', {
        content: config.ADMIN_IDS.map(id => `<@${id}>`).join(' '),
        embeds: [embed],
        allowedMentions: { users: config.ADMIN_IDS },
    });
    for (const id of config.ADMIN_IDS) {
        const u = await guild.client.users.fetch(id).catch(() => null);
        await u?.send({ embeds: [EmbedBuilder.from(embed).setFooter({ text: `${guild.name} · Protección 7x` })] }).catch(() => {});
    }
}

// ── Restaurar un canal entero ────────────────────────────────────────────────

const restaurando = new Set();
const MAX_INDIVIDUALES = 50;   // mensajes/seguridad: los últimos, uno a uno; el resto en un .txt

async function restaurarCanal(guild, tipo, motivo) {
    if (restaurando.has(tipo)) return 0;
    restaurando.add(tipo);
    try {
        const ch = await logCanales.canal(guild, tipo);
        if (!ch) return 0;
        const lista = archivo.entradas(tipo);
        if (!lista.length) return 0;

        const todos = tipo === 'transcripciones';
        const individuales = todos ? lista : lista.slice(-MAX_INDIVIDUALES);
        const resumidos = todos ? [] : lista.slice(0, -MAX_INDIVIDUALES);

        await ch.send({
            embeds: [new EmbedBuilder()
                .setColor(0x22C55E)
                .setTitle(`${ui('escudo')} Canal restaurado`)
                .setDescription(`${motivo}\nSe vuelven a publicar **${lista.length}** registro(s) desde la copia de seguridad del bot.`
                    + (resumidos.length ? `\nLos ${resumidos.length} más antiguos van en el archivo adjunto; los ${individuales.length} más recientes, abajo.` : ''))
                .setTimestamp()],
            files: resumidos.length
                ? [new AttachmentBuilder(Buffer.from(archivo.resumenTexto(resumidos), 'utf8'), { name: `registros-${tipo}-antiguos.txt` })]
                : [],
        }).catch(() => {});

        let n = 0;
        for (const e of individuales) {
            const msg = await ch.send(archivo.payloadDe(tipo, e, `Restaurado ${new Date().toLocaleDateString('es-MX')}`)).catch(err => {
                console.error(`[proteccion] Restaurar ${tipo}/${e.id}:`, err.message);
                return null;
            });
            if (msg) { archivo.alias(tipo, msg.id, e.id); n++; }
        }
        console.log(`[proteccion] ${tipo}: ${n}/${individuales.length} registros restaurados.`);
        return lista.length;
    } finally {
        restaurando.delete(tipo);
    }
}

// ── Canal borrado ────────────────────────────────────────────────────────────

const borrados = new Map();   // executorId -> [timestamps]

async function alBorrarCanal(channel) {
    try {
        const guild = channel?.guild;
        if (!guild) return;
        const tipo = logCanales.tipoDe(channel.id);
        const esTicket = channel.parentId === config.CATEGORIES.TICKETS;
        if (!tipo && esTicket) return;

        const quien = await ejecutorDe(guild, AuditLogEvent.ChannelDelete, e => e.target?.id === channel.id);

        // Un registro se restaura lo borre quien lo borre, incluso el propio
        // bot (un token robado también es "el bot"). El anti-nuke no cuenta al
        // bot: él borra tickets cerrados constantemente.
        if (tipo) await protegerRegistro(guild, channel, tipo, quien);
        if (quien && quien.id !== guild.client.user.id) await antiNuke(guild, quien, channel);
    } catch (err) {
        console.error('[proteccion] alBorrarCanal:', err.message);
    }
}

async function protegerRegistro(guild, channel, tipo, quien) {
    const r = await logCanales.asegurarTodos(guild);
    const restaurados = {};
    for (const t of r.creados) {
        restaurados[t] = await restaurarCanal(guild, t, `Alguien borró este canal (${quien ? `<@${quien.id}>` : 'no se sabe quién'}).`);
    }
    const lineas = Object.entries(restaurados).map(([t, n]) => `**#${t}** recreado · ${n} registro(s) restaurado(s)`);
    await avisar(guild, new EmbedBuilder()
        .setColor(0xDC2626)
        .setTitle(`${ui('alerta')} ${tipo === 'categoria' ? 'Borraron la categoría de registros' : 'Borraron un canal de registros'}`)
        .addFields(
            { name: 'Canal', value: `#${channel.name}`, inline: true },
            { name: 'Borrado por', value: nombre(quien), inline: true },
            { name: 'Resultado', value: lineas.join('\n') || 'Categoría recreada y canales devueltos dentro, privados. No se perdió nada.' },
        )
        .setFooter({ text: 'Los registros tienen copia en el servidor del bot: borrarlos en Discord no los elimina' })
        .setTimestamp());
}

// ── Anti-nuke ────────────────────────────────────────────────────────────────

async function antiNuke(guild, quien, channel) {
    if (!P().ANTINUKE_ACTIVO) return;
    const ahora = Date.now();
    const ventana = P().ANTINUKE_VENTANA_SEG * 1000;
    const lista = (borrados.get(quien.id) ?? []).filter(t => ahora - t < ventana);
    lista.push(ahora);
    borrados.set(quien.id, lista);
    if (lista.length !== P().ANTINUKE_CANALES) return;   // un aviso por ráfaga

    const owner = esAdmin(quien.id);
    let accion = 'Sólo aviso: es un owner.';
    if (!owner) {
        const member = await guild.members.fetch(quien.id).catch(() => null);
        if (!member) accion = 'Ya no está en el servidor.';
        else if (!member.manageable) accion = 'No se le pudieron quitar los roles: su rol está por encima del bot.';
        else {
            const quitados = member.roles.cache.filter(r => r.id !== guild.id).map(r => r.name);
            await member.roles.set([], `Anti-nuke: ${lista.length} canales borrados en ${P().ANTINUKE_VENTANA_SEG}s`)
                .then(() => { accion = `${ui('escudo')} **Roles retirados** (${quitados.length}): ${quitados.join(', ').slice(0, 900) || '—'}`; })
                .catch(err => { accion = `No se pudieron quitar los roles: ${err.message}`; });
        }
    }

    await avisar(guild, new EmbedBuilder()
        .setColor(0x7F1D1D)
        .setTitle(`${ui('alerta')} Anti-nuke: borrado masivo de canales`)
        .addFields(
            { name: 'Quién', value: nombre(quien), inline: true },
            { name: 'Canales borrados', value: `${lista.length} en menos de ${P().ANTINUKE_VENTANA_SEG}s (último: #${channel.name})`, inline: true },
            { name: 'Acción', value: accion },
        )
        .setTimestamp());
}

// ── Mensaje de registro borrado ──────────────────────────────────────────────

async function alBorrarMensaje(message) {
    try {
        const guild = message?.guild;
        const tipo = guild && logCanales.tipoDe(message.channelId);
        if (!tipo || tipo === 'categoria') return;
        const encontrado = archivo.porMensaje(message.id, logCanales.TIPOS());
        if (!encontrado) return;

        const quien = await ejecutorDe(guild, AuditLogEvent.MessageDelete,
            e => e.target?.id === guild.client.user.id && e.extra?.channel?.id === message.channelId);
        const ch = await logCanales.canal(guild, tipo);
        const msg = await ch?.send(archivo.payloadDe(tipo, encontrado.entrada,
            `Restaurado: ${quien ? `${quien.username} borró este registro` : 'alguien borró este registro'}`)).catch(() => null);
        if (msg) archivo.alias(tipo, msg.id, encontrado.entrada.id);
        console.warn(`[proteccion] Registro de ${tipo} borrado${quien ? ` por ${quien.username}` : ''}: restaurado.`);
    } catch (err) {
        console.error('[proteccion] alBorrarMensaje:', err.message);
    }
}

async function alBorradoMasivo(mensajes, channel) {
    if (!logCanales.tipoDe(channel?.id)) return;
    for (const m of [...mensajes.values()].reverse()) await alBorrarMensaje(m);
}

// Al arrancar: si un canal de registro se borró mientras el bot estaba
// apagado, ya se recreó vacío en asegurarTodos; aquí se rellena.
async function alArrancar(guild, creados) {
    for (const t of creados ?? []) {
        if (!archivo.entradas(t).length) continue;   // instalación nueva: nada que restaurar
        const n = await restaurarCanal(guild, t, 'Este canal no existía al arrancar el bot (se borró mientras estaba apagado).');
        await avisar(guild, new EmbedBuilder()
            .setColor(0xDC2626)
            .setTitle(`${ui('alerta')} Canal de registros borrado con el bot apagado`)
            .setDescription(`**#${t}** se recreó y se restauraron ${n} registro(s).`)
            .setTimestamp());
    }
}

module.exports = {
    alBorrarCanal, alBorrarMensaje, alBorradoMasivo, alArrancar, restaurarCanal,
    __test: { antiNuke, borrados },
};
