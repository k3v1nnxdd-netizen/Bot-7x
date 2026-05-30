'use strict';

const fs = require('fs');
const { EmbedBuilder } = require('discord.js');
const config = require('./config');

const OXXO_PATH   = './oxxo.jpg';
const OXXO_NAME   = 'oxxo.jpg';
const OXXO_EXISTS = fs.existsSync(OXXO_PATH);

function buildMetodosEmbed() {
    const embed = new EmbedBuilder()
        .setColor(0x000000)
        .setTitle('<:buy:1501212698556371004> MÉTODOS DE PAGO')
        .setDescription(
            '<:point:1501212595464700104> Elige tu método de pago preferido y completa tu compra de forma rápida y segura.\n\n' +

            '<:money:1501213606077792266> **TRANSFERENCIA**\n\n' +
            '**MERCADO PAGO**\n' +
            'VICENTA MARIANO VALDOVINOS\n\n' +
            '```722969040869278041```\n' +
            '<:point:1501212595464700104> Verifica cuidadosamente el número de cuenta antes de realizar tu pago.\n\n' +
            '<:point:1501212595464700104> Una vez realizado el pago, envía tu comprobante en tu ticket para continuar con el proceso.\n\n' +
            '━━━━━━━━━━━━━━━━━━━━\n\n' +

            '<:card:1510169188373758166> **GIFT CARD**\n\n' +
            '<:point:1501212595464700104> Aceptamos Gift Cards para compras internacionales.\n\n' +
            '<:point:1501212595464700104> Selecciona el valor de la tarjeta según la cantidad de Robux que deseas adquirir.\n\n' +
            '<:point:1501212595464700104> Después de comprar la tarjeta, envía el código o comprobante en tu ticket.\n\n' +
            '<:web:1182891011064729610> [Click Aqui](<https://www.eneba.com/eneba-eneba-gift-card-5-eur-global>)\n\n' +
            '━━━━━━━━━━━━━━━━━━━━\n\n' +

            '<:oxxo:1510195718231429180> **DEPÓSITO OXXO**\n\n' +
            '<:point:1501212595464700104> También puedes realizar tu pago mediante depósito OXXO utilizando el código QR mostrado a continuación.\n\n' +
            '<:point:1501212595464700104> Conserva tu comprobante de pago y envíalo en tu ticket para validar tu compra.'
        );

    if (OXXO_EXISTS) embed.setImage(`attachment://${OXXO_NAME}`);

    return embed;
}

function isMetodosMsg(msg, botId) {
    return (
        msg.author.id === botId &&
        msg.embeds.length > 0 &&
        msg.embeds[0]?.title?.includes('MÉTODOS DE PAGO')
    );
}

async function ensureMetodosPanel(client) {
    const channel = client.channels.cache.get(config.CHANNELS.METODOS);
    if (!channel) {
        console.warn('[metodos] Metodos channel not found — skipping.');
        return;
    }

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (messages) {
        const pinned = messages.find(m => m.pinned && isMetodosMsg(m, client.user.id));
        if (pinned) {
            const payload = {
                embeds: [buildMetodosEmbed()],
                ...(OXXO_EXISTS && { files: [{ attachment: OXXO_PATH, name: OXXO_NAME }] }),
            };
            await pinned.edit(payload).catch(err => console.warn('[metodos] Could not edit pinned:', err.message));
            console.log('[metodos] Pinned metodos updated.');
            return;
        }
        const existing = messages.find(m => isMetodosMsg(m, client.user.id));
        if (existing) {
            const payload = {
                embeds: [buildMetodosEmbed()],
                ...(OXXO_EXISTS && { files: [{ attachment: OXXO_PATH, name: OXXO_NAME }] }),
            };
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

    const payload = {
        embeds: [buildMetodosEmbed()],
        ...(OXXO_EXISTS && { files: [{ attachment: OXXO_PATH, name: OXXO_NAME }] }),
    };
    const msg = await channel.send(payload);
    await msg.pin().catch(err => console.warn('[metodos] Could not pin:', err.message));
    console.log('[metodos] Metodos sent and pinned.');
}

module.exports = { ensureMetodosPanel };
