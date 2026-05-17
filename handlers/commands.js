'use strict';

const { EmbedBuilder } = require('discord.js');
const { safeDeferReply, safeReply, safeEditReply } = require('../utils/safe');
const roblox = require('../roblox');
const config = require('../config');

async function handleOutfit(interaction) {
    if (interaction.channelId !== config.CHANNELS.OUTFIT) {
        return safeReply(interaction, {
            content: `❌ Este comando solo puede usarse en <#${config.CHANNELS.OUTFIT}>.`,
            ephemeral: true,
        });
    }

    const ok = await safeDeferReply(interaction);
    if (!ok) return;

    const username = (interaction.options.getString('user') ?? '').trim();
    if (!username) {
        return safeEditReply(interaction, { content: '❌ Debes ingresar un nombre de usuario de Roblox.' });
    }

    try {
        const user = await roblox.getUserByUsername(username);
        const uid  = user.id;

        // All API calls in parallel; failures are tolerated
        const [profile, followers, friends, avatarUrl, headshotUrl] = await Promise.allSettled([
            roblox.getUserProfile(uid),
            roblox.getFollowerCount(uid),
            roblox.getFriendCount(uid),
            roblox.getAvatarImage(uid),
            roblox.getHeadshot(uid),
        ]).then(r => r.map(x => x.status === 'fulfilled' ? x.value : null));

        const created = profile?.created
            ? new Date(profile.created).toLocaleDateString('es-ES', { year: 'numeric', month: 'short', day: 'numeric' })
            : 'Desconocida';
        const bio = (profile?.description ?? '').trim() || 'Sin descripción';

        const embed = new EmbedBuilder()
            .setColor(0x0b1220)
            .setTitle(`${user.name} • ${user.displayName || user.name}`)
            .setURL(`https://www.roblox.com/users/${uid}/profile`)
            .setThumbnail(headshotUrl ?? undefined)
            .setImage(avatarUrl ?? undefined)
            .addFields(
                { name: 'Nombre',       value: user.name,                                           inline: true },
                { name: 'Display Name', value: user.displayName || '—',                             inline: true },
                { name: 'User ID',      value: String(uid),                                         inline: true },
                { name: 'Followers',    value: followers != null ? followers.toLocaleString() : 'N/A', inline: true },
                { name: 'Friends',      value: friends   != null ? friends.toLocaleString()   : 'N/A', inline: true },
                { name: 'Creado',       value: created,                                             inline: true },
                { name: 'Descripción',  value: bio.substring(0, 1024),                              inline: false }
            )
            .setFooter({ text: '7x Community • Roblox Profile' })
            .setTimestamp();

        await safeEditReply(interaction, { embeds: [embed] });
    } catch (err) {
        const status = err?.response?.status;
        console.error('[outfit] Error:', status, err?.message);
        const msg =
            (status === 404 || err?.message === 'not_found')
                ? '❌ Usuario no encontrado. Verifica el nombre e intenta de nuevo.'
            : status === 429
                ? '⏱️ Roblox está limitando las peticiones. Espera unos segundos e intenta de nuevo.'
                : '❌ No pude obtener la información. Verifica el nombre e intenta de nuevo.';
        await safeEditReply(interaction, { content: msg });
    }
}

module.exports = { handleOutfit };
