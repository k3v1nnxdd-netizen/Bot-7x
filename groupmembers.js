'use strict';

const { EmbedBuilder } = require('discord.js');
const config = require('./config');
const roblox = require('./roblox');
const { safeReply } = require('./utils/safe');

const USER_DELAY_MS = 700;
const MAX_BACKOFF_MS = 30_000;

let activeScan = null;

// Interruptible sleep — resolves early as soon as the scan is stopped,
// so /stopgroupmembers doesn't have to wait out a long backoff.
function sleep(ms, session) {
    return new Promise(resolve => {
        const start = Date.now();
        (function tick() {
            if (session.stopped || Date.now() - start >= ms) return resolve();
            setTimeout(tick, Math.min(50, ms));
        })();
    });
}

function buildFoundEmbed(member, price, avatarUrl) {
    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .addFields(
            { name: 'Username',           value: member.username,      inline: true },
            { name: 'User ID',            value: String(member.userId), inline: true },
            { name: 'Precio del outfit',  value: `${price} Robux`,      inline: true },
        );
    if (avatarUrl) embed.setImage(avatarUrl);
    return embed;
}

function buildDoneEmbed(session, reason) {
    return new EmbedBuilder()
        .setColor(session.foundCount >= session.amount ? 0x2ECC71 : 0xE74C3C)
        .setDescription(
            '**Escaneo de grupo finalizado**\n\n' +
            `> **Encontrados:** \`${session.foundCount}/${session.amount}\`\n` +
            `> **Miembros escaneados:** \`${session.scanned}\`\n` +
            `> **Motivo:** ${reason}`
        );
}

async function sendToChannel(client, payload) {
    try {
        const channel = await client.channels.fetch(config.CHANNELS.GROUPMEMBERS_RESULTS);
        await channel.send(payload);
    } catch (err) {
        console.warn('[groupmembers] Could not send to channel:', err.message);
    }
}

async function runScan(client, session) {
    console.log(`[groupmembers] Scan started — price=${session.minPrice}-${session.maxPrice} amount=${session.amount}`);
    let cursor = null;
    let pageErrors = 0;
    let rateLimitStreak = 0;

    pageLoop:
    while (!session.stopped) {
        let page;
        try {
            page = await roblox.getGroupMembersPage(config.GROUPMEMBERS_GROUP_ID, cursor);
            pageErrors = 0;
        } catch (err) {
            pageErrors++;
            const backoff = Math.min(2000 * pageErrors, MAX_BACKOFF_MS);
            console.warn('[groupmembers] Page fetch failed:', err.message, '— backing off', backoff, 'ms');
            await sleep(backoff, session);
            continue;
        }

        for (const member of page.members) {
            if (session.stopped) break pageLoop;
            session.scanned++;

            try {
                const assetIds = await roblox.getWornAssetIds(member.userId);
                const value = await roblox.getAssetsValue(assetIds);
                rateLimitStreak = 0;
                console.log(`[groupmembers] ${member.username} (${member.userId}) -> ${value} robux`);

                if (value >= session.minPrice && value <= session.maxPrice) {
                    session.foundCount++;
                    const avatarUrl = await roblox.getAvatarImage(member.userId).catch(() => null);
                    await sendToChannel(client, { embeds: [buildFoundEmbed(member, value, avatarUrl)] });
                    if (session.foundCount >= session.amount) break pageLoop;
                }
            } catch (err) {
                if (err?.response?.status === 429) {
                    rateLimitStreak++;
                    const retryAfter = Number(err.response.headers?.['retry-after']);
                    const backoff = Number.isFinite(retryAfter)
                        ? retryAfter * 1000
                        : Math.min(3000 * rateLimitStreak, MAX_BACKOFF_MS);
                    console.warn(`[groupmembers] Rate limited on ${member.userId} (x${rateLimitStreak}) — backing off ${backoff}ms`);
                    await sleep(backoff, session);
                } else {
                    console.warn(`[groupmembers] Skipping ${member.userId}:`, err.message);
                }
            }

            await sleep(USER_DELAY_MS, session);
        }

        cursor = page.nextCursor;
        if (!cursor) {
            session.exhausted = true;
            break;
        }
    }

    const reason = session.foundCount >= session.amount
        ? 'Se alcanzó la cantidad solicitada.'
        : session.exhausted
            ? 'Se escaneó todo el grupo sin alcanzar la cantidad solicitada.'
            : 'Detenido manualmente.';

    await sendToChannel(client, { embeds: [buildDoneEmbed(session, reason)] });
    console.log('[groupmembers] Scan stopped:', reason);
    if (activeScan === session) activeScan = null;
}

async function handleGroupMembers(interaction) {
    if (interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ No tienes permisos para usar este comando.', ephemeral: true });
    }

    if (activeScan) {
        return safeReply(interaction, { content: '⚠️ Ya hay un escaneo de grupo activo. Usa `/stopgroupmembers` antes de iniciar otro.', ephemeral: true });
    }

    const minPrice = interaction.options.getInteger('min_price');
    const maxPrice = interaction.options.getInteger('max_price');
    const amount   = interaction.options.getInteger('amount');

    if (minPrice > maxPrice) {
        return safeReply(interaction, { content: '❌ El precio mínimo no puede ser mayor que el máximo.', ephemeral: true });
    }

    const session = {
        stopped: false,
        exhausted: false,
        minPrice,
        maxPrice,
        amount,
        foundCount: 0,
        scanned: 0,
        startedAt: Date.now(),
    };
    activeScan = session;

    runScan(interaction.client, session).catch(err => {
        console.error('[groupmembers] Scan crashed:', err);
        if (activeScan === session) activeScan = null;
    });

    return safeReply(interaction, {
        content: `✅ Escaneo de grupo iniciado (${minPrice}-${maxPrice} Robux, buscando ${amount} outfit(s)). Resultados en <#${config.CHANNELS.GROUPMEMBERS_RESULTS}>.`,
        ephemeral: true,
    });
}

async function handleStopGroupMembers(interaction) {
    if (interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ No tienes permisos para usar este comando.', ephemeral: true });
    }

    if (!activeScan) {
        return safeReply(interaction, { content: 'ℹ️ No hay ningún escaneo activo en este momento.', ephemeral: true });
    }

    activeScan.stopped = true;
    activeScan = null;

    return safeReply(interaction, { content: '🛑 Escaneo detenido correctamente.', ephemeral: true });
}

module.exports = { handleGroupMembers, handleStopGroupMembers };
