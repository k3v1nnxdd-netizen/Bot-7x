'use strict';

const fs = require('fs');
const { EmbedBuilder } = require('discord.js');
const tickets = require('../utils/tickets');
const { isPaymentConfirmation } = require('../utils/payment');
const { isLocked, lock } = require('../utils/spam');
const config = require('../config');

const PENDING_PATH   = './pending.gif';
const PENDING_NAME   = 'pending.gif';
const PENDING_EXISTS = fs.existsSync(PENDING_PATH);

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

    // ── Borra cualquier mensaje que mencione el rol prohibido ─────────────────
    if (message.mentions.roles.has(config.ROLES.NO_PING)) {
        await message.delete().catch(() => {});
        return;
    }

    // ── Anti-spam: elimina mensajes con 3+ imágenes (excepto tickets y referencias) ──
    const isTicket  = Boolean(tickets.getOwner(message.channel));
    const isExempt  = message.channelId === config.CHANNELS.REFERENCIAS;
    if (!isTicket && !isExempt) {
        const imageCount = message.attachments.filter(a => a.contentType?.startsWith('image/')).size;
        if (imageCount >= 3) {
            await message.delete().catch(() => {});
            const warn = await message.channel.send({
                content: `<@${message.author.id}> No puedes enviar 3 o más imágenes a la vez. Por favor envíalas de una en una.`,
            }).catch(() => null);
            if (warn) setTimeout(() => warn.delete().catch(() => {}), 6000);
            return;
        }
    }

    // Auto-react in referencias channel
    if (message.channelId === config.CHANNELS.REFERENCIAS) {
        await message.react('<:perfect:1501214987190927432>').catch(() => {});
        await message.react('<a:leggit:1510180431738179654>').catch(() => {});
    }

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
        .setThumbnail(PENDING_EXISTS ? `attachment://${PENDING_NAME}` : null)
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

    const sendPayload = {
        embeds: [embed],
        ...(PENDING_EXISTS && { files: [{ attachment: PENDING_PATH, name: PENDING_NAME }] }),
    };
    await message.channel.send(sendPayload);

    await renameChannel(message.channel, ['⚠-pago-revision', 'pago-revision']);
}

module.exports = { handleMessage };
