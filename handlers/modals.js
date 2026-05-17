'use strict';

const fs = require('fs');
const {
    ModalBuilder, TextInputBuilder, TextInputStyle,
    ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { safeDeferReply, safeEditReply } = require('../utils/safe');
const { isLocked, lock }                = require('../utils/spam');
const tickets                           = require('../utils/tickets');
const { lookup, extractNumber, MIN, MAX } = require('../data/prices');
const config                            = require('../config');

const OXXO_EXISTS = fs.existsSync('./oxxo.jpg');

// ── Modal builders (exported so buttons.js can show them) ─────────────────────

function buildComprarModal() {
    const modal = new ModalBuilder().setCustomId('comprar_modal').setTitle('Compra de Robux');
    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('usuario_roblox').setLabel('Usuario de Roblox').setStyle(TextInputStyle.Short).setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('cantidad_robux').setLabel('Cantidad de Robux').setStyle(TextInputStyle.Short).setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('es_miembro').setLabel('¿Eres miembro de 7x Studio? (Sí/No)').setStyle(TextInputStyle.Short).setRequired(true)
        )
    );
    return modal;
}

function buildOtraCosaModal() {
    const modal = new ModalBuilder().setCustomId('otra_cosa_modal').setTitle('Soporte / Otra cosa');
    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('motivo_ticket')
                .setLabel('¿Por qué estás creando este ticket?')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(500)
        )
    );
    return modal;
}

// ── Shared UI helpers ─────────────────────────────────────────────────────────

function closeBtnRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('cerrar_ticket').setLabel('Cerrar Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒')
    );
}

function confirmBtnRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirmar_pago').setLabel('✅ PAGO REALIZADO (SOLO OWNER)').setStyle(ButtonStyle.Success)
    );
}

// ── Counter (resets on restart — Discord allows duplicate channel names) ──────
let comprarN = 1;
let soporteN = 1;
function pad(n) { return String(n).padStart(4, '0'); }

// ── Comprar modal handler ─────────────────────────────────────────────────────

async function handleComprarModal(interaction) {
    // Immediately defer — avoids "interaction expired" if ticket creation takes time
    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    const userId = interaction.user.id;

    // Anti-spam: block concurrent modal submits from the same user
    if (isLocked(`modal:${userId}`)) {
        return safeEditReply(interaction, { content: '⏳ Espera un momento antes de intentar de nuevo.' });
    }
    lock(`modal:${userId}`, config.TIMEOUTS.LOCK_MS);

    try {
        if (await tickets.hasActiveTicket(interaction.guild, userId)) {
            return safeEditReply(interaction, { content: '❌ Ya tienes un ticket abierto. Cierra el anterior antes de crear uno nuevo.' });
        }

        const robloxUser  = interaction.fields.getTextInputValue('usuario_roblox').trim();
        const cantidadRaw = interaction.fields.getTextInputValue('cantidad_robux');
        const esMiembro   = interaction.fields.getTextInputValue('es_miembro').trim();

        const amount = extractNumber(cantidadRaw);
        if (!amount) {
            return safeEditReply(interaction, { content: '❌ Escribe un número válido para la cantidad de Robux. (Ejemplo: 1500)' });
        }

        const priceData = lookup(amount);
        if (!priceData) {
            return safeEditReply(interaction, {
                content: `❌ Monto no disponible. Elige una cantidad entre **${MIN.toLocaleString()}** y **${MAX.toLocaleString()}** robux.`,
            });
        }

        const { amount: finalAmount, price: priceText, rounded } = priceData;

        const channel = await tickets.createTicket(interaction.guild, userId, 'comprar', `comprar-${pad(comprarN++)}`);

        // ── Welcome embed
        const welcomeDesc =
            `<@${userId}>\n\n` +
            'Este ticket es **automático** y será procesado por el bot.\n' +
            '**No es necesario esperar a un staff** — sigue los pasos indicados.\n\n' +
            '━━━━━━━━━━━━━━━━━━━━\n\n' +
            `**Tipo de ticket**\n\`\`\`Compra de Robux\`\`\`\n` +
            `**Usuario de Roblox**\n\`\`\`${robloxUser}\`\`\`\n` +
            `**¿Miembro de 7x Studio?**\n\`\`\`${esMiembro}\`\`\`\n` +
            `**Cantidad**\n\`\`\`${finalAmount.toLocaleString()} Robux\`\`\`` +
            (rounded ? `\n\n⚠️ Tu monto fue redondeado a **${finalAmount.toLocaleString()} robux**.` : '');

        const embedWelcome = new EmbedBuilder().setColor(0x000000).setTitle('🎫 ¡Bienvenido a tu ticket de compra!').setDescription(welcomeDesc)
            .setFooter({ text: '7x Community • Proceso automático' });

        // ── Payment embed
        const embedPago = new EmbedBuilder()
            .setColor(0x000000)
            .setTitle('💳 MÉTODOS DE PAGO')
            .setDescription('Elige tu método de pago y completa tu compra de forma segura.')
            .addFields(
                { name: '📋 Resumen', value: `**${finalAmount.toLocaleString()} Robux** → **${priceText} MXN**`, inline: false },
                { name: '🏦 TRANSFERENCIA', value: '**CUENTA 1:**\n```722969040869278041```\n**MERCADO PAGO**\nVICENTA MARIANO VALDOVINOS', inline: false },
                { name: '🏪 DEPÓSITO OXXO', value: 'Consulta los datos de OXXO en la imagen adjunta.', inline: false },
                { name: '📞 OTROS MÉTODOS', value: `Consulta <#${config.CHANNELS.METODOS}>`, inline: false }
            );
        if (OXXO_EXISTS) embedPago.setImage('attachment://oxxo.jpg');

        const embedSteps = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle('⏳ SIGUIENTES PASOS')
            .setDescription(
                '1. Realiza el pago por el monto exacto.\n' +
                '2. Envía la **FOTO DEL COMPROBANTE** aquí mismo.\n' +
                '3. Escribe **PAGO EXITOSO** para confirmar.'
            );

        await channel.send({ embeds: [embedWelcome], components: [closeBtnRow()] });

        if (OXXO_EXISTS) {
            await channel.send({ embeds: [embedPago], files: [{ attachment: 'oxxo.jpg', name: 'oxxo.jpg' }] });
        } else {
            await channel.send({ embeds: [embedPago] });
        }

        await channel.send({ embeds: [embedSteps] });
        await channel.send({ components: [confirmBtnRow()] });

        await safeEditReply(interaction, { content: `✅ Ticket creado: ${channel}` });
    } catch (err) {
        console.error('[modal:comprar] Error:', err);
        await safeEditReply(interaction, { content: `❌ Error al crear el ticket: ${err.message}` });
    }
}

// ── Soporte modal handler ─────────────────────────────────────────────────────

async function handleOtraCosaModal(interaction) {
    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    const userId = interaction.user.id;

    if (isLocked(`modal:${userId}`)) {
        return safeEditReply(interaction, { content: '⏳ Espera un momento antes de intentar de nuevo.' });
    }
    lock(`modal:${userId}`, config.TIMEOUTS.LOCK_MS);

    try {
        if (await tickets.hasActiveTicket(interaction.guild, userId)) {
            return safeEditReply(interaction, { content: '❌ Ya tienes un ticket abierto. Cierra el anterior antes de crear uno nuevo.' });
        }

        const motivo  = interaction.fields.getTextInputValue('motivo_ticket');
        const channel = await tickets.createTicket(interaction.guild, userId, 'soporte', `soporte-${pad(soporteN++)}`);

        const embed = new EmbedBuilder()
            .setColor(0x000000)
            .setTitle('🎫 ¡Bienvenido a tu ticket de soporte!')
            .setDescription(
                `<@${userId}>\n\n` +
                'Tu ticket ha sido creado correctamente.\n' +
                'Un miembro del staff lo revisará lo antes posible.\n\n' +
                '━━━━━━━━━━━━━━━━━━━━\n\n' +
                `**Motivo**\n\`\`\`${motivo}\`\`\``
            );

        await channel.send({ embeds: [embed], components: [closeBtnRow()] });
        await safeEditReply(interaction, { content: `✅ Ticket creado: ${channel}` });
    } catch (err) {
        console.error('[modal:soporte] Error:', err);
        await safeEditReply(interaction, { content: `❌ Error al crear el ticket: ${err.message}` });
    }
}

// ── Router ────────────────────────────────────────────────────────────────────

const HANDLERS = {
    comprar_modal:   handleComprarModal,
    otra_cosa_modal: handleOtraCosaModal,
};

async function handleModal(interaction) {
    const fn = HANDLERS[interaction.customId];
    if (!fn) return;
    try {
        await fn(interaction);
    } catch (err) {
        console.error(`[modal:${interaction.customId}] Unhandled error:`, err);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '❌ Ocurrió un error. Intenta de nuevo.', ephemeral: true }).catch(() => {});
        }
    }
}

module.exports = { handleModal, buildComprarModal, buildOtraCosaModal };
