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

// Send the panel only if no valid bot panel already exists in the channel.
async function ensurePanel(client) {
    const channel = client.channels.cache.get(config.CHANNELS.PANEL);
    if (!channel) {
        console.warn('[panel] Panel channel not found.');
        return;
    }

    const messages = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    if (messages) {
        const existing = messages.find(m =>
            m.author.id === client.user.id &&
            m.embeds.length > 0 &&
            m.components.length > 0
        );
        if (existing) {
            console.log('[panel] Panel already exists — skipping send.');
            return;
        }
    }

    await channel.send({ embeds: [buildEmbed()], components: [buildRow()] });
    console.log('[panel] Panel sent.');
}

module.exports = { ensurePanel };
