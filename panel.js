'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('./config');

function buildEmbed() {
    return new EmbedBuilder()
        .setColor(0x000000)
        .setTitle('<:buy:1501212698556371004> ** 7x COMMUNITY - Soporte & Compras**')
        .setDescription(
            '¿Quieres comprar **Robux** o tienes alguna **duda**?\n' +
            'Selecciona una opción abajo para **continuar**.\n\n' +
            '<:point:1501212595464700104>  **Comprar** - Crear ticket para comprar Robux\n' +
            '<:point:1501212595464700104> ** Soporte** - Resolver dudas, problemas o consultas\n\n' +
            '━━━━━━━━━━━━━━━━━━━━\n\n' +
            'Los tickets de compra de **Robux** son automáticos y atendidos por un **bot**.\n' +
            '**No es necesaria la intervención de staff, owner ni menciones a @kevvv7x para completar tu compra**.\n\n' +
            'El staff solo intervendrá en tickets de soporte, dudas o problemas.\n\n' +
            '<:alert:1501220021035204658> **Por favor, evita crear tickets innecesarios.**'
        );
}

function buildRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('comprar')
            .setLabel('Comprar')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('<:buy:1501212698556371004>'),
        new ButtonBuilder()
            .setCustomId('otra_cosa')
            .setLabel('Otra cosa')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('<:up:1501217620437897227>')
    );
}

function isPanelMsg(msg, botId) {
    return (
        msg.author.id === botId &&
        msg.embeds.length > 0 &&
        msg.components.length > 0 &&
        msg.embeds[0]?.title?.includes('7x COMMUNITY')
    );
}

// ── ensurePanel ───────────────────────────────────────────────────────────────
// The ONLY place the panel message is ever sent.
// Uses channel.messages.fetch() exclusively — avoids fetchPinned/fetchPins
// which have inconsistent return types across discord.js v14 patch versions.
// Pinned messages are detected via the m.pinned property on each message object.

async function ensurePanel(client) {
    const channel = client.channels.cache.get(config.CHANNELS.PANEL);
    if (!channel) {
        console.warn('[panel] Panel channel not found — skipping.');
        return;
    }

    // ── 1. Scan last 100 messages ─────────────────────────────────────────────
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (messages) {
        // Prefer a pinned panel — edit it in place to reflect current layout
        const pinned = messages.find(m => m.pinned && isPanelMsg(m, client.user.id));
        if (pinned) {
            await pinned.edit({ embeds: [buildEmbed()], components: [buildRow()] })
                .catch(err => console.warn('[panel] Could not edit pinned panel:', err.message));
            console.log('[panel] Pinned panel updated in place.');
            return;
        }
        // Any panel in history — edit and pin it
        const existing = messages.find(m => isPanelMsg(m, client.user.id));
        if (existing) {
            await existing.edit({ embeds: [buildEmbed()], components: [buildRow()] })
                .catch(err => console.warn('[panel] Could not edit panel:', err.message));
            await existing.pin().catch(err => console.warn('[panel] Could not pin:', err.message));
            console.log('[panel] Found in history — updated and pinned.');
            return;
        }
    }

    // ── 2. Wait then re-check ─────────────────────────────────────────────────
    // Guards against two bot instances starting simultaneously.
    await new Promise(r => setTimeout(r, 3000));

    const recheck = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    if (recheck?.find(m => isPanelMsg(m, client.user.id))) {
        console.log('[panel] Panel appeared while waiting — skipping send.');
        return;
    }

    // ── 3. Send and pin ───────────────────────────────────────────────────────
    const msg = await channel.send({ embeds: [buildEmbed()], components: [buildRow()] });
    await msg.pin().catch(err => console.warn('[panel] Could not pin:', err.message));
    console.log('[panel] Panel sent and pinned.');
}

module.exports = { ensurePanel };
