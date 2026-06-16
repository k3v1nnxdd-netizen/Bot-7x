'use strict';

const fs = require('fs');
const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} = require('discord.js');
const config = require('./config');
const { safeDeferReply, safeEditReply } = require('./utils/safe');

const OXXO_PATH   = './oxxo.jpg';
const OXXO_NAME   = 'oxxo.jpg';
const OXXO_EXISTS = fs.existsSync(OXXO_PATH);

// ── Panel principal (solo introducción + dropdown) ────────────────────────────

function buildMetodosEmbed() {
    return new EmbedBuilder()
        .setColor(0x000000)
        .setDescription(
            '# 7x - Métodos de Pago\n\n\n' +
            '<:point:1501212595464700104> Consulta los métodos de pago disponibles actualmente en 7x utilizando el menú desplegable de abajo.\n\n' +
            '<:point:1501212595464700104> Selecciona una opción para ver información detallada sobre cada método de pago, instrucciones y requisitos.\n\n' +
            '<:point:1501212595464700104> Si no encuentras el método que buscas, abre un ticket y nuestro equipo te ayudará.\n\n' +
            '<:point:1501212595464700104> Los métodos de pago disponibles pueden cambiar con el tiempo, por lo que recomendamos revisar este panel antes de realizar una compra.\n\n' +
            '<:point:1501212595464700104> Toca el menú inferior para ver las opciones disponibles.'
        );
}

function buildMetodosRow() {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('metodos_select')
            .setPlaceholder('Selecciona un método de pago')
            .addOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel('Transferencia')
                    .setDescription('Mercado Pago MX')
                    .setValue('transferencia')
                    .setEmoji({ id: '1501213606077792266', name: 'money' }),
                new StringSelectMenuOptionBuilder()
                    .setLabel('Depósito OXXO')
                    .setDescription('Depósito mediante código QR en tiendas OXXO')
                    .setValue('oxxo')
                    .setEmoji({ id: '1510195718231429180', name: 'oxxo' }),
                new StringSelectMenuOptionBuilder()
                    .setLabel('Gift Card')
                    .setDescription('Gift Cards para compras internacionales')
                    .setValue('giftcard')
                    .setEmoji({ id: '1510169188373758166', name: 'card' }),
            )
    );
}

// ── Embeds de detalle por opción ──────────────────────────────────────────────

function buildTransferenciaEmbed() {
    return new EmbedBuilder()
        .setColor(0x000000)
        .setTitle('🇲🇽 Transferencia — Mercado Pago')
        .setDescription(
            'Transferencia es uno de nuestros métodos de pago. A continuación se te otorgarán los datos para enviar el dinero.\n\n' +
            '• **Número de Cuenta:**\n```722969040869278041```\n' +
            '• **Nombre:** `VICENTA MARIANO VALDOVINOS`\n' +
            '• **Banco:** `Mercado Pago`\n\n' +
            '━━━━━━━━━━━━━━━━━━━━\n\n' +
            '**¿Cuál es el titular de la cuenta?**\n' +
            '• **Titular:** `VICENTA MARIANO VALDOVINOS`\n\n' +
            'Una vez enviado el dinero, recuerda enviar el comprobante en tu ticket para que podamos verificar tu pago.'
        )
        .setFooter({ text: '7x Community • Métodos de Pago' })
        .setTimestamp();
}

function buildTransferenciaRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('metodos_copy_cuenta')
            .setLabel('Copiar Cuenta')
            .setEmoji('🔑')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('metodos_copy_nombre')
            .setLabel('Copiar Nombre')
            .setEmoji('🔑')
            .setStyle(ButtonStyle.Secondary),
    );
}

function buildOxxoEmbed() {
    const embed = new EmbedBuilder()
        .setColor(0x000000)
        .setTitle('<:oxxo:1510195718231429180> Depósito OXXO')
        .setDescription(
            '<:point:1501212595464700104> Puedes realizar tu pago mediante depósito OXXO utilizando el código QR mostrado a continuación.\n\n' +
            '<:point:1501212595464700104> Conserva tu comprobante de pago y envíalo en tu ticket para validar tu compra.'
        )
        .setFooter({ text: '7x Community • Métodos de Pago' });

    if (OXXO_EXISTS) embed.setImage(`attachment://${OXXO_NAME}`);
    return embed;
}

function buildGiftCardEmbed() {
    return new EmbedBuilder()
        .setColor(0x000000)
        .setTitle('<:card:1510169188373758166> Gift Card')
        .setDescription(
            '<:point:1501212595464700104> Aceptamos Gift Cards para compras internacionales.\n\n' +
            '<:point:1501212595464700104> Selecciona el valor de la tarjeta según la cantidad de Robux que deseas adquirir.\n\n' +
            '<:point:1501212595464700104> Después de comprar la tarjeta, envía el código o comprobante en tu ticket.\n\n' +
            '<:web:1182891011064729610> [Click Aqui](<https://www.eneba.com/eneba-eneba-gift-card-5-eur-global>)'
        )
        .setFooter({ text: '7x Community • Métodos de Pago' });
}

// ── Handler del select menu (respuesta efímera) ───────────────────────────────

async function handleMetodosSelect(interaction) {
    if (interaction.customId !== 'metodos_select') return;
    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    const value = interaction.values[0];

    if (value === 'transferencia') {
        return safeEditReply(interaction, {
            embeds: [buildTransferenciaEmbed()],
            components: [buildTransferenciaRow()],
        });
    }
    if (value === 'oxxo') {
        const payload = { embeds: [buildOxxoEmbed()] };
        if (OXXO_EXISTS) payload.files = [{ attachment: OXXO_PATH, name: OXXO_NAME }];
        return safeEditReply(interaction, payload);
    }
    if (value === 'giftcard') {
        return safeEditReply(interaction, { embeds: [buildGiftCardEmbed()] });
    }
}

// ── Panel detection & setup ───────────────────────────────────────────────────

function isMetodosMsg(msg, botId) {
    return (
        msg.author.id === botId &&
        msg.embeds.length > 0 &&
        (
            msg.embeds[0]?.title?.includes('MÉTODOS DE PAGO') ||
            msg.embeds[0]?.title?.includes('Métodos de Pago') ||
            msg.embeds[0]?.description?.includes('Métodos de Pago')
        )
    );
}

async function ensureMetodosPanel(client) {
    const channel = client.channels.cache.get(config.CHANNELS.METODOS);
    if (!channel) {
        console.warn('[metodos] Metodos channel not found — skipping.');
        return;
    }

    const payload = {
        embeds: [buildMetodosEmbed()],
        components: [buildMetodosRow()],
        attachments: [],
    };

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (messages) {
        const pinned = messages.find(m => m.pinned && isMetodosMsg(m, client.user.id));
        if (pinned) {
            await pinned.edit(payload).catch(err => console.warn('[metodos] Could not edit pinned:', err.message));
            console.log('[metodos] Pinned metodos updated.');
            return;
        }
        const existing = messages.find(m => isMetodosMsg(m, client.user.id));
        if (existing) {
            await existing.edit(payload).catch(err => console.warn('[metodos] Could not edit:', err.message));
            await existing.pin().catch(err => console.warn('[metodos] Could not pin:', err.message));
            console.log('[metodos] Metodos updated and pinned.');
            return;
        }
    }

    await new Promise(r => setTimeout(r, 3000));

    const recheck = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    if (recheck?.find(m => isMetodosMsg(m, client.user.id))) {
        console.log('[metodos] Metodos appeared while waiting — skipping send.');
        return;
    }

    const msg = await channel.send(payload);
    await msg.pin().catch(err => console.warn('[metodos] Could not pin:', err.message));
    console.log('[metodos] Metodos sent and pinned.');
}

module.exports = {
    ensureMetodosPanel,
    handleMetodosSelect,
    buildMetodosEmbed,
    buildMetodosRow,
    buildTransferenciaEmbed,
    buildTransferenciaRow,
    buildOxxoEmbed,
    buildGiftCardEmbed,
    OXXO_PATH,
    OXXO_NAME,
    OXXO_EXISTS,
};
