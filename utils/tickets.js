'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const config = require('../config');

// In-memory state — rebuilt from channel topics on every startup
const ticketOwner   = new Map(); // channelId -> userId
const userTickets   = new Map(); // userId -> channelId
const confirmedPaid = new Set(); // channelId (payment already confirmed)
const paymentReview = new Set(); // channelId (user already requested payment review)
const pendingTickets = new Map(); // userId -> { token, expiresAt }

const CREATE_LOCK_MS = config.TIMEOUTS.TICKET_CREATE_LOCK_MS ?? 30_000;

function buildTopic(userId, type) {
    return config.TOPIC_PREFIX + JSON.stringify({ userId, type, ts: Date.now() });
}

function parseTopic(topic) {
    if (!topic || !topic.startsWith(config.TOPIC_PREFIX)) return null;
    try {
        return JSON.parse(topic.slice(config.TOPIC_PREFIX.length));
    } catch {
        return null;
    }
}

async function rebuildFromGuild(guild) {
    const channels = guild.channels.cache.filter(
        ch => ch.parentId === config.CATEGORIES.TICKETS &&
              ch.type === ChannelType.GuildText
    );

    for (const [, ch] of channels) {
        const data = parseTopic(ch.topic);
        if (!data?.userId) continue;
        ticketOwner.set(ch.id, data.userId);
        if (!userTickets.has(data.userId)) {
            userTickets.set(data.userId, ch.id);
        }
    }

    console.log(`[tickets] Rebuilt ${ticketOwner.size} active ticket(s) from channel topics.`);
}

function cacheChannel(channel) {
    const data = parseTopic(channel?.topic);
    if (!data?.userId) return null;

    ticketOwner.set(channel.id, data.userId);
    if (!userTickets.has(data.userId)) {
        userTickets.set(data.userId, channel.id);
    }

    return data;
}

function getTicketData(channel) {
    return cacheChannel(channel);
}

function findCachedTicketChannel(guild, userId) {
    const channels = guild.channels.cache.filter(
        ch => ch.parentId === config.CATEGORIES.TICKETS &&
              ch.type === ChannelType.GuildText
    );

    for (const [, channel] of channels) {
        const data = cacheChannel(channel);
        if (data?.userId === userId) return channel;
    }

    return null;
}

async function hasActiveTicket(guild, userId) {
    if (hasPendingTicket(userId)) return true;

    const channelId = userTickets.get(userId);
    if (!channelId) return Boolean(findCachedTicketChannel(guild, userId));

    const channel = guild.channels.cache.get(channelId)
        ?? await guild.channels.fetch(channelId).catch(() => null);

    if (!channel) {
        cleanup(channelId, userId);
        return hasPendingTicket(userId) || Boolean(findCachedTicketChannel(guild, userId));
    }

    cacheChannel(channel);
    return true;
}

function getOwner(channelOrId) {
    if (typeof channelOrId === 'object' && channelOrId !== null) {
        return cacheChannel(channelOrId)?.userId ?? ticketOwner.get(channelOrId.id) ?? null;
    }
    return ticketOwner.get(channelOrId) ?? null;
}
function getChannel(userId) { return userTickets.get(userId) ?? null; }

function getType(channel) {
    return cacheChannel(channel)?.type ?? null;
}

function isConfirmed(channelId) { return confirmedPaid.has(channelId); }
function markConfirmed(channelId) { confirmedPaid.add(channelId); }
function isPaymentReview(channelId) { return paymentReview.has(channelId); }
function markPaymentReview(channelId) { paymentReview.add(channelId); }

function hasPendingTicket(userId) {
    const pending = pendingTickets.get(userId);
    if (!pending) return false;
    if (Date.now() < pending.expiresAt) return true;
    pendingTickets.delete(userId);
    return false;
}

function reserveTicket(userId) {
    if (userTickets.has(userId) || hasPendingTicket(userId)) return null;

    const token = Symbol(userId);
    pendingTickets.set(userId, {
        token,
        expiresAt: Date.now() + CREATE_LOCK_MS,
    });

    setTimeout(() => {
        const pending = pendingTickets.get(userId);
        if (pending?.token === token && Date.now() >= pending.expiresAt) {
            pendingTickets.delete(userId);
        }
    }, CREATE_LOCK_MS + 100);

    return token;
}

function releaseReservation(userId, token) {
    const pending = pendingTickets.get(userId);
    if (pending?.token === token) pendingTickets.delete(userId);
}

function ticketExistsError(userId) {
    const err = new Error('Ya tienes un ticket abierto o en proceso de creacion.');
    err.code = 'TICKET_EXISTS';
    err.channelId = userTickets.get(userId) ?? null;
    return err;
}

async function createTicket(guild, userId, type, name) {
    if (await hasActiveTicket(guild, userId)) throw ticketExistsError(userId);

    const reservation = reserveTicket(userId);
    if (!reservation) throw ticketExistsError(userId);

    try {
        const channel = await guild.channels.create({
            name,
            type: ChannelType.GuildText,
            parent: config.CATEGORIES.TICKETS,
            topic: buildTopic(userId, type),
            permissionOverwrites: [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                { id: userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
            ],
        });

        ticketOwner.set(channel.id, userId);
        userTickets.set(userId, channel.id);
        return channel;
    } finally {
        releaseReservation(userId, reservation);
    }
}

function cleanup(channelId, userId) {
    if (channelId) {
        ticketOwner.delete(channelId);
        confirmedPaid.delete(channelId);
        paymentReview.delete(channelId);
    }

    if (userId) {
        if (!channelId || userTickets.get(userId) === channelId) {
            userTickets.delete(userId);
        }
        pendingTickets.delete(userId);
    }
}

module.exports = {
    rebuildFromGuild,
    hasActiveTicket,
    getOwner,
    getChannel,
    getType,
    isConfirmed,
    markConfirmed,
    isPaymentReview,
    markPaymentReview,
    createTicket,
    cleanup,
};
