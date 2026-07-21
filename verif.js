'use strict';

const { EmbedBuilder } = require('discord.js');
const config = require('./config');

function buildVerifEmbed() {
    return new EmbedBuilder()
        .setColor(0x000000)
        .setDescription(
            "# 7x Community - Group's\n\n" +
            "<:followers7x:1525326777071960124> **7x Community's**\n" +
            'https://www.roblox.com/share/g/59218460\n\n' +
            '<:followers7x:1525326777071960124> **Noctra Study**\n' +
            'https://www.roblox.com/share/g/282134403\n\n' +
            '<:followers7x:1525326777071960124> **7x $tudio**\n' +
            'https://www.roblox.com/share/g/1101699267\n\n' +
            '<:point:1501212595464700104> **Actualmente los Robux se envían únicamente mediante el grupo *Noctra Study*.** Sin embargo, con el paso del tiempo también se utilizarán las demás comunidades para realizar los pagos.\n\n' +
            '<:rules:1525317070764511343> **Roblox exige que un usuario permanezca al menos 14 días dentro del grupo antes de poder recibir pagos de Robux.** Por ello, es importante unirte cuanto antes.\n\n' +
            '<:point:1501212595464700104> **Es obligatorio unirse a todas las comunidades**, no solo a una. En cualquier momento los pagos pueden realizarse desde cualquiera de estos grupos.'
        );
}

function buildVerifOptions() {
    return {
        content: '',
        embeds: [buildVerifEmbed()],
        components: [],
    };
}

function isVerifMsg(msg, botId) {
    return (
        msg.author.id === botId &&
        msg.embeds.length > 0 &&
        (
            msg.embeds[0]?.description?.includes('Verificación de Grupo') ||
            msg.embeds[0]?.title?.includes('Verificación de Grupo') ||
            msg.content?.includes('Verificación de Grupo') ||
            msg.embeds[0]?.description?.includes("7x Community - Group's")
        )
    );
}

async function ensureVerifPanel(client) {
    const channel = client.channels.cache.get(config.CHANNELS.VERIF);
    if (!channel) {
        console.warn('[verif] Verif channel not found — skipping.');
        return;
    }

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (messages) {
        const pinned = messages.find(m => m.pinned && isVerifMsg(m, client.user.id));
        if (pinned) {
            await pinned.edit(buildVerifOptions())
                .catch(err => console.warn('[verif] Could not edit pinned:', err.message));
            console.log('[verif] Pinned verif panel updated.');
            return;
        }
        const existing = messages.find(m => isVerifMsg(m, client.user.id));
        if (existing) {
            await existing.edit(buildVerifOptions())
                .catch(err => console.warn('[verif] Could not edit:', err.message));
            await existing.pin().catch(err => console.warn('[verif] Could not pin:', err.message));
            console.log('[verif] Verif panel updated and pinned.');
            return;
        }
    }

    await new Promise(r => setTimeout(r, 3000));

    const recheck = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    if (recheck?.find(m => isVerifMsg(m, client.user.id))) {
        console.log('[verif] Verif panel appeared while waiting — skipping send.');
        return;
    }

    const msg = await channel.send(buildVerifOptions());
    await msg.pin().catch(err => console.warn('[verif] Could not pin:', err.message));
    console.log('[verif] Verif panel sent and pinned.');
}

module.exports = { ensureVerifPanel };
