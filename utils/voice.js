'use strict';

const {
    joinVoiceChannel,
    VoiceConnectionStatus,
    entersState,
} = require('@discordjs/voice');
const config = require('../config');
const { safeReply } = require('./safe');

let connection = null;
let reconnectTimer = null;
// Set by leaveVoice() (i.e. an explicit /connect disconnect) — suppresses
// the auto-rejoin logic below, which exists specifically to fight
// UNwanted disconnects (kicked from the channel, network blip, etc.) and
// would otherwise undo a deliberate manual disconnect within 5 seconds.
let manuallyDisconnected = false;

function scheduleReconnect(guild) {
    if (manuallyDisconnected) return;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        joinVoice(guild);
    }, 5000);
}

function joinVoice(guild) {
    manuallyDisconnected = false;
    const channel = guild.channels.cache.get(config.VOICE_CHANNEL_ID);
    if (!channel) {
        console.warn('[voice] Voice channel not found:', config.VOICE_CHANNEL_ID);
        return;
    }

    try {
        connection = joinVoiceChannel({
            channelId:      channel.id,
            guildId:        guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf:       true,
            selfMute:       true,
        });

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                // Give Discord a few seconds to auto-reconnect
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling,  5_000),
                    entersState(connection, VoiceConnectionStatus.Connecting,   5_000),
                ]);
            } catch {
                connection.destroy();
                connection = null;
                console.warn('[voice] Disconnected — reconnecting in 5s...');
                scheduleReconnect(guild);
            }
        });

        connection.on(VoiceConnectionStatus.Ready, () => {
            console.log('[voice] Connected to voice channel.');
        });

        connection.on('error', err => {
            console.error('[voice] Connection error:', err.message);
            scheduleReconnect(guild);
        });

    } catch (err) {
        console.error('[voice] joinVoiceChannel failed:', err.message);
        scheduleReconnect(guild);
    }
}

// Tears down the connection deliberately (e.g. via /connect) — unlike a
// disconnect the bot didn't choose, this one should stick, so it flips
// manuallyDisconnected before destroying to suppress both the
// VoiceConnectionStatus.Disconnected handler above and the
// VoiceStateUpdate-driven rejoin below.
function leaveVoice() {
    manuallyDisconnected = true;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (!connection) return false;
    connection.destroy();
    connection = null;
    console.log('[voice] Disconnected manually.');
    return true;
}

function isConnected() {
    return connection !== null && connection.state.status !== VoiceConnectionStatus.Destroyed;
}

// Called from VoiceStateUpdate — if bot was moved out, rejoin
function handleVoiceStateUpdate(oldState, newState, client) {
    if (oldState.member?.id !== client.user.id) return;
    if (manuallyDisconnected) return;
    const wasInChannel  = Boolean(oldState.channelId);
    const isInChannel   = Boolean(newState.channelId);
    const movedOut      = wasInChannel && !isInChannel;
    const movedWrong    = isInChannel && newState.channelId !== config.VOICE_CHANNEL_ID;
    if (movedOut || movedWrong) {
        console.warn('[voice] Bot removed from voice — rejoining...');
        scheduleReconnect(oldState.guild ?? newState.guild);
    }
}

// /connect (owner-only) — toggles the bot in/out of config.VOICE_CHANNEL_ID.
async function handleConnect(interaction) {
    if (interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ No tienes permisos para usar este comando.', ephemeral: true });
    }

    const guild = interaction.guild;
    if (!guild) {
        return safeReply(interaction, { content: '❌ Este comando solo puede usarse dentro del servidor.', ephemeral: true });
    }

    if (isConnected()) {
        leaveVoice();
        return safeReply(interaction, { content: '🔌 Bot desconectado del canal de voz.', ephemeral: true });
    }

    joinVoice(guild);
    return safeReply(interaction, { content: `🔊 Conectando al canal de voz <#${config.VOICE_CHANNEL_ID}>...`, ephemeral: true });
}

module.exports = { joinVoice, leaveVoice, isConnected, handleVoiceStateUpdate, handleConnect };
