'use strict';

const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const robuxLeaderboard = require('./robuxLeaderboard');

const EMBED_COLOR = 0x2B2D31; // gray, per request

function formatEntry(entry, rank) {
    const rankLabel = rank === 1 ? '<a:star:1514369366878064650> **Top-1**' : `**#${rank}**`;
    const richBadge = entry.totalRobux >= config.RICH_CLIENT_ROBUX_THRESHOLD
        ? '\n<:true:1501213776878501899> `Rich Client — +50,000 Robux`'
        : '';

    return (
        `${rankLabel} — <@${entry.userId}>\n` +
        `<a:robuxxx:1510070809366892604> Robux comprados\n\`\`\`${entry.totalRobux.toLocaleString()} Robux\`\`\`\n` +
        `<a:shop:1190502129748676650> Dinero gastado\n\`\`\`$${Math.round(entry.totalSpent).toLocaleString()} MXN\`\`\`` +
        richBadge
    );
}

function buildLeaderboardEmbed() {
    const top = robuxLeaderboard.getTop(10);

    const description = top.length === 0
        ? 'Todavía no hay compras registradas.'
        : top.map((entry, i) => formatEntry(entry, i + 1)).join('\n\n');

    return new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle('<a:robuxxx:1510070809366892604> Top 10 — Mayores Compradores de Robux')
        .setDescription(description)
        .setFooter({ text: '7x Community • Se actualiza con cada pago confirmado' })
        .setTimestamp();
}

// Sends or edits the persistent leaderboard message in the top-buyers
// channel — the message ref is stored so it's edited in place on every
// purchase instead of resending, and re-found across bot restarts.
async function updateLeaderboardMessage(client) {
    const channel = client.channels.cache.get(config.CHANNELS.ROBUX_TOP)
        ?? await client.channels.fetch(config.CHANNELS.ROBUX_TOP).catch(() => null);
    if (!channel) {
        console.warn('[robuxLeaderboardPanel] Top buyers channel not found.');
        return;
    }

    const embed = buildLeaderboardEmbed();
    const ref = robuxLeaderboard.getMessageRef();

    if (ref) {
        try {
            const msg = await channel.messages.fetch(ref.messageId);
            await msg.edit({ embeds: [embed] });
            return;
        } catch (err) {
            console.warn('[robuxLeaderboardPanel] Could not edit existing message, sending a new one:', err.message);
        }
    }

    try {
        const msg = await channel.send({ embeds: [embed] });
        robuxLeaderboard.setMessageRef(msg.channelId, msg.id);
    } catch (err) {
        console.warn('[robuxLeaderboardPanel] Could not send leaderboard message:', err.message);
    }
}

// Grants the Rich Client role (cumulative threshold, never revoked) and
// swaps the Top-1 role from the previous leader to the new one, if the
// buyer's purchase just changed who's in first place.
async function syncRobuxRoles(client, buyerId) {
    const guild = client.guilds.cache.get(config.GUILD_ID);
    if (!guild) return;

    // ── Rich Client ────────────────────────────────────────────────────────────
    const buyerEntry = robuxLeaderboard.getEntry(buyerId);
    if (buyerEntry && buyerEntry.totalRobux >= config.RICH_CLIENT_ROBUX_THRESHOLD) {
        try {
            const member = await guild.members.fetch(buyerId);
            if (!member.roles.cache.has(config.ROLES.RICH_CLIENT)) {
                await member.roles.add(config.ROLES.RICH_CLIENT);
            }
        } catch (err) {
            console.warn('[robuxLeaderboardPanel] Could not grant Rich Client role:', err.message);
        }
    }

    // ── Top-1 swap ─────────────────────────────────────────────────────────────
    const ranked  = robuxLeaderboard.getRanked();
    const newTop1  = ranked[0]?.userId ?? null;
    const prevTop1 = robuxLeaderboard.getTop1UserId();
    if (newTop1 === prevTop1) return;

    if (prevTop1) {
        const prevMember = await guild.members.fetch(prevTop1).catch(() => null);
        if (prevMember?.roles.cache.has(config.ROLES.ROBUX_TOP1)) {
            await prevMember.roles.remove(config.ROLES.ROBUX_TOP1).catch(err =>
                console.warn('[robuxLeaderboardPanel] Could not remove Top-1 role from previous holder:', err.message)
            );
        }
    }

    if (newTop1) {
        const newMember = await guild.members.fetch(newTop1).catch(() => null);
        if (newMember && !newMember.roles.cache.has(config.ROLES.ROBUX_TOP1)) {
            await newMember.roles.add(config.ROLES.ROBUX_TOP1).catch(err =>
                console.warn('[robuxLeaderboardPanel] Could not grant Top-1 role to new holder:', err.message)
            );
        }
    }

    robuxLeaderboard.setTop1UserId(newTop1);
}

module.exports = { buildLeaderboardEmbed, updateLeaderboardMessage, syncRobuxRoles };
