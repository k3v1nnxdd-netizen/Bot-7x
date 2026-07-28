'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const reviews = require('./reviews');
const { safeMessageEdit } = require('./safe');

const SHOP_EMOJI  = '<a:shop:1190502129748676650>';
const STAR_EMOJI  = '<a:star:1514369366878064650>';
const STATS_EMOJI = '<:stats:1190502686886481991>';

function buildReviewEmbed(buyerId) {
    return new EmbedBuilder()
        .setColor(0x2B2D31)
        .setDescription(
            `${SHOP_EMOJI} Compra por <@${buyerId}>\n\n` +
            'Gracias por tu compra. ¿Podrías evaluar la atención y el trato del staff hacia tu ticket?\n\n' +
            '• Presiona el botón de abajo y escribe un número del **1 al 5** (5 = la mejor atención).'
        )
        .setFooter({ text: '7x Community • Sistema de reseñas' });
}

function buildReviewRow(ticketChannelId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`review_rate:${ticketChannelId}`)
            .setLabel(disabled ? 'Ya calificado' : 'Calificar atención')
            .setEmoji({ id: '1514369366878064650', name: 'star', animated: true })
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled)
    );
}

// score === null → still-pending placeholder ("Reseña: ???"), shown the
// moment a purchase is confirmed. Edited in place once the buyer rates.
function buildAnnounceEmbed(buyerId, score = null) {
    const value = score === null
        ? '???'
        : `${score >= 5 ? STAR_EMOJI.repeat(5) : STATS_EMOJI.repeat(score)} **(${score}/5)**`;

    return new EmbedBuilder()
        .setColor(0x2B2D31) // reviews channel is always gray, pending or rated
        .setDescription(
            // No bullet on the "Reseña" line — a "•" right next to the
            // repeated star/stats emojis breaks the line rendering.
            `${SHOP_EMOJI} • Compra hecha por <@${buyerId}>\n\n` +
            `**Reseña:** ${value}`
        )
        .setFooter({ text: '7x Community • Sistema de reseñas' })
        .setTimestamp();
}

// Sends the DM-side review prompt and stores the message ref so it can be
// disabled later. Mirrors sendPurchaseDM's "never throw" style — a DM failure
// (closed DMs, etc.) must not block the rest of the purchase flow.
async function sendReviewDM(client, buyerId, ticketChannelId) {
    try {
        const user = await client.users.fetch(buyerId);
        const msg  = await user.send({
            embeds: [buildReviewEmbed(buyerId)],
            components: [buildReviewRow(ticketChannelId)],
        });
        reviews.setDmMessageRef(ticketChannelId, msg.channelId, msg.id);
    } catch (err) {
        console.warn('[reviewFlow] Could not DM review request:', err.message);
    }
}

async function sendPendingAnnouncement(client, ticketChannelId, buyerId) {
    try {
        const ch  = await client.channels.fetch(config.CHANNELS.REVIEWS);
        const msg = await ch.send({ embeds: [buildAnnounceEmbed(buyerId, null)] });
        reviews.setAnnounceMessageRef(ticketChannelId, msg.channelId, msg.id);
    } catch (err) {
        console.warn('[reviewFlow] Could not send pending review announcement:', err.message);
    }
}

// Single entry point for kicking off a review request — called both from the
// "PAGO REALIZADO" ticket button and from /pagoverified. Idempotent: a
// second call for the same ticket (either trigger firing twice) is a no-op.
async function requestReview(client, channel, ticketChannelId, buyerId) {
    if (reviews.getReview(ticketChannelId)) return;
    reviews.createReviewRequest(ticketChannelId, buyerId);

    try {
        const ticketMsg = await channel.send({
            embeds: [buildReviewEmbed(buyerId)],
            components: [buildReviewRow(ticketChannelId)],
        });
        reviews.setTicketMessageRef(ticketChannelId, ticketMsg.channelId, ticketMsg.id);
    } catch (err) {
        console.warn('[reviewFlow] Could not send ticket review prompt:', err.message);
    }

    await sendReviewDM(client, buyerId, ticketChannelId);
    await sendPendingAnnouncement(client, ticketChannelId, buyerId);
}

// Called once a rating is submitted (from either the DM or the ticket
// channel) — disables both prompt buttons and edits the pending
// announcement in place to show the real score.
async function finalizeReview(client, ticketChannelId, score) {
    const rec = reviews.getReview(ticketChannelId);
    if (!rec) return;

    if (rec.ticketMessageRef) {
        try {
            const ch  = await client.channels.fetch(rec.ticketMessageRef.channelId);
            const msg = await ch.messages.fetch(rec.ticketMessageRef.messageId);
            await safeMessageEdit(msg, { components: [buildReviewRow(ticketChannelId, true)] });
        } catch (err) {
            console.warn('[reviewFlow] Could not disable ticket review button:', err.message);
        }
    }

    if (rec.dmMessageRef) {
        try {
            const user = await client.users.fetch(rec.buyerId);
            const dm   = await user.createDM();
            const msg  = await dm.messages.fetch(rec.dmMessageRef.messageId);
            await safeMessageEdit(msg, { components: [buildReviewRow(ticketChannelId, true)] });
        } catch (err) {
            console.warn('[reviewFlow] Could not disable DM review button:', err.message);
        }
    }

    const embed = buildAnnounceEmbed(rec.buyerId, score);
    if (rec.announceMessageRef) {
        try {
            const ch  = await client.channels.fetch(rec.announceMessageRef.channelId);
            const msg = await ch.messages.fetch(rec.announceMessageRef.messageId);
            await safeMessageEdit(msg, { embeds: [embed] });
            return;
        } catch (err) {
            console.warn('[reviewFlow] Could not edit review announcement, sending new one:', err.message);
        }
    }

    // Fallback — no ref was ever stored (e.g. the pending send failed), so
    // there's nothing to edit; post it now rather than losing the rating.
    try {
        const announceCh = await client.channels.fetch(config.CHANNELS.REVIEWS);
        await announceCh.send({ embeds: [embed] });
    } catch (err) {
        console.warn('[reviewFlow] Could not send review announcement:', err.message);
    }
}

module.exports = { buildReviewEmbed, buildReviewRow, requestReview, finalizeReview };
