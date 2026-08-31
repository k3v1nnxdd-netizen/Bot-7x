'use strict';

const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const EXITOSO_PATH   = './exitosoemoji.gif';
const EXITOSO_NAME   = 'exitosoemoji.gif';
const EXITOSO_EXISTS = fs.existsSync(EXITOSO_PATH);
const { isGone, safeReply, safeEditReply, safeDeferReply, safeShowModal } = require('../utils/safe');
const { isLocked, lock } = require('../utils/spam');
const tickets            = require('../utils/tickets');
const { buildComprarModal, buildOtraCosaModal, buildDuelsModal, buildCalcDineroModal, buildCalcRobuxModal, buildVerifModal, buildReviewModal } = require('./modals');
const { buildRefRow, sendPurchaseDM } = require('../utils/purchaseDm');
const reviews            = require('../utils/reviews');
const { requestReview }  = require('../utils/reviewFlow');
const { sendOrderCompletionSummary } = require('../utils/orderNotify');
const { startSeguidoresTicket, handleSeguidoresButton } = require('./seguidoresFlow');
const { handleCheckGroupButton } = require('./checkGroupFlow');
const { handleGroupsPageButton } = require('./groupLicenses');
const config             = require('../config');

// ── Countdown timers per ticket channel ───────────────────────────────────────

const timers = new Map(); // channelId -> { interval, timeout }

function clearTimers(channelId) {
    const t = timers.get(channelId);
    if (!t) return;
    clearInterval(t.interval);
    clearTimeout(t.timeout);
    timers.delete(channelId);
}

function buildAutoCloseEmbed(minutes) {
    return new EmbedBuilder()
        .setColor(0x2B2D31)
        .setTitle('Cierre automatico programado')
        .setDescription(`Este ticket se cerrara automaticamente en **${minutes} minutos**.`)
        .setFooter({ text: 'Gracias por comprar en 7x Community' })
        .setTimestamp();
}

// ── Channel classification ────────────────────────────────────────────────────

const PANEL_BUTTONS  = new Set(['comprar', 'otra_cosa', 'duels', 'seguidores']);
const CALC_BUTTONS   = new Set(['calc_dinero', 'calc_robux']);
const VERIF_BUTTONS  = new Set(['verif_check']);
const TICKET_BUTTONS = new Set(['confirmar_pago', 'cerrar_ticket', 'confirmar_cerrar', 'cancelar_cerrar']);
// Derivado de config.CHECK_GROUPS en vez de escrito a mano: el customId de
// cada boton del panel es literalmente `cg_<clave>`, asi que anadir una cuarta
// comunidad en config no puede dejarse a medias aqui.
const CHECKGROUP_BUTTONS = new Set(Object.keys(config.CHECK_GROUPS).map(clave => `cg_${clave}`));
const CHECKGROUP_RESULT_BUTTONS = new Set(['cg_elig_yes', 'cg_elig_no']);

function isTicketChannel(interaction) {
    return (
        interaction.channel?.parentId === config.CATEGORIES.TICKETS &&
        Boolean(tickets.getOwner(interaction.channel))
    );
}

async function renameChannel(channel, names, logPrefix) {
    for (const name of names) {
        try { await channel.setName(name); return true; }
        catch (err) { console.error(`${logPrefix} rename to "${name}" failed:`, err.message); }
    }
    return false;
}

// ── guardButton ───────────────────────────────────────────────────────────────
// Returns false (and optionally replies) if the interaction must be rejected.
// NEVER defers — so callers always get a fresh interaction token.

async function guardButton(interaction) {
    // Hard stop: interaction already responded — nothing we can do
    if (interaction.replied || interaction.deferred) return false;

    // Panel-only buttons must come from the panel channel
    if (PANEL_BUTTONS.has(interaction.customId) && interaction.channelId !== config.CHANNELS.PANEL) {
        await safeReply(interaction, { content: 'Usa los botones del panel oficial para crear tickets.', ephemeral: true });
        return false;
    }

    // Calc buttons must come from the calc channel
    if (CALC_BUTTONS.has(interaction.customId) && interaction.channelId !== config.CHANNELS.CALC) {
        await safeReply(interaction, { content: 'Usa los botones del canal de calculadora.', ephemeral: true });
        return false;
    }

    // Verif buttons must come from the verif channel
    if (VERIF_BUTTONS.has(interaction.customId) && interaction.channelId !== config.CHANNELS.VERIF) {
        await safeReply(interaction, { content: 'Usa los botones del canal de verificación.', ephemeral: true });
        return false;
    }

    // Ticket-only buttons must come from an active ticket channel
    if (TICKET_BUTTONS.has(interaction.customId) && !isTicketChannel(interaction)) {
        await safeReply(interaction, { content: 'Este boton solo funciona dentro de un ticket activo.', ephemeral: true });
        return false;
    }

    // Check Group panel buttons must come from the check group channel
    if (CHECKGROUP_BUTTONS.has(interaction.customId) && interaction.channelId !== config.CHANNELS.CHECKGROUP) {
        await safeReply(interaction, { content: 'Usa los botones del panel oficial de Check Group.', ephemeral: true });
        return false;
    }

    // Check Group eligibility buttons (and their confirm/cancel follow-ups)
    // must come from the results channel
    const isCheckGroupResultButton = CHECKGROUP_RESULT_BUTTONS.has(interaction.customId)
        || interaction.customId.startsWith('cg_elig_confirm:')
        || interaction.customId.startsWith('cg_elig_cancel:');
    if (isCheckGroupResultButton && interaction.channelId !== config.CHANNELS.CHECKGROUP_RESULTS) {
        await safeReply(interaction, { content: 'Este boton solo funciona en el canal de resultados.', ephemeral: true });
        return false;
    }

    // Seguidores flow buttons (seg_platform_*, seg_askqty_*, seg_quality_*) are ticket-only too
    if (interaction.customId.startsWith('seg_') && !isTicketChannel(interaction)) {
        await safeReply(interaction, { content: 'Este boton solo funciona dentro de un ticket activo.', ephemeral: true });
        return false;
    }

    // Per-user per-button per-message anti-spam (covers double-clicks and autoclickers)
    const messageId = interaction.message?.id ?? interaction.channelId ?? 'unknown';
    const key = `button:${interaction.customId}:${interaction.user.id}:${messageId}`;
    if (isLocked(key)) {
        await safeReply(interaction, { content: 'Espera un momento antes de volver a tocar ese boton.', ephemeral: true });
        return false;
    }
    lock(key, config.TIMEOUTS.BUTTON_LOCK_MS ?? config.TIMEOUTS.LOCK_MS);

    return true;
}

// ── Individual handlers ───────────────────────────────────────────────────────
// Every handler starts with an explicit guard.
// Handlers that show a modal NEVER defer first.
// Handlers that defer NEVER show a modal.

async function onComprar(interaction) {
    if (interaction.replied || interaction.deferred) return;

    const userId = interaction.user.id;

    // Secondary per-user lock — blocks even if user hits two different panel messages
    if (isLocked(`btn:comprar:${userId}`)) {
        return safeReply(interaction, { content: '⏳ Espera un momento antes de intentar de nuevo.', ephemeral: true });
    }
    lock(`btn:comprar:${userId}`, config.TIMEOUTS.LOCK_MS);

    if (await tickets.hasActiveTicket(interaction.guild, userId)) {
        return safeReply(interaction, { content: '❌ Ya tienes un ticket abierto. Cierra el anterior antes de crear otro.', ephemeral: true });
    }

    // safeShowModal internally checks replied/deferred before calling showModal()
    await safeShowModal(interaction, buildComprarModal());
}

async function onOtraCosa(interaction) {
    if (interaction.replied || interaction.deferred) return;

    const userId = interaction.user.id;

    if (isLocked(`btn:soporte:${userId}`)) {
        return safeReply(interaction, { content: '⏳ Espera un momento antes de intentar de nuevo.', ephemeral: true });
    }
    lock(`btn:soporte:${userId}`, config.TIMEOUTS.LOCK_MS);

    if (await tickets.hasActiveTicket(interaction.guild, userId)) {
        return safeReply(interaction, { content: '❌ Ya tienes un ticket abierto. Cierra el anterior antes de crear otro.', ephemeral: true });
    }

    await safeShowModal(interaction, buildOtraCosaModal());
}

async function onDuels(interaction) {
    if (interaction.replied || interaction.deferred) return;

    const userId = interaction.user.id;

    if (isLocked(`btn:duels:${userId}`)) {
        return safeReply(interaction, { content: '⏳ Espera un momento antes de intentar de nuevo.', ephemeral: true });
    }
    lock(`btn:duels:${userId}`, config.TIMEOUTS.LOCK_MS);

    if (await tickets.hasActiveTicket(interaction.guild, userId)) {
        return safeReply(interaction, { content: '❌ Ya tienes un ticket abierto. Cierra el anterior antes de crear otro.', ephemeral: true });
    }

    await safeShowModal(interaction, buildDuelsModal());
}

async function onConfirmarPago(interaction) {
    if (interaction.replied || interaction.deferred) return;

    if (interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ No tienes permiso para usar este botón.', ephemeral: true });
    }

    const channelId = interaction.channelId;

    if (tickets.getType(interaction.channel) !== 'comprar') {
        return safeReply(interaction, { content: '❌ Este botón solo funciona en tickets de compra.', ephemeral: true });
    }

    if (tickets.isConfirmed(channelId)) {
        return safeReply(interaction, { content: '❌ Este pago ya fue confirmado.', ephemeral: true });
    }

    if (isLocked(`pago:${channelId}`)) {
        return safeReply(interaction, { content: '⏳ Este pago ya se está procesando.', ephemeral: true });
    }
    lock(`pago:${channelId}`, 6000);

    // Mark confirmed synchronously — any concurrent handler arriving after this
    // will be blocked by isConfirmed() above
    tickets.markConfirmed(channelId);

    const ownerId = tickets.getOwner(interaction.channel);
    const mention = ownerId ? `<@${ownerId}>` : 'Usuario';

    const embed = new EmbedBuilder()
        .setColor(0x2B2D31)
        .setTitle('<:truepurple:1501214679400190086> PAGO EXITOSO')
        .setThumbnail(EXITOSO_EXISTS ? `attachment://${EXITOSO_NAME}` : null)
        .setDescription(
            `<:member:1501261625523699892> ${mention}, ¡tu pago fue confirmado y tus Robux ya fueron enviados a tu cuenta!\n\n` +
            '<:alert:1501220021035204658> Si aún no los ves, Roblox puede retenerlos en estado **Pendiente** por seguridad (normalmente **5-10 min**, máximo **10 días**).\n\n' +
            '<:point:1501212595464700104> Revisa el estado de tus Robux aquí: [ver transacciones](<https://www.roblox.com/transactions>)\n\n' +
            '<:truepurple:1501214679400190086> ¡Gracias por tu compra!'
        );

    const replyPayload = {
        content: ownerId ? `<@${ownerId}>` : undefined,
        embeds: [embed],
        components: [buildRefRow()],
        ...(EXITOSO_EXISTS && { files: [{ attachment: EXITOSO_PATH, name: EXITOSO_NAME }] }),
    };
    await safeReply(interaction, replyPayload);

    if (ownerId) {
        await sendPurchaseDM(interaction.client, ownerId);
        await requestReview(interaction.client, interaction.channel, channelId, ownerId);
        await sendOrderCompletionSummary(interaction.client, interaction.channel, ownerId);
    }

    try {
        const member = ownerId ? await interaction.guild.members.fetch(ownerId).catch(() => null) : null;
        const cleanName = (member?.user.username ?? 'user').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';
        await renameChannel(interaction.channel, [`pago-${cleanName}`, 'pago-user'], '[buttons]');
    } catch (err) {
        console.error('[buttons] rename failed:', err.message);
    }

    await startAutoClose(interaction.channel);
}

async function onCerrarTicket(interaction) {
    if (interaction.replied || interaction.deferred) return;

    const ownerId = tickets.getOwner(interaction.channel);
    if (interaction.user.id !== ownerId && interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ Solo el creador del ticket o el owner pueden cerrarlo.', ephemeral: true });
    }

    const embed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('⚠️ CONFIRMAR CIERRE DE TICKET')
        .setDescription('¿Estás seguro de que quieres cerrar este ticket?\n\n**Esta acción es irreversible y eliminará el canal.**');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirmar_cerrar').setLabel('Sí, cerrar ticket').setStyle(ButtonStyle.Danger).setEmoji('✅'),
        new ButtonBuilder().setCustomId('cancelar_cerrar').setLabel('Cancelar').setStyle(ButtonStyle.Secondary).setEmoji('❌')
    );

    await safeReply(interaction, { embeds: [embed], components: [row], ephemeral: true });
}

async function onConfirmarCerrar(interaction) {
    if (interaction.replied || interaction.deferred) return;

    const channelId = interaction.channelId;
    const ownerId   = tickets.getOwner(interaction.channel);

    if (interaction.user.id !== ownerId && interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ Solo el creador del ticket o el owner pueden cerrarlo.', ephemeral: true });
    }

    if (isLocked(`cerrar:${channelId}`)) {
        return safeReply(interaction, { content: '⏳ El ticket ya se está cerrando.', ephemeral: true });
    }
    lock(`cerrar:${channelId}`, 10000);

    await safeReply(interaction, { content: '🔒 Cerrando ticket en 5 segundos...', ephemeral: true });

    setTimeout(async () => {
        clearTimers(channelId);
        try { await interaction.channel.delete(); }
        catch (err) { console.error('[buttons] close-delete failed:', err.message); }
    }, config.TIMEOUTS.MANUAL_CLOSE_MS);
}

async function onCancelarCerrar(interaction) {
    if (interaction.replied || interaction.deferred) return;

    const ownerId = tickets.getOwner(interaction.channel);
    if (interaction.user.id !== ownerId && interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ Solo el creador del ticket o el owner pueden cancelar.', ephemeral: true });
    }
    try { await interaction.message.delete(); } catch {}
    await safeReply(interaction, { content: '✅ Cierre del ticket cancelado.', ephemeral: true });
}

// ── Verif handler ─────────────────────────────────────────────────────────────

async function onVerifCheck(interaction) {
    if (interaction.replied || interaction.deferred) return;
    const ok = await safeShowModal(interaction, buildVerifModal());
    if (!ok) await safeReply(interaction, { content: '❌ No se pudo abrir el formulario. Intenta de nuevo.', ephemeral: true });
}

// ── Calc handlers ─────────────────────────────────────────────────────────────

async function onCalcDinero(interaction) {
    if (interaction.replied || interaction.deferred) return;
    const ok = await safeShowModal(interaction, buildCalcDineroModal());
    if (!ok) await safeReply(interaction, { content: '❌ No se pudo abrir el formulario. Intenta de nuevo.', ephemeral: true });
}

async function onCalcRobux(interaction) {
    if (interaction.replied || interaction.deferred) return;
    const ok = await safeShowModal(interaction, buildCalcRobuxModal());
    if (!ok) await safeReply(interaction, { content: '❌ No se pudo abrir el formulario. Intenta de nuevo.', ephemeral: true });
}

async function onCopiarCuenta(interaction) {
    if (interaction.replied || interaction.deferred) return;
    await safeReply(interaction, {
        content: '722969040869278041',
        ephemeral: true,
    });
}

async function onCopiarNombre(interaction) {
    if (interaction.replied || interaction.deferred) return;
    await safeReply(interaction, {
        content: 'VICENTA MARIANO VALDOVINOS',
        ephemeral: true,
    });
}

// ── Review rating handler (button lives in both a ticket channel and a DM) ────

async function onReviewRate(interaction) {
    if (interaction.replied || interaction.deferred) return;

    const ticketChannelId = interaction.customId.slice('review_rate:'.length);
    const review = reviews.getReview(ticketChannelId);

    if (!review) {
        return safeReply(interaction, { content: '❌ Esta solicitud de reseña ya no es válida.', ephemeral: true });
    }
    if (review.rating !== null) {
        return safeReply(interaction, { content: '❌ Esta compra ya fue calificada.', ephemeral: true });
    }
    if (interaction.user.id !== review.buyerId) {
        return safeReply(interaction, { content: '❌ Solo el comprador puede calificar esta compra.', ephemeral: true });
    }

    const ok = await safeShowModal(interaction, buildReviewModal(ticketChannelId));
    if (!ok) await safeReply(interaction, { content: '❌ No se pudo abrir el formulario. Intenta de nuevo.', ephemeral: true });
}

// ── Auto-close countdown (shared with /close command) ─────────────────────────

async function startAutoClose(channel) {
    const channelId = channel.id;
    clearTimers(channelId);

    let mins = 10;
    let countdownMsg = null;
    try { countdownMsg = await channel.send({ embeds: [buildAutoCloseEmbed(mins)] }); } catch {}

    const interval = setInterval(async () => {
        mins--;
        if (mins <= 0) return;
        try { await countdownMsg?.edit({ embeds: [buildAutoCloseEmbed(mins)] }); } catch {}
    }, config.TIMEOUTS.COUNTDOWN_TICK_MS);

    const timeout = setTimeout(async () => {
        clearTimers(channelId);
        try { await channel.delete(); }
        catch (err) { console.error('[autoclose] delete failed:', err.message); }
    }, config.TIMEOUTS.PAYMENT_CLOSE_MS);

    timers.set(channelId, { interval, timeout });
}

// ── Router ────────────────────────────────────────────────────────────────────

const HANDLERS = {
    comprar:          onComprar,
    otra_cosa:        onOtraCosa,
    duels:            onDuels,
    seguidores:       startSeguidoresTicket,
    verif_check:      onVerifCheck,
    calc_dinero:      onCalcDinero,
    calc_robux:       onCalcRobux,
    confirmar_pago:      onConfirmarPago,
    cerrar_ticket:       onCerrarTicket,
    confirmar_cerrar:    onConfirmarCerrar,
    cancelar_cerrar:     onCancelarCerrar,
    metodos_copy_cuenta: onCopiarCuenta,
    metodos_copy_nombre: onCopiarNombre,
};

async function handleButton(interaction) {
    // Hard stop — should not be reachable thanks to markInteraction in main.js,
    // but this is the final safety net before any response attempt.
    if (interaction.replied || interaction.deferred) return;

    const isSeg    = interaction.customId.startsWith('seg_');
    const isCg     = interaction.customId.startsWith('cg_');
    const isReview = interaction.customId.startsWith('review_rate:');
    // Paging of the /groups license listing. Its message is ephemeral and
    // owner-only, and the handler re-checks the owner itself — the customId
    // carries the page number and nothing else, so a forged one can only ask
    // for a different page of a list its clicker was already allowed to see.
    const isGroupList = interaction.customId.startsWith('gl_groups:');
    const fn = isSeg ? handleSeguidoresButton
        : isCg ? handleCheckGroupButton
        : isReview ? onReviewRate
        : isGroupList ? handleGroupsPageButton
        : HANDLERS[interaction.customId];
    if (!fn) return;

    try {
        if (!await guardButton(interaction)) return;
        await fn(interaction);
    } catch (err) {
        // Suppress expected Discord lifecycle errors silently
        if (isGone(err)) return;
        console.error(`[button:${interaction.customId}] Unhandled error:`, err);
        await safeReply(interaction, { content: '❌ Ocurrió un error. Intenta de nuevo.', ephemeral: true });
    }
}

module.exports = { handleButton, clearTimers, startAutoClose };
