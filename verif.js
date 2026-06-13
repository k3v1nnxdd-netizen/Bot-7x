'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('./config');

function buildVerifEmbed() {
    return new EmbedBuilder()
        .setColor(0x000000)
        .setDescription(
            '# 7x Community - Verificación de Grupo\n\n' +
            '¿Quieres saber si ya eres elegible para recibir Robux?\n\n' +
            '<:member:1501261625523699892> = Toca este botón para verificar cuántos días llevas dentro del grupo de Roblox. El bot revisará automáticamente tu tiempo de permanencia y te indicará si ya cumples los requisitos para recibir Robux.\n\n' +
            '<:point:1501212595464700104> Verificación instantánea y automática.\n' +
            '<:point:1501212595464700104> Muestra los días exactos que llevas en el grupo.\n' +
            '<:point:1501212595464700104> Confirma si eres elegible para recibir Robux.\n' +
            '<:point:1501212595464700104> Rápido, sencillo y seguro.\n\n' +
            `<:truepurple:1501214679400190086> Debes unirte primero a la comunidad de Roblox: [Click Aqui](<${config.ROBLOX_GROUP_LINK}>) Si no formas parte del grupo, no podrás ser verificado ni recibir Robux.\n\n` +
            'Presiona el botón para comenzar.'
        );
}

function buildVerifRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('verif_check')
            .setEmoji({ id: '1501261625523699892', name: 'member' })
            .setStyle(ButtonStyle.Secondary),
    );
}

function buildVerifOptions() {
    return {
        content: '',
        embeds: [buildVerifEmbed()],
        components: [buildVerifRow()],
    };
}

function isVerifMsg(msg, botId) {
    return (
        msg.author.id === botId &&
        msg.embeds.length > 0 &&
        (
            msg.embeds[0]?.description?.includes('Verificación de Grupo') ||
            msg.embeds[0]?.title?.includes('Verificación de Grupo') ||
            msg.content?.includes('Verificación de Grupo')
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
