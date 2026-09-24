'use strict';

const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const tickets = require('./tickets');
const robuxLeaderboard = require('./robuxLeaderboard');
const robuxLeaderboardPanel = require('./robuxLeaderboardPanel');
const { panelText } = require('./panelV2');

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

// El texto del mensaje del ticket que contenga `marca`.
//
// Lee TANTO los embeds clásicos como los bloques de texto de Components V2
// (panelText hace las dos cosas), y eso no es por gusto: los resúmenes de
// ticket pasaron a ser contenedores V2 para poder llevar sus botones dentro,
// pero los tickets que ya estaban abiertos siguen teniendo el embed de antes.
// Buscar sólo en `embeds[0].description` habría dejado de registrar sus compras
// —y de contarlas en el ranking— sin que nada fallara.
function textoDelTicket(messages, marca) {
    for (const m of messages.values()) {
        const texto = panelText(m);
        if (texto.includes(marca)) return texto;
    }
    return '';
}

// Saca los datos del pedido del mensaje que cada flujo ya envió al abrir el
// ticket — el único sitio donde existen (no se guarda nada). Para los tickets
// de 'comprar' devuelve además robuxAmount/priceMxn ya en número, que es lo que
// alimenta el ranking de compradores.
async function extractOrderFields(channel, ticketType) {
    try {
        const messages = await channel.messages.fetch({ limit: 100 });

        if (ticketType === 'comprar') {
            const desc = textoDelTicket(messages, 'Robux a recibir');
            const robloxUser = desc.match(/Usuario de Roblox\*\*\n```([^`]+)```/)?.[1] ?? 'No disponible';
            const robux = desc.match(/Robux a recibir\*\*\n```([^`]+)```/)?.[1] ?? 'No disponible';
            const price = desc.match(/Precio final a pagar\*\*\n```\$([^`]+) MXN```/)?.[1]
                       ?? desc.match(/Precio a pagar\*\*\n```\$([^`]+) MXN```/)?.[1]
                       ?? null;
            return {
                fields: [
                    { name: 'Usuario de Roblox', value: robloxUser },
                    { name: 'Robux comprados',   value: robux },
                    { name: 'Precio',            value: price ? `$${price} MXN` : 'No disponible' },
                ],
                robuxAmount: parseInt(robux.replace(/[^\d]/g, ''), 10) || null,
                priceMxn:    price ? parseFloat(price.replace(/[^\d.]/g, '')) : null,
            };
        }

        if (ticketType === 'duels') {
            const desc = textoDelTicket(messages, 'Set solicitado');
            const set = desc.match(/Set solicitado\*\*\n```([^`]+)```/)?.[1] ?? 'No disponible';
            const robloxUser = desc.match(/Usuario de Roblox\*\*\n```([^`]+)```/)?.[1] ?? 'No disponible';
            return {
                fields: [
                    { name: 'Usuario de Roblox', value: robloxUser },
                    { name: 'Set solicitado',    value: set },
                ],
            };
        }

        if (ticketType === 'seguidores') {
            const desc = textoDelTicket(messages, 'Resumen de tu pedido');
            const platform = desc.match(/Plataforma\*\*\n```([^`]+)```/)?.[1] ?? null;
            const qty      = desc.match(/Seguidores solicitados\*\*\n```([^`]+)```/)?.[1] ?? 'No disponible';
            const price    = desc.match(/Precio a pagar\*\*\n```\$([^`]+) MXN```/)?.[1] ?? null;
            const fields = [{ name: 'Seguidores', value: qty }];
            if (platform) fields.unshift({ name: 'Plataforma', value: platform });
            fields.push({ name: 'Precio', value: price ? `$${price} MXN` : 'No disponible' });
            return { fields };
        }

        if (ticketType === 'soporte') {
            const desc = textoDelTicket(messages, 'Motivo');
            const motivo = desc.match(/Motivo\*\*\n```([^`]+)```/)?.[1] ?? 'No disponible';
            return { fields: [{ name: 'Motivo', value: motivo }] };
        }

        return { fields: [] };
    } catch {
        return { fields: [] };
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
    const [{ fields, robuxAmount, priceMxn }, comprobante] = await Promise.all([
        extractOrderFields(channel, ticketType),
        findComprobante(channel, buyerId),
    ]);

    const embed = new EmbedBuilder()
        .setColor(0x2B2D31)
        .setTitle('Pedido completado')
        .setDescription(
            `<:member:1501261625523699892> **Cliente**\n<@${buyerId}>\n\n` +
            `<:point:1501212595464700104> **Tipo de ticket**\n\`${TYPE_LABELS[ticketType] ?? 'Desconocido'}\`` +
            fields.map(f => `\n\n**${f.name}**\n\`${f.value}\``).join('')
        )
        .setFooter({ text: '7x Community • Registro de pedidos' })
        .setTimestamp();

    if (comprobante) embed.setImage(comprobante.url);

    const logMsg = await logChannel.send({ embeds: [embed] }).catch(err => {
        console.warn('[orderNotify] Could not send order summary:', err.message);
        return null;
    });

    // The log message's own id doubles as this order's unique id — the
    // same id robuxLeaderboardBackfill.js reads back when replaying this
    // same channel, so an order is never double-counted whether it's
    // recorded here in real time or reconciled later from history.
    if (ticketType === 'comprar' && robuxAmount && logMsg) {
        const isNew = robuxLeaderboard.recordPurchase(buyerId, robuxAmount, priceMxn, logMsg.id);
        if (isNew) {
            await robuxLeaderboardPanel.updateLeaderboardMessage(client);
            await robuxLeaderboardPanel.syncRobuxRoles(client, buyerId);
        }
    }
}

module.exports = { sendOrderCompletionSummary };
