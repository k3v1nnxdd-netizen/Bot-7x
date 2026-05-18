'use strict';

const { EmbedBuilder } = require('discord.js');
const tickets = require('../utils/tickets');
const { isPaymentConfirmation } = require('../utils/payment');
const { isLocked, lock } = require('../utils/spam');

async function renameChannel(channel, names) {
    for (const name of names) {
        try {
            await channel.setName(name);
            return true;
        } catch (err) {
            console.error(`[messages] rename to "${name}" failed:`, err.message);
        }
    }
    return false;
}

async function handleMessage(message) {
    if (message.author.bot) return;
    if (!message.guild) return;

    const channelId = message.channelId;
    const ownerId = tickets.getOwner(message.channel);
    if (!ownerId) return;
    if (message.author.id !== ownerId) return;
    if (tickets.getType(message.channel) !== 'comprar') return;
    if (tickets.isConfirmed(channelId)) return;

    // Lock check first — short-circuits before any expensive operations
    if (isLocked(`review:${channelId}`)) return;

    // Persistent state: channel name survives bot restarts
    if ((message.channel.name ?? '').includes('revision')) return;

    // In-memory state (fast, cleared on restart — covered by lock + name check)
    if (tickets.isPaymentReview(channelId)) return;

    // Only trigger on the "pago exitoso" keyword
    if (!isPaymentConfirmation(message.content)) return;

    // Claim the lock and mark state BEFORE any async work.
    // If send/rename fail, the lock still prevents a duplicate for 30 seconds,
    // and the name check prevents duplicates after restart once renamed.
    lock(`review:${channelId}`, 30_000);
    tickets.markPaymentReview(channelId);

    const embed = new EmbedBuilder()
        .setColor(0xF59E0B)
        .setTitle('Pago pendiente de revision')
        .setDescription(
            `<@${ownerId}>, recibimos tu aviso de **pago exitoso**.\n\n` +
            'El comprobante queda pendiente de revision por parte del staff. ' +
            'Cuando el pago sea validado, se confirmara desde el boton de owner y se enviara la confirmacion final.'
        )
        .addFields(
            { name: 'Estado',         value: '`Pendiente de revision`',       inline: true },
            { name: 'Siguiente paso', value: '`Espera la validacion del staff`', inline: true }
        )
        .setFooter({ text: '7x Community - Revision de pago' })
        .setTimestamp();

    await message.channel.send({ embeds: [embed] });

    await renameChannel(message.channel, ['⚠-pago-revision', 'pago-revision']);
}

module.exports = { handleMessage };
