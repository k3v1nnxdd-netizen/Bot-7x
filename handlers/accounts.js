'use strict';

const fs = require('fs');
const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const { dataPath, ensureDataDir } = require('../utils/dataDir');
const { safeDeferReply, safeEditReply, safeReply } = require('../utils/safe');

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

    // Acknowledge before transferring media. Discord expires an interaction
    // after a few seconds, while a video upload can take considerably longer.
    const deferred = await safeDeferReply(interaction, { ephemeral: true });
    if (!deferred) return;

    const nombre = interaction.options.getString('nombre', true).trim();
    const key = keyFor(nombre);
    const listings = load();
    if (listings[key]) {
        return safeEditReply(interaction, {
            content: `❌ Ya existe una ficha para **${listings[key].nombre}**. Usa otro nombre o actualiza su disponibilidad con /accdispo.`,
        });
    }

    const imagenes = ['imagen1', 'imagen2'].map(name => interaction.options.getAttachment(name)).filter(Boolean);
    const videos = ['video1', 'video2'].map(name => interaction.options.getAttachment(name)).filter(Boolean);
    if (imagenes.some(file => !file.contentType?.startsWith('image/'))) {
        return safeEditReply(interaction, { content: '❌ Los archivos de imagen deben ser imágenes válidas.' });
    }
    if (videos.some(file => !file.contentType?.startsWith('video/'))) {
        return safeEditReply(interaction, { content: '❌ Los archivos de video deben ser videos válidos.' });
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

    let message = null;
    try {
        await safeEditReply(interaction, { content: '⏳ Preparando la ficha y subiendo los archivos…' });

        const channel = interaction.channel;
        if (!channel?.isTextBased() || typeof channel.send !== 'function') {
            return safeEditReply(interaction, { content: '❌ Usa `/acc` en un canal de texto donde el bot pueda publicar.' });
        }

        const files = [...imagenes, ...videos].map((file, index) => {
            const originalName = file.name || '';
            const extension = originalName.includes('.')
                ? originalName.split('.').pop().replace(/[^a-z0-9]/gi, '').toLowerCase()
                : '';
            const kind = file.contentType.startsWith('video/') ? 'video' : 'imagen';
            return {
                attachment: file.url,
                name: `${kind}-${index + 1}.${extension || 'bin'}`,
            };
        });

        message = await channel.send({
            embeds: [buildEmbed(listing)],
            files,
            allowedMentions: { parse: [] },
        });
        listing.messageId = message.id;
        listings[key] = listing;
        save(listings);

        return safeEditReply(interaction, {
            content: `✅ Ficha publicada correctamente. Identificador interno: **${listing.nombre}**.`,
        });
    } catch (err) {
        console.error('[accounts] No se pudo publicar o guardar la ficha:', err?.message);
        const messageText = message
            ? `⚠️ La publicación ${message.url} se envió, pero no pude guardar sus datos para futuras actualizaciones.`
            : '❌ No pude publicar la ficha. Revisa el tamaño y formato de los archivos, los permisos del bot y vuelve a intentarlo.';
        return safeEditReply(interaction, { content: messageText });
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

async function handleAccDispoAutocomplete(interaction) {
    if (!isOwner(interaction)) return interaction.respond([]);

    const focused = interaction.options.getFocused().trim().toLocaleLowerCase('es-MX');
    const choices = Object.values(load())
        .filter(listing => listing?.disponible === true && typeof listing.nombre === 'string')
        .filter(listing => listing.nombre.toLocaleLowerCase('es-MX').includes(focused))
        .slice(0, 25)
        .map(listing => ({
            name: `${listing.nombre} · $${Number(listing.precio).toLocaleString('es-MX')} MXN`.slice(0, 100),
            value: listing.nombre,
        }));

    return interaction.respond(choices);
}

module.exports = { handleAcc, handleAccDispo, handleAccDispoAutocomplete, __test: { buildEmbed, keyFor } };
