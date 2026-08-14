'use strict';

const { EmbedBuilder } = require('discord.js');
const config = require('./config');

// emoji ID → role ID
const EMOJI_ROLE_MAP = {
    '1510070809366892604': '1514370250324443176', // robuxxx  → Robux
    '1501212817502502913': '1514370713669341236', // sale     → Ofertas
    '1514369084265861212': '1514370936223301713', // notify   → Servidor
    '1514369366878064650': '1514370139242500156', // star     → Sorteos
    '1514369710349877320': '1514374940844101712', // duels    → Duels
};

// Ordered emojis to react with (same order as the embed)
const REACTION_EMOJIS = [
    'a:robuxxx:1510070809366892604',
    'sale:1501212817502502913',
    'notify:1514369084265861212',
    'a:star:1514369366878064650',
    'duels:1514369710349877320',
];

// Populated during ensureRolesPanel — used by reaction event handlers
let rolesMsgId = null;
function getRolesMsgId() { return rolesMsgId; }

function buildRolesEmbed() {
    return new EmbedBuilder()
        .setColor(0x2B2D31)
        .setDescription(
            '# 7x • Ping Roles\n\n' +
            '<:point:1501212595464700104> Presiona la reacción correspondiente para recibir notificaciones\n\n' +
            '<a:robuxxx:1510070809366892604> • Para recibir notificaciones sobre Robux\n\n' +
            '<:sale:1501212817502502913> • Para recibir notificaciones de ofertas\n\n' +
            '<:notify:1514369084265861212> • Para recibir notificaciones del servidor\n\n' +
            '<a:star:1514369366878064650> • Para recibir notificaciones de sorteos\n\n' +
            '<:duels:1514369710349877320> • Para recibir notificaciones de Duels\n\n' +
            '<:point:1501212595464700104> Si deseas dejar de recibir alguna notificación, simplemente vuelve a presionar la reacción correspondiente.'
        );
}

function isRolesMsg(msg, botId) {
    return (
        msg.author.id === botId &&
        msg.embeds.length > 0 &&
        msg.embeds[0]?.description?.includes('Ping Roles') &&
        msg.embeds[0]?.description?.includes('notificaciones')
    );
}

async function ensureReactions(msg) {
    for (const emoji of REACTION_EMOJIS) {
        const id = emoji.split(':').pop();
        if (msg.reactions.cache.get(id)?.me) continue;
        await msg.react(emoji).catch(err => console.warn(`[roles] react failed (${emoji}):`, err.message));
    }
}

async function ensureRolesPanel(client) {
    const channel = client.channels.cache.get(config.CHANNELS.PINGROLES);
    if (!channel) {
        console.warn('[roles] PingRoles channel not found — skipping.');
        return;
    }

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (messages) {
        const pinned = messages.find(m => m.pinned && isRolesMsg(m, client.user.id));
        if (pinned) {
            await pinned.edit({ embeds: [buildRolesEmbed()] }).catch(err => console.warn('[roles] edit failed:', err.message));
            await ensureReactions(pinned);
            rolesMsgId = pinned.id;
            console.log('[roles] Pinned roles panel updated.');
            return;
        }
        const existing = messages.find(m => isRolesMsg(m, client.user.id));
        if (existing) {
            await existing.edit({ embeds: [buildRolesEmbed()] }).catch(err => console.warn('[roles] edit failed:', err.message));
            await existing.pin().catch(err => console.warn('[roles] pin failed:', err.message));
            await ensureReactions(existing);
            rolesMsgId = existing.id;
            console.log('[roles] Roles panel updated and pinned.');
            return;
        }
    }

    await new Promise(r => setTimeout(r, 3000));

    const recheck = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const found   = recheck?.find(m => isRolesMsg(m, client.user.id));
    if (found) {
        await ensureReactions(found);
        rolesMsgId = found.id;
        console.log('[roles] Roles panel appeared while waiting — reactions ensured.');
        return;
    }

    const msg = await channel.send({ embeds: [buildRolesEmbed()] });
    await msg.pin().catch(err => console.warn('[roles] Could not pin:', err.message));
    await ensureReactions(msg);
    rolesMsgId = msg.id;
    console.log('[roles] Roles panel sent, pinned and reactions added.');
}

module.exports = { ensureRolesPanel, EMOJI_ROLE_MAP, getRolesMsgId };
