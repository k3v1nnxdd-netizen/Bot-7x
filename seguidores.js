'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('./config');

function buildSeguidoresEmbed() {
    return new EmbedBuilder()
        .setColor(0x000000)
        .setDescription(
            '# SEGUIDORES\n\n' +

            '<:insta:1525317982518251690> **INSTAGRAM**\n\n' +
            'Calidad Normal (algunas caídas)\n' +
            '• 1,000 seguidores — $50 MXN\n\n' +
            'Calidad Premium (menos caídas)\n' +
            '• 1,000 seguidores — $60 MXN\n\n' +
            '> `Los seguidores de Instagram solo se venden en paquetes de 1,000 o más.`\n\n' +

            '<:roblox:1525317838938701967> **ROBLOX**\n\n' +
            '• 100 seguidores — $17 MXN\n' +
            '• 1,000 seguidores — $174 MXN\n\n' +
            '> `En ocasiones Roblox elimina cuentas falsas durante sus limpiezas periódicas (aproximadamente cada 3 meses), por lo que algunos seguidores pueden disminuir. Esto depende exclusivamente de Roblox y está fuera de nuestro control.`\n\n' +

            '<:ttk:1525317575783743580> **TIKTOK**\n\n' +
            'Calidad Normal (algunas caídas)\n' +
            '• 1,000 seguidores — $100 MXN\n\n' +
            'Calidad Premium (menos caídas)\n' +
            '• 1,000 seguidores — $150 MXN\n\n' +
            '> `Los seguidores de TikTok solo se venden en paquetes de 1,000 o más.`\n\n' +

            '<:truepurple:1501214679400190086> Entrega instantánea.\n\n' +
            '> `Las garantías aplican únicamente cuando la pérdida de seguidores supera el 15%.`'
        );
}

function buildSeguidoresRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Comprar')
            .setEmoji({ id: '1190502129748676650', name: 'shop', animated: true })
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/channels/${config.GUILD_ID}/${config.CHANNELS.PANEL}`),
    );
}

function isSeguidoresMsg(msg, botId) {
    return (
        msg.author.id === botId &&
        msg.embeds.length > 0 &&
        msg.embeds[0]?.description?.includes('SEGUIDORES') &&
        msg.embeds[0]?.description?.includes('INSTAGRAM')
    );
}

async function ensureSeguidoresPanel(client) {
    const channel = client.channels.cache.get(config.CHANNELS.SEGUIDORES);
    if (!channel) {
        console.warn('[seguidores] Seguidores channel not found — skipping.');
        return;
    }

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (messages) {
        const pinned = messages.find(m => m.pinned && isSeguidoresMsg(m, client.user.id));
        if (pinned) {
            await pinned.edit({ embeds: [buildSeguidoresEmbed()], components: [buildSeguidoresRow()] })
                .catch(err => console.warn('[seguidores] Could not edit pinned:', err.message));
            console.log('[seguidores] Pinned message updated.');
            return;
        }
        const existing = messages.find(m => isSeguidoresMsg(m, client.user.id));
        if (existing) {
            await existing.edit({ embeds: [buildSeguidoresEmbed()], components: [buildSeguidoresRow()] })
                .catch(err => console.warn('[seguidores] Could not edit:', err.message));
            await existing.pin().catch(err => console.warn('[seguidores] Could not pin:', err.message));
            console.log('[seguidores] Message updated and pinned.');
            return;
        }
    }

    await new Promise(r => setTimeout(r, 3000));

    const recheck = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    if (recheck?.find(m => isSeguidoresMsg(m, client.user.id))) {
        console.log('[seguidores] Message appeared while waiting — skipping send.');
        return;
    }

    const msg = await channel.send({ embeds: [buildSeguidoresEmbed()], components: [buildSeguidoresRow()] });
    await msg.pin().catch(err => console.warn('[seguidores] Could not pin:', err.message));
    console.log('[seguidores] Message sent and pinned.');
}

module.exports = { ensureSeguidoresPanel };
