'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { safeReply, safeEditReply, safeDeferReply, safeShowModal } = require('../utils/safe');
const { isLocked, lock }             = require('../utils/spam');
const tickets                        = require('../utils/tickets');
const { sendPricesTo }               = require('../utils/pricesSender');
const { buildComprarModal, buildOtraCosaModal } = require('./modals');
const config                         = require('../config');

// ── Active countdown timers per channel ───────────────────────────────────────

const timers = new Map(); // channelId -> { interval, timeout }

function clearTimers(channelId) {
    const t = timers.get(channelId);
    if (!t) return;
    clearInterval(t.interval);
    clearTimeout(t.timeout);
    timers.delete(channelId);
}

// ── Individual button handlers ────────────────────────────────────────────────

async function onComprar(interaction) {
    const userId = interaction.user.id;
    if (isLocked(`btn:comprar:${userId}`)) {
        return safeReply(interaction, { content: '⏳ Espera un momento antes de intentar de nuevo.', ephemeral: true });
    }
    lock(`btn:comprar:${userId}`, config.TIMEOUTS.LOCK_MS);

    if (await tickets.hasActiveTicket(interaction.guild, userId)) {
        return safeReply(interaction, { content: '❌ Ya tienes un ticket abierto. Cierra el anterior antes de crear uno nuevo.', ephemeral: true });
    }

    await safeShowModal(interaction, buildComprarModal());
}

async function onPrecios(interaction) {
    if (!await safeDeferReply(interaction, { ephemeral: true })) return;
    try {
        await sendPricesTo(interaction.user);
        await safeEditReply(interaction, { content: '✅ Te envié los precios por DM. Revisa tus mensajes privados.' });
    } catch {
        await safeEditReply(interaction, { content: '❌ No pude enviarte los precios. Por favor abre tus DMs e inténtalo de nuevo.' });
    }
}

async function onOtraCosa(interaction) {
    const userId = interaction.user.id;
    if (isLocked(`btn:soporte:${userId}`)) {
        return safeReply(interaction, { content: '⏳ Espera un momento antes de intentar de nuevo.', ephemeral: true });
    }
    lock(`btn:soporte:${userId}`, config.TIMEOUTS.LOCK_MS);

    if (await tickets.hasActiveTicket(interaction.guild, userId)) {
        return safeReply(interaction, { content: '❌ Ya tienes un ticket abierto. Cierra el anterior antes de crear uno nuevo.', ephemeral: true });
    }

    await safeShowModal(interaction, buildOtraCosaModal());
}

async function onConfirmarPago(interaction) {
    if (interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ No tienes permiso para usar este botón.', ephemeral: true });
    }

    const channelId = interaction.channelId;

    // Only valid inside a comprar ticket
    if (tickets.getType(interaction.channel) !== 'comprar') {
        return safeReply(interaction, { content: '❌ Este botón solo funciona en tickets de compra.', ephemeral: true });
    }

    // Prevent double-confirmation and spam
    if (tickets.isConfirmed(channelId)) {
        return safeReply(interaction, { content: '❌ Este pago ya fue confirmado.', ephemeral: true });
    }
    if (isLocked(`pago:${channelId}`)) {
        return safeReply(interaction, { content: '⏳ Este pago ya se está procesando.', ephemeral: true });
    }
    lock(`pago:${channelId}`, 6000);

    tickets.markConfirmed(channelId);

    const ownerId = tickets.getOwner(channelId);
    const mention = ownerId ? `<@${ownerId}>, ` : '';

    const embed = new EmbedBuilder()
        .setColor(0x00C853)
        .setTitle('✅ PAGO EXITOSO')
        .setDescription(`${mention}tus robux han sido enviados correctamente.\n\nPor favor, deja tu reseña en <#${config.CHANNELS.REFERENCIAS}>`)
        .setImage(config.IMAGES.ROBUX_ENVIADOS);

    await safeReply(interaction, { embeds: [embed] });

    // Rename channel
    try {
        const member   = ownerId ? await interaction.guild.members.fetch(ownerId).catch(() => null) : null;
        const cleanName = (member?.user.username ?? 'usuario').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'usuario';
        await interaction.channel.setName(`✅-pago-${cleanName}`);
    } catch (err) {
        console.error('[buttons] rename failed:', err.message);
    }

    // Countdown auto-close
    let mins = 10;
    let countdownMsg = null;
    try {
        countdownMsg = await interaction.channel.send(`${mention}⏳ Este ticket se cerrará automáticamente en **${mins} minutos**...`);
    } catch {}

    const interval = setInterval(async () => {
        mins--;
        if (mins <= 0) return; // handled by timeout below
        try { await countdownMsg?.edit(`${mention}⏳ Este ticket se cerrará automáticamente en **${mins} minutos**...`); }
        catch {}
    }, config.TIMEOUTS.COUNTDOWN_TICK_MS);

    const timeout = setTimeout(async () => {
        clearTimers(channelId);
        try { await interaction.channel.delete(); } catch (err) { console.error('[buttons] delete failed:', err.message); }
    }, config.TIMEOUTS.PAYMENT_CLOSE_MS);

    timers.set(channelId, { interval, timeout });
}

async function onMostrarPrecios(interaction) {
    if (!await safeDeferReply(interaction)) return;
    try {
        await sendPricesTo(interaction.channel);
        await safeEditReply(interaction, { content: '✅ Precios mostrados.' });
    } catch (err) {
        console.error('[buttons] mostrar_precios error:', err.message);
    }
}

async function onCerrarTicket(interaction) {
    const channelId = interaction.channelId;
    const ownerId   = tickets.getOwner(channelId);
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

    await safeReply(interaction, { embeds: [embed], components: [row] });
}

async function onConfirmarCerrar(interaction) {
    const channelId = interaction.channelId;
    const ownerId   = tickets.getOwner(channelId);
    if (interaction.user.id !== ownerId && interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ Solo el creador del ticket o el owner pueden cerrarlo.', ephemeral: true });
    }

    if (isLocked(`cerrar:${channelId}`)) {
        return safeReply(interaction, { content: '⏳ El ticket ya se está cerrando.', ephemeral: true });
    }
    lock(`cerrar:${channelId}`, 10000);

    await safeReply(interaction, { content: '🔒 Cerrando ticket en 5 segundos...' });

    setTimeout(async () => {
        clearTimers(channelId);
        try { await interaction.channel.delete(); }
        catch (err) { console.error('[buttons] close-delete failed:', err.message); }
    }, config.TIMEOUTS.MANUAL_CLOSE_MS);
}

async function onCancelarCerrar(interaction) {
    const channelId = interaction.channelId;
    const ownerId   = tickets.getOwner(channelId);
    if (interaction.user.id !== ownerId && interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ Solo el creador del ticket o el owner pueden cancelar.', ephemeral: true });
    }
    try { await interaction.message.delete(); } catch {}
    await safeReply(interaction, { content: '✅ Cierre del ticket cancelado.', ephemeral: true });
}

// ── Router ────────────────────────────────────────────────────────────────────

const HANDLERS = {
    comprar:          onComprar,
    precios:          onPrecios,
    otra_cosa:        onOtraCosa,
    confirmar_pago:   onConfirmarPago,
    mostrar_precios:  onMostrarPrecios,
    cerrar_ticket:    onCerrarTicket,
    confirmar_cerrar: onConfirmarCerrar,
    cancelar_cerrar:  onCancelarCerrar,
};

async function handleButton(interaction) {
    const fn = HANDLERS[interaction.customId];
    if (!fn) return;
    try {
        await fn(interaction);
    } catch (err) {
        console.error(`[button:${interaction.customId}] Unhandled error:`, err);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ Ocurrió un error. Intenta de nuevo.', ephemeral: true }).catch(() => {});
        }
    }
}

module.exports = { handleButton, clearTimers };
