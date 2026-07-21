'use strict';

const { EmbedBuilder, AuditLogEvent, PermissionFlagsBits } = require('discord.js');
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

// Log the exact rejection reason instead of a generic guess — a rejected
// fetchAuditLogs() can fail for reasons that have nothing to do with
// permissions (bad guild reference, API outage, rate limit, etc.), and
// assuming "missing permission" without checking hides the real cause.
function describeError(err) {
    return { name: err?.name, code: err?.code, httpStatus: err?.status, message: err?.message };
}

// Resolves the bot's own GuildMember with a forced re-fetch (not the cache)
// so a stale members.me snapshot can't produce a false "missing permission"
// read right after a role was granted.
async function fetchFreshBotMember(guild) {
    try {
        return await guild.members.fetchMe({ force: true });
    } catch (err) {
        console.error('[messageDelete] could not fetch bot member (guild.members.fetchMe):', describeError(err));
        return guild.members.me ?? null; // fall back to cache rather than nothing
    }
}

async function wasDeletedBySomeoneElse(message) {
    if (!message.guild) {
        console.warn('[messageDelete] message.guild is null (DM or uncached) — cannot check audit log, failing closed.');
        return true;
    }

    const botMember = await fetchFreshBotMember(message.guild);
    if (!botMember) {
        console.error('[messageDelete] bot GuildMember could not be resolved at all — failing closed.');
        return true;
    }

    console.log(
        `[messageDelete] bot effective permissions in guild "${message.guild.name}" (${message.guild.id}):`,
        botMember.permissions.toArray().join(', ')
    );

    if (!botMember.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
        console.error(
            '[messageDelete] ViewAuditLog missing from guild.members.me.permissions — ' +
            'the bot\'s role does not actually grant it (or Administrator was revoked). Failing closed.'
        );
        return true;
    }

    await sleep(AUDIT_LOG_FETCH_DELAY_MS);
    const now = Date.now();

    // Fetch each audit log type explicitly (instead of one mixed "latest 5"
    // fetch) so unrelated mod actions (bans, role edits, etc.) happening in
    // the same window can't push the relevant delete entry out of range.
    const [singleLogs, bulkLogs] = await Promise.allSettled([
        message.guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 5 }),
        message.guild.fetchAuditLogs({ type: AuditLogEvent.MessageBulkDelete, limit: 5 }),
    ]);

    // Permissions check passed above, so a rejection here means something
    // else is wrong (API error, network blip, etc.) — log the real reason.
    if (singleLogs.status === 'rejected' && bulkLogs.status === 'rejected') {
        console.error('[messageDelete] fetchAuditLogs (MessageDelete) failed:', describeError(singleLogs.reason));
        console.error('[messageDelete] fetchAuditLogs (MessageBulkDelete) failed:', describeError(bulkLogs.reason));
        return true; // fail closed — cannot verify who deleted it
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
