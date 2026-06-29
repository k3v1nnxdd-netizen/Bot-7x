'use strict';

const {
    joinVoiceChannel,
    VoiceConnectionStatus,
    entersState,
} = require('@discordjs/voice');
const config = require('../config');

let connection = null;
let reconnectTimer = null;

function scheduleReconnect(guild) {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        joinVoice(guild);
    }, 5000);
}

function joinVoice(guild) {
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

// Called from VoiceStateUpdate — if bot was moved out, rejoin
function handleVoiceStateUpdate(oldState, newState, client) {
    if (oldState.member?.id !== client.user.id) return;
    const wasInChannel  = Boolean(oldState.channelId);
    const isInChannel   = Boolean(newState.channelId);
    const movedOut      = wasInChannel && !isInChannel;
    const movedWrong    = isInChannel && newState.channelId !== config.VOICE_CHANNEL_ID;
    if (movedOut || movedWrong) {
        console.warn('[voice] Bot removed from voice — rejoining...');
        scheduleReconnect(oldState.guild ?? newState.guild);
    }
}

module.exports = { joinVoice, handleVoiceStateUpdate };
