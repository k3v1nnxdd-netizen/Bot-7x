'use strict';

const { EmbedBuilder, AuditLogEvent } = require('discord.js');
const config = require('../config');

// Discord only writes a MESSAGE_DELETE / MESSAGE_BULK_DELETE audit log entry
// when someone deletes a message that isn't their own (mod/admin/bot deleting
// another user's message). So: a fresh matching entry => someone else deleted
// it. No entry => self-delete.
const AUDIT_LOG_WINDOW_MS = 8000;
// Give Discord's audit log a moment to index the entry before we fetch —
// fetching immediately can race ahead of the entry actually being written.
const AUDIT_LOG_FETCH_DELAY_MS = 1200;

// Other bots in the server known to delete messages (moderation / anti-scam
// bots, including this bot's own auto-delete for scam/trade content). Their
// bulk-delete entries don't carry a per-message target, so we trust them by
// executor id instead of matching message.author.
const KNOWN_MODERATION_BOT_IDS = new Set([
    '1468827564792483874', // 7x Bot — anti-scam auto-delete (ventas/tradeos)
    '282859044593598464',
    '155149108183695360',
    '402528814548254720',
]);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function wasDeletedBySomeoneElse(message) {
    try {
        await sleep(AUDIT_LOG_FETCH_DELAY_MS);

        const logs = await message.guild.fetchAuditLogs({ limit: 5 });
        const now = Date.now();

        for (const entry of logs.entries.values()) {
            if (now - entry.createdTimestamp > AUDIT_LOG_WINDOW_MS) continue;

            if (
                entry.action === AuditLogEvent.MessageDelete &&
                entry.target?.id === message.author.id &&
                entry.extra?.channel?.id === message.channelId
            ) {
                return true;
            }

            if (
                entry.action === AuditLogEvent.MessageBulkDelete &&
                entry.extra?.channel?.id === message.channelId &&
                (KNOWN_MODERATION_BOT_IDS.has(entry.executorId) || entry.executor?.bot)
            ) {
                return true;
            }
        }

        return false;
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
