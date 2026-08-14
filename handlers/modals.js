'use strict';

const fs = require('fs');
const {
    ModalBuilder, TextInputBuilder, TextInputStyle,
    ActionRowBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle,
} = require('discord.js');
const { isGone, safeDeferReply, safeEditReply, safeReply } = require('../utils/safe');
const { isLocked, lock }                                   = require('../utils/spam');
const tickets                                              = require('../utils/tickets');
const { lookup, extractNumber, lookupByBudget, extractDecimal, MIN, MAX, MIN_PRICE } = require('../data/prices');
const { getCoupon, isValid: isCouponValid, useCoupon } = require('../utils/coupons');
const { refreshCouponEmbed } = require('./commands');
const reviews                                               = require('../utils/reviews');
const { finalizeReview }                                    = require('../utils/reviewFlow');
const roblox                                               = require('../src/roblox/client');
const { getJoinDate, getLastChecked, trackIfNew, updateLastChecked, daysSince } = require('../utils/groupTracker');
const config                                               = require('../config');
const { buildMetodosEmbed, buildMetodosRow }               = require('../metodos');
const { handleSeguidoresModal }                             = require('./seguidoresFlow');
const { handleCheckGroupModal }                             = require('./checkGroupFlow');

// ── Modal builders ────────────────────────────────────────────────────────────
// These are exported so buttons.js can pass them to safeShowModal().
// They never send messages — they only build the modal object.

function buildComprarModal() {
    const modal = new ModalBuilder().setCustomId('comprar_modal').setTitle('Compra de Robux');
    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('usuario_roblox')
                .setLabel('Usuario de Roblox')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('cantidad_robux')
                .setLabel('Cantidad de Robux')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('es_miembro')
                .setLabel('¿Perteneces a una comunidad de Robux? (Sí/No)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('codigo_descuento')
                .setLabel('Código de descuento (Solo si tienes uno)')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setPlaceholder('Ej: PROMO20')
        )
    );
    return modal;
}

function buildCalcDineroModal() {
    const modal = new ModalBuilder().setCustomId('calc_dinero_modal').setTitle('¿Cuánto dinero tienes?');
    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('presupuesto')
                .setLabel('Cantidad de dinero disponible (MXN)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Ej: 500 o 150.50')
                .setRequired(true)
        )
    );
    return modal;
}

function buildCalcRobuxModal() {
    const modal = new ModalBuilder().setCustomId('calc_robux_modal').setTitle('¿Cuántos Robux quieres?');
    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('cantidad_robux')
                .setLabel('Cantidad de Robux')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Ej: 1500')
                .setRequired(true)
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

function buildDuelsModal() {
    const modal = new ModalBuilder().setCustomId('duels_modal').setTitle('Compra de Duels');
    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('set_duels')
                .setLabel('¿Qué set deseas adquirir en Duels?')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('usuario_roblox_duels')
                .setLabel('¿Cuál es tu usuario de Roblox?')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
        )
    );
    return modal;
}

// ── Shared UI helpers ─────────────────────────────────────────────────────────

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

// Counter resets on restart — Discord allows duplicate channel names
let comprarN = 1;
let soporteN = 1;
let duelsN = 1;
function pad(n) { return String(n).padStart(4, '0'); }

function ticketErrorMsg(err) {
    return err?.code === 'TICKET_EXISTS'
        ? '❌ Ya tienes un ticket abierto o se esta creando uno. Cierra el anterior antes de crear otro.'
        : `❌ Error al crear el ticket: ${err.message}`;
}

// ── Comprar modal handler ─────────────────────────────────────────────────────

async function handleComprarModal(interaction) {
    // Hard stop — modal submits arrive fresh, but guard anyway
    if (interaction.replied || interaction.deferred) return;

    // Defer immediately to claim the 3-second token before ticket creation
    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    const userId = interaction.user.id;

    // Anti-concurrent-submit: block a second modal from the same user
    if (isLocked(`modal:${userId}`)) {
        return safeEditReply(interaction, { content: '⏳ Espera un momento antes de intentar de nuevo.' });
    }
    lock(`modal:${userId}`, config.TIMEOUTS.LOCK_MS);

    try {
        if (await tickets.hasActiveTicket(interaction.guild, userId)) {
            return safeEditReply(interaction, { content: '❌ Ya tienes un ticket abierto. Cierra el anterior antes de crear otro.' });
        }

        const robloxUser  = interaction.fields.getTextInputValue('usuario_roblox').trim();
        const cantidadRaw = interaction.fields.getTextInputValue('cantidad_robux');
        const esMiembro   = interaction.fields.getTextInputValue('es_miembro').trim();
        const codigoRaw   = interaction.fields.getTextInputValue('codigo_descuento').trim();

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

        // ── Coupon logic ──────────────────────────────────────────────────────
        const originalPriceNum = parseFloat(priceText.replace(/[$,]/g, ''));
        let couponApplied  = false;
        let couponInvalid  = false;
        let couponObj      = null;
        let finalPriceNum  = originalPriceNum;

        if (codigoRaw) {
            couponObj = getCoupon(codigoRaw);
            if (isCouponValid(codigoRaw, finalAmount)) {
                couponApplied = true;
                finalPriceNum = Math.round(originalPriceNum * (1 - couponObj.discount / 100));
            } else {
                couponInvalid = true;
            }
        }

        const channel = await tickets.createTicket(interaction.guild, userId, 'comprar', `comprar-${pad(comprarN++)}`);

        // Decrement coupon uses after ticket is created successfully, then refresh the offer embed
        if (couponApplied) {
            useCoupon(codigoRaw);
            refreshCouponEmbed(interaction.client, codigoRaw).catch(() => {});
        }

        // ── Mensaje 1: Información de la compra ───────────────────────────────
        const savedNum = originalPriceNum - finalPriceNum;

        let descLines =
            `<:member:1501261625523699892> **Usuario de Roblox**\n\`\`\`${robloxUser}\`\`\`\n` +
            `<a:robuxxx:1510070809366892604> **Robux a recibir**\n\`\`\`${finalAmount.toLocaleString()} Robux\`\`\`\n`;

        if (couponApplied) {
            descLines +=
                `<:money:1501213606077792266> **Precio original**\n\`\`\`${priceText} MXN\`\`\`\n` +
                `<:true:1501213776878501899> **Descuento aplicado — ${codigoRaw.toUpperCase()} (${couponObj.discount}%)**\n\`\`\`Ahorras $${savedNum} MXN\`\`\`\n` +
                `<:money:1501213606077792266> **Precio final a pagar**\n\`\`\`$${finalPriceNum} MXN\`\`\`\n`;
        } else if (couponInvalid) {
            descLines +=
                `<:alert:1501220021035204658> **Código usado: ${codigoRaw.toUpperCase()}**\n\`\`\`Inválido o sin usos disponibles\`\`\`\n` +
                `<:money:1501213606077792266> **Precio a pagar**\n\`\`\`${priceText} MXN\`\`\`\n`;
        } else {
            descLines +=
                `<:money:1501213606077792266> **Precio a pagar**\n\`\`\`${priceText} MXN\`\`\`\n`;
        }

        descLines += `<:truepurple:1501214679400190086> **¿Miembro de comunidad?**\n\`\`\`${esMiembro}\`\`\``;

        if (rounded) descLines += `\n\n<:alert:1501220021035204658> Tu monto fue redondeado a **${finalAmount.toLocaleString()} robux**.`;


        const embedWelcome = new EmbedBuilder()
            .setColor(0x2B2D31)
            .setTitle('Resumen de tu compra')
            .setThumbnail(interaction.user.displayAvatarURL({ size: 256 }))
            .setDescription(descLines)
            .setFooter({ text: '7x Community • Proceso automático' })
            .setTimestamp();

        await channel.send({
            content: `<@${userId}>`,
            embeds: [embedWelcome],
            components: [closeBtnRow()],
        });

        // ── Mensaje 2: Panel de métodos de pago (con dropdown) ────────────────
        await channel.send({
            embeds: [buildMetodosEmbed()],
            components: [buildMetodosRow()],
        });

        // ── Mensaje 3: Pago pendiente ─────────────────────────────────────────
        const embedSteps = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle('Pago Pendiente')
            .setDescription(
                'Selecciona tu método de pago en el menú de arriba.\n\n' +
                'Realiza el pago por el monto exacto.\n\n' +
                'Envía la **foto del comprobante** en este ticket.\n\n' +
                'Escribe **PAGO EXITOSO** para que procesemos tu orden.'
            )
            .setFooter({ text: '7x Community • Proceso automático' });

        await channel.send({ embeds: [embedSteps] });
        await channel.send({ components: [confirmBtnRow()] });

        await safeEditReply(interaction, { content: `✅ Ticket creado: ${channel}` });
    } catch (err) {
        console.error('[modal:comprar] Error:', err);
        await safeEditReply(interaction, { content: ticketErrorMsg(err) });
    }
}

// ── Soporte modal handler ─────────────────────────────────────────────────────

async function handleOtraCosaModal(interaction) {
    if (interaction.replied || interaction.deferred) return;
    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    const userId = interaction.user.id;

    if (isLocked(`modal:${userId}`)) {
        return safeEditReply(interaction, { content: '⏳ Espera un momento antes de intentar de nuevo.' });
    }
    lock(`modal:${userId}`, config.TIMEOUTS.LOCK_MS);

    try {
        if (await tickets.hasActiveTicket(interaction.guild, userId)) {
            return safeEditReply(interaction, { content: '❌ Ya tienes un ticket abierto. Cierra el anterior antes de crear otro.' });
        }

        const motivo  = interaction.fields.getTextInputValue('motivo_ticket');
        const channel = await tickets.createTicket(interaction.guild, userId, 'soporte', `soporte-${pad(soporteN++)}`);

        const embed = new EmbedBuilder()
            .setColor(0x2B2D31)
            .setTitle('🎫 ¡Bienvenido a tu ticket de soporte!')
            .setThumbnail(interaction.user.displayAvatarURL({ size: 256 }))
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
        await safeEditReply(interaction, { content: ticketErrorMsg(err) });
    }
}

// ── Duels modal handler ───────────────────────────────────────────────────────

async function handleDuelsModal(interaction) {
    if (interaction.replied || interaction.deferred) return;
    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    const userId = interaction.user.id;

    if (isLocked(`modal:${userId}`)) {
        return safeEditReply(interaction, { content: '⏳ Espera un momento antes de intentar de nuevo.' });
    }
    lock(`modal:${userId}`, config.TIMEOUTS.LOCK_MS);

    try {
        if (await tickets.hasActiveTicket(interaction.guild, userId)) {
            return safeEditReply(interaction, { content: '❌ Ya tienes un ticket abierto. Cierra el anterior antes de crear otro.' });
        }

        const set         = interaction.fields.getTextInputValue('set_duels').trim();
        const robloxUser  = interaction.fields.getTextInputValue('usuario_roblox_duels').trim();
        const channel     = await tickets.createTicket(interaction.guild, userId, 'duels', `duels-${pad(duelsN++)}`);

        const embed = new EmbedBuilder()
            .setColor(0x2B2D31)
            .setTitle('<:7xduels:1524947898264059995> Ticket de Duels')
            .setThumbnail(interaction.user.displayAvatarURL({ size: 256 }))
            .setDescription(
                `<@${userId}>\n\n` +
                'Tu ticket ha sido creado correctamente.\n' +
                'En un momento un miembro del staff te atenderá. Te pedimos paciencia.\n\n' +
                '━━━━━━━━━━━━━━━━━━━━\n\n' +
                `**Set solicitado**\n\`\`\`${set}\`\`\`\n` +
                `**Usuario de Roblox**\n\`\`\`${robloxUser}\`\`\`\n\n` +
                '<:alert:1501220021035204658> Es necesario enviar una **solicitud de amistad** en Roblox a la cuenta **Nooctraa** para continuar con el proceso.'
            )
            .setFooter({ text: '7x Community • Duels' });

        await channel.send({ embeds: [embed], components: [closeBtnRow()] });
        await safeEditReply(interaction, { content: `✅ Ticket creado: ${channel}` });
    } catch (err) {
        console.error('[modal:duels] Error:', err);
        await safeEditReply(interaction, { content: ticketErrorMsg(err) });
    }
}

// ── Calc dinero modal handler ─────────────────────────────────────────────────

async function handleCalcDineroModal(interaction) {
    if (interaction.replied || interaction.deferred) return;
    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    const raw    = interaction.fields.getTextInputValue('presupuesto');
    const budget = extractDecimal(raw);

    if (!budget) {
        return safeEditReply(interaction, { content: '<:alert:1501220021035204658> Ingresa una cantidad válida. Ejemplo: 500 o 150.50' });
    }

    const result = lookupByBudget(budget);
    if (!result) {
        return safeEditReply(interaction, {
            content: `<:alert:1501220021035204658> Con ese presupuesto no puedes comprar Robux. El paquete mínimo cuesta **$${MIN_PRICE} MXN** (${MIN.toLocaleString()} Robux).`,
        });
    }

    const embed = new EmbedBuilder()
        .setColor(0x2B2D31)
        .setTitle('<a:boost:1525333836181934081> Resultado del cálculo')
        .addFields(
            { name: '<:point:1501212595464700104> Presupuesto ingresado', value: `$${budget.toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} MXN`, inline: true },
            { name: '<a:robuxxx:1510070809366892604> Robux que puedes obtener', value: `${result.robux.toLocaleString()} Robux`, inline: true },
            { name: '<a:shop:1190502129748676650> Precio exacto del paquete', value: `${result.price} MXN`, inline: true },
        )
        .setFooter({ text: '7x Community • Calculadora de precios' });

    await safeEditReply(interaction, { embeds: [embed] });
}

// ── Calc robux modal handler ──────────────────────────────────────────────────

async function handleCalcRobuxModal(interaction) {
    if (interaction.replied || interaction.deferred) return;
    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    const raw    = interaction.fields.getTextInputValue('cantidad_robux');
    const amount = extractNumber(raw);

    if (!amount) {
        return safeEditReply(interaction, { content: '<:alert:1501220021035204658> Ingresa una cantidad válida de Robux. Ejemplo: 1500' });
    }

    const result = lookup(amount);
    if (!result) {
        return safeEditReply(interaction, {
            content: `<:alert:1501220021035204658> Cantidad no disponible. Elige entre **${MIN.toLocaleString()}** y **${MAX.toLocaleString()}** Robux.`,
        });
    }

    const embed = new EmbedBuilder()
        .setColor(0x2B2D31)
        .setTitle('<a:boost:1525333836181934081> Resultado del cálculo')
        .setDescription(result.rounded ? `<:alert:1501220021035204658> Tu monto fue redondeado al paquete más cercano: **${result.amount.toLocaleString()} Robux**.` : null)
        .addFields(
            { name: '<a:robuxxx:1510070809366892604> Robux solicitados', value: `${result.amount.toLocaleString()} Robux`, inline: true },
            { name: '<a:shop:1190502129748676650> Precio total', value: `${result.price} MXN`, inline: true },
        )
        .setFooter({ text: '7x Community • Calculadora de precios' });

    await safeEditReply(interaction, { embeds: [embed] });
}

// ── Verif modal builder ───────────────────────────────────────────────────────

function buildVerifModal() {
    const modal = new ModalBuilder().setCustomId('verif_modal').setTitle('Verificación de Grupo Roblox');
    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('roblox_username')
                .setLabel('Tu nombre de usuario de Roblox')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Ej: PlayerName123')
                .setRequired(true)
        )
    );
    return modal;
}

// ── Verif modal handler ───────────────────────────────────────────────────────

async function handleVerifModal(interaction) {
    if (interaction.replied || interaction.deferred) return;
    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    const username = interaction.fields.getTextInputValue('roblox_username').trim();
    if (!username) {
        return safeEditReply(interaction, { content: '❌ Ingresa un nombre de usuario válido.' });
    }

    // ── Fetch Roblox user ─────────────────────────────────────────────────────
    let robloxUser;
    try {
        robloxUser = await roblox.getUserByUsername(username);
    } catch {
        const embed = new EmbedBuilder()
            .setColor(0x2B2D31)
            .setTitle('<:alert:1501220021035204658> Usuario no encontrado')
            .setDescription(
                `No encontramos ninguna cuenta de Roblox con el nombre **${username}**.\n\n` +
                '<:point:1501212595464700104> Verifica que el nombre esté escrito correctamente e intenta de nuevo.'
            )
            .setFooter({ text: '7x Community • Verificación de Grupo' });
        return safeEditReply(interaction, { embeds: [embed] });
    }

    const userId = robloxUser.id;

    // ── Check group membership ────────────────────────────────────────────────
    let inGroup;
    try {
        inGroup = await roblox.isUserInGroup(userId, config.ROBLOX_GROUP_ID);
    } catch {
        return safeEditReply(interaction, { content: '❌ Error al conectar con la API de Roblox. Intenta de nuevo en unos segundos.' });
    }

    if (!inGroup) {
        const embed = new EmbedBuilder()
            .setColor(0x2B2D31)
            .setTitle('<:alert:1501220021035204658> No estás en la comunidad')
            .setDescription(
                `**${robloxUser.name}** no se encuentra en la comunidad de Roblox requerida.\n\n` +
                `<:point:1501212595464700104> Para poder ser verificado y recibir Robux, primero debes unirte:\n` +
                `[**Comunidad de Robux-Roblox**](<${config.ROBLOX_GROUP_LINK}>)\n\n` +
                '<:point:1501212595464700104> Una vez dentro, regresa aquí y vuelve a verificarte.'
            )
            .setFooter({ text: '7x Community • Verificación de Grupo' });
        return safeEditReply(interaction, { embeds: [embed] });
    }

    // ── Track / retrieve join date ────────────────────────────────────────────
    const discordUserId = interaction.user.id;
    const isNew  = trackIfNew(discordUserId);
    updateLastChecked(discordUserId);
    const joined      = getJoinDate(discordUserId);
    const lastChecked = getLastChecked(discordUserId);
    const days        = joined ? daysSince(joined) : 0;
    const req         = config.ROBLOX_GROUP_DAYS_REQ;
    const left        = Math.max(0, req - days);
    const eligible    = days >= req;

    const statusIcon = eligible ? '<:true:1501213776878501899>' : '<:alert:1501220021035204658>';
    const statusText = eligible ? '<:true:1501213776878501899> ELEGIBLE' : '<:alert:1501220021035204658> NO ELEGIBLE';

    const lastCheckedStr = lastChecked
        ? `<t:${Math.floor(lastChecked.getTime() / 1000)}:f>`
        : 'Primera vez';

    const embed = new EmbedBuilder()
        .setColor(0x2B2D31)
        .setTitle(`${statusIcon} Resultado de Verificación`)
        .addFields(
            { name: '<:member:1501261625523699892> Usuario de Roblox', value: `\`${robloxUser.name}\``,                  inline: true },
            { name: '<a:robuxxx:1510070809366892604> Días en el grupo', value: `**${days}** día${days !== 1 ? 's' : ''}`, inline: true },
            { name: '<:truepurple:1501214679400190086> Estado',         value: statusText,                                inline: true },
            { name: '<:point:1501212595464700104> Última revisión',     value: lastCheckedStr,                            inline: false },
        )
        .setFooter({ text: '7x Community • Verificación de Grupo' });

    if (eligible) {
        embed.setDescription(
            '<:truepurple:1501214679400190086> ¡Felicidades! Ya cumples los requisitos para recibir Robux.\n\n' +
            '<:point:1501212595464700104> Puedes proceder a crear un ticket de compra desde el panel principal.'
        );
    } else {
        embed.setDescription(
            `<:point:1501212595464700104> Aún no cumples los **${req} días** requeridos en la comunidad.\n\n` +
            `<:alert:1501220021035204658> Te faltan **${left} día${left !== 1 ? 's' : ''}** para ser elegible.\n\n` +
            (isNew
                ? '<:point:1501212595464700104> **Nota:** El contador comenzó hoy. Vuelve a verificarte cuando hayas completado los días restantes.'
                : '<:point:1501212595464700104> Vuelve a verificarte cuando hayas completado el tiempo restante.')
        );
    }

    await safeEditReply(interaction, { embeds: [embed] });
}

// ── Review modal builder ──────────────────────────────────────────────────────

function buildReviewModal(ticketChannelId) {
    const modal = new ModalBuilder().setCustomId(`review_modal:${ticketChannelId}`).setTitle('Calificar atención del ticket');
    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('review_score')
                .setLabel('Número del 1 al 5 (5 = la mejor atención)')
                .setStyle(TextInputStyle.Short)
                .setMinLength(1)
                .setMaxLength(1)
                .setPlaceholder('Ej: 5')
                .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('review_comment')
                .setLabel('Déjanos una breve reseña sobre tu experiencia')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(200)
                .setPlaceholder('Ejem: Rapido, Legal, ect.')
                .setRequired(true)
        )
    );
    return modal;
}

// ── Review modal handler ──────────────────────────────────────────────────────

async function handleReviewModal(interaction) {
    if (interaction.replied || interaction.deferred) return;

    const ticketChannelId = interaction.customId.slice('review_modal:'.length);
    const raw   = interaction.fields.getTextInputValue('review_score').trim();
    const score = Number(raw);

    if (!Number.isInteger(score) || score < 1 || score > 5) {
        return safeReply(interaction, { content: '❌ Escribe solo un número entero del 1 al 5.', ephemeral: true });
    }

    const comment = interaction.fields.getTextInputValue('review_comment').trim();
    if (!comment) {
        return safeReply(interaction, { content: '❌ Escribe una breve reseña sobre tu experiencia.', ephemeral: true });
    }

    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    const review = reviews.getReview(ticketChannelId);
    if (!review) {
        return safeEditReply(interaction, { content: '❌ Esta solicitud de reseña ya no es válida.' });
    }
    if (interaction.user.id !== review.buyerId) {
        return safeEditReply(interaction, { content: '❌ Solo el comprador puede calificar esta compra.' });
    }

    const via = interaction.channel?.isDMBased?.() ? 'dm' : 'ticket';
    const ok  = reviews.submitRating(ticketChannelId, interaction.user.id, score, comment, via);
    if (!ok) {
        return safeEditReply(interaction, { content: '❌ Esta compra ya fue calificada anteriormente.' });
    }

    await safeEditReply(interaction, { content: '✅ ¡Gracias por tu calificación!' });
    await finalizeReview(interaction.client, ticketChannelId, score, comment);
}

// ── Router ────────────────────────────────────────────────────────────────────

const HANDLERS = {
    comprar_modal:    handleComprarModal,
    otra_cosa_modal:  handleOtraCosaModal,
    duels_modal:       handleDuelsModal,
    calc_dinero_modal: handleCalcDineroModal,
    calc_robux_modal:  handleCalcRobuxModal,
    verif_modal:       handleVerifModal,
};

async function handleModal(interaction) {
    // Hard stop — same pattern as handleButton
    if (interaction.replied || interaction.deferred) return;

    const isSeg    = interaction.customId.startsWith('seg_');
    const isCg     = interaction.customId.startsWith('cg_modal_');
    const isReview = interaction.customId.startsWith('review_modal:');
    const fn = isSeg ? handleSeguidoresModal : isCg ? handleCheckGroupModal : isReview ? handleReviewModal : HANDLERS[interaction.customId];
    if (!fn) return;

    try {
        await fn(interaction);
    } catch (err) {
        if (isGone(err)) return;
        console.error(`[modal:${interaction.customId}] Unhandled error:`, err);
        await safeReply(interaction, { content: '❌ Ocurrió un error. Intenta de nuevo.', ephemeral: true });
    }
}

module.exports = { handleModal, buildComprarModal, buildOtraCosaModal, buildDuelsModal, buildCalcDineroModal, buildCalcRobuxModal, buildVerifModal, buildReviewModal };
