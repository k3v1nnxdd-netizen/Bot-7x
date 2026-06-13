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
const roblox                                               = require('../roblox');
const { getJoinDate, trackIfNew, daysSince }               = require('../utils/groupTracker');
const config                                               = require('../config');
const { buildMetodosEmbed, buildMetodosRow }               = require('../metodos');

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
                .setLabel('¿Eres miembro de 7x Studio? (Sí/No)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
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

        // ── Mensaje 1: Información de la compra ───────────────────────────────
        const embedWelcome = new EmbedBuilder()
            .setColor(0x000000)
            .setTitle('<:buy:1501212698556371004> Resumen de tu compra')
            .setDescription(
                `<:member:1501261625523699892> **Usuario de Roblox**\n\`\`\`${robloxUser}\`\`\`\n` +
                `<a:robuxxx:1510070809366892604> **Robux a recibir**\n\`\`\`${finalAmount.toLocaleString()} Robux\`\`\`\n` +
                `<:money:1501213606077792266> **Precio a pagar**\n\`\`\`${priceText} MXN\`\`\`\n` +
                `<:truepurple:1501214679400190086> **¿Miembro de 7x Studio?**\n\`\`\`${esMiembro}\`\`\`` +
                (rounded ? `\n\n<:alert:1501220021035204658> Tu monto fue redondeado a **${finalAmount.toLocaleString()} robux**.` : '')
            )
            .setFooter({ text: '7x Community • Proceso automático' });

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
            .setTitle('<:alert:1501220021035204658> Pago Pendiente')
            .setDescription(
                '<:point:1501212595464700104> Selecciona tu método de pago en el menú de arriba.\n\n' +
                '<:point:1501212595464700104> Realiza el pago por el monto exacto.\n\n' +
                '<:point:1501212595464700104> Envía la **foto del comprobante** en este ticket.\n\n' +
                '<:point:1501212595464700104> Escribe **PAGO EXITOSO** para que procesemos tu orden.'
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
        return safeEditReply(interaction, { content: '❌ Ingresa una cantidad válida. Ejemplo: 500 o 150.50' });
    }

    const result = lookupByBudget(budget);
    if (!result) {
        return safeEditReply(interaction, {
            content: `❌ Con ese presupuesto no puedes comprar Robux. El paquete mínimo cuesta **$${MIN_PRICE} MXN** (${MIN.toLocaleString()} Robux).`,
        });
    }

    const embed = new EmbedBuilder()
        .setColor(0x000000)
        .setTitle('🧮 Resultado del cálculo')
        .addFields(
            { name: '💰 Presupuesto ingresado', value: `$${budget.toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} MXN`, inline: true },
            { name: '<a:robuxxx:1510070809366892604> Robux que puedes obtener', value: `${result.robux.toLocaleString()} Robux`, inline: true },
            { name: '💵 Precio exacto del paquete', value: `${result.price} MXN`, inline: true },
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
        return safeEditReply(interaction, { content: '❌ Ingresa una cantidad válida de Robux. Ejemplo: 1500' });
    }

    const result = lookup(amount);
    if (!result) {
        return safeEditReply(interaction, {
            content: `❌ Cantidad no disponible. Elige entre **${MIN.toLocaleString()}** y **${MAX.toLocaleString()}** Robux.`,
        });
    }

    const embed = new EmbedBuilder()
        .setColor(0x000000)
        .setTitle('🧮 Resultado del cálculo')
        .setDescription(result.rounded ? `⚠️ Tu monto fue redondeado al paquete más cercano: **${result.amount.toLocaleString()} Robux**.` : null)
        .addFields(
            { name: '<a:robuxxx:1510070809366892604> Robux solicitados', value: `${result.amount.toLocaleString()} Robux`, inline: true },
            { name: '💰 Precio total', value: `${result.price} MXN`, inline: true },
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
            .setColor(0x000000)
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
            .setColor(0x000000)
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
    const isNew  = trackIfNew(userId);
    const joined = getJoinDate(userId);
    const days   = joined ? daysSince(joined) : 0;
    const req    = config.ROBLOX_GROUP_DAYS_REQ;
    const left   = Math.max(0, req - days);
    const eligible = days >= req;

    const statusIcon = eligible ? '<:true:1501213776878501899>' : '<:alert:1501220021035204658>';
    const statusText = eligible ? '**ELEGIBLE** ✅' : '**NO ELEGIBLE** ❌';

    const embed = new EmbedBuilder()
        .setColor(0x000000)
        .setTitle(`${statusIcon} Resultado de Verificación`)
        .addFields(
            { name: '<:member:1501261625523699892> Usuario de Roblox', value: `\`${robloxUser.name}\``, inline: true },
            { name: '📅 Días en el grupo', value: `**${days}** día${days !== 1 ? 's' : ''}`, inline: true },
            { name: '🏆 Estado', value: statusText, inline: true },
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

// ── Router ────────────────────────────────────────────────────────────────────

const HANDLERS = {
    comprar_modal:    handleComprarModal,
    otra_cosa_modal:  handleOtraCosaModal,
    calc_dinero_modal: handleCalcDineroModal,
    calc_robux_modal:  handleCalcRobuxModal,
    verif_modal:       handleVerifModal,
};

async function handleModal(interaction) {
    // Hard stop — same pattern as handleButton
    if (interaction.replied || interaction.deferred) return;

    const fn = HANDLERS[interaction.customId];
    if (!fn) return;

    try {
        await fn(interaction);
    } catch (err) {
        if (isGone(err)) return;
        console.error(`[modal:${interaction.customId}] Unhandled error:`, err);
        await safeReply(interaction, { content: '❌ Ocurrió un error. Intenta de nuevo.', ephemeral: true });
    }
}

module.exports = { handleModal, buildComprarModal, buildOtraCosaModal, buildCalcDineroModal, buildCalcRobuxModal, buildVerifModal };
