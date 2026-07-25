'use strict';

const { EmbedBuilder } = require('discord.js');
const config = require('./config');
const roblox = require('./roblox');
const { safeReply } = require('./utils/safe');

// avatar.roblox.com's /v1/users/{id}/avatar is documented (via its own
// x-ratelimit-limit response header) at 40 requests/60s, with no bulk
// alternative available — 1500ms/request is the exact boundary. Fixed
// slightly above it, on purpose never eased down: any steady rate faster
// than the documented limit will eventually get throttled again regardless
// of how well things have been going.
const AVATAR_DELAY_MS = 1700;

// catalog.roblox.com/v1/catalog/items/details is documented at 10 req/60s
// but accepts large batches per call (100+ verified) — batching many
// members' worth of assets into one call is what keeps this endpoint far
// under its limit despite being the strictest of the three per-call.
const CATALOG_BATCH_SIZE = 100;
const CATALOG_BATCH_DELAY_MS = 1500;

const MAX_RATE_LIMIT_RETRIES = 8;
const DEFAULT_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 70_000; // above the largest x-ratelimit-reset observed (51s) + margin
const RATE_LIMIT_SAFETY_MARGIN_MS = 750;

let activeScan = null;

// Interruptible sleep — resolves early as soon as the scan is stopped, so
// /stopgroupmembers doesn't have to wait out a long backoff.
function sleep(ms, session) {
    return new Promise(resolve => {
        const start = Date.now();
        (function tick() {
            if (session.stopped || Date.now() - start >= ms) return resolve();
            setTimeout(tick, Math.min(50, ms));
        })();
    });
}

function parseMaxHeaderValue(headerValue) {
    if (!headerValue) return null;
    const nums = String(headerValue).split(',').map(s => parseFloat(s.trim())).filter(Number.isFinite);
    return nums.length ? Math.max(...nums) : null;
}

// Prefers x-ratelimit-reset (the real time until the exhausted bucket
// refills) over Retry-After — Roblox's Retry-After can report a much
// shorter wait than the bucket's actual reset (seen: retry-after=5 while
// x-ratelimit-reset=51), and honoring the short one just re-triggers the
// same 429 immediately.
function computeRetryDelayMs(err, attempt) {
    const headers = err?.response?.headers ?? {};
    const resetSeconds = parseMaxHeaderValue(headers['x-ratelimit-reset']);
    if (resetSeconds !== null && resetSeconds > 0) {
        return Math.min(Math.ceil(resetSeconds * 1000) + RATE_LIMIT_SAFETY_MARGIN_MS, MAX_BACKOFF_MS);
    }
    const retryAfterSeconds = parseMaxHeaderValue(headers['retry-after']);
    if (retryAfterSeconds !== null && retryAfterSeconds > 0) {
        return Math.min(Math.ceil(retryAfterSeconds * 1000) + RATE_LIMIT_SAFETY_MARGIN_MS, MAX_BACKOFF_MS);
    }
    return Math.min(DEFAULT_BACKOFF_MS * attempt, MAX_BACKOFF_MS);
}

// Retries the SAME call on 429 (waiting the real reset time) instead of
// dropping it — a throttled member/batch gets processed once it's actually
// safe to do so, not abandoned. Non-429 errors are not this function's
// concern — they propagate immediately so the caller can decide (those
// aren't rate-limit issues, so retrying blindly won't help).
async function withRateLimitRetry(session, label, fn) {
    for (let attempt = 1; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
        if (session.stopped) return null;
        try {
            return await fn();
        } catch (err) {
            if (err?.response?.status !== 429) throw err;
            const wait = computeRetryDelayMs(err, attempt);
            console.warn(`[groupmembers] 429 on ${label} (attempt ${attempt}/${MAX_RATE_LIMIT_RETRIES}) — waiting ${wait}ms`);
            await sleep(wait, session);
        }
    }
    console.warn(`[groupmembers] Giving up on ${label} after ${MAX_RATE_LIMIT_RETRIES} rate-limit retries`);
    return null;
}

// Page fetch retries on ANY error (not just 429) and never advances the
// cursor until it succeeds — the whole scan depends on it, and the cursor
// passed in is always the last confirmed position, so a retry here can
// never cause the scan to lose its place or restart from the beginning.
async function fetchPageWithRetry(cursor, session) {
    let attempt = 0;
    while (!session.stopped) {
        attempt++;
        try {
            return await roblox.getGroupMembersPage(config.GROUPMEMBERS_GROUP_ID, cursor);
        } catch (err) {
            const wait = computeRetryDelayMs(err, attempt);
            console.warn(`[groupmembers] Page fetch failed (${err.response?.status ?? err.message}) — retrying in ${wait}ms`);
            await sleep(wait, session);
        }
    }
    return null;
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
    let lap = 1;

    outerLoop:
    while (!session.stopped) {
        const page = await fetchPageWithRetry(cursor, session);
        if (!page || session.stopped) break;

        // Phase 1 — gather worn items for every member in this page, one
        // avatar.roblox.com call each, at the fixed safe pace. A member that
        // keeps 429ing is retried in place (up to the cap) — never skipped
        // outright — and the loop index only advances after it's resolved.
        const memberAssets = [];
        for (const member of page.members) {
            if (session.stopped) break outerLoop;
            session.scanned++;

            let assetIds = null;
            try {
                assetIds = await withRateLimitRetry(
                    session,
                    `worn assets for ${member.userId}`,
                    () => roblox.getWornAssetIds(member.userId)
                );
            } catch (err) {
                console.warn(`[groupmembers] Skipping ${member.userId} this lap (avatar fetch):`, err.message);
            }
            if (assetIds) memberAssets.push({ member, assetIds });

            await sleep(AVATAR_DELAY_MS, session);
        }
        if (session.stopped) break;

        // Phase 2 — price every distinct NOT-YET-CACHED asset across the
        // whole page in as few batched catalog calls as possible. The
        // session-lifetime price cache means repeated common items (default
        // outfits etc.) are only ever priced once for the entire scan.
        const distinctIds = [...new Set(memberAssets.flatMap(m => m.assetIds))];
        const uncachedIds = distinctIds.filter(id => !session.priceCache.has(id));

        for (let i = 0; i < uncachedIds.length; i += CATALOG_BATCH_SIZE) {
            if (session.stopped) break outerLoop;
            const chunk = uncachedIds.slice(i, i + CATALOG_BATCH_SIZE);

            let prices = null;
            try {
                prices = await withRateLimitRetry(
                    session,
                    `pricing batch of ${chunk.length}`,
                    () => roblox.getAssetPrices(chunk)
                );
            } catch (err) {
                console.warn('[groupmembers] Pricing batch failed:', err.message);
            }
            if (prices) for (const [id, price] of prices) session.priceCache.set(id, price);

            await sleep(CATALOG_BATCH_DELAY_MS, session);
        }

        // Phase 3 — evaluate each member with cached prices and report
        // matches. Anything left uncached (a batch that never recovered)
        // contributes 0 for this lap only — the circular re-scan gives it
        // another chance rather than a permanent miss.
        for (const { member, assetIds } of memberAssets) {
            if (session.stopped) break outerLoop;
            const value = assetIds.reduce((sum, id) => sum + (session.priceCache.get(id) ?? 0), 0);
            console.log(`[groupmembers] ${member.username} (${member.userId}) -> ${value} robux`);

            if (value >= session.minPrice && value <= session.maxPrice) {
                session.foundCount++;
                const avatarUrl = await roblox.getAvatarImage(member.userId).catch(() => null);
                await sendToChannel(client, { embeds: [buildFoundEmbed(member, value, avatarUrl)] });
                if (session.foundCount >= session.amount) break outerLoop;
            }
        }

        // Only wrap back to the beginning once the whole group has been
        // walked once — never before, and never re-visiting members while
        // any are still unseen this lap.
        cursor = page.nextCursor;
        if (!cursor) {
            lap++;
            console.log(`[groupmembers] Lap complete — starting lap ${lap} from the beginning (${session.scanned} scanned so far).`);
        }
    }

    const reason = session.foundCount >= session.amount
        ? 'Se alcanzó la cantidad solicitada.'
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
        minPrice,
        maxPrice,
        amount,
        foundCount: 0,
        scanned: 0,
        priceCache: new Map(),
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
