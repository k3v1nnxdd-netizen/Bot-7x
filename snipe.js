'use strict';

const { EmbedBuilder } = require('discord.js');
const config = require('./config');
const roblox = require('./roblox');
const { safeReply } = require('./utils/safe');

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS  = '0123456789';

const CHECK_DELAY_MS = 350;
const MAX_BACKOFF_MS = 30_000;

let activeSession = null;

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Interruptible sleep — resolves early as soon as the session is stopped,
// so /stopsnipe doesn't have to wait out a long backoff.
function sleep(ms, session) {
    return new Promise(resolve => {
        const start = Date.now();
        (function tick() {
            if (session.stopped || Date.now() - start >= ms) return resolve();
            setTimeout(tick, Math.min(50, ms));
        })();
    });
}

function generateUsername({ maxCharacters, allowUnderscores, allowNumbers }) {
    const length = randomInt(3, maxCharacters);
    const pool = allowNumbers ? LETTERS + DIGITS : LETTERS;

    const chars = [LETTERS[randomInt(0, LETTERS.length - 1)]];
    for (let i = 1; i < length; i++) {
        chars.push(pool[randomInt(0, pool.length - 1)]);
    }

    if (allowUnderscores && length >= 3 && Math.random() < 0.35) {
        chars[randomInt(1, length - 2)] = '_';
    }

    return chars.join('');
}

function generateUniqueUsername(session) {
    for (let i = 0; i < 100; i++) {
        const name = generateUsername(session.options);
        if (!session.seen.has(name)) {
            session.seen.add(name);
            return name;
        }
    }
    // Astronomically unlikely fallback to guarantee no repeats in-session.
    let name;
    do { name = generateUsername(session.options) + LETTERS[randomInt(0, LETTERS.length - 1)]; }
    while (session.seen.has(name));
    session.seen.add(name);
    return name;
}

function buildResultEmbed(username) {
    return new EmbedBuilder()
        .setColor(0x2ECC71)
        .addFields(
            { name: 'Username', value: username, inline: true },
            { name: 'Estado',   value: '🟢 Disponible', inline: true },
        );
}

async function sendResult(client, username) {
    try {
        const channel = await client.channels.fetch(config.CHANNELS.SNIPE_RESULTS);
        await channel.send({ embeds: [buildResultEmbed(username)] });
    } catch (err) {
        console.warn('[snipe] Could not send result embed:', err.message);
    }
}

async function runLoop(client, session) {
    let consecutiveErrors = 0;

    while (!session.stopped) {
        const username = generateUniqueUsername(session);

        try {
            const available = await roblox.checkUsernameAvailable(username);
            consecutiveErrors = 0;

            if (available) {
                await sendResult(client, username);
            }
        } catch (err) {
            consecutiveErrors++;
            const status = err?.response?.status;
            const retryAfter = Number(err?.response?.headers?.['retry-after']);
            const backoff = status === 429 && Number.isFinite(retryAfter)
                ? retryAfter * 1000
                : Math.min(1500 * consecutiveErrors, MAX_BACKOFF_MS);

            console.warn(`[snipe] Check failed for "${username}" (${status ?? err.message}) — backing off ${backoff}ms`);
            await sleep(backoff, session);
            continue;
        }

        await sleep(CHECK_DELAY_MS, session);
    }
}

async function handleSnipeUsername(interaction) {
    if (interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ No tienes permisos para usar este comando.', ephemeral: true });
    }

    if (activeSession) {
        return safeReply(interaction, { content: '⚠️ Ya existe una búsqueda activa. Usa `/stopsnipe` antes de iniciar otra.', ephemeral: true });
    }

    const maxCharacters    = interaction.options.getInteger('max_characters');
    const allowUnderscores = interaction.options.getString('underscores') === 'si';
    const allowNumbers     = interaction.options.getString('numbers') === 'si';

    const session = {
        stopped: false,
        ownerId: interaction.user.id,
        options: { maxCharacters, allowUnderscores, allowNumbers },
        seen: new Set(),
        startedAt: Date.now(),
    };
    activeSession = session;

    runLoop(interaction.client, session).catch(err => {
        console.error('[snipe] Loop crashed:', err);
        if (activeSession === session) activeSession = null;
    });

    return safeReply(interaction, {
        content: `✅ Búsqueda de usernames iniciada (máx. ${maxCharacters} caracteres, guiones bajos: ${allowUnderscores ? 'sí' : 'no'}, números: ${allowNumbers ? 'sí' : 'no'}). Resultados en <#${config.CHANNELS.SNIPE_RESULTS}>.`,
        ephemeral: true,
    });
}

async function handleStopSnipe(interaction) {
    if (interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ No tienes permisos para usar este comando.', ephemeral: true });
    }

    if (!activeSession) {
        return safeReply(interaction, { content: 'ℹ️ No hay ninguna búsqueda activa en este momento.', ephemeral: true });
    }

    activeSession.stopped = true;
    activeSession = null;

    const embed = new EmbedBuilder()
        .setColor(0xE74C3C)
        .setDescription('🛑 La búsqueda de usernames fue detenida correctamente.');

    return safeReply(interaction, { embeds: [embed], ephemeral: true });
}

module.exports = { handleSnipeUsername, handleStopSnipe };
