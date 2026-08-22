'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, escapeMarkdown } = require('discord.js');
const { safeDeferReply, safeReply, safeEditReply, safeFollowUp, safeDeferUpdate } = require('../utils/safe');
const roblox = require('../src/roblox/client');
const outfitApi = require('../utils/outfitApi');
const config = require('../config');

// /addgroup, /deletegroup, /checkgroup and /groups — the license system for
// Roblox groups, on top of outfit-api's /admin/groups.
//
// TWO RULES THIS FILE EXISTS TO ENFORCE, both easy to break by accident:
//
//   1. Roblox is asked FIRST. A group id that isn't a real group never
//      becomes a license: /addgroup stops before it ever calls the API. A
//      license for a typo'd id looks perfectly fine in every panel and only
//      surfaces the day a paying customer says "it doesn't work".
//   2. Nothing internal reaches a message. No URLs, no key, no raw upstream
//      error — every failure shown here comes from utils/outfitApi.js's
//      sanitized OutfitApiError, which is built precisely so an axios error
//      (headers, admin key and all) can't escape into a Discord embed or a
//      Railway log.
//
// Storage lives entirely in outfit-api/Postgres. This bot keeps no local copy
// of the whitelist on purpose: two copies of "who paid" drift, and the one on
// a Railway container's disk is the one that disappears on redeploy.

// ── Look ─────────────────────────────────────────────────────────────────────
// Soft, "completed"-looking tones rather than saturated ones: these embeds are
// posted publicly in a customer-facing server.
const VERDE   = 0x6FCF97; // license granted / active
const ROJO    = 0xE57373; // license withdrawn — soft, not alarm red
const NARANJA = 0xF2994A; // known group, license no longer valid
const GRIS    = 0x9AA0A6; // never had a license at all
const NEUTRO  = 0x2B2D31; // the listing, same gray as the rest of the bot's panels

const FOOTER = '7x Community • Sistema de licencias';

const GRUPOS_POR_PAGINA = 8;

// Same shape outfit-api validates on its side (see its validation/params.js):
// positive integer, no leading zeros — "007" and "7" must never be able to
// become two rows for the same group.
const GROUP_ID_PATTERN = /^[1-9][0-9]{0,19}$/;
const ROBLOX_USER_PATTERN = /^[A-Za-z0-9_]{3,20}$/;

// ── Small helpers ────────────────────────────────────────────────────────────

function esOwner(interaction) {
    return interaction.user.id === config.OWNER_ID;
}

function denegar(interaction) {
    return safeReply(interaction, {
        content: '❌ No tienes permiso para usar este comando.',
        ephemeral: true,
    });
}

// Full date AND relative age, both from the same timestamp: Discord renders
// them in each viewer's own timezone and language, which a preformatted date
// string can't do. The relative line is what makes "hace 3 meses" readable at
// a glance without doing arithmetic on a date.
function fecha(iso) {
    if (!iso) return '—';
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return '—';
    const unix = Math.floor(ms / 1000);
    return `<t:${unix}:F>\n<t:${unix}:R>`;
}

// Group names and Roblox usernames are attacker-adjacent text (anyone can name
// a Roblox group `**__@everyone__**`): escaped so they can never reshape the
// embed they're printed in.
function texto(valor, fallback = '—') {
    if (valor === null || valor === undefined || valor === '') return fallback;
    return escapeMarkdown(String(valor));
}

function mencion(discordUserId) {
    return discordUserId ? `<@${discordUserId}>\n\`${discordUserId}\`` : '—';
}

// The bot validates before spending a Roblox call or an API round trip; the
// API validates again on its side. Neither is redundant — this one exists to
// give a fast, specific answer in Discord, the other is the real boundary.
function validarGroupId(raw) {
    const groupId = (raw ?? '').trim();
    return GROUP_ID_PATTERN.test(groupId) ? groupId : null;
}

// The ONLY text allowed into a Discord message from a failure. An
// OutfitApiError was built to be shown (see utils/outfitApi.js); anything else
// reaching here is a bug in this file, and a bug's message can carry paths,
// stacks or upstream detail — so it gets logged and replaced, never printed.
function mensajeDeError(err) {
    if (err instanceof outfitApi.OutfitApiError) return err.message;
    console.error('[licencias] error inesperado:', err?.message);
    return 'Ocurrió un error inesperado con el sistema de licencias. Vuelve a intentarlo.';
}

// Public deferral + an error means the pending "thinking..." message has to go
// away, and the explanation should not stay in the channel: same treatment
// /outfit already gives its failures (see handlers/commands.js).
async function fallar(interaction, mensaje) {
    await interaction.deleteReply().catch(() => {});
    await safeFollowUp(interaction, { content: mensaje, ephemeral: true });
}

// Roblox data is decoration for everything except /addgroup's existence check:
// a license must still be listable, checkable and removable when Roblox is
// down or rate-limiting. Hence allSettled and a null-shaped fallback.
async function datosDeRoblox(groupId) {
    const [info, icono] = await Promise.allSettled([
        roblox.getGroupInfo(groupId),
        roblox.getGroupIcon(groupId),
    ]).then(r => r.map(x => (x.status === 'fulfilled' ? x.value : null)));

    return { info, icono };
}

// ── Embeds ───────────────────────────────────────────────────────────────────

function buildAddedEmbed({ licencia, nombreGrupo, iconUrl, actorId }) {
    return new EmbedBuilder()
        .setColor(VERDE)
        .setTitle('Licencia agregada')
        .setThumbnail(iconUrl ?? undefined)
        .addFields(
            { name: 'Estado',             value: 'Activa ✅',                          inline: true },
            { name: 'Grupo',              value: texto(nombreGrupo),                   inline: true },
            { name: 'Group ID',           value: `\`${licencia.groupId}\``,            inline: true },
            { name: 'Usuario de Discord', value: mencion(licencia.discordUserId),      inline: true },
            { name: 'Usuario de Roblox',  value: texto(licencia.robloxUsername),       inline: true },
            { name: 'Agregado por',       value: actorId ? `<@${actorId}>` : '—',      inline: true },
            { name: 'Alta original',      value: fecha(licencia.createdAt),            inline: true },
            { name: 'Enlace actual',      value: fecha(licencia.linkedAt),             inline: true },
            {
                name: 'Tipo',
                // The API's `created` flag is the only honest source for this:
                // it comes from whether Postgres INSERTed or UPDATEd the row,
                // not from a guess made here.
                value: licencia.created ? '🆕 Licencia nueva' : '♻️ Licencia reactivada',
                inline: true,
            },
        )
        .setFooter({ text: FOOTER })
        .setTimestamp();
}

function buildRemovedEmbed({ licencia, nombreGrupo, iconUrl, actorId, motivo }) {
    return new EmbedBuilder()
        .setColor(ROJO)
        .setTitle('⛔ Licencia desactivada')
        .setThumbnail(iconUrl ?? undefined)
        .addFields(
            { name: 'Estado',             value: 'Inactiva',                       inline: true },
            { name: 'Grupo',              value: texto(nombreGrupo),               inline: true },
            { name: 'Group ID',           value: `\`${licencia.groupId}\``,        inline: true },
            { name: 'Usuario de Discord', value: mencion(licencia.discordUserId),  inline: true },
            { name: 'Usuario de Roblox',  value: texto(licencia.robloxUsername),   inline: true },
            { name: 'Desactivado por',    value: actorId ? `<@${actorId}>` : '—',  inline: true },
            { name: 'Motivo',             value: texto(motivo, 'No especificado'), inline: false },
            { name: 'Alta original',      value: fecha(licencia.createdAt),        inline: true },
            { name: 'Fecha de baja',      value: fecha(licencia.deactivatedAt),    inline: true },
        )
        .setFooter({ text: FOOTER })
        .setTimestamp();
}

// Three outcomes, three colors, and the difference between the last two is the
// point: "had a license and lost it" and "never had one" look identical if you
// only ask "is it authorized?", and they mean very different things when a
// customer is waiting for an answer.
function buildCheckEmbed({ estado, groupId, nombreGrupo, iconUrl, miembros }) {
    const autorizada = estado.authorized === true;
    const conocida = estado.found === true;

    const color = autorizada ? VERDE : conocida ? NARANJA : GRIS;
    const titulo = autorizada ? '✅ Licencia activa' : conocida ? '⛔ Licencia desactivada' : '❔ Sin licencia';
    const linea = autorizada
        ? 'Activa ✅ — el grupo está autorizado.'
        : conocida
            ? 'Inactiva ⛔ — tuvo licencia y se le retiró.'
            : 'Sin licencia ❔ — este grupo nunca fue dado de alta.';

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle(titulo)
        .setThumbnail(iconUrl ?? undefined)
        .addFields(
            { name: 'Estado',             value: linea,                          inline: false },
            { name: 'Grupo',              value: texto(nombreGrupo),             inline: true },
            { name: 'Group ID',           value: `\`${groupId}\``,               inline: true },
            { name: 'Miembros',           value: miembros != null ? miembros.toLocaleString('es-ES') : '—', inline: true },
            { name: 'Usuario de Discord', value: mencion(estado.discordUserId),  inline: true },
            { name: 'Usuario de Roblox',  value: texto(estado.robloxUsername),   inline: true },
            { name: 'Autorizado ahora',   value: autorizada ? 'Sí' : 'No',       inline: true },
            { name: 'Alta original',      value: fecha(estado.createdAt),        inline: true },
            { name: 'Último enlace',      value: fecha(estado.linkedAt),         inline: true },
        )
        .setFooter({ text: FOOTER })
        .setTimestamp();

    // Only shown when there IS a withdrawal to explain — an empty "Motivo: —"
    // on an active license is noise.
    if (conocida && !autorizada) {
        embed.addFields(
            { name: 'Fecha de baja',   value: fecha(estado.deactivatedAt),                 inline: true },
            { name: 'Desactivado por', value: estado.deactivatedBy ? `<@${estado.deactivatedBy}>` : '—', inline: true },
            { name: 'Motivo',          value: texto(estado.deactivationReason, 'No especificado'),       inline: false },
        );
    }

    return embed;
}

// Pure, and exported for the tests: the paging arithmetic is the part of the
// listing that can silently drop a license, so it's worth pinning down without
// a Discord client anywhere near it.
function paginar(groups, porPagina = GRUPOS_POR_PAGINA) {
    const paginas = [];
    for (let i = 0; i < groups.length; i += porPagina) paginas.push(groups.slice(i, i + porPagina));
    return paginas.length ? paginas : [[]];
}

function lineaDeGrupo(group) {
    const icono = group.active ? '✅' : '⛔';
    const nombre = texto(group.groupName, 'Grupo sin nombre guardado');
    const discord = group.discordUserId ? `<@${group.discordUserId}>` : 'Discord no enlazado';
    const roblox = texto(group.robloxUsername, 'Roblox no enlazado');
    return `${icono} **${nombre}** — \`${group.groupId}\`\n${discord} • ${roblox}`;
}

function buildListEmbed({ groups, total, pagina, paginas, truncado }) {
    const activas = groups.filter(g => g.active).length;
    const inactivas = groups.length - activas;
    const enPagina = paginar(groups)[pagina] ?? [];

    const cuerpo = enPagina.length
        ? enPagina.map(lineaDeGrupo).join('\n\n')
        : '_No hay ninguna licencia registrada todavía._';

    const embed = new EmbedBuilder()
        .setColor(NEUTRO)
        .setTitle('Licencias de grupos')
        .setDescription(
            `**Total:** ${total}  •  **Activas:** ${activas}  •  **Inactivas:** ${inactivas}\n\n${cuerpo}`
        )
        .setFooter({ text: `Página ${pagina + 1}/${paginas} • ${FOOTER}` })
        .setTimestamp();

    // Said out loud instead of quietly showing fewer: a listing that cuts off
    // in silence reads exactly like a complete one.
    if (truncado) {
        embed.addFields({
            name: '⚠️ Listado incompleto',
            value: 'Hay más licencias de las que caben en una consulta. Se muestran las más recientes.',
            inline: false,
        });
    }

    return embed;
}

function buildListRow(pagina, paginas) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`gl_groups:${pagina - 1}`)
            .setLabel('Anterior')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(pagina <= 0),
        new ButtonBuilder()
            .setCustomId(`gl_groups:${pagina + 1}`)
            .setLabel('Siguiente')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(pagina >= paginas - 1),
    );
}

// ── /addgroup ────────────────────────────────────────────────────────────────

async function handleAddGroup(interaction) {
    if (!esOwner(interaction)) return denegar(interaction);

    const groupId = validarGroupId(interaction.options.getString('group_id'));
    const discordUser = interaction.options.getUser('discord_user');
    const robloxUser = (interaction.options.getString('roblox_user') ?? '').trim();

    // Both checks BEFORE deferring: an obviously wrong argument deserves an
    // instant private answer, not a public "thinking..." that turns into an
    // error in front of the whole server.
    if (!groupId) {
        return safeReply(interaction, {
            content: '❌ El **Group ID** debe ser el id numérico del grupo de Roblox, sin ceros a la izquierda.',
            ephemeral: true,
        });
    }
    if (!ROBLOX_USER_PATTERN.test(robloxUser)) {
        return safeReply(interaction, {
            content: '❌ El **usuario de Roblox** debe tener entre 3 y 20 caracteres alfanuméricos o guion bajo.',
            ephemeral: true,
        });
    }

    if (!await safeDeferReply(interaction)) return; // público

    // 1. Roblox decides whether this group exists. If it doesn't, we stop
    //    here: no license is created for an id nobody can join.
    let info;
    try {
        info = await roblox.getGroupInfo(groupId);
    } catch (err) {
        if (err?.message === 'not_found') {
            return fallar(interaction, `❌ Roblox no encuentra ningún grupo con el ID \`${groupId}\`. No se creó ninguna licencia.`);
        }
        console.error('[addgroup] Roblox falló:', err?.response?.status ?? null, err?.message);
        return fallar(
            interaction,
            '❌ No se pudo comprobar el grupo en Roblox, así que **no se creó la licencia**. Inténtalo de nuevo en unos segundos.'
        );
    }

    // 2. The icon is decoration: a missing image never blocks a sale.
    const iconUrl = await roblox.getGroupIcon(groupId).catch(() => null);

    // 3. Only now does the license get written, through the API.
    let licencia;
    try {
        licencia = await outfitApi.addGroup({
            groupId,
            discordUserId: discordUser.id,
            robloxUsername: robloxUser,
            groupName: info.name,
            addedBy: interaction.user.id,
        });
    } catch (err) {
        return fallar(interaction, `❌ ${mensajeDeError(err)}`);
    }

    await safeEditReply(interaction, {
        embeds: [buildAddedEmbed({
            licencia,
            nombreGrupo: licencia.groupName ?? info.name,
            iconUrl,
            actorId: licencia.addedBy ?? interaction.user.id,
        })],
    });
}

// ── /deletegroup ─────────────────────────────────────────────────────────────

async function handleDeleteGroup(interaction) {
    if (!esOwner(interaction)) return denegar(interaction);

    const groupId = validarGroupId(interaction.options.getString('group_id'));
    const motivo = (interaction.options.getString('motivo') ?? '').trim() || null;

    if (!groupId) {
        return safeReply(interaction, {
            content: '❌ El **Group ID** debe ser el id numérico del grupo de Roblox, sin ceros a la izquierda.',
            ephemeral: true,
        });
    }

    if (!await safeDeferReply(interaction)) return; // público

    // The row is NOT deleted: outfit-api deactivates it and keeps the original
    // date, the buyer and now the reason. That record is what answers a
    // dispute months later.
    let licencia;
    try {
        licencia = await outfitApi.removeGroup(groupId, { reason: motivo, actorId: interaction.user.id });
    } catch (err) {
        if (err.code === 'group_not_found') {
            return fallar(interaction, `❌ El grupo \`${groupId}\` no está en la whitelist, así que no hay nada que desactivar.`);
        }
        return fallar(interaction, `❌ ${mensajeDeError(err)}`);
    }

    // Roblox only for the name/icon, and only if it answers. The license is
    // already withdrawn at this point — nothing here can undo that.
    const { info, icono } = await datosDeRoblox(groupId);

    await safeEditReply(interaction, {
        embeds: [buildRemovedEmbed({
            licencia,
            nombreGrupo: info?.name ?? licencia.groupName,
            iconUrl: icono,
            actorId: licencia.deactivatedBy ?? interaction.user.id,
            motivo: licencia.deactivationReason ?? motivo,
        })],
    });
}

// ── /checkgroup ──────────────────────────────────────────────────────────────

async function handleCheckGroup(interaction) {
    if (!esOwner(interaction)) return denegar(interaction);

    const groupId = validarGroupId(interaction.options.getString('group_id'));
    if (!groupId) {
        return safeReply(interaction, {
            content: '❌ El **Group ID** debe ser el id numérico del grupo de Roblox, sin ceros a la izquierda.',
            ephemeral: true,
        });
    }

    if (!await safeDeferReply(interaction)) return; // público

    let estado;
    try {
        estado = await outfitApi.getGroup(groupId);
    } catch (err) {
        return fallar(interaction, `❌ ${mensajeDeError(err)}`);
    }

    const { info, icono } = await datosDeRoblox(groupId);

    await safeEditReply(interaction, {
        embeds: [buildCheckEmbed({
            estado,
            groupId,
            // Live name first, stored name as fallback: a group can be renamed
            // after the license was granted, and the current name is the one
            // that helps whoever is reading.
            nombreGrupo: info?.name ?? estado.groupName,
            iconUrl: icono,
            miembros: info?.memberCount ?? null,
        })],
    });
}

// ── /groups ──────────────────────────────────────────────────────────────────

async function renderListado(pagina) {
    const { groups, total, truncated } = await outfitApi.listAllGroups({ includeInactive: true });
    const paginas = paginar(groups).length;
    const actual = Math.min(Math.max(pagina, 0), paginas - 1);

    return {
        embeds: [buildListEmbed({ groups, total, pagina: actual, paginas, truncado: truncated })],
        components: paginas > 1 ? [buildListRow(actual, paginas)] : [],
    };
}

// The only one of the four that is EPHEMERAL: the other three announce a
// decision and belong in the channel, this one is an internal roster with
// every customer's Discord and Roblox account in it.
async function handleGroups(interaction) {
    if (!esOwner(interaction)) return denegar(interaction);
    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    try {
        await safeEditReply(interaction, await renderListado(0));
    } catch (err) {
        await safeEditReply(interaction, { content: `❌ ${mensajeDeError(err)}`, embeds: [], components: [] });
    }
}

// Paging re-queries the API instead of caching the list in memory: the roster
// is small, the data is then never stale, and the buttons keep working after a
// restart instead of dying silently.
async function handleGroupsPageButton(interaction) {
    if (!esOwner(interaction)) return denegar(interaction);

    const pagina = Number.parseInt(interaction.customId.split(':')[1], 10);
    if (!Number.isInteger(pagina)) return;

    // Acknowledge first: re-querying can take a couple of seconds and Discord
    // gives an interaction 3 to be answered.
    if (!await safeDeferUpdate(interaction)) return;

    try {
        await safeEditReply(interaction, await renderListado(pagina));
    } catch (err) {
        await safeEditReply(interaction, { content: `❌ ${mensajeDeError(err)}`, embeds: [], components: [] });
    }
}

module.exports = {
    handleAddGroup,
    handleDeleteGroup,
    handleCheckGroup,
    handleGroups,
    handleGroupsPageButton,
    // Exported for src/tests/groupLicenses.test.js — all pure, no Discord
    // client and no network involved.
    __test: {
        buildAddedEmbed,
        buildRemovedEmbed,
        buildCheckEmbed,
        buildListEmbed,
        buildListRow,
        paginar,
        validarGroupId,
        fecha,
        GRUPOS_POR_PAGINA,
    },
};
