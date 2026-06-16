'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { safeDeferReply, safeReply, safeEditReply } = require('../utils/safe');
const roblox = require('../roblox');
const config = require('../config');
const { createCoupon, getCoupon } = require('../utils/coupons');
const {
    buildTransferenciaEmbed, buildTransferenciaRow,
    buildOxxoEmbed, buildGiftCardEmbed,
    OXXO_PATH, OXXO_NAME, OXXO_EXISTS,
} = require('../metodos');

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

function buildRefRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Dejar Reseña')
            .setEmoji({ id: '1514369366878064650', name: 'star', animated: true })
            .setStyle(ButtonStyle.Link)
            .setURL('https://discord.com/channels/1162602588328435802/1452939436525617293'),
    );
}

async function handlePagoVerified(interaction) {
    if (interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ No tienes permiso para usar este comando.', ephemeral: true });
    }

    const ok = await safeDeferReply(interaction);
    if (!ok) return;

    const embed = new EmbedBuilder()
        .setColor(0x000000)
        .setTitle('<:truepurple:1501214679400190086> Pago Verificado — 7x Community')
        .setDescription(
            '¡Gracias por tu compra con **7x Community**!\n\n' +
            '<:point:1501212595464700104> Ya sea que hayas adquirido **Robux** u otro tipo de producto, esperamos que lo disfrutes al máximo.\n\n' +
            '<:point:1501212595464700104> Si adquiriste Robux y aún no aparecen en tu balance, no te preocupes. Roblox puede colocarlos en estado **Pendiente** por motivos de seguridad.\n\n' +
            '<:alert:1501220021035204658> Normalmente se acreditan en **5 a 10 minutos**, aunque en casos poco comunes puede tomar hasta **6-7 días**. Como máximo, Roblox los libera dentro de **10 días**.\n\n' +
            '<:point:1501212595464700104> Puedes revisar el estado de tus transacciones aquí: [Ver Robux pendientes](<https://www.roblox.com/transactions>)\n\n' +
            '<:truepurple:1501214679400190086> ¡Gracias por confiar en nosotros y esperamos verte pronto!'
        )
        .setFooter({ text: '7x Community • Compra verificada' })
        .setTimestamp();

    return safeEditReply(interaction, { embeds: [embed], components: [buildRefRow()] });
}

async function handlePagos(interaction) {
    const ok = await safeDeferReply(interaction);
    if (!ok) return;

    const metodo = interaction.options.getString('metodo');

    if (metodo === 'transferencia') {
        return safeEditReply(interaction, {
            embeds: [buildTransferenciaEmbed()],
            components: [buildTransferenciaRow()],
        });
    }
    if (metodo === 'oxxo') {
        const payload = { embeds: [buildOxxoEmbed()] };
        if (OXXO_EXISTS) payload.files = [{ attachment: OXXO_PATH, name: OXXO_NAME }];
        return safeEditReply(interaction, payload);
    }
    if (metodo === 'giftcard') {
        return safeEditReply(interaction, { embeds: [buildGiftCardEmbed()] });
    }
}

async function handleOffer(interaction) {
    if (interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ No tienes permiso para usar este comando.', ephemeral: true });
    }

    const ok = await safeDeferReply(interaction, { ephemeral: true });
    if (!ok) return;

    const codigo    = interaction.options.getString('codigo').trim().toUpperCase();
    const descuento = interaction.options.getInteger('descuento');
    const usos      = interaction.options.getInteger('usos');

    if (descuento < 1 || descuento > 99) {
        return safeEditReply(interaction, { content: '❌ El porcentaje de descuento debe estar entre 1 y 99.' });
    }
    if (usos < 1) {
        return safeEditReply(interaction, { content: '❌ La cantidad de usos debe ser al menos 1.' });
    }

    createCoupon(codigo, descuento, usos, interaction.user.id);
    const coupon = getCoupon(codigo);

    const embed = new EmbedBuilder()
        .setColor(0x5b5b5b)
        .setTitle('7x - Cupón')
        .addFields(
            { name: 'Código',             value: `\`${codigo}\``,                                   inline: true  },
            { name: 'Descuento',          value: `**${descuento}%**`,                               inline: true  },
            { name: 'Usos máximos',       value: `**${usos}**`,                                     inline: true  },
            { name: 'Usos restantes',     value: `**${usos - coupon.uses}**`,                       inline: true  },
            { name: 'Creado por',         value: `<@${interaction.user.id}>`,                       inline: true  },
        )
        .setFooter({ text: '7x Community • Sistema de cupones' })
        .setTimestamp();

    return safeEditReply(interaction, { embeds: [embed] });
}

async function handleClose(interaction) {
    if (interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ No tienes permiso para usar este comando.', ephemeral: true });
    }

    const channel = interaction.channel;
    if (channel?.parentId !== config.CATEGORIES.TICKETS) {
        return safeReply(interaction, { content: '❌ Este comando solo puede usarse dentro de un ticket.', ephemeral: true });
    }

    const ok = await safeDeferReply(interaction, { ephemeral: true });
    if (!ok) return;
    await safeEditReply(interaction, { content: '🔒 Cierre automático iniciado. El ticket se eliminará en 10 minutos.' });

    const { startAutoClose } = require('./buttons');
    await startAutoClose(channel);
}

module.exports = { handleOutfit, handlePagos, handlePagoVerified, handleOffer, handleClose };
