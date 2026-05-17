'use strict';

const { EmbedBuilder } = require('discord.js');
const tickets = require('../utils/tickets');
const { isPaymentConfirmation } = require('../utils/payment');
const config = require('../config');

async function handleMessage(message) {
    if (message.author.bot) return;
    if (!message.guild)     return;

    const channelId = message.channelId;
    const ownerId   = tickets.getOwner(channelId);
    if (!ownerId)                          return;
    if (message.author.id !== ownerId)     return;

    // Only process payment confirmations inside comprar tickets
    if (tickets.getType(message.channel) !== 'comprar') return;

    // Already handled — don't fire again
    if (tickets.isConfirmed(channelId)) return;

    if (!isPaymentConfirmation(message.content)) return;

    tickets.markConfirmed(channelId);

    const embed = new EmbedBuilder()
        .setColor(0x00C853)
        .setTitle('🚀 Pago en Revisión')
        .setDescription(
            `<@${message.author.id}>, hemos recibido tu confirmación de pago.\n\n` +
            'Tu comprobante está siendo **revisado por el staff**. ' +
            'En cuanto sea verificado, recibirás tus **Robux** automáticamente.'
        )
        .addFields(
            { name: '📌 Estado',         value: '`En revisión`',       inline: true },
            { name: '⏱️ Tiempo estimado', value: '`5 - 15 minutos`',   inline: true },
            { name: '📝 Recomendación',   value: 'Mantente atento a este canal. **No cierres el ticket** hasta recibir tus Robux.', inline: false }
        )
        .setFooter({ text: '7x Community • Gracias por tu compra' })
        .setTimestamp();

    await message.channel.send({ embeds: [embed] });

    try {
        const clean = message.author.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'usuario';
        await message.channel.setName(`✅-pago-${clean}`);
    } catch (err) {
        console.error('[messages] rename failed:', err.message);
    }
}

module.exports = { handleMessage };
