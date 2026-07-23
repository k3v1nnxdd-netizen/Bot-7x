'use strict';

const { EmbedBuilder } = require('discord.js');
const config = require('./config');
const roblox = require('./roblox');
const snipeHistory = require('./utils/snipeHistory');
const snipeSeen = require('./utils/snipeSeen');
const { safeReply, safeDeferReply, safeEditReply } = require('./utils/safe');

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS  = '0123456789';

const BATCH_SIZE = 15;        // usernames checked per Roblox request
const BATCH_DELAY_MS = 900;   // pause between batches — ~16.7 checks/s at ~1.1 req/s to Roblox
const MAX_BACKOFF_MS = 30_000;
const CHECKSNIPE_DELAY_MS = 500;

let activeSession = null;

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

function generateUsername({ minCharacters, maxCharacters, allowUnderscores, allowNumbers }) {
    const length = randomInt(minCharacters, maxCharacters);
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

// session.seen is preloaded from disk (utils/snipeSeen) with every username
// ever generated across all sessions/restarts, so this dedupes globally,
// not just within the current run.
function generateUniqueUsername(session) {
    for (let i = 0; i < 100; i++) {
        const name = generateUsername(session.options);
        if (!session.seen.has(name)) {
            session.seen.add(name);
            snipeSeen.appendSeen(name);
            return name;
        }
    }
    // Astronomically unlikely fallback to guarantee no repeats, ever.
    let name;
    do { name = generateUsername(session.options) + LETTERS[randomInt(0, LETTERS.length - 1)]; }
    while (session.seen.has(name));
    session.seen.add(name);
    snipeSeen.appendSeen(name);
    return name;
}

function formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}m ${s}s`;
}

function formatFoundList(list) {
    if (list.length === 0) return 'Ninguno';
    const shown = list.slice(0, 15).map(u => `\`${u}\``).join(', ');
    return list.length > 15 ? `${shown} y ${list.length - 15} más` : shown;
}

function buildActiveEmbed({ minCharacters, maxCharacters, allowUnderscores, allowNumbers }) {
    return new EmbedBuilder()
        .setColor(0x2ECC71)
        .setDescription(
            '<a:active:1529678531473309848> **Active Snipe**\n\n' +
            `> **Caracteres:** \`${minCharacters}-${maxCharacters}\`\n` +
            `> **Números:** \`${allowNumbers ? 'yes' : 'no'}\`\n` +
            `> **Guiones bajos:** \`${allowUnderscores ? 'yes' : 'no'}\``
        );
}

function buildDeactiveEmbed(session) {
    return new EmbedBuilder()
        .setColor(0xE74C3C)
        .setDescription(
            '<a:desactive:1529681682670813326> **Snipe Desactivado**\n\n' +
            `> **Duración:** \`${formatDuration(Date.now() - session.startedAt)}\`\n` +
            `> **Usernames comprobados:** \`${session.checked}\`\n` +
            `> **Usernames encontrados:** \`${session.foundUsernames.length}\`\n` +
            `> **Encontrados:** ${formatFoundList(session.foundUsernames)}`
        );
}

function buildResultEmbed(username, available) {
    return new EmbedBuilder()
        .setColor(available ? 0x2ECC71 : 0xE74C3C)
        .addFields(
            { name: 'Username', value: username, inline: true },
            { name: 'Estado',   value: available ? 'Disponible' : 'No disponible', inline: true },
        );
}

function buildFoundEmbed(username) {
    return new EmbedBuilder()
        .setColor(0x2ECC71)
        .addFields(
            { name: 'Username', value: username, inline: true },
            { name: 'Estado',   value: 'Disponible', inline: true },
            { name: 'Hora',     value: `<t:${Math.floor(Date.now() / 1000)}:T>`, inline: true },
        );
}

function buildCheckSnipeEmbed(results) {
    const header = '<a:activee:1529710078754553968> **Check Snipe**\n\n';

    if (results.length === 0) {
        return new EmbedBuilder()
            .setColor(0x2ECC71)
            .setDescription(header + 'Todavía no se ha encontrado ningún username disponible.');
    }

    const lines = results.map(r => `> \`${r.username}\` — ${r.status}`);
    let body = '';
    let shown = 0;
    for (const line of lines) {
        if ((body + line + '\n').length > 3500) break;
        body += line + '\n';
        shown++;
    }
    if (shown < lines.length) body += `\n*y ${lines.length - shown} más...*`;

    return new EmbedBuilder()
        .setColor(0x2ECC71)
        .setDescription(header + body);
}

async function sendToChannel(client, channelId, payload) {
    try {
        const channel = await client.channels.fetch(channelId);
        await channel.send(payload);
        return true;
    } catch (err) {
        console.warn(`[snipe] Could not send to channel ${channelId}:`, err.message);
        return false;
    }
}

async function fetchRoleMemberIds(client, roleId) {
    try {
        const guild = await client.guilds.fetch(config.GUILD_ID);
        const role = await guild.roles.fetch(roleId);
        if (!role) {
            console.warn('[snipe] Notify role not found:', roleId);
            return [];
        }

        // REST-paginated listing — avoids the gateway opcode-8 (request guild
        // members) path, which Discord rate-limits hard for back-to-back calls.
        let after = '0';
        for (let page = 0; page < 50; page++) {
            const batch = await guild.members.list({ limit: 1000, after });
            if (batch.size === 0) break;
            after = batch.lastKey();
            if (batch.size < 1000) break;
        }

        return [...role.members.keys()];
    } catch (err) {
        console.warn('[snipe] Could not fetch role members:', err.message);
        return [];
    }
}

async function dmRoleMembers(client, memberIds, payload) {
    await Promise.allSettled(memberIds.map(async id => {
        try {
            const user = await client.users.fetch(id);
            await user.send(payload);
        } catch (err) {
            console.warn(`[snipe] Could not DM ${id}:`, err.message);
        }
    }));
}

async function runLoop(client, session) {
    console.log(`[snipe] Loop started — chars=${session.options.minCharacters}-${session.options.maxCharacters} underscores=${session.options.allowUnderscores} numbers=${session.options.allowNumbers} batch=${BATCH_SIZE}`);
    let consecutiveErrors = 0;

    while (!session.stopped) {
        const batch = [];
        for (let i = 0; i < BATCH_SIZE; i++) batch.push(generateUniqueUsername(session));

        try {
            const results = await roblox.checkUsernamesAvailable(batch);
            consecutiveErrors = 0;

            for (const username of batch) {
                const available = results[username];
                session.checked++;
                console.log(`[snipe] ${username} -> ${available ? 'available' : 'taken'}`);

                if (available) {
                    session.foundUsernames.push(username);
                    snipeHistory.addFound(username);
                    const foundEmbed = buildFoundEmbed(username);
                    await sendToChannel(client, config.CHANNELS.SNIPE_RESULTS, { embeds: [buildResultEmbed(username, true)] });
                    await sendToChannel(client, config.CHANNELS.SNIPE_FOUND, { embeds: [foundEmbed] });
                    await dmRoleMembers(client, session.notifyTargets, { embeds: [foundEmbed] });
                } else {
                    await sendToChannel(client, config.CHANNELS.SNIPE_RESULTS, { embeds: [buildResultEmbed(username, false)] });
                }

                if (session.stopped) break;
            }
        } catch (err) {
            consecutiveErrors++;
            const status = err?.response?.status;
            const retryAfter = Number(err?.response?.headers?.['retry-after']);
            const backoff = status === 429 && Number.isFinite(retryAfter)
                ? retryAfter * 1000
                : Math.min(1500 * consecutiveErrors, MAX_BACKOFF_MS);

            console.warn(`[snipe] Batch check failed (${status ?? err.message}) — backing off ${backoff}ms`);
            await sleep(backoff, session);
            continue;
        }

        await sleep(BATCH_DELAY_MS, session);
    }

    console.log('[snipe] Loop stopped.');
}

async function handleSnipeUsername(interaction) {
    if (interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ No tienes permisos para usar este comando.', ephemeral: true });
    }

    if (activeSession) {
        return safeReply(interaction, { content: '⚠️ Ya existe una búsqueda activa. Usa `/stopsnipe` antes de iniciar otra.', ephemeral: true });
    }

    const minCharacters    = interaction.options.getInteger('min_characters');
    const maxCharacters    = interaction.options.getInteger('max_characters');
    const allowUnderscores = interaction.options.getString('underscores') === 'si';
    const allowNumbers     = interaction.options.getString('numbers') === 'si';

    if (minCharacters > maxCharacters) {
        return safeReply(interaction, { content: '❌ El mínimo de caracteres no puede ser mayor que el máximo.', ephemeral: true });
    }

    const session = {
        stopped: false,
        ownerId: interaction.user.id,
        options: { minCharacters, maxCharacters, allowUnderscores, allowNumbers },
        seen: snipeSeen.loadSeen(),
        checked: 0,
        foundUsernames: [],
        notifyTargets: [],
        startedAt: Date.now(),
    };
    activeSession = session;

    session.notifyTargets = await fetchRoleMemberIds(interaction.client, config.ROLES.SNIPE_NOTIFY);

    await sendToChannel(interaction.client, config.CHANNELS.SNIPE_RESULTS, { embeds: [buildActiveEmbed(session.options)] });

    runLoop(interaction.client, session).catch(err => {
        console.error('[snipe] Loop crashed:', err);
        if (activeSession === session) activeSession = null;
    });

    return safeReply(interaction, {
        content: `✅ Búsqueda de usernames iniciada (${minCharacters}-${maxCharacters} caracteres, guiones bajos: ${allowUnderscores ? 'sí' : 'no'}, números: ${allowNumbers ? 'sí' : 'no'}). Resultados en <#${config.CHANNELS.SNIPE_RESULTS}>.`,
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

    const session = activeSession;
    session.stopped = true;
    activeSession = null;

    await sendToChannel(interaction.client, config.CHANNELS.SNIPE_RESULTS, { embeds: [buildDeactiveEmbed(session)] });

    return safeReply(interaction, { content: '🛑 Búsqueda detenida correctamente.', ephemeral: true });
}

async function handleCheckSnipe(interaction) {
    if (interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ No tienes permisos para usar este comando.', ephemeral: true });
    }

    const ok = await safeDeferReply(interaction, { ephemeral: true });
    if (!ok) return;

    const all = snipeHistory.getAllFound().map(f => f.username);
    const results = [];

    for (let i = 0; i < all.length; i += BATCH_SIZE) {
        const chunk = all.slice(i, i + BATCH_SIZE);
        try {
            const available = await roblox.checkUsernamesAvailable(chunk);
            for (const username of chunk) {
                results.push({ username, status: available[username] ? 'Disponible' : 'No disponible' });
            }
        } catch (err) {
            for (const username of chunk) results.push({ username, status: 'Error al comprobar' });
        }
        await delay(CHECKSNIPE_DELAY_MS);
    }

    return safeEditReply(interaction, { embeds: [buildCheckSnipeEmbed(results)] });
}

module.exports = { handleSnipeUsername, handleStopSnipe, handleCheckSnipe };
