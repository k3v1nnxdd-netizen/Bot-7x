'use strict';

const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const config = require('./config');
const v2 = require('./utils/panelV2');
const plus = require('./utils/plusPrecios');
const { extractNumber, extractDecimal } = require('./data/prices');
const { safeDeferReply, safeEditReply, safeReply, safeShowModal } = require('./utils/safe');
const divisas = require('./utils/divisas');

// ── Panel de precios por Roblox Plus ──────────────────────────────────────────
// El mismo molde que el de gamepass: un Container con el texto y los dos
// botones de calculadora dentro. Lo que lo distingue es lo que avisa: los
// Robux se mandan con "Enviar Robux" de Roblox Plus, llegan completos, y
// quien los recibe tiene que tener la cuenta verificada para poder recibir.
// Eso, y que depende del stock, se dice AQUÍ, antes de que nadie pague.

const ACCENT = 0x2B2D31;

const TITULO = '7x Community - Plus';

const E = {
    money: { id: '1544123920897019906', name: 'money' },
    robux: { id: '1510070809366892604', name: 'robuxxx', animated: true },
    point: '<:point:1501212595464700104>',
    alert: '<:alert:1501220021035204658>',
    shop:  '<a:shop:1190502129748676650>',
    plus:  config.ROBLOX_PLUS_EMOJI || '💎',
};

function buildTexto() {
    const P = plus.P;
    return [
        `# ${TITULO}`,
        '',
        `Compra Robux enviados con **Roblox Plus** ${E.plus}. Te los mandamos directo a tu cuenta: sin gamepass y sin comisión.`,
        '',
        `${E.shop} **${plus.fmtRobux(1000)} Robux = ${plus.fmtMXN(P.PRECIO_POR_1K)}**`,
        `-# Te llegan **completos**. De ${plus.fmtRobux(P.MIN_ROBUX)} a **${plus.fmtRobux(P.MAX_ROBUX)} Robux** por pedido, de ${P.MULTIPLO} en ${P.MULTIPLO}.`,
        '',
        `### ${E.point} Cómo funciona`,
        '**1.** Mira aquí abajo cuánto cuesta lo que quieres.',
        '**2.** Abre tu ticket de **robux-plus** y pregunta si hay **stock**.',
        '**3.** Con el stock confirmado, pagas y te los enviamos con Roblox Plus.',
        '',
        `### ${E.alert} Requisitos para recibir`,
        `${E.point} Tu cuenta de Roblox tiene que estar **verificada** (verificación de edad de Roblox). Sin ella, Roblox no te deja recibir.`,
        `${E.point} Si Roblox te pide **aceptar** el envío, acéptalo.`,
        `${E.point} Los envíos de Roblox son finales: **si tu cuenta no puede recibir, no hay reembolso**. Revísalo antes de comprar.`,
        '',
        `### ${E.point} Stock`,
        'Antes de pagar, pregunta en tu ticket si hay stock. Si no hay, tu pedido se envía **en cuanto haya**.',
        '',
        `### ${E.point} Consulta tu precio`,
        `<:${E.money.name}:${E.money.id}> = Tienes un presupuesto y quieres saber cuántos Robux te alcanzan.`,
        `<a:${E.robux.name}:${E.robux.id}> = Sabes cuántos Robux quieres y quieres el precio exacto.`,
        '',
        'Presiona uno de los botones para comenzar.',
    ].join('\n');
}

function buildPlusRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('plus_dinero').setEmoji(E.money).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('plus_robux').setEmoji(E.robux).setStyle(ButtonStyle.Secondary),
    );
}

function buildContainer() {
    return v2.tarjeta({ color: ACCENT, texto: buildTexto(), filas: [buildPlusRow()] });
}

function buildPayload() {
    return v2.tarjetaPayload({ color: ACCENT, texto: buildTexto(), filas: [buildPlusRow()] });
}

function isPlusMsg(msg, botId) {
    if (msg.author?.id !== botId) return false;
    if (v2.collectButtons(msg).some(b => b.custom_id === 'plus_dinero')) return true;
    return v2.panelText(msg).includes(TITULO);
}

// El ÚNICO sitio desde el que se publica: fijados primero, luego el historial,
// y sólo si no está en ninguno, uno nuevo.
async function ensurePlusPanel(client) {
    const id = config.CHANNELS.PLUS;
    if (!id) {
        console.warn('[plus] config.CHANNELS.PLUS sin definir — panel omitido.');
        return null;
    }

    const channel = client.channels.cache.get(id) ?? await client.channels.fetch(id).catch(() => null);
    if (!channel) {
        console.warn(`[plus] Canal ${id} no encontrado — panel omitido.`);
        return null;
    }

    const container = buildContainer();
    const aplicar = async (msg, comoLlego) => {
        if (v2.isUpToDate(msg, container)) {
            console.log(`[plus] Panel ${comoLlego} ya actualizado — nada que hacer.`);
            return msg;
        }
        const editado = await v2.editOrRecreate(msg, container, { exists: false }, 'plus');
        console.log(`[plus] Panel ${comoLlego} actualizado.`);
        return editado;
    };

    const fijados = await v2.fetchPinnedMessages(channel);
    const pinned = fijados.find(m => isPlusMsg(m, client.user.id));
    if (pinned) return aplicar(pinned, 'fijado');

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const existing = messages?.find(m => isPlusMsg(m, client.user.id));
    if (existing) {
        const msg = await aplicar(existing, 'del historial');
        await msg.pin().catch(err => console.warn('[plus] No se pudo fijar:', err.message));
        return msg;
    }

    const msg = await channel.send(buildPayload());
    await msg.pin().catch(err => console.warn('[plus] No se pudo fijar:', err.message));
    console.log('[plus] Panel enviado y fijado.');
    return msg;
}

// ── Las dos calculadoras ──────────────────────────────────────────────────────

function buildPlusDineroModal() {
    return new ModalBuilder().setCustomId('plus_dinero_modal').setTitle('¿Cuánto dinero tienes?').addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('presupuesto')
                .setLabel('Tu presupuesto en MXN')
                .setPlaceholder('Ejemplo: 280')
                .setStyle(TextInputStyle.Short)
                .setMaxLength(12)
                .setRequired(true)
        )
    );
}

function buildPlusRobuxModal() {
    return new ModalBuilder().setCustomId('plus_robux_modal').setTitle('¿Cuántos Robux quieres?').addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('cantidad_robux')
                .setLabel('Cantidad de Robux')
                .setPlaceholder(`Entre ${plus.fmtRobux(plus.P.MIN_ROBUX)} y ${plus.fmtRobux(plus.P.MAX_ROBUX)}`)
                .setStyle(TextInputStyle.Short)
                .setMaxLength(9)
                .setRequired(true)
        )
    );
}

function buildPlusEmbed(campos, aviso = null) {
    return new EmbedBuilder()
        .setColor(ACCENT)
        .setTitle('<a:shop:1190502129748676650> Precio por Roblox Plus')
        .setDescription(aviso)
        .addFields(campos)
        .setFooter({ text: '7x Community • Llegan completos · cuenta verificada · sujeto a stock' });
}

async function onPlusDinero(interaction) {
    if (interaction.replied || interaction.deferred) return;
    const ok = await safeShowModal(interaction, buildPlusDineroModal());
    if (!ok) await safeReply(interaction, { content: '❌ No se pudo abrir el formulario. Intenta de nuevo.', ephemeral: true });
}

async function onPlusRobux(interaction) {
    if (interaction.replied || interaction.deferred) return;
    const ok = await safeShowModal(interaction, buildPlusRobuxModal());
    if (!ok) await safeReply(interaction, { content: '❌ No se pudo abrir el formulario. Intenta de nuevo.', ephemeral: true });
}

async function handlePlusDineroModal(interaction) {
    if (interaction.replied || interaction.deferred) return;
    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    const presupuesto = extractDecimal(interaction.fields.getTextInputValue('presupuesto'));
    if (!presupuesto) {
        return safeEditReply(interaction, { content: `${E.alert} Ingresa una cantidad válida. Ejemplo: 280 o 150.50` });
    }

    const robux = plus.robuxPor(presupuesto);
    if (!robux) {
        return safeEditReply(interaction, {
            content: `${E.alert} Con ese presupuesto no alcanza. El mínimo por Plus son ` +
                `**${plus.fmtRobux(plus.P.MIN_ROBUX)} Robux** (${plus.fmtMXN(plus.precioDe(plus.P.MIN_ROBUX))}).`,
        });
    }

    const precio = plus.precioDe(robux);
    const sobra = Math.round((presupuesto - precio) * 100) / 100;
    const tope = robux === plus.P.MAX_ROBUX && sobra > 0;

    await safeEditReply(interaction, {
        embeds: [buildPlusEmbed([
            { name: `${E.point} Tu presupuesto`, value: plus.fmtMXN(presupuesto), inline: true },
            { name: '<a:robuxxx:1510070809366892604> Recibes en tu cuenta', value: `${plus.fmtRobux(robux)} Robux`, inline: true },
            { name: `${E.point} Precio exacto`, value: plus.fmtMXN(precio), inline: true },
            { name: '💵 En dólares', value: divisas.usdTexto(precio), inline: true },
        ], tope
            ? `-# El máximo por pedido son ${plus.fmtRobux(plus.P.MAX_ROBUX)} Robux: te sobran ${plus.fmtMXN(sobra)}.`
            : sobra > 0 ? `-# Te sobran ${plus.fmtMXN(sobra)}: se ajusta a la baja para no pasarse de tu presupuesto.` : null)],
    });
}

async function handlePlusRobuxModal(interaction) {
    if (interaction.replied || interaction.deferred) return;
    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    const robux = extractNumber(interaction.fields.getTextInputValue('cantidad_robux'));
    if (!robux) {
        return safeEditReply(interaction, { content: `${E.alert} Ingresa una cantidad válida de Robux. Ejemplo: 1000` });
    }
    const error = plus.errorCantidad(robux);
    if (error) return safeEditReply(interaction, { content: `${E.alert} ${error}` });

    await safeEditReply(interaction, {
        embeds: [buildPlusEmbed([
            { name: '<a:robuxxx:1510070809366892604> Recibes en tu cuenta', value: `${plus.fmtRobux(robux)} Robux`, inline: true },
            { name: `${E.point} Precio total`, value: plus.fmtMXN(plus.precioDe(robux)), inline: true },
            { name: '💵 En dólares', value: divisas.usdTexto(plus.precioDe(robux)), inline: true },
        ])],
    });
}

module.exports = {
    ensurePlusPanel,
    onPlusDinero, onPlusRobux, handlePlusDineroModal, handlePlusRobuxModal,
    __test: { buildTexto, buildContainer, buildPayload, buildPlusRow, isPlusMsg, buildPlusDineroModal, buildPlusRobuxModal, TITULO },
};
