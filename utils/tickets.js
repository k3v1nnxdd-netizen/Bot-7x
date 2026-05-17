'use strict';

const { ChannelType, PermissionFlagsBits } = require('discord.js');
const config = require('../config');

// In-memory state — rebuilt from channel topics on every startup
const ticketOwner   = new Map(); // channelId  -> userId
const userTickets   = new Map(); // userId     -> channelId
const confirmedPaid = new Set(); // channelId  (payment already confirmed)

// ── Topic helpers ─────────────────────────────────────────────────────────────

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

// ── Startup rebuild ───────────────────────────────────────────────────────────

async function rebuildFromGuild(guild) {
    const channels = guild.channels.cache.filter(
        ch => ch.parentId === config.CATEGORIES.TICKETS &&
              ch.type     === ChannelType.GuildText
    );

    for (const [, ch] of channels) {
        const data = parseTopic(ch.topic);
        if (!data?.userId) continue;
        ticketOwner.set(ch.id, data.userId);
        userTickets.set(data.userId, ch.id);
    }

    console.log(`[tickets] Rebuilt ${ticketOwner.size} active ticket(s) from channel topics.`);
}

// ── Queries ───────────────────────────────────────────────────────────────────

async function hasActiveTicket(guild, userId) {
    if (!userTickets.has(userId)) return false;
    const channelId = userTickets.get(userId);

    const channel = guild.channels.cache.get(channelId)
        ?? await guild.channels.fetch(channelId).catch(() => null);

    if (!channel) {
        cleanup(channelId, userId);
        return false;
    }
    return true;
}

function getOwner(channelId)  { return ticketOwner.get(channelId) ?? null; }
function getChannel(userId)   { return userTickets.get(userId)    ?? null; }

function getType(channel) {
    return parseTopic(channel?.topic)?.type ?? null;
}

function isConfirmed(channelId) { return confirmedPaid.has(channelId); }
function markConfirmed(channelId) { confirmedPaid.add(channelId); }

// ── Mutations ─────────────────────────────────────────────────────────────────

async function createTicket(guild, userId, type, name) {
    const channel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: config.CATEGORIES.TICKETS,
        topic: buildTopic(userId, type),
        permissionOverwrites: [
            { id: guild.id,  deny:  [PermissionFlagsBits.ViewChannel] },
            { id: userId,    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ],
    });

    ticketOwner.set(channel.id, userId);
    userTickets.set(userId, channel.id);
    return channel;
}

function cleanup(channelId, userId) {
    if (channelId) {
        ticketOwner.delete(channelId);
        confirmedPaid.delete(channelId);
    }
    if (userId) userTickets.delete(userId);
}

module.exports = {
    rebuildFromGuild,
    hasActiveTicket,
    getOwner,
    getChannel,
    getType,
    isConfirmed,
    markConfirmed,
    createTicket,
    cleanup,
};
