'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('./config');

const EMBED_COLOR = 0x2B2D31; // gray, per request

function buildCheckGroupEmbed() {
    return new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setDescription(
            "# <:followers7x:1525326777071960124> Check Group's\n\n" +
            '<:point:1501212595464700104> Presiona el botón del grupo en el que deseas comprobar si eres elegible para recibir envíos de Robux.\n\n' +
            '<:point:1501212595464700104> **7x (Antes Noctra Study)**: Verifica si eres elegible para este grupo.\n\n' +
            "<:point:1501212595464700104> **7x Community's**: Verifica si eres elegible para este grupo.\n\n" +
            '<:point:1501212595464700104> **#7x Group**: Verifica si eres elegible para este grupo.\n\n' +
            '**Información importante**\n\n' +
            '<:point:1501212595464700104> Se recomienda estar en los 3 grupos, ya que si alguno presenta problemas o alcanza sus límites, podremos realizar el envío desde otra comunidad.\n\n' +
            '<:point:1501212595464700104> Los envíos se realizan principalmente por 7x (Antes Noctra Study), aunque esto puede cambiar en cualquier momento.\n\n' +
            '<:point:1501212595464700104> No se realizan envíos mediante Roblox Plus/Premium.\n\n' +
            '<:truepurple:1501214679400190086> Mientras esperas, revisa periódicamente el canal de resultados, ya que ahí se notificará si eres elegible o no para recibir envíos de Robux.'
        );
}

function buildCheckGroupRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('cg_noctra')
            .setLabel('7x (Antes Noctra)')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('cg_community')
            .setLabel("7x Community's")
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('cg_group7x')
            .setLabel('#7x Group')
            .setStyle(ButtonStyle.Secondary),
    );
}

function isCheckGroupMsg(msg, botId) {
    return (
        msg.author.id === botId &&
        msg.embeds.length > 0 &&
        msg.embeds[0]?.description?.includes("Check Group's")
    );
}

async function ensureCheckGroupPanel(client) {
    const channel = client.channels.cache.get(config.CHANNELS.CHECKGROUP);
    if (!channel) {
        console.warn('[checkGroup] CheckGroup channel not found — skipping.');
        return;
    }

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (messages) {
        const pinned = messages.find(m => m.pinned && isCheckGroupMsg(m, client.user.id));
        if (pinned) {
            await pinned.edit({ embeds: [buildCheckGroupEmbed()], components: [buildCheckGroupRow()] })
                .catch(err => console.warn('[checkGroup] Could not edit pinned:', err.message));
            console.log('[checkGroup] Pinned message updated.');
            return;
        }
        const existing = messages.find(m => isCheckGroupMsg(m, client.user.id));
        if (existing) {
            await existing.edit({ embeds: [buildCheckGroupEmbed()], components: [buildCheckGroupRow()] })
                .catch(err => console.warn('[checkGroup] Could not edit:', err.message));
            await existing.pin().catch(err => console.warn('[checkGroup] Could not pin:', err.message));
            console.log('[checkGroup] Message updated and pinned.');
            return;
        }
    }

    await new Promise(r => setTimeout(r, 3000));

    const recheck = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    if (recheck?.find(m => isCheckGroupMsg(m, client.user.id))) {
        console.log('[checkGroup] Message appeared while waiting — skipping send.');
        return;
    }

    const msg = await channel.send({ embeds: [buildCheckGroupEmbed()], components: [buildCheckGroupRow()] });
    await msg.pin().catch(err => console.warn('[checkGroup] Could not pin:', err.message));
    console.log('[checkGroup] Message sent and pinned.');
}

module.exports = { ensureCheckGroupPanel };
