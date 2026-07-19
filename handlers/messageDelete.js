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

function matchesWindow(entry, now) {
    return now - entry.createdTimestamp <= AUDIT_LOG_WINDOW_MS;
}

async function wasDeletedBySomeoneElse(message) {
    await sleep(AUDIT_LOG_FETCH_DELAY_MS);
    const now = Date.now();

    // Fetch each audit log type explicitly (instead of one mixed "latest 5"
    // fetch) so unrelated mod actions (bans, role edits, etc.) happening in
    // the same window can't push the relevant delete entry out of range.
    const [singleLogs, bulkLogs] = await Promise.allSettled([
        message.guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 5 }),
        message.guild.fetchAuditLogs({ type: AuditLogEvent.MessageBulkDelete, limit: 5 }),
    ]);

    // If BOTH fetches failed (e.g. the bot is missing "View Audit Log"),
    // we have no way to verify who deleted it. Fail CLOSED: do not repost,
    // since wrongly reposting content a moderator removed on purpose is
    // worse than occasionally missing a genuine self-delete repost.
    if (singleLogs.status === 'rejected' && bulkLogs.status === 'rejected') {
        console.error(
            '[messageDelete] audit log fetch failed (missing "View Audit Log" permission?):',
            singleLogs.reason?.message
        );
        return true;
    }

    if (singleLogs.status === 'fulfilled') {
        for (const entry of singleLogs.value.entries.values()) {
            if (!matchesWindow(entry, now)) continue;
            if (entry.target?.id === message.author.id && entry.extra?.channel?.id === message.channelId) {
                return true;
            }
        }
    }

    if (bulkLogs.status === 'fulfilled') {
        for (const entry of bulkLogs.value.entries.values()) {
            if (!matchesWindow(entry, now)) continue;
            if (
                entry.extra?.channel?.id === message.channelId &&
                (KNOWN_MODERATION_BOT_IDS.has(entry.executorId) || entry.executor?.bot)
            ) {
                return true;
            }
        }
    }

    return false;
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
