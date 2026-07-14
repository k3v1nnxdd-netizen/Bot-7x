'use strict';

const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const { containsScamTerm } = require('../utils/antiScam');

// Returns true if the message was flagged and handled (deleted + warned).
async function handleAntiScam(message) {
    if (message.author.bot) return false;
    if (!message.guild) return false;
    if (message.author.id === config.OWNER_ID) return false;
    if (message.author.id === config.INTERMEDIARY_ID) return false;
    if (message.channel.parentId === config.CATEGORIES.TICKETS) return false;
    if (!containsScamTerm(message.content)) return false;

    await message.delete().catch(() => {});

    const embed = new EmbedBuilder()
        .setColor(0x2B2D31)
        .setTitle('⚠️ Actividad no permitida')
        .setDescription(
            `Hola <@${message.author.id}>, las compras, ventas o tradeos fuera de este servidor, ` +
            `o que no sean ventas de <@${config.OWNER_ID}> o <@${config.INTERMEDIARY_ID}>, no están permitidas.\n\n` +
            `Si necesitan algún intermediario, pueden pedir ayuda a <@${config.INTERMEDIARY_ID}>.\n\n` +
            `Si se detecta que siguen intentando vender, comprar o tradear en el servidor, **serán expulsados**.`
        )
        .setFooter({ text: 'Sistema anti-estafa · 7x Community' })
        .setTimestamp();

    await message.channel.send({ embeds: [embed] }).catch(() => {});
    return true;
}

module.exports = { handleAntiScam };
