'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AuditLogEvent, AttachmentBuilder } = require('discord.js');
const logCanales = require('./logCanales');
const { ui, uiBoton } = require('./uiIconos');

// ── Registro privado de mensajes editados y borrados ─────────────────────────
//
// Va al canal de registro "mensajes" (utils/logCanales.js), sólo visible para
// los admins. Es independiente del aviso PÚBLICO que ya pone
// handlers/messageDelete.js en el propio canal cuando alguien borra lo suyo:
// aquí se registra TODO (también lo que borra un moderador, y lo de los
// admins), con el contenido completo, los archivos y quién lo borró.
//
// Límite que no se puede saltar: Discord sólo entrega el contenido de un
// mensaje borrado o editado si el bot lo tenía en caché, es decir, si se
// escribió después del último arranque. Si no, se registra igualmente que
// pasó, diciendo que el contenido no está disponible.

const MAX_CAMPO = 1024;
const MAX_ARCHIVO = 8 * 1024 * 1024;
const MAX_ARCHIVOS_TOTAL = 9 * 1024 * 1024;
const ESPERA_AUDITORIA_MS = 1500;
const VENTANA_AUDITORIA_MS = 10_000;

const ts = (ms, f = 'f') => `<t:${Math.floor(ms / 1000)}:${f}>`;

function cortar(t, max) {
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Bloque citado y sin menciones activas (el embed no las dispara, pero así se
// lee igual que lo que escribió la persona).
function citado(texto) {
    if (!texto) return '*Sin texto*';
    return cortar(texto.split('\n').map(l => `> ${l}`).join('\n'), MAX_CAMPO);
}

function debeIgnorarse(message) {
    if (!message?.guildId) return true;
    if (message.author?.bot || message.webhookId) return true;
    return logCanales.idsDeRegistro().has(message.channelId);
}

function cabecera(embed, autor) {
    if (autor) embed.setAuthor({ name: `${autor.tag ?? autor.username}`, iconURL: autor.displayAvatarURL?.({ size: 128 }) });
    return embed;
}

function botonIr(url) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Ir al mensaje').setURL(url).setEmoji(uiBoton('editado')),
    );
}

// ── Quién borró ──────────────────────────────────────────────────────────────
//
// Discord AGRUPA las entradas de auditoría: si el mismo moderador borra varios
// mensajes del mismo autor en el mismo canal en pocos minutos, no crea entradas
// nuevas, sube el `count` de la que ya había (y la fecha NO cambia). Por eso no
// basta con mirar la fecha: también cuenta como "fue él" una entrada cuyo
// contador subió desde la última vez que la vimos.
const contadores = new Map();   // entryId -> último count visto

async function quienBorro(message) {
    const guild = message.guild;
    if (!guild || !message.author) return null;
    await new Promise(r => setTimeout(r, ESPERA_AUDITORIA_MS));
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 10 }).catch(() => null);
    if (!logs) return null;

    let quien = null;
    const ahora = Date.now();
    for (const entry of logs.entries.values()) {
        const count = entry.extra?.count ?? 1;
        const antes = contadores.get(entry.id);
        contadores.set(entry.id, count);
        if (quien) continue;
        if (entry.target?.id !== message.author.id || entry.extra?.channel?.id !== message.channelId) continue;
        const reciente = ahora - entry.createdTimestamp <= VENTANA_AUDITORIA_MS;
        const subio = antes !== undefined && count > antes;
        if ((reciente && antes === undefined) || subio) quien = entry.executor ?? null;
    }
    if (contadores.size > 500) contadores.clear();
    return quien;
}

// Descarga los archivos de un mensaje borrado para volver a subirlos al
// registro. El CDN de Discord los sirve un rato después del borrado; si ya no,
// queda el nombre y el tamaño.
async function rescatarArchivos(message) {
    const files = [];
    const perdidos = [];
    let total = 0;
    for (const a of message.attachments?.values?.() ?? []) {
        if (a.size > MAX_ARCHIVO || total + a.size > MAX_ARCHIVOS_TOTAL) { perdidos.push(a); continue; }
        try {
            const r = await fetch(a.proxyURL || a.url, { signal: AbortSignal.timeout(8000) });
            if (!r.ok) throw new Error(String(r.status));
            const buf = Buffer.from(await r.arrayBuffer());
            total += buf.length;
            files.push(new AttachmentBuilder(buf, { name: a.name ?? 'archivo' }));
        } catch {
            perdidos.push(a);
        }
    }
    return { files, perdidos };
}

const kb = n => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

// Al arrancar, se apuntan los contadores de las entradas que ya existen: así la
// primera vez que un moderador borra algo tras un reinicio también se detecta
// por el contador, aunque la entrada sea antigua.
async function iniciar(guild) {
    const logs = await guild?.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 10 }).catch(() => null);
    for (const entry of logs?.entries.values() ?? []) contadores.set(entry.id, entry.extra?.count ?? 1);
}

// ── Editado ──────────────────────────────────────────────────────────────────

async function alEditar(viejo, nuevo) {
    try {
        if (nuevo.partial) nuevo = await nuevo.fetch().catch(() => null);
        if (!nuevo || debeIgnorarse(nuevo)) return;

        const antes = viejo.partial ? null : (viejo.content ?? '');
        const despues = nuevo.content ?? '';
        // Discord también "edita" un mensaje al cargar la vista previa de un
        // link o fijarlo: si el texto es igual, no es una edición.
        if (antes !== null && antes === despues) return;

        const embed = cabecera(new EmbedBuilder(), nuevo.author)
            .setColor(0x3B82F6)
            .setTitle(`${ui('editado')} Mensaje editado`)
            .addFields(
                { name: 'Autor', value: `<@${nuevo.author.id}>\n\`${nuevo.author.id}\``, inline: true },
                { name: 'Canal', value: `<#${nuevo.channelId}>`, inline: true },
                { name: 'Enviado', value: ts(nuevo.createdTimestamp), inline: true },
                { name: 'Antes', value: antes === null ? '*No disponible: el mensaje es anterior al último reinicio del bot.*' : citado(antes) },
                { name: 'Después', value: citado(despues) },
            )
            .setFooter({ text: `Mensaje ${nuevo.id}` })
            .setTimestamp(nuevo.editedTimestamp ?? Date.now());

        // Si alguno no cabe entero en el embed, va completo en un .txt.
        const files = [];
        if ((antes?.length ?? 0) > MAX_CAMPO - 50 || despues.length > MAX_CAMPO - 50) {
            files.push(new AttachmentBuilder(
                Buffer.from(`ANTES:\n${antes ?? '(no disponible)'}\n\nDESPUÉS:\n${despues}\n`, 'utf8'),
                { name: `editado-${nuevo.id}.txt` },
            ));
        }

        await logCanales.enviar(nuevo.guild, 'mensajes', {
            embeds: [embed], files, components: [botonIr(nuevo.url)], allowedMentions: { parse: [] },
        });
    } catch (err) {
        console.error('[registro] alEditar:', err.message);
    }
}

// ── Borrado ──────────────────────────────────────────────────────────────────

async function alBorrar(message) {
    try {
        if (!message.guild || logCanales.idsDeRegistro().has(message.channelId)) return;

        if (message.partial || !message.author) {
            await logCanales.enviar(message.guild, 'mensajes', {
                embeds: [new EmbedBuilder()
                    .setColor(0x64748B)
                    .setTitle(`${ui('borrado')} Mensaje borrado (sin contenido)`)
                    .setDescription('El mensaje es anterior al último reinicio del bot, así que Discord no entregó su contenido ni su autor.')
                    .addFields({ name: 'Canal', value: `<#${message.channelId}>`, inline: true })
                    .setFooter({ text: `Mensaje ${message.id}` })
                    .setTimestamp()],
                allowedMentions: { parse: [] },
            });
            return;
        }
        if (debeIgnorarse(message)) return;

        const [quien, archivos] = await Promise.all([quienBorro(message), rescatarArchivos(message)]);
        const porOtro = quien && quien.id !== message.author.id;

        const embed = cabecera(new EmbedBuilder(), message.author)
            .setColor(porOtro ? 0xF97316 : 0xEF4444)
            .setTitle(`${ui('borrado')} ${porOtro ? 'Mensaje borrado por un moderador' : 'Mensaje borrado'}`)
            .addFields(
                { name: 'Autor', value: `<@${message.author.id}>\n\`${message.author.id}\``, inline: true },
                { name: 'Canal', value: `<#${message.channelId}>`, inline: true },
                { name: 'Borrado por', value: porOtro ? `<@${quien.id}>\n\`${quien.id}\`` : 'Su autor\n-# sin registro de moderador', inline: true },
                { name: 'Enviado', value: `${ts(message.createdTimestamp)}\n${ts(message.createdTimestamp, 'R')}`, inline: true },
                { name: 'Contenido', value: citado(message.content) },
            )
            .setFooter({ text: `Mensaje ${message.id}` })
            .setTimestamp();

        if (message.embeds?.length) embed.addFields({ name: 'Embeds', value: `${message.embeds.length} embed(s) adjunto(s)`, inline: true });
        if (message.stickers?.size) embed.addFields({ name: 'Stickers', value: message.stickers.map(s => s.name).join(', '), inline: true });
        if (message.attachments?.size) {
            embed.addFields({
                name: `Archivos (${message.attachments.size})`,
                value: cortar(message.attachments.map(a =>
                    `${archivos.perdidos.includes(a) ? '❌' : '✅'} ${a.name} · ${kb(a.size)}`).join('\n'), MAX_CAMPO),
            });
        }
        if (message.reference?.messageId) {
            embed.addFields({ name: 'Respondía a', value: `https://discord.com/channels/${message.guildId}/${message.reference.channelId}/${message.reference.messageId}` });
        }

        const files = [...archivos.files];
        if ((message.content?.length ?? 0) > MAX_CAMPO - 50) {
            files.push(new AttachmentBuilder(Buffer.from(message.content, 'utf8'), { name: `borrado-${message.id}.txt` }));
        }

        await logCanales.enviar(message.guild, 'mensajes', { embeds: [embed], files, allowedMentions: { parse: [] } });
    } catch (err) {
        console.error('[registro] alBorrar:', err.message);
    }
}

// ── Borrado masivo ───────────────────────────────────────────────────────────

async function alBorradoMasivo(mensajes, canal) {
    try {
        const guild = canal?.guild;
        if (!guild || logCanales.idsDeRegistro().has(canal.id)) return;

        await new Promise(r => setTimeout(r, ESPERA_AUDITORIA_MS));
        const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageBulkDelete, limit: 5 }).catch(() => null);
        const entry = logs?.entries.find(e => e.target?.id === canal.id && Date.now() - e.createdTimestamp <= VENTANA_AUDITORIA_MS);

        const lista = [...mensajes.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        const conContenido = lista.filter(m => !m.partial && m.author);
        const texto = conContenido.map(m =>
            `[${new Date(m.createdTimestamp).toISOString()}] ${m.author.tag ?? m.author.username} (${m.author.id}): ` +
            `${m.content || ''}${m.attachments?.size ? ` [archivos: ${m.attachments.map(a => a.url).join(' ')}]` : ''}`,
        ).join('\n');

        const embed = new EmbedBuilder()
            .setColor(0xDC2626)
            .setTitle(`${ui('borrado')} Borrado masivo`)
            .addFields(
                { name: 'Canal', value: `<#${canal.id}>`, inline: true },
                { name: 'Mensajes', value: String(mensajes.size), inline: true },
                { name: 'Borrado por', value: entry?.executor ? `<@${entry.executor.id}>` : 'Desconocido', inline: true },
                { name: 'Recuperados', value: `${conContenido.length} de ${mensajes.size}${conContenido.length < mensajes.size ? ' (el resto era anterior al último reinicio)' : ''}` },
            )
            .setTimestamp();

        await logCanales.enviar(guild, 'mensajes', {
            embeds: [embed],
            files: texto ? [new AttachmentBuilder(Buffer.from(texto, 'utf8'), { name: `borrado-masivo-${canal.id}.txt` })] : [],
            allowedMentions: { parse: [] },
        });
    } catch (err) {
        console.error('[registro] alBorradoMasivo:', err.message);
    }
}

module.exports = { iniciar, alEditar, alBorrar, alBorradoMasivo, __test: { citado, debeIgnorarse } };
