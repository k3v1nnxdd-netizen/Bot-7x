'use strict';

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { safeReply, safeEditReply, safeDeferReply, safeShowModal } = require('../utils/safe');
const { isLocked, lock } = require('../utils/spam');
const { isValidUsername } = require('../utils/groupMembership');
const headlessSale = require('../utils/headlessSale');
const tickets = require('../utils/tickets');
const config = require('../config');
const { buildMetodosEmbed, buildMetodosRow } = require('../metodos');

// ── Ticket del Headless Horseman ──────────────────────────────────────────────
// Es un ticket de compra de Robux normal, con dos diferencias y sólo dos:
//
//   1. No se pregunta nada más que el usuario de Roblox. La cantidad
//      (config.HEADLESS.ROBUX) y el precio (config.HEADLESS.PRECIO_MXN) son
//      fijos: es una oferta cerrada, no una compra a medida.
//   2. Sólo se puede abrir con la venta ABIERTA (/headless on).
//
// El tipo de ticket que se guarda es 'comprar', no 'headless', y eso es
// deliberado: de ese tipo cuelga TODO lo que viene después — el botón de "PAGO
// REALIZADO" del owner (que rechaza cualquier otro tipo), el "PAGO EXITOSO"
// escrito por el cliente, el registro en el canal de pedidos y el ranking de
// compradores. Inventar un tipo nuevo dejaría el ticket a medio funcionar. Lo
// que lo distingue a la vista es el nombre del canal: headless-0001.
//
// Por lo mismo, el embed de resumen usa LAS MISMAS etiquetas que el de compra
// normal ("Usuario de Roblox", "Robux a recibir", "Precio a pagar"): es de ahí
// de donde utils/orderNotify.js saca los Robux y el precio para el ranking.

const ACCENT_NARANJA = 0xFF8C00;

const H = config.HEADLESS;
const fmt = n => n.toLocaleString('es-MX');

let headlessN = 1;
function pad(n) { return String(n).padStart(4, '0'); }

const VENTA_CERRADA =
    '<:alert:1501220021035204658> **El Headless Horseman todavía no está a la venta.**\n' +
    'Aún no hemos abierto esta promoción — espera un poco más de tiempo y vuelve a intentarlo. ' +
    'En cuanto se abra podrás comprarlo desde este mismo botón.';

// ── Paso 1: botón "Comprar" → pedir el usuario de Roblox ─────────────────────

function buildHeadlessModal() {
    const modal = new ModalBuilder()
        .setCustomId('headless_modal')
        .setTitle('Headless Horseman — 7x');

    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('usuario_roblox')
                .setLabel('¿Cuál es tu usuario de Roblox?')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Ej: PlayerName123')
                .setMinLength(3)
                .setMaxLength(20)
                .setRequired(true)
        )
    );
    return modal;
}

async function handleHeadlessButton(interaction) {
    if (interaction.replied || interaction.deferred) return;

    const userId = interaction.user.id;

    // La venta se comprueba ANTES que nada: con la promoción cerrada no se abre
    // formulario, no se reserva ticket y no se toca ningún candado.
    if (!headlessSale.isOpen()) {
        return safeReply(interaction, { content: VENTA_CERRADA, ephemeral: true });
    }

    if (isLocked(`btn:headless:${userId}`)) {
        return safeReply(interaction, { content: '⏳ Espera un momento antes de intentar de nuevo.', ephemeral: true });
    }
    lock(`btn:headless:${userId}`, config.TIMEOUTS.LOCK_MS);

    if (await tickets.hasActiveTicket(interaction.guild, userId)) {
        return safeReply(interaction, { content: '❌ Ya tienes un ticket abierto. Cierra el anterior antes de crear otro.', ephemeral: true });
    }

    const ok = await safeShowModal(interaction, buildHeadlessModal());
    if (!ok) await safeReply(interaction, { content: '❌ No se pudo abrir el formulario. Intenta de nuevo.', ephemeral: true });
}

// ── Paso 2: usuario enviado → crear el ticket ────────────────────────────────

function closeBtnRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('cerrar_ticket')
            .setLabel('Cerrar Ticket')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🔒')
    );
}

function confirmBtnRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('confirmar_pago')
            .setLabel('✅ PAGO REALIZADO (SOLO OWNER)')
            .setStyle(ButtonStyle.Success)
    );
}

function buildResumenEmbed(robloxUser, avatarURL) {
    const comunidades = H.COMUNIDADES.map(c => `<:followers7x:1525326777071960124> [**${c.label}**](${c.link})`).join('\n');

    return new EmbedBuilder()
        .setColor(ACCENT_NARANJA)
        .setTitle('Resumen de tu compra — Headless Horseman')
        .setThumbnail(avatarURL)
        .setDescription(
            `<:member:1501261625523699892> **Usuario de Roblox**\n\`\`\`${robloxUser}\`\`\`\n` +
            `<a:robuxxx:1510070809366892604> **Robux a recibir**\n\`\`\`${fmt(H.ROBUX)} Robux\`\`\`\n` +
            `<:money:1544123920897019906> **Precio a pagar**\n\`\`\`$${fmt(H.PRECIO_MXN)} MXN\`\`\`\n` +
            `<:Headlesss:1546349270486220976> **Promoción**\n\`\`\`Headless Horseman — paquete fijo\`\`\`\n` +
            `<:alert:1501220021035204658> **Requisito**\nDebes llevar **${H.DIAS_REQ} días** dentro de ambas comunidades para poder recibir los Robux:\n${comunidades}`
        )
        .setFooter({ text: '7x Community • Proceso automático' })
        .setTimestamp();
}

function buildPasosEmbed() {
    return new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('Pago Pendiente')
        .setDescription(
            'Selecciona tu método de pago en el menú de arriba.\n\n' +
            `Realiza el pago por el monto exacto: **$${fmt(H.PRECIO_MXN)} MXN**.\n\n` +
            'Envía la **foto del comprobante** en este ticket.\n\n' +
            'Escribe **PAGO EXITOSO** para que procesemos tu orden.'
        )
        .setFooter({ text: '7x Community • Proceso automático' });
}

function ticketErrorMsg(err) {
    return err?.code === 'TICKET_EXISTS'
        ? '❌ Ya tienes un ticket abierto o se esta creando uno. Cierra el anterior antes de crear otro.'
        : `❌ Error al crear el ticket: ${err.message}`;
}

async function handleHeadlessModal(interaction) {
    if (interaction.replied || interaction.deferred) return;
    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    const userId = interaction.user.id;

    if (isLocked(`modal:${userId}`)) {
        return safeEditReply(interaction, { content: '⏳ Espera un momento antes de intentar de nuevo.' });
    }
    lock(`modal:${userId}`, config.TIMEOUTS.LOCK_MS);

    // Se vuelve a mirar: entre abrir el formulario y enviarlo el owner puede
    // haber cerrado la venta, y ese es el estado que manda.
    if (!headlessSale.isOpen()) {
        return safeEditReply(interaction, { content: VENTA_CERRADA });
    }

    try {
        if (await tickets.hasActiveTicket(interaction.guild, userId)) {
            return safeEditReply(interaction, { content: '❌ Ya tienes un ticket abierto. Cierra el anterior antes de crear otro.' });
        }

        const robloxUser = interaction.fields.getTextInputValue('usuario_roblox').trim();
        if (!isValidUsername(robloxUser)) {
            return safeEditReply(interaction, { content: '❌ Un usuario de Roblox son 3-20 caracteres: letras, números y guion bajo.' });
        }

        const channel = await tickets.createTicket(interaction.guild, userId, 'comprar', `headless-${pad(headlessN++)}`);

        // ── Mensaje 1: resumen del pedido ─────────────────────────────────────
        await channel.send({
            content: `<@${userId}>`,
            embeds: [buildResumenEmbed(robloxUser, interaction.user.displayAvatarURL({ size: 256 }))],
            components: [closeBtnRow()],
        });

        // ── Mensaje 2: métodos de pago ────────────────────────────────────────
        await channel.send({
            embeds: [buildMetodosEmbed()],
            components: [buildMetodosRow()],
        });

        // ── Mensaje 3: pago pendiente ─────────────────────────────────────────
        await channel.send({ embeds: [buildPasosEmbed()] });

        // ── Mensaje 4: botón de confirmación del owner ────────────────────────
        await channel.send({ components: [confirmBtnRow()] });

        await safeEditReply(interaction, { content: `✅ Ticket creado: ${channel}` });
    } catch (err) {
        console.error('[headless] Error al crear el ticket:', err);
        await safeEditReply(interaction, { content: ticketErrorMsg(err) });
    }
}

module.exports = {
    handleHeadlessButton,
    handleHeadlessModal,
    __test: { buildHeadlessModal, buildResumenEmbed, buildPasosEmbed, VENTA_CERRADA, ACCENT_NARANJA },
};
