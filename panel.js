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
            '<:point:1501212595464700104>  **Precios** - Ver lista de precios disponibles\n' +
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
            .setCustomId('precios')
            .setLabel('Precios')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('<:money:1501213606077792266>'),
        new ButtonBuilder()
            .setCustomId('otra_cosa')
            .setLabel('Otra cosa')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('<:up:1501217620437897227>')
    );
}

// Returns true if a message is the panel (bot author + embed with the panel title + buttons)
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
// No button, modal, or handler calls this function.
//
// Detection order:
//   1. Pinned messages  — survives unlimited channel activity
//   2. Last 100 messages — fallback for unpinned panels
//   3. Send + pin       — only when truly absent
//
// A short wait + re-check before step 3 reduces (but cannot eliminate)
// the race condition when two bot instances start simultaneously.

async function ensurePanel(client) {
    const channel = client.channels.cache.get(config.CHANNELS.PANEL);
    if (!channel) {
        console.warn('[panel] Panel channel not found — skipping.');
        return;
    }

    // ── 1. Check pinned messages ──────────────────────────────────────────────
    const pins = await channel.messages.fetchPinned().catch(() => null);
    if (pins) {
        const pinned = pins.find(m => isPanelMsg(m, client.user.id));
        if (pinned) {
            console.log('[panel] Found in pins — nothing to do.');
            return;
        }
    }

    // ── 2. Scan last 100 messages ─────────────────────────────────────────────
    const recent = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (recent) {
        const existing = recent.find(m => isPanelMsg(m, client.user.id));
        if (existing) {
            console.log('[panel] Found in history — pinning.');
            await existing.pin().catch(err => console.warn('[panel] Could not pin:', err.message));
            return;
        }
    }

    // ── 3. Wait then re-check before sending ──────────────────────────────────
    // If two instances start at almost the same time, one will send the panel
    // and pin it while the other is waiting here. The re-check below catches that.
    await new Promise(r => setTimeout(r, 3000));

    const recheckPins = await channel.messages.fetchPinned().catch(() => null);
    if (recheckPins?.find(m => isPanelMsg(m, client.user.id))) {
        console.log('[panel] Panel appeared while waiting (concurrent instance) — skipping send.');
        return;
    }
    const recheckRecent = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    if (recheckRecent?.find(m => isPanelMsg(m, client.user.id))) {
        console.log('[panel] Panel appeared while waiting — skipping send.');
        return;
    }

    // ── 4. Send and pin ───────────────────────────────────────────────────────
    const msg = await channel.send({ embeds: [buildEmbed()], components: [buildRow()] });
    await msg.pin().catch(err => console.warn('[panel] Could not pin:', err.message));
    console.log('[panel] Panel sent and pinned.');
}

module.exports = { ensurePanel };
