'use strict';

const { MessageFlags } = require('discord.js');

// ── Discord "interaction is gone" error codes ─────────────────────────────────
// These are expected in production and must be handled silently.
const GONE_CODES = new Set([
    10062, // Unknown interaction  (token expired after 3 s without a response)
    40060, // Interaction has already been acknowledged
    10015, // Unknown webhook
    10008, // Unknown Message — e.g. a tracked message was deleted
]);

function isGone(err) {
    if (!err) return false;
    if (GONE_CODES.has(err.code)) return true;
    const msg = err.message ?? '';
    return (
        msg.includes('Unknown interaction') ||
        msg.includes('already been acknowledged') ||
        msg.includes('Interaction has already been acknowledged')
    );
}

function log(method, err) {
    // Never log expected Discord lifecycle errors — they would spam the console.
    if (!isGone(err)) console.error(`[safe.${method}]`, err);
}

// Convert deprecated { ephemeral: true } to MessageFlags.Ephemeral
function fixFlags(options) {
    if (!options || typeof options !== 'object' || !('ephemeral' in options)) return options;
    const { ephemeral, flags = 0, ...rest } = options;
    return ephemeral ? { ...rest, flags: flags | MessageFlags.Ephemeral } : { ...rest, flags };
}

// ── safe wrappers ─────────────────────────────────────────────────────────────
// Every wrapper returns false (never throws) so callers can use early-return
// patterns without try/catch boilerplate.

async function safeDeferReply(interaction, options = {}) {
    try {
        if (!interaction || interaction.replied || interaction.deferred) return false;
        await interaction.deferReply(fixFlags(options));
        return true;
    } catch (err) {
        if (isGone(err)) return false;
        log('deferReply', err);
        return false;
    }
}

async function safeReply(interaction, options) {
    try {
        if (!interaction) return false;
        // If already responded, fall back to editing the existing response
        if (interaction.replied || interaction.deferred) return await safeEditReply(interaction, options);
        await interaction.reply(fixFlags(options));
        return true;
    } catch (err) {
        if (isGone(err)) return false;
        log('reply', err);
        return false;
    }
}

async function safeEditReply(interaction, options) {
    try {
        if (!interaction || (!interaction.replied && !interaction.deferred)) return false;
        await interaction.editReply(fixFlags(options));
        return true;
    } catch (err) {
        if (isGone(err)) return false;
        log('editReply', err);
        return false;
    }
}

async function safeFollowUp(interaction, options) {
    try {
        if (!interaction || (!interaction.replied && !interaction.deferred)) return false;
        await interaction.followUp(fixFlags(options));
        return true;
    } catch (err) {
        if (isGone(err)) return false;
        log('followUp', err);
        return false;
    }
}

// safeShowModal is the ONLY place showModal() is ever called.
// It ALWAYS checks replied/deferred first — if either is true, it does nothing.
async function safeShowModal(interaction, modal) {
    try {
        if (!interaction || interaction.replied || interaction.deferred) return false;
        await interaction.showModal(modal);
        return true;
    } catch (err) {
        if (isGone(err)) return false;
        log('showModal', err);
        return false;
    }
}

// Edits a plain Message (not an interaction reply) — same "never throw"
// convention as the interaction wrappers above. Used by long-running
// features that send once and periodically edit in place (e.g.
// /groupmembers' live progress embed).
async function safeMessageEdit(message, options) {
    try {
        if (!message) return false;
        await message.edit(options);
        return true;
    } catch (err) {
        if (isGone(err)) return false;
        log('messageEdit', err);
        return false;
    }
}

module.exports = {
    isGone,          // exported so handlers can filter their own error catches
    safeDeferReply,
    safeReply,
    safeEditReply,
    safeFollowUp,
    safeShowModal,
    safeMessageEdit,
};
