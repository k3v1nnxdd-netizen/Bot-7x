'use strict';

const fs = require('fs');
const { EmbedBuilder } = require('discord.js');
const tickets = require('../utils/tickets');
const { isPaymentConfirmation, isPagoRealizado } = require('../utils/payment');
const { isLocked, lock } = require('../utils/spam');
const config = require('../config');

const PENDING_PATH   = './pending.gif';
const PENDING_NAME   = 'pending.gif';
const PENDING_EXISTS = fs.existsSync(PENDING_PATH);

function buildNoMediaEmbed(userId) {
    return new EmbedBuilder()
        .setColor(0x2B2D31)
        .setTitle('📷 Imagen o video requerido')
        .setDescription(
            `Hola <@${userId}>, este canal está destinado exclusivamente a referencias. ` +
            'No es posible publicar un mensaje sin una imagen o video adjunto.\n\n' +
            'Por favor, vuelve a enviar tu mensaje incluyendo una imagen o video.'
        )
        .setFooter({ text: '7x Community • Referencias' })
        .setTimestamp();
}

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

    // Referencias channel: every message must include at least one image or video
    if (message.channelId === config.CHANNELS.REFERENCIAS) {
        const hasMedia = message.attachments.some(
            a => a.contentType?.startsWith('image/') || a.contentType?.startsWith('video/')
        );
        if (!hasMedia) {
            await message.delete().catch(() => {});
            const warn = await message.channel.send({ embeds: [buildNoMediaEmbed(message.author.id)] }).catch(() => null);
            if (warn) setTimeout(() => warn.delete().catch(() => {}), 8000);
            return;
        }
        await message.react('<:perfect:1501214987190927432>').catch(() => {});
        await message.react('<a:leggit:1510180431738179654>').catch(() => {});
    }

    const channelId  = message.channelId;
    const ownerId    = tickets.getOwner(message.channel);
    if (!ownerId) return;
    if (message.author.id !== ownerId) return;

    const ticketType = tickets.getType(message.channel);
    if (ticketType !== 'comprar' && ticketType !== 'seguidores') return;
    if (tickets.isConfirmed(channelId)) return;

    // Lock check first — short-circuits before any expensive operations
    if (isLocked(`review:${channelId}`)) return;

    // Persistent state: channel name survives bot restarts
    const channelName = message.channel.name ?? '';
    if (channelName.includes('revision') || channelName.includes('pendiente')) return;

    // In-memory state (fast, cleared on restart — covered by lock + name check)
    if (tickets.isPaymentReview(channelId)) return;

    if (ticketType === 'comprar') {
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
        return;
    }

    // ticketType === 'seguidores'
    // Only trigger on the "pago realizado" keyword
    if (!isPagoRealizado(message.content)) return;

    lock(`review:${channelId}`, 30_000);
    tickets.markPaymentReview(channelId);

    const embed = new EmbedBuilder()
        .setColor(0xF59E0B)
        .setTitle('Pago pendiente de revision')
        .setThumbnail(PENDING_EXISTS ? `attachment://${PENDING_NAME}` : null)
        .setDescription(
            `<@${ownerId}>, recibimos tu aviso de **pago realizado**.\n\n` +
            'Tu comprobante queda pendiente de revision por parte del staff. ' +
            'Te notificaremos en cuanto sea validado.'
        )
        .addFields(
            { name: 'Estado',         value: '`Pendiente de revision`',         inline: true },
            { name: 'Siguiente paso', value: '`Espera la validacion del staff`', inline: true }
        )
        .setFooter({ text: '7x Community - Revision de pago' })
        .setTimestamp();

    const sendPayload = {
        embeds: [embed],
        ...(PENDING_EXISTS && { files: [{ attachment: PENDING_PATH, name: PENDING_NAME }] }),
    };
    await message.channel.send(sendPayload);

    const numMatch  = (message.channel.name ?? '').match(/(\d{4})/);
    const num       = numMatch ? numMatch[1] : '0000';
    const cleanName = (message.author.username ?? 'user').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
    await renameChannel(message.channel, [`seg-pendiente-${num}-${cleanName}`, 'seg-pendiente']);
}

module.exports = { handleMessage };
