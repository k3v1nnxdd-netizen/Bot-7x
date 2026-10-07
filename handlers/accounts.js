'use strict';

const fs = require('fs');
const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const { dataPath, ensureDataDir } = require('../utils/dataDir');
const { safeReply } = require('../utils/safe');

const FILE = dataPath('accountListings.json');
const TMP = `${FILE}.tmp`;

function load() {
    try {
        const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch {
        return {};
    }
}

function save(data) {
    ensureDataDir();
    fs.writeFileSync(TMP, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(TMP, FILE);
}

function keyFor(name) {
    return name.trim().toLocaleLowerCase('es-MX');
}

function isOwner(interaction) {
    return config.ADMIN_IDS.includes(interaction.user?.id);
}

function buildEmbed(listing) {
    const estado = listing.disponible
        ? '<:disponible:1540603311890104321> Disponible'
        : '<:nodisponible:1540604743234228364> No disponible';

    const embed = new EmbedBuilder()
        .setColor(listing.disponible ? 0x168A62 : 0x62666D)
        .setAuthor({ name: '7x Community · Catálogo de cuentas' })
        .setTitle(listing.titulo)
        .setDescription(listing.descripcion)
        .addFields(
            { name: '💰 Precio', value: `**$${listing.precio.toLocaleString('es-MX')} MXN**`, inline: true },
            { name: 'Estado', value: estado, inline: true },
        )
        .setFooter({ text: '7x Community · Consulta al staff para más información' })
        .setTimestamp();

    if (listing.imagenUrl) embed.setImage(listing.imagenUrl);
    return embed;
}

async function handleAcc(interaction) {
    if (!isOwner(interaction)) {
        return safeReply(interaction, { content: '❌ Solo el owner puede usar este comando.', ephemeral: true });
    }

    const nombre = interaction.options.getString('nombre', true).trim();
    const key = keyFor(nombre);
    const listings = load();
    if (listings[key]) {
        return safeReply(interaction, {
            content: `❌ Ya existe una ficha para **${listings[key].nombre}**. Usa otro nombre o actualiza su disponibilidad con /accdispo.`,
            ephemeral: true,
        });
    }

    const imagenes = ['imagen1', 'imagen2'].map(name => interaction.options.getAttachment(name)).filter(Boolean);
    const videos = ['video1', 'video2'].map(name => interaction.options.getAttachment(name)).filter(Boolean);
    if (imagenes.some(file => !file.contentType?.startsWith('image/'))) {
        return safeReply(interaction, { content: '❌ Los archivos de imagen deben ser imágenes válidas.', ephemeral: true });
    }
    if (videos.some(file => !file.contentType?.startsWith('video/'))) {
        return safeReply(interaction, { content: '❌ Los archivos de video deben ser videos válidos.', ephemeral: true });
    }

    const listing = {
        nombre,
        titulo: interaction.options.getString('titulo', true).trim(),
        descripcion: interaction.options.getString('descripcion', true).trim(),
        precio: interaction.options.getNumber('precio', true),
        disponible: interaction.options.getBoolean('disponible', true),
        imagenUrl: imagenes[0]?.url ?? null,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        messageId: null,
        createdAt: new Date().toISOString(),
    };

    try {
        await interaction.reply({
            embeds: [buildEmbed(listing)],
            files: [...imagenes, ...videos].map((file, index) => ({
                attachment: file.url,
                name: `${file.contentType.startsWith('video/') ? 'video' : 'imagen'}-${index + 1}.${(file.name.split('.').pop() || 'bin').replace(/[^a-z0-9]/gi, '')}`,
            })),
            allowedMentions: { parse: [] },
            fetchReply: true,
        });
        const message = await interaction.fetchReply();
        listing.messageId = message.id;
        listings[key] = listing;
        save(listings);
    } catch (err) {
        console.error('[accounts] No se pudo publicar o guardar la ficha:', err?.message);
        if (interaction.replied) {
            await interaction.followUp({ content: '⚠️ La ficha se publicó, pero no pude guardar sus datos para futuras actualizaciones.', ephemeral: true }).catch(() => {});
        } else {
            await safeReply(interaction, { content: '❌ No pude publicar la ficha. Revisa los archivos adjuntos e inténtalo de nuevo.', ephemeral: true });
        }
    }
}

async function handleAccDispo(interaction) {
    if (!isOwner(interaction)) {
        return safeReply(interaction, { content: '❌ Solo el owner puede usar este comando.', ephemeral: true });
    }

    const nombre = interaction.options.getString('nombre', true).trim();
    const key = keyFor(nombre);
    const listings = load();
    const listing = listings[key];
    if (!listing) {
        return safeReply(interaction, { content: `❌ No encontré una ficha para **${nombre}**.`, ephemeral: true });
    }

    listing.disponible = interaction.options.getBoolean('disponible', true);
    try {
        const channel = await interaction.client.channels.fetch(listing.channelId);
        const message = await channel?.messages.fetch(listing.messageId);
        if (!message) throw new Error('listing message not found');
        await message.edit({ embeds: [buildEmbed(listing)] });
        save(listings);
        return safeReply(interaction, {
            content: `✅ **${listing.nombre}** ahora aparece como ${listing.disponible ? 'disponible' : 'no disponible'}.`,
            ephemeral: true,
        });
    } catch (err) {
        console.error('[accounts] No se pudo actualizar la ficha:', err?.message);
        return safeReply(interaction, {
            content: '❌ No pude actualizar la publicación. Puede que el mensaje ya no exista o el bot no tenga acceso al canal.',
            ephemeral: true,
        });
    }
}

module.exports = { handleAcc, handleAccDispo, __test: { buildEmbed, keyFor } };
