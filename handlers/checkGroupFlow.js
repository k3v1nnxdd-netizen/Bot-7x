'use strict';

const fs = require('fs');
const path = require('path');
const {
    EmbedBuilder, ActionRowBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { safeReply, safeEditReply, safeDeferReply, safeShowModal } = require('../utils/safe');
const { checkMembership, getGroup, getPlayerAvatar, getCommunityIcon, GroupCheckError } = require('../utils/groupMembership');
const config = require('../config');

const EMBED_COLOR = 0x2B2D31; // gray, per request

// Check Group's es 100% automático: el veredicto lo da Roblox y nadie más.
// No hay botones bajo los resultados, nadie revisa nada a mano, no hay cola de
// pendientes y no hay ninguna decisión de elegibilidad en manos del owner. Si
// Roblox no contesta, NO se publica nada — el usuario recibe un aviso efímero y
// el detalle técnico se queda en consola. Publicar un "NO ELEGIBLE" porque una
// API falló le negaría Robux a un cliente que sí los tenía ganados, y en
// pantalla se vería idéntico a un "no" legítimo.

// Imagen local de respaldo por comunidad. NO es la fuente principal: la tarjeta
// pide a Roblox el icono ACTUAL del grupo (ver getCommunityIcon) y sólo cae aquí
// si Roblox todavía no tiene uno renderizado. El label y el ID de Roblox no
// están en este archivo: viven en config.CHECK_GROUPS.
const GROUP_FILES = {
    noctra:    { file: path.join(__dirname, '..', 'se7en.png'),        attachName: 'se7en.png' },
    community: { file: path.join(__dirname, '..', '7 communitys.png'), attachName: 'communitys.png' },
    group7x:   { file: path.join(__dirname, '..', '$7 studio.png'),    attachName: 'studio.png' },
};

function groupFallbackImage(groupKey) {
    const assets = GROUP_FILES[groupKey];
    if (!assets) return null;
    return fs.existsSync(assets.file) ? assets : null;
}

// ── Step 1: panel button click → ask Roblox username via modal ───────────────

function buildUsernameModal(groupKey, groupLabel) {
    const modal = new ModalBuilder().setCustomId(`cg_modal_${groupKey}`).setTitle(`Check Group — ${groupLabel}`.slice(0, 45));
    modal.addComponents(
        new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('roblox_username')
                .setLabel('¿Cuál es tu usuario de Roblox?')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Ej: PlayerName123')
                .setMinLength(3)
                .setMaxLength(20)
                .setRequired(true)
        )
    );
    return modal;
}

async function handleCheckGroupButton(interaction) {
    if (interaction.replied || interaction.deferred) return;

    const groupKey = interaction.customId.slice('cg_'.length);
    const group = getGroup(groupKey);
    if (!group) return;

    // Sin ID de Roblox no hay nada que consultar: mejor decirlo antes de pedir
    // el usuario que después de que lo escriba.
    if (!group.groupId) {
        return safeReply(interaction, {
            content: `❌ La comunidad **${group.label}** todavía no está configurada. Avisa a un administrador.`,
            ephemeral: true,
        });
    }

    const ok = await safeShowModal(interaction, buildUsernameModal(groupKey, group.label));
    if (!ok) await safeReply(interaction, { content: '❌ No se pudo abrir el formulario. Intenta de nuevo.', ephemeral: true });
}

// ── The result card ──────────────────────────────────────────────────────────
// Compacta y horizontal: tres columnas (inline) y nada más. Los emojis del
// servidor van SIEMPRE en el value de un field — Discord no los renderiza en un
// título, en el NAME de un field ni en el footer; ahí se imprimen crudos, como
// `<:true:1501213776878501899>`.

const EMOJI = {
    point: '<:point:1501212595464700104>',
    ok:    '<:true:1501213776878501899>',
    alert: '<:alert:1501220021035204658>',
};

const FIELD = {
    JOINED: 'Se unió',
    AGE:    'Antigüedad',
    STATUS: 'Estado',
};

// Un field necesita nombre; para la línea de "le faltan N días" no hay ninguno
// que aporte algo, así que va un espacio de ancho cero. Se pinta como una línea
// suelta debajo de las tres columnas, que es justo lo que queremos.
const BLANK_FIELD_NAME = '​';

const NONE = '—';

function statusValue(status) {
    switch (status) {
        case 'eligible':     return `${EMOJI.ok} **ELEGIBLE**`;
        case 'not_eligible': return `${EMOJI.alert} **NO ELEGIBLE**`;
        case 'not_member':   return `${EMOJI.alert} **NO PERTENECE**`;
        default:             return NONE;
    }
}

function missingDaysLine(days) {
    const left = Math.max(0, config.MIN_GROUP_DAYS - days);
    return `${EMOJI.point} Le falta${left === 1 ? '' : 'n'} **${left} día${left === 1 ? '' : 's'}** para ser elegible.`;
}

// Avatar del jugador = icono pequeño del author, a la izquierda junto al
// nombre. Icono de la comunidad = thumbnail, arriba a la derecha. Ninguna
// imagen grande: eso es lo que hacía la tarjeta demasiado alta.
function buildResultEmbed({
    groupKey, groupLabel,
    robloxUsername, status,
    joinedAt = null, days = null,
    avatarUrl = null, iconUrl = null,
    requesterName = null,
}) {
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle(`Check Group's — ${groupLabel}`.slice(0, 256));

    const author = { name: String(robloxUsername).slice(0, 256) };
    if (avatarUrl) author.iconURL = avatarUrl;
    embed.setAuthor(author);

    embed.addFields(
        { name: FIELD.JOINED, value: joinedAt ? `<t:${Math.floor(joinedAt.getTime() / 1000)}:D>` : NONE, inline: true },
        { name: FIELD.AGE,    value: days === null ? NONE : `**${days} día${days === 1 ? '' : 's'}**`,   inline: true },
        { name: FIELD.STATUS, value: statusValue(status),                                                inline: true },
    );

    // Sólo si de verdad falta algo. En un no-miembro sería un número inventado.
    if (status === 'not_eligible' && days !== null) {
        embed.addFields({ name: BLANK_FIELD_NAME, value: missingDaysLine(days), inline: false });
    }

    if (requesterName) embed.setFooter({ text: `Solicitado por ${requesterName}`.slice(0, 2048) });

    // Icono actual de Roblox primero; el PNG del repo sólo como último recurso.
    const fallback = iconUrl ? null : groupFallbackImage(groupKey);
    if (iconUrl) embed.setThumbnail(iconUrl);
    else if (fallback) embed.setThumbnail(`attachment://${fallback.attachName}`);

    return { embed, fallbackFile: fallback };
}

// ── Step 2: username submitted → ask Roblox and publish the verdict ──────────

// Errores que el usuario puede corregir por su cuenta: se le dice exactamente
// qué pasó. Cualquier otro código es un problema nuestro o de Roblox, y para
// ésos hay un único mensaje genérico — el detalle técnico va a consola, nunca a
// Discord (una API key, una URL interna o un stack no son cosas que se enseñen
// en un canal).
const USER_FIXABLE = {
    user_not_found:        username => `❌ No encontramos ninguna cuenta de Roblox llamada **${username}**. Revisa que esté bien escrito.`,
    invalid_username:      () => '❌ Un usuario de Roblox son 3-20 caracteres: letras, números y guion bajo.',
    unknown_group:         () => '❌ Esa comunidad no existe en la configuración del bot.',
    group_not_configured:  () => '❌ Esa comunidad todavía no está configurada. Avisa a un administrador.',
};

const GENERIC_FAILURE = '❌ No se pudo comprobar tu antigüedad en Roblox en este momento. Intenta nuevamente más tarde.';

// El canal de resultados es SIEMPRE config.CHANNELS.CHECKGROUP_RESULTS. La
// caché del cliente puede no tenerlo (arranque en frío, canal nunca visto en
// esta sesión), así que si falla se pide a la API antes de darlo por perdido.
async function resolveResultsChannel(client) {
    const channelId = config.CHANNELS.CHECKGROUP_RESULTS;
    const cached = client.channels.cache.get(channelId);
    if (cached) return cached;

    const fetched = await client.channels.fetch(channelId).catch(err => {
        console.error(`[checkGroupFlow] No se pudo resolver el canal de resultados ${channelId}:`, err?.message ?? err);
        return null;
    });
    if (!fetched) console.warn(`[checkGroupFlow] Canal de resultados ${channelId} no encontrado.`);
    return fetched;
}

// Las dos imágenes en paralelo, y ninguna puede tumbar la solicitud: ambas
// devuelven null en vez de lanzar (ver utils/groupMembership.js).
async function fetchImages({ robloxUserId, groupId }) {
    const [avatarUrl, iconUrl] = await Promise.all([
        robloxUserId ? getPlayerAvatar(robloxUserId) : Promise.resolve(null),
        groupId ? getCommunityIcon(groupId) : Promise.resolve(null),
    ]);
    return { avatarUrl, iconUrl };
}

function requesterNameOf(interaction) {
    return interaction.member?.displayName
        ?? interaction.user?.displayName
        ?? interaction.user?.username
        ?? 'un usuario';
}

async function handleCheckGroupModal(interaction) {
    if (interaction.replied || interaction.deferred) return;

    const groupKey = interaction.customId.slice('cg_modal_'.length);
    const group = getGroup(groupKey);
    if (!group) return;

    const username = interaction.fields.getTextInputValue('roblox_username').trim();
    if (!username) {
        return safeReply(interaction, { content: '❌ Ingresa un nombre de usuario válido.', ephemeral: true });
    }

    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    // ── Consulta a Roblox ────────────────────────────────────────────────────
    let result;
    try {
        result = await checkMembership(groupKey, username);
    } catch (err) {
        const code = err instanceof GroupCheckError ? err.code : 'unexpected';

        const mensajeConcreto = USER_FIXABLE[code];
        if (mensajeConcreto) {
            console.warn(`[checkGroupFlow] ${interaction.user.id} → ${groupKey}/"${username}": ${code}`);
            return safeEditReply(interaction, { content: mensajeConcreto(username) });
        }

        // Fallo nuestro o de Roblox: NO se publica nada, NO se marca como no
        // elegible y NO se abre ninguna revisión. Sólo aviso al usuario y el
        // detalle en consola.
        console.error(
            `[checkGroupFlow] No se pudo comprobar ${groupKey} (${group.groupId}) / "${username}" ` +
            `solicitado por ${interaction.user.id}: ${code} — ${err?.message ?? 'sin detalle'}`
        );
        return safeEditReply(interaction, { content: GENERIC_FAILURE });
    }

    // ── Publicación del resultado ────────────────────────────────────────────
    const resultsChannel = await resolveResultsChannel(interaction.client);
    if (!resultsChannel) {
        return safeEditReply(interaction, { content: GENERIC_FAILURE });
    }

    const status = !result.isMember ? 'not_member' : result.eligible ? 'eligible' : 'not_eligible';
    console.log(
        `[checkGroupFlow] ${interaction.user.id} → ${group.label} (${group.groupId}) / ${result.robloxUsername} (${result.robloxUserId}): ` +
        `${result.isMember ? `${result.days} día(s), ingreso ${result.joinedAt.toISOString()}` : 'no es miembro'} → ${status}`
    );

    try {
        const images = await fetchImages({ robloxUserId: result.robloxUserId, groupId: result.groupId });
        const { embed, fallbackFile } = buildResultEmbed({
            groupKey,
            groupLabel: result.groupLabel,
            robloxUsername: result.robloxUsername,
            status,
            joinedAt: result.joinedAt,
            days: result.days,
            requesterName: requesterNameOf(interaction),
            ...images,
        });

        // Sin `components`: bajo un resultado no hay ningún botón que pulsar.
        await resultsChannel.send({
            embeds: [embed],
            ...(fallbackFile && { files: [{ attachment: fallbackFile.file, name: fallbackFile.attachName }] }),
        });
    } catch (err) {
        console.error('[checkGroupFlow] send error:', err);
        return safeEditReply(interaction, { content: '❌ Ocurrió un error al publicar tu resultado. Intenta de nuevo.' });
    }

    const resumen = !result.isMember
        ? `${EMOJI.alert} **${result.robloxUsername}** no pertenece a **${group.label}**.`
        : result.eligible
            ? `${EMOJI.ok} **${result.robloxUsername}** lleva **${result.days} día${result.days === 1 ? '' : 's'}** en **${group.label}**: elegible.`
            : `${EMOJI.alert} **${result.robloxUsername}** lleva **${result.days} día${result.days === 1 ? '' : 's'}** en **${group.label}**: aún no cumple los **${config.MIN_GROUP_DAYS} días** mínimos.`;

    await safeEditReply(interaction, {
        content: `${resumen}\n${EMOJI.point} Resultado publicado en <#${config.CHANNELS.CHECKGROUP_RESULTS}>.`,
    });
}

// ── Router (called from handlers/buttons.js and handlers/modals.js) ──────────

// `cg_elig_*` son los botones del flujo manual que este sistema ya no tiene.
// Siguen existiendo en las tarjetas que se publicaron ANTES de este cambio y
// que aún están en el canal, así que se les contesta en vez de dejar al owner
// mirando un "la interacción falló". No deciden nada: sólo dicen que ya no
// están en uso. Cuando esas tarjetas viejas desaparezcan del canal, estas tres
// líneas se pueden borrar.
const LEGACY_MANUAL_PREFIX = 'cg_elig';

async function handleCheckGroupButtonRouter(interaction) {
    if (interaction.customId.startsWith(LEGACY_MANUAL_PREFIX)) {
        return safeReply(interaction, {
            content: "ℹ️ Este botón ya no está en uso: Check Group's ahora resuelve la elegibilidad automáticamente con Roblox.",
            ephemeral: true,
        });
    }
    return handleCheckGroupButton(interaction);
}

module.exports = {
    handleCheckGroupButton: handleCheckGroupButtonRouter,
    handleCheckGroupModal,
    __test: { buildResultEmbed, statusValue, missingDaysLine, FIELD, BLANK_FIELD_NAME, GENERIC_FAILURE },
};
