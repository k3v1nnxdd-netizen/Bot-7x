'use strict';

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { safeReply, safeEditReply, safeDeferReply, safeShowModal } = require('../utils/safe');
const { isLocked, lock } = require('../utils/spam');
const tickets = require('../utils/tickets');
const config = require('../config');

let seguidoresN = 1;
function pad(n) { return String(n).padStart(4, '0'); }

// Channels where the quantity has already been submitted — answer only once per ticket.
const qtySubmitted = new Set();

// Rate = price (MXN) per single follower, derived from the published per-1000 prices.
const PLATFORMS = {
    instagram: { label: 'INSTAGRAM', emoji: '<:insta:1525317982518251690>',  hasQuality: true,  rates: { normal: 0.05, premium: 0.06 } },
    tiktok:    { label: 'TIK TOK',   emoji: '<:ttk:1525317575783743580>',    hasQuality: true,  rates: { normal: 0.10, premium: 0.15 } },
    roblox:    { label: 'ROBLOX',    emoji: '<:roblox:1525317838938701967>', hasQuality: false, rate: 0.174 },
};

function closeBtnRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('cerrar_ticket')
            .setLabel('Cerrar Ticket')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🔒')
    );
}

function fmtMoney(n) {
    return Math.round(n).toLocaleString('es-MX');
}

function fmtQty(n) {
    return n.toLocaleString('es-MX');
}

function isTicketChannelOwnedBy(channel, userId) {
    return channel?.parentId === config.CATEGORIES.TICKETS && tickets.getOwner(channel) === userId;
}

// ── Step 1: panel button click → create ticket, ask platform ─────────────────

function buildPlatformEmbed(userId) {
    return new EmbedBuilder()
        .setColor(0x000000)
        .setTitle('SEGUIDORES')
        .setDescription(
            `Hola, <@${userId}>, has abierto un ticket para comprar seguidores.\n\n` +
            'A continuación, dinos de qué plataforma quieres tus seguidores.'
        )
        .setFooter({ text: '7x Community • Seguidores' });
}

function buildPlatformRow() {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('seg_platform_select')
            .setPlaceholder('Selecciona una plataforma')
            .addOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel('INSTAGRAM')
                    .setDescription('Comprar seguidores de Instagram')
                    .setValue('instagram')
                    .setEmoji(PLATFORMS.instagram.emoji),
                new StringSelectMenuOptionBuilder()
                    .setLabel('TIK TOK')
                    .setDescription('Comprar seguidores de TikTok')
                    .setValue('tiktok')
                    .setEmoji(PLATFORMS.tiktok.emoji),
                new StringSelectMenuOptionBuilder()
                    .setLabel('ROBLOX')
                    .setDescription('Comprar seguidores de Roblox')
                    .setValue('roblox')
                    .setEmoji(PLATFORMS.roblox.emoji),
            )
    );
}

async function startSeguidoresTicket(interaction) {
    if (interaction.replied || interaction.deferred) return;

    const userId = interaction.user.id;

    if (isLocked(`btn:seguidores:${userId}`)) {
        return safeReply(interaction, { content: '⏳ Espera un momento antes de intentar de nuevo.', ephemeral: true });
    }
    lock(`btn:seguidores:${userId}`, config.TIMEOUTS.LOCK_MS);

    if (await tickets.hasActiveTicket(interaction.guild, userId)) {
        return safeReply(interaction, { content: '❌ Ya tienes un ticket abierto. Cierra el anterior antes de crear otro.', ephemeral: true });
    }

    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    try {
        const channel = await tickets.createTicket(interaction.guild, userId, 'seguidores', `seguidores-${pad(seguidoresN++)}`);
        await channel.send({
            content: `<@${userId}>`,
            embeds: [buildPlatformEmbed(userId)],
            components: [buildPlatformRow()],
        });
        await safeEditReply(interaction, { content: `✅ Ticket creado: ${channel}` });
    } catch (err) {
        console.error('[seguidores] ticket creation error:', err);
        const msg = err?.code === 'TICKET_EXISTS'
            ? '❌ Ya tienes un ticket abierto o se esta creando uno.'
            : `❌ Error al crear el ticket: ${err.message}`;
        await safeEditReply(interaction, { content: msg });
    }
}

// ── Step 2: platform chosen (select menu) → ask quantity ─────────────────────

function buildQtyRow(platformKey, disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`seg_askqty_${platformKey}`)
            .setLabel('Escribir cantidad')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('✏️')
            .setDisabled(disabled)
    );
}

async function handlePlatformSelect(interaction) {
    if (interaction.customId !== 'seg_platform_select') return;

    if (!isTicketChannelOwnedBy(interaction.channel, interaction.user.id)) {
        return safeReply(interaction, { content: '❌ Solo el creador del ticket puede elegir la plataforma.', ephemeral: true });
    }

    const platformKey = interaction.values[0];
    const platform = PLATFORMS[platformKey];
    if (!platform) return;

    const disabledSelect = StringSelectMenuBuilder
        .from(interaction.message.components[0].components[0])
        .setDisabled(true);
    await interaction.update({ components: [new ActionRowBuilder().addComponents(disabledSelect)] }).catch(() => {});

    const embed = new EmbedBuilder()
        .setColor(0x000000)
        .setTitle('¿Cuántos seguidores quieres?')
        .setDescription(
            `Plataforma seleccionada: ${platform.emoji} **${platform.label}**\n\n` +
            'Presiona el botón de abajo para escribir la cantidad de seguidores que deseas.'
        )
        .setFooter({ text: '7x Community • Seguidores' });

    await interaction.channel.send({ embeds: [embed], components: [buildQtyRow(platformKey)] });
}

// ── Step 3: quantity button → show modal ──────────────────────────────────────

function buildQtyModal(platformKey) {
    const platform = PLATFORMS[platformKey];
    const modal = new ModalBuilder().setCustomId(`seg_qty_modal_${platformKey}`).setTitle(`Seguidores — ${platform.label}`);
    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('cantidad_seguidores')
                .setLabel('¿Cuántos seguidores quieres?')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Ej: 3500')
                .setRequired(true)
        )
    );
    return modal;
}

async function handleAskQtyButton(interaction, platformKey) {
    if (!isTicketChannelOwnedBy(interaction.channel, interaction.user.id)) {
        return safeReply(interaction, { content: '❌ Solo el creador del ticket puede continuar.', ephemeral: true });
    }
    if (qtySubmitted.has(interaction.channelId)) {
        return safeReply(interaction, { content: '❌ Ya indicaste la cantidad de seguidores para este ticket.', ephemeral: true });
    }
    await safeShowModal(interaction, buildQtyModal(platformKey));
}

// ── Step 4: quantity submitted → calculate price(s) ───────────────────────────

function extractQty(raw) {
    const digits = (raw || '').replace(/[^\d]/g, '');
    if (!digits) return null;
    const n = parseInt(digits, 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
}

async function handleQtyModal(interaction, platformKey) {
    if (interaction.replied || interaction.deferred) return;

    if (!isTicketChannelOwnedBy(interaction.channel, interaction.user.id)) {
        return safeReply(interaction, { content: '❌ Solo el creador del ticket puede continuar.', ephemeral: true });
    }

    const platform = PLATFORMS[platformKey];
    if (!platform) return;

    // Answer-once guard — blocks a second submit even if two modals were open at once
    if (qtySubmitted.has(interaction.channelId)) {
        return safeReply(interaction, { content: '❌ Ya indicaste la cantidad de seguidores para este ticket.', ephemeral: true });
    }

    const qty = extractQty(interaction.fields.getTextInputValue('cantidad_seguidores'));
    if (!qty) {
        return safeReply(interaction, { content: '❌ Escribe una cantidad válida de seguidores. Ejemplo: 3500', ephemeral: true });
    }

    qtySubmitted.add(interaction.channelId);

    // Disable the "Escribir cantidad" button on the source message (modal was opened from it)
    if (interaction.isFromMessage()) {
        await interaction.update({ components: [buildQtyRow(platformKey, true)] }).catch(() => {});
    } else {
        await safeDeferReply(interaction, { ephemeral: true });
    }

    if (!platform.hasQuality) {
        const price = qty * platform.rate;
        await sendFinalInfo(interaction.channel, interaction.user.id, platform.label, qty, price);
    } else {
        const normalPrice  = qty * platform.rates.normal;
        const premiumPrice = qty * platform.rates.premium;

        const embed = new EmbedBuilder()
            .setColor(0x000000)
            .setTitle('Elige la calidad')
            .setDescription(
                `${platform.emoji} **${platform.label}** — ${fmtQty(qty)} seguidores\n\n` +
                `${fmtQty(qty)} seguidores (Calidad Normal): **$${fmtMoney(normalPrice)} MXN**\n` +
                `${fmtQty(qty)} seguidores (Calidad Premium): **$${fmtMoney(premiumPrice)} MXN**`
            )
            .setFooter({ text: '7x Community • Seguidores' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`seg_quality_${platformKey}_normal_${qty}_${Math.round(normalPrice)}`)
                .setLabel(`Calidad Normal — $${fmtMoney(normalPrice)} MXN`)
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`seg_quality_${platformKey}_premium_${qty}_${Math.round(premiumPrice)}`)
                .setLabel(`Calidad Premium — $${fmtMoney(premiumPrice)} MXN`)
                .setStyle(ButtonStyle.Primary),
        );

        await interaction.channel.send({ embeds: [embed], components: [row] });
    }

    if (interaction.deferred) {
        await safeEditReply(interaction, { content: '✅ Cantidad registrada.' });
    }
}

// ── Step 5: quality chosen → final order summary ──────────────────────────────

async function handleQualityChoice(interaction, platformKey, quality, qty, price) {
    if (interaction.replied || interaction.deferred) return;

    if (!isTicketChannelOwnedBy(interaction.channel, interaction.user.id)) {
        return safeReply(interaction, { content: '❌ Solo el creador del ticket puede elegir la calidad.', ephemeral: true });
    }

    await interaction.update({ components: [] }).catch(() => {});

    const platform = PLATFORMS[platformKey];
    if (!platform) return;
    const qualityLabel = quality === 'premium' ? 'Premium' : 'Normal';
    await sendFinalInfo(interaction.channel, interaction.user.id, `${platform.label} (Calidad ${qualityLabel})`, qty, price);
}

async function sendFinalInfo(channel, userId, platformLabel, qty, price) {
    const embed = new EmbedBuilder()
        .setColor(0x000000)
        .setTitle('Resumen de tu pedido')
        .setDescription(
            `<:member:1501261625523699892> **Usuario de Discord**\n<@${userId}>\n\n` +
            `<a:boost:1525333836181934081> **Plataforma**\n\`\`\`${platformLabel}\`\`\`\n` +
            `<:followers7x:1525326777071960124> **Seguidores solicitados**\n\`\`\`${fmtQty(qty)}\`\`\`\n` +
            `<:money:1501213606077792266> **Precio a pagar**\n\`\`\`$${fmtMoney(price)} MXN\`\`\`\n\n` +
            'Una vez realices el pago, envía tu **comprobante** en este ticket para que el staff lo revise.'
        )
        .setFooter({ text: '7x Community • Seguidores' })
        .setTimestamp();

    await channel.send({ content: `<@${userId}>`, embeds: [embed], components: [closeBtnRow()] });
}

// ── Routers (called from handlers/buttons.js and handlers/modals.js) ─────────

async function handleSeguidoresButton(interaction) {
    if (interaction.replied || interaction.deferred) return;
    const id = interaction.customId;

    if (id.startsWith('seg_askqty_')) {
        return handleAskQtyButton(interaction, id.slice('seg_askqty_'.length));
    }
    if (id.startsWith('seg_quality_')) {
        const [platformKey, quality, qtyStr, priceStr] = id.slice('seg_quality_'.length).split('_');
        return handleQualityChoice(interaction, platformKey, quality, parseInt(qtyStr, 10), parseInt(priceStr, 10));
    }
}

async function handleSeguidoresModal(interaction) {
    if (interaction.replied || interaction.deferred) return;
    const id = interaction.customId;

    if (id.startsWith('seg_qty_modal_')) {
        return handleQtyModal(interaction, id.slice('seg_qty_modal_'.length));
    }
}

async function handleSeguidoresSelect(interaction) {
    if (interaction.customId === 'seg_platform_select') {
        return handlePlatformSelect(interaction);
    }
}

module.exports = { startSeguidoresTicket, handleSeguidoresButton, handleSeguidoresModal, handleSeguidoresSelect };
