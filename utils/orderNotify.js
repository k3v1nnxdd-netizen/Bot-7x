'use strict';

const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const tickets = require('./tickets');

const TYPE_LABELS = {
    comprar:    'Compra de Robux',
    duels:      'Duels',
    seguidores: 'Seguidores',
    soporte:    'Soporte / Otra cosa',
};

// Most recent image attachment sent by the buyer in the ticket — the
// payment receipt. Only ever forwarded to the order log channel, never DM'd.
async function findComprobante(channel, buyerId) {
    try {
        const messages = await channel.messages.fetch({ limit: 100 });
        const withImage = messages
            .filter(m => m.author.id === buyerId && m.attachments.some(a => a.contentType?.startsWith('image/')))
            .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
            .first();
        return withImage?.attachments.find(a => a.contentType?.startsWith('image/')) ?? null;
    } catch {
        return null;
    }
}

// Scrapes the order-specific embed each flow already sent when the ticket
// was created — the only place these details exist (nothing is persisted).
async function extractOrderFields(channel, ticketType) {
    try {
        const messages = await channel.messages.fetch({ limit: 100 });

        if (ticketType === 'comprar') {
            const desc = messages.find(m => m.embeds[0]?.description?.includes('Robux a recibir'))?.embeds[0]?.description ?? '';
            const robux = desc.match(/Robux a recibir\*\*\n```([^`]+)```/)?.[1] ?? 'No disponible';
            const price = desc.match(/Precio final a pagar\*\*\n```\$([^`]+) MXN```/)?.[1]
                       ?? desc.match(/Precio a pagar\*\*\n```\$([^`]+) MXN```/)?.[1]
                       ?? null;
            return [
                { name: 'Robux comprados', value: robux },
                { name: 'Precio',          value: price ? `$${price} MXN` : 'No disponible' },
            ];
        }

        if (ticketType === 'duels') {
            const desc = messages.find(m => m.embeds[0]?.description?.includes('Set solicitado'))?.embeds[0]?.description ?? '';
            const set = desc.match(/Set solicitado\*\*\n```([^`]+)```/)?.[1] ?? 'No disponible';
            return [{ name: 'Set solicitado', value: set }];
        }

        if (ticketType === 'seguidores') {
            const desc = messages.find(m => m.embeds[0]?.title === 'Resumen de tu pedido')?.embeds[0]?.description ?? '';
            const platform = desc.match(/Plataforma\*\*\n```([^`]+)```/)?.[1] ?? null;
            const qty      = desc.match(/Seguidores solicitados\*\*\n```([^`]+)```/)?.[1] ?? 'No disponible';
            const price    = desc.match(/Precio a pagar\*\*\n```\$([^`]+) MXN```/)?.[1] ?? null;
            const fields = [{ name: 'Seguidores', value: qty }];
            if (platform) fields.unshift({ name: 'Plataforma', value: platform });
            fields.push({ name: 'Precio', value: price ? `$${price} MXN` : 'No disponible' });
            return fields;
        }

        if (ticketType === 'soporte') {
            const desc = messages.find(m => m.embeds[0]?.description?.includes('Motivo'))?.embeds[0]?.description ?? '';
            const motivo = desc.match(/Motivo\*\*\n```([^`]+)```/)?.[1] ?? 'No disponible';
            return [{ name: 'Motivo', value: motivo }];
        }

        return [];
    } catch {
        return [];
    }
}

// Posts a detailed completion record to the order log channel once a
// purchase/ticket is confirmed — called from both the "confirmar_pago"
// button (Robux tickets only) and /pagoverified (any ticket type).
async function sendOrderCompletionSummary(client, channel, buyerId) {
    const logChannel = client.channels.cache.get(config.CHANNELS.ORDER_LOG)
        ?? await client.channels.fetch(config.CHANNELS.ORDER_LOG).catch(() => null);
    if (!logChannel) {
        console.warn('[orderNotify] Order log channel not found.');
        return;
    }

    const ticketType = tickets.getType(channel);
    const [fields, comprobante] = await Promise.all([
        extractOrderFields(channel, ticketType),
        findComprobante(channel, buyerId),
    ]);

    const embed = new EmbedBuilder()
        .setColor(0x000000)
        .setTitle('<:true:1501213776878501899> Pedido completado')
        .setDescription(
            `<:member:1501261625523699892> **Cliente**\n<@${buyerId}>\n\n` +
            `<:point:1501212595464700104> **Tipo de ticket**\n\`${TYPE_LABELS[ticketType] ?? 'Desconocido'}\`` +
            fields.map(f => `\n\n**${f.name}**\n\`${f.value}\``).join('')
        )
        .setFooter({ text: '7x Community • Registro de pedidos' })
        .setTimestamp();

    if (comprobante) embed.setImage(comprobante.url);

    await logChannel.send({ embeds: [embed] }).catch(err =>
        console.warn('[orderNotify] Could not send order summary:', err.message)
    );
}

module.exports = { sendOrderCompletionSummary };
