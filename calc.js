'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('./config');

function buildCalcEmbed() {
    return new EmbedBuilder()
        .setColor(0x2B2D31)
        .setDescription(
            '# 7x Community - Robux\n\n' +
            '¿Quieres saber cuántos Robux puedes comprar o cuánto costarán los que necesitas?\n\n' +
            '<:money:1501213606077792266> = Ingresa la cantidad de dinero que tienes y el bot te dirá cuántos Robux puedes obtener.\n\n' +
            '<a:robuxxx:1510070809366892604> = Ingresa la cantidad de Robux que deseas y el bot calculará el precio exacto.\n\n' +
            '<:point:1501212595464700104> Cálculo instantáneo y automático.\n' +
            '<:point:1501212595464700104> Precios actualizados.\n' +
            '<:point:1501212595464700104> Fácil y rápido.\n\n' +
            'Presiona uno de los botones para comenzar.'
        );
}

function buildCalcRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('calc_dinero')
            .setEmoji({ id: '1501213606077792266', name: 'money' })
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('calc_robux')
            .setEmoji({ id: '1510070809366892604', name: 'robuxxx', animated: true })
            .setStyle(ButtonStyle.Secondary),
    );
}

function isCalcMsg(msg, botId) {
    // Matches both the current description-heading format and the older
    // title-based format, so the existing pinned message is found and
    // migrated in place instead of being orphaned and duplicated.
    return (
        msg.author.id === botId &&
        msg.embeds.length > 0 &&
        msg.components.length > 0 &&
        (msg.embeds[0]?.description?.includes('7x Community - Robux') || msg.embeds[0]?.title?.includes('7x Community - Robux'))
    );
}

async function ensureCalcPanel(client) {
    const channel = client.channels.cache.get(config.CHANNELS.CALC);
    if (!channel) {
        console.warn('[calc] Calc channel not found — skipping.');
        return;
    }

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (messages) {
        const pinned = messages.find(m => m.pinned && isCalcMsg(m, client.user.id));
        if (pinned) {
            await pinned.edit({ embeds: [buildCalcEmbed()], components: [buildCalcRow()] })
                .catch(err => console.warn('[calc] Could not edit pinned calc panel:', err.message));
            console.log('[calc] Pinned calc panel updated.');
            return;
        }
        const existing = messages.find(m => isCalcMsg(m, client.user.id));
        if (existing) {
            await existing.edit({ embeds: [buildCalcEmbed()], components: [buildCalcRow()] })
                .catch(err => console.warn('[calc] Could not edit calc panel:', err.message));
            await existing.pin().catch(err => console.warn('[calc] Could not pin:', err.message));
            console.log('[calc] Calc panel updated and pinned.');
            return;
        }
    }

    await new Promise(r => setTimeout(r, 3000));

    const recheck = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    if (recheck?.find(m => isCalcMsg(m, client.user.id))) {
        console.log('[calc] Calc panel appeared while waiting — skipping send.');
        return;
    }

    const msg = await channel.send({ embeds: [buildCalcEmbed()], components: [buildCalcRow()] });
    await msg.pin().catch(err => console.warn('[calc] Could not pin:', err.message));
    console.log('[calc] Calc panel sent and pinned.');
}

module.exports = { ensureCalcPanel };
