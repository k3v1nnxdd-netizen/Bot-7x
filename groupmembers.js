'use strict';

const { EmbedBuilder } = require('discord.js');
const config = require('./config');
const roblox = require('./roblox');
const { safeReply, safeMessageEdit } = require('./utils/safe');

// avatar.roblox.com's /v1/users/{id}/avatar is documented (via its own
// x-ratelimit-limit response header) at 40 requests/60s — no bulk/batch
// alternative exists (checked currently-wearing: worse, 6 req/60s;
// inventory.roblox.com equivalent: 404; Open Cloud: no public avatar
// resource, requires an API key anyway). This is the real, platform-imposed
// ceiling — a token bucket paces requests up to exactly this limit instead
// of a fixed per-call delay, so idle bucket capacity never goes to waste.
const AVATAR_RATE_LIMIT = { maxTokens: 40, windowMs: 60_000 };

// catalog.roblox.com/v1/catalog/items/details is documented at 10 req/60s
// but accepts large batches per call (100+ verified) — batching many
// members' worth of assets into one call is what keeps this endpoint far
// under its limit despite being the strictest of the two per-call.
const CATALOG_RATE_LIMIT = { maxTokens: 10, windowMs: 60_000 };
const CATALOG_BATCH_SIZE = 100;

const MAX_RATE_LIMIT_RETRIES = 8;
const DEFAULT_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 70_000; // above the largest x-ratelimit-reset observed (51s) + margin
const RATE_LIMIT_SAFETY_MARGIN_MS = 750;

const PROGRESS_TICK_MS = 3000;

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

// Same idea, but keyed on session.done (set once, last, by runScan) instead
// of session.stopped — the progress ticker needs to keep ticking until the
// scan has truly finished writing its final numbers, not just until a stop
// was requested (see runProgressTicker).
function sleepUntilDone(ms, session) {
    return new Promise(resolve => {
        const start = Date.now();
        (function tick() {
            if (session.done || Date.now() - start >= ms) return resolve();
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

// Lazy/pull-based token bucket — refill is computed from elapsed time on
// each take(), not a live setInterval (nothing to clean up). One instance
// per Roblox endpoint, created fresh per scan session.
function createRateLimiter(maxTokens, windowMs) {
    let tokens = maxTokens;
    let lastRefill = Date.now();
    return {
        async take(session) {
            for (;;) {
                if (session.stopped) return false;
                const now = Date.now();
                const elapsed = now - lastRefill;
                if (elapsed > 0) {
                    tokens = Math.min(maxTokens, tokens + (elapsed / windowMs) * maxTokens);
                    lastRefill = now;
                }
                if (tokens >= 1) { tokens -= 1; return true; }
                await sleep(100, session);
            }
        },
    };
}

// Drains `items` by calling worker(item) once per item, pulling one token
// from `limiter` before every attempt (including retries). On a 429, the
// item is deferred — NOT retried in place — and the loop immediately moves
// to the next pending item; deferred items are promoted back to pending
// once their computeRetryDelayMs()-derived cooldown elapses, so a single
// throttled item never blocks progress on the rest. Only blocks (via the
// interruptible sleep) when nothing is pending and something is purely
// waiting out its own cooldown. After MAX_RATE_LIMIT_RETRIES attempts an
// item is given up on for this call only — callers (this file) rely on the
// circular re-scan to give it a fresh attempt next lap. Non-429 errors are
// never retried — logged and dropped immediately.
async function processWithRetryQueue({ items, worker, keyOf, limiter, session, label, onEvent }) {
    const results = new Map();
    const pending = items.map(item => ({ item, attempts: 0 }));
    const deferred = [];
    let gaveUpCount = 0;

    while (!session.stopped && (pending.length || deferred.length)) {
        const now = Date.now();
        for (let i = deferred.length - 1; i >= 0; i--) {
            if (deferred[i].notBefore <= now) pending.push(deferred.splice(i, 1)[0]);
        }
        onEvent?.('queue', { pendingCount: pending.length, deferredCount: deferred.length });

        if (!pending.length) {
            const soonest = Math.min(...deferred.map(d => d.notBefore));
            await sleep(Math.max(50, soonest - Date.now()), session);
            continue;
        }

        const entry = pending.shift();
        entry.attempts++;

        if (!await limiter.take(session)) break; // session.stopped flipped mid-wait

        onEvent?.('attempt', { item: entry.item, attempts: entry.attempts });
        try {
            const result = await worker(entry.item);
            results.set(entry.item, result);
            onEvent?.('success', { item: entry.item, attempts: entry.attempts });
        } catch (err) {
            if (err?.response?.status === 429) {
                onEvent?.('rateLimited', { item: entry.item, attempts: entry.attempts });
                if (entry.attempts >= MAX_RATE_LIMIT_RETRIES) {
                    gaveUpCount++;
                    console.warn(`[groupmembers] Giving up on ${label} ${keyOf(entry.item)} after ${MAX_RATE_LIMIT_RETRIES} rate-limit retries`);
                } else {
                    const wait = computeRetryDelayMs(err, entry.attempts);
                    deferred.push({ item: entry.item, attempts: entry.attempts, notBefore: Date.now() + wait });
                    console.warn(`[groupmembers] 429 on ${label} ${keyOf(entry.item)} (attempt ${entry.attempts}/${MAX_RATE_LIMIT_RETRIES}) — deferring ${wait}ms, continuing with next item`);
                }
            } else {
                console.warn(`[groupmembers] Skipping ${label} ${keyOf(entry.item)} (${err.message})`);
            }
        }
    }
    return { results, gaveUpCount };
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

function formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
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

// One embed builder for both the periodic live snapshot and the single
// terminal edit — final=true swaps the ETA field for a Motivo field and
// switches the color to the pass/fail result, matching what the old
// separate "done" message used to show.
function buildProgressEmbed(session, { final = false } = {}) {
    const elapsedMs = Date.now() - session.startedAt;
    const elapsedMinutes = elapsedMs / 60_000;
    // Based on scanned (Phase 1 avatar-fetch attempts), not processed (Phase
    // 3 evaluations) — processed can stay tiny even on a fast scan whenever
    // Phase 3 breaks early after hitting `amount`, which would otherwise
    // make a fast scan look artificially slow here.
    const speed = elapsedMinutes >= 0.05 ? `${(session.scanned / elapsedMinutes).toFixed(1)} usuarios/min` : 'Calculando...';
    const status = final
        ? (session.foundCount >= session.amount ? 'Finalizado' : 'Detenido')
        : (session.avatarQueueSize > 0 ? 'Reintentando' : 'Escaneando');

    const fields = [
        { name: 'Estado',                      value: status, inline: true },
        { name: 'Encontrados',                 value: `${session.foundCount}/${session.amount}`, inline: true },
        { name: 'Restantes por encontrar',     value: `${Math.max(0, session.amount - session.foundCount)}`, inline: true },
        { name: 'Usuarios escaneados',         value: `${session.scanned}`, inline: true },
        { name: 'Usuarios procesados',         value: `${session.processed}`, inline: true },
        { name: 'Vuelta actual',               value: `${session.lap}`, inline: true },
        { name: 'Tiempo transcurrido',         value: formatDuration(elapsedMs), inline: true },
        { name: 'Velocidad aproximada',        value: speed, inline: true },
        { name: 'En cola de reintentos',       value: `${session.avatarQueueSize}`, inline: true },
        { name: 'Errores 429 detectados',      value: `${session.rateLimitCount}`, inline: true },
    ];

    if (final) {
        fields.push({ name: 'Motivo', value: session.terminalReason ?? '—', inline: true });
    } else {
        const eta = session.foundCount > 0
            ? formatDuration((elapsedMs / session.foundCount) * Math.max(0, session.amount - session.foundCount))
            : 'Calculando...';
        fields.push({ name: 'Tiempo restante estimado', value: eta, inline: true });
    }

    const color = final
        ? (session.foundCount >= session.amount ? 0x2ECC71 : 0xE74C3C)
        : 0x3498DB;

    return new EmbedBuilder()
        .setColor(color)
        .setTitle('📊 Progreso del escaneo — /groupmembers')
        .addFields(...fields);
}

async function sendToChannel(client, payload) {
    try {
        const channel = await client.channels.fetch(config.CHANNELS.GROUPMEMBERS_RESULTS);
        return await channel.send(payload);
    } catch (err) {
        console.warn('[groupmembers] Could not send to channel:', err.message);
        return null;
    }
}

async function sendInitialProgressMessage(client, session) {
    const message = await sendToChannel(client, { embeds: [buildProgressEmbed(session)] });
    if (!message) console.warn('[groupmembers] Progress message could not be sent — scan continues without a live tracker.');
    return message;
}

// The only function that ever edits the progress message — both the
// periodic ticks and the single terminal edit — so there's no possibility
// of two different code paths racing to send a "final" state.
async function runProgressTicker(session) {
    while (!session.done) {
        await sleepUntilDone(PROGRESS_TICK_MS, session);
        if (session.done) break;
        await safeMessageEdit(session.progressMessage, { embeds: [buildProgressEmbed(session)] });
    }
    await safeMessageEdit(session.progressMessage, { embeds: [buildProgressEmbed(session, { final: true })] });
}

async function runScan(client, session) {
    console.log(`[groupmembers] Scan started — price=${session.minPrice}-${session.maxPrice} amount=${session.amount}`);
    let cursor = null;

    try {
        session.progressMessage = await sendInitialProgressMessage(client, session);
        runProgressTicker(session).catch(err => console.error('[groupmembers] Progress ticker crashed:', err));

        outerLoop:
        while (!session.stopped) {
            const page = await fetchPageWithRetry(cursor, session);
            if (!page || session.stopped) break;

            // Phase 1 — gather worn items for every member in this page.
            // Throttled members are deferred and retried without blocking
            // the rest of the page (see processWithRetryQueue).
            const { results: wornByMember } = await processWithRetryQueue({
                items: page.members,
                worker: member => roblox.getWornAssetIds(member.userId),
                keyOf: member => member.userId,
                limiter: session.avatarLimiter,
                session,
                label: 'worn assets for',
                onEvent: (type, p) => {
                    if (type === 'attempt' && p.attempts === 1) session.scanned++;
                    if (type === 'rateLimited') session.rateLimitCount++;
                    if (type === 'queue') session.avatarQueueSize = p.deferredCount;
                },
            });
            session.avatarQueueSize = 0; // drained (or stopped) — don't leave a stale count for Phase 2/3
            if (session.stopped) break outerLoop;

            // page.members order preserved (not completion order), so
            // Phase 3's found-embed posting order matches today's behavior.
            const memberAssets = page.members
                .filter(m => wornByMember.has(m))
                .map(m => ({ member: m, assetIds: wornByMember.get(m) }));

            // Phase 2 — price every distinct NOT-YET-CACHED asset across the
            // page in as few batched catalog calls as possible. The
            // session-lifetime price cache means repeated common items
            // (default outfits etc.) are only ever priced once for the
            // whole scan.
            const distinctIds = [...new Set(memberAssets.flatMap(m => m.assetIds))];
            const uncachedIds = distinctIds.filter(id => !session.priceCache.has(id));
            const chunks = [];
            for (let i = 0; i < uncachedIds.length; i += CATALOG_BATCH_SIZE) {
                chunks.push(uncachedIds.slice(i, i + CATALOG_BATCH_SIZE));
            }

            const { results: pricesByChunk } = await processWithRetryQueue({
                items: chunks,
                worker: chunk => roblox.getAssetPrices(chunk),
                keyOf: chunk => `of ${chunk.length}`,
                limiter: session.catalogLimiter,
                session,
                label: 'pricing batch',
                onEvent: (type) => { if (type === 'rateLimited') session.rateLimitCount++; },
            });
            for (const prices of pricesByChunk.values()) {
                for (const [id, price] of prices) session.priceCache.set(id, price);
            }
            if (session.stopped) break outerLoop;

            // Phase 3 — evaluate each member with cached prices and report
            // matches. Anything left uncached (a batch that never
            // recovered) contributes 0 for this lap only — the circular
            // re-scan gives it another chance rather than a permanent miss.
            for (const { member, assetIds } of memberAssets) {
                if (session.stopped) break outerLoop;
                session.processed++;
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
            // walked once — never before, and never re-visiting members
            // while any are still unseen this lap.
            cursor = page.nextCursor;
            if (!cursor) {
                session.lap++;
                console.log(`[groupmembers] Lap complete — starting lap ${session.lap} from the beginning (${session.scanned} scanned so far).`);
            }
        }

        session.terminalReason = session.foundCount >= session.amount
            ? 'Se alcanzó la cantidad solicitada.'
            : 'Detenido manualmente.';
    } catch (err) {
        session.terminalReason = `Error inesperado: ${err.message}`;
        console.error('[groupmembers] Scan crashed:', err);
    } finally {
        session.done = true;
        console.log('[groupmembers] Scan stopped:', session.terminalReason);
        if (activeScan === session) activeScan = null;
    }
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
        done: false,
        terminalReason: null,

        minPrice,
        maxPrice,
        amount,
        foundCount: 0,
        scanned: 0,
        processed: 0,
        lap: 1,
        rateLimitCount: 0,
        avatarQueueSize: 0,

        priceCache: new Map(),
        avatarLimiter: createRateLimiter(AVATAR_RATE_LIMIT.maxTokens, AVATAR_RATE_LIMIT.windowMs),
        catalogLimiter: createRateLimiter(CATALOG_RATE_LIMIT.maxTokens, CATALOG_RATE_LIMIT.windowMs),
        progressMessage: null,
        startedAt: Date.now(),
    };
    activeScan = session;

    runScan(interaction.client, session).catch(err => {
        console.error('[groupmembers] Scan crashed:', err);
        if (activeScan === session) activeScan = null;
    });

    return safeReply(interaction, {
        content: `✅ Escaneo de grupo iniciado (${minPrice}-${maxPrice} Robux, buscando ${amount} outfit(s)). Progreso y resultados en <#${config.CHANNELS.GROUPMEMBERS_RESULTS}>.`,
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

module.exports = {
    handleGroupMembers,
    handleStopGroupMembers,
    __test: { createRateLimiter, processWithRetryQueue, computeRetryDelayMs, buildProgressEmbed },
};
