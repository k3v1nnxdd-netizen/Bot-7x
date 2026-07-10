'use strict';

const { EmbedBuilder, AuditLogEvent } = require('discord.js');
const config = require('../config');

// Discord only writes a MESSAGE_DELETE audit log entry when someone deletes
// a message that isn't their own (mod/admin/bot deleting another user's message).
// So: a fresh matching entry => someone else deleted it. No entry => self-delete.
const AUDIT_LOG_WINDOW_MS = 5000;

async function wasDeletedBySomeoneElse(message) {
    try {
        const logs = await message.guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 1 });
        const entry = logs.entries.first();
        return Boolean(
            entry &&
            entry.target?.id === message.author.id &&
            entry.extra?.channel?.id === message.channelId &&
            Date.now() - entry.createdTimestamp < AUDIT_LOG_WINDOW_MS
        );
    } catch (err) {
        console.error('[messageDelete] audit log fetch failed:', err.message);
        return false; // fail open: if we can't verify, treat as self-delete
    }
}

async function handleMessageDelete(message) {
    if (message.partial) return; // uncached message — no author/content to report
    if (!message.guild) return;
    if (!message.author || message.author.bot) return;
    if (message.author.id === config.OWNER_ID) return;

    if (await wasDeletedBySomeoneElse(message)) return;

    const embed = new EmbedBuilder()
        .setColor(0x2B2D31)
        .setAuthor({
            name: message.author.tag ?? message.author.username,
            iconURL: message.author.displayAvatarURL({ size: 128 }),
        })
        .setTitle('🗑️ Mensaje eliminado por su autor')
        .setDescription(
            message.content
                ? `\`\`\`${message.content}\`\`\``
                : '*Sin contenido de texto (posible imagen, archivo o embed).*'
        )
        .setFooter({ text: `ID: ${message.author.id}` })
        .setTimestamp();

    await message.channel.send({ embeds: [embed] })
        .catch(err => console.error('[messageDelete] send failed:', err.message));
}

module.exports = { handleMessageDelete };
