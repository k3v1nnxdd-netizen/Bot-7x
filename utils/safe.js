'use strict';

// Discord API error codes that mean the interaction token is gone
const GONE_CODES = new Set([
    10062, // Unknown Interaction (expired / already used)
    40060, // Interaction has already been acknowledged
    10015, // Unknown Webhook (token expired)
]);

function isGone(err) {
    if (!err) return false;
    if (GONE_CODES.has(err.code)) return true;
    const msg = err.message ?? '';
    return msg.includes('Unknown interaction') ||
           msg.includes('already been acknowledged') ||
           msg.includes('Interaction has already been acknowledged');
}

function log(method, err) {
    if (!isGone(err)) console.error(`[safe.${method}]`, err.message ?? err);
}

// Defer the reply. Returns true if succeeded, false otherwise.
async function safeDeferReply(interaction, options = {}) {
    if (interaction.replied || interaction.deferred) return false;
    try {
        await interaction.deferReply(options);
        return true;
    } catch (err) {
        log('deferReply', err);
        return false;
    }
}

// Reply or fall back to editReply when already deferred.
async function safeReply(interaction, options) {
    if (interaction.replied || interaction.deferred) {
        return safeEditReply(interaction, options);
    }
    try {
        await interaction.reply(options);
        return true;
    } catch (err) {
        log('reply', err);
        return false;
    }
}

// Edit the deferred/replied response.
async function safeEditReply(interaction, options) {
    if (!interaction.deferred && !interaction.replied) return false;
    try {
        await interaction.editReply(options);
        return true;
    } catch (err) {
        log('editReply', err);
        return false;
    }
}

// Follow-up message (requires a prior reply or defer).
async function safeFollowUp(interaction, options) {
    if (!interaction.replied && !interaction.deferred) return false;
    try {
        await interaction.followUp(options);
        return true;
    } catch (err) {
        log('followUp', err);
        return false;
    }
}

// Show a modal. Fails silently if the interaction was already acknowledged.
async function safeShowModal(interaction, modal) {
    if (interaction.replied || interaction.deferred) return false;
    try {
        await interaction.showModal(modal);
        return true;
    } catch (err) {
        log('showModal', err);
        return false;
    }
}

module.exports = { safeDeferReply, safeReply, safeEditReply, safeFollowUp, safeShowModal };
