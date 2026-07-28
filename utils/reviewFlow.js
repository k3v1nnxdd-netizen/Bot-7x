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
        .setColor(0xFFFF00)
        .setDescription(
            `${SHOP_EMOJI} Compra por <@${buyerId}>\n\n` +
            'Gracias por tu compra. ¿Podrías evaluar la atención y el trato del staff hacia tu ticket?\n\n' +
            'Presiona el botón de abajo y escribe un número del **1 al 5** (5 = la mejor atención).'
        )
        .setFooter({ text: '7x Community • Sistema de reseñas' });
}

function buildReviewRow(ticketChannelId, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`review_rate:${ticketChannelId}`)
            .setLabel(disabled ? 'Ya calificado' : 'Calificar atención')
            .setEmoji({ id: '1514369366878064650', name: 'star', animated: true })
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled)
    );
}

function buildAnnounceEmbed(buyerId, score) {
    const stars = score >= 5 ? STAR_EMOJI.repeat(5) : STATS_EMOJI.repeat(score);
    return new EmbedBuilder()
        .setColor(0xFFD700)
        .setDescription(
            `${SHOP_EMOJI} Compra hecha por <@${buyerId}> y valoró la atención del ticket\n\n` +
            `${stars} **(${score}/5)**`
        )
        .setFooter({ text: '7x Community • Sistema de reseñas' })
        .setTimestamp();
}

// Sends the DM-side review prompt and stores the message ref so it can be
// disabled later. Mirrors sendPurchaseDM's "never throw" style — a DM failure
// (closed DMs, etc.) must not block the rest of /pagoverified.
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

// Called once a rating is submitted (from either the DM or the ticket
// channel) — disables both prompt buttons and posts the announcement.
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

    try {
        const announceCh = await client.channels.fetch(config.CHANNELS.REVIEWS);
        await announceCh.send({ embeds: [buildAnnounceEmbed(rec.buyerId, score)] });
    } catch (err) {
        console.warn('[reviewFlow] Could not send review announcement:', err.message);
    }
}

module.exports = { buildReviewEmbed, buildReviewRow, sendReviewDM, finalizeReview };
