'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');

function buildRefRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Dejar Referencia')
            .setEmoji({ id: '1514369366878064650', name: 'star', animated: true })
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/channels/${config.GUILD_ID}/${config.CHANNELS.REFERENCIAS}`),
    );
}

async function sendPurchaseDM(client, userId) {
    try {
        const guild = client.guilds.cache.get(config.GUILD_ID);
        const user  = await client.users.fetch(userId);

        const embed = new EmbedBuilder()
            .setColor(0x000000)
            .setThumbnail(guild?.iconURL({ size: 256 }) ?? null)
            .setTitle('<:truepurple:1501214679400190086> ¡Gracias por tu compra en 7x!')
            .setDescription(
                `<@${userId}>, gracias por tu compra en **7x Community**. ¡Disfruta tu compra!\n\n` +
                `Te agradecemos mucho si nos dejas una referencia de tu compra en el siguiente canal: <#${config.CHANNELS.REFERENCIAS}>`
            )
            .setFooter({ text: '7x Community' })
            .setTimestamp();

        await user.send({ embeds: [embed], components: [buildRefRow()] });
    } catch (err) {
        console.warn('[purchaseDM] Could not DM user:', err.message);
    }
}

module.exports = { buildRefRow, sendPurchaseDM };
