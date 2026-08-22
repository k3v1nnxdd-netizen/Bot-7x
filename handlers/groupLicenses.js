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

// Emojis del servidor, no unicode. Se declaran aquí y en un solo sitio porque
// un id de emoji equivocado no falla: se imprime `<a:add:123>` en crudo en
// mitad de un mensaje público, y eso solo se ve en producción.
//
// OJO CON DÓNDE SE USAN: Discord solo los renderiza en el contenido del
// mensaje, en la descripción del embed y en el valor de un campo. En títulos,
// nombres de campo y pies aparecen como texto plano — ver el bloque de embeds.
const EMOJI = {
    grupo:   '<:followers7x:1525326777071960124>',
    roblox:  '<:roblox:1501213275482886205>',
    discord: '<a:dccc:1540604144325369907>',
    alta:    '<a:add:1540603311890104321>',
    baja:    '<a:remove:1540604743234228364>',
};

const FOOTER = '7x Community · Sistema de licencias';

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

// Fecha completa Y antigüedad relativa, las dos del mismo instante: Discord las
// pinta en la zona horaria y el idioma de cada quien, cosa que una fecha ya
// formateada no puede hacer. La segunda línea es la que hace legible "hace 3
// meses" sin ponerse a restar fechas.
//
// `:f` en vez de `:F` — misma fecha y hora completas, pero sin el día de la
// semana por delante, que en una rejilla de tres campos era lo único que
// obligaba a que cada uno ocupara dos renglones.
function fecha(iso) {
    if (!iso) return '—';
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return '—';
    const unix = Math.floor(ms / 1000);
    return `<t:${unix}:f>\n<t:${unix}:R>`;
}

// Group names and Roblox usernames are attacker-adjacent text (anyone can name
// a Roblox group `**__@everyone__**`): escaped so they can never reshape the
// embed they're printed in.
function texto(valor, fallback = '—') {
    if (valor === null || valor === undefined || valor === '') return fallback;
    return escapeMarkdown(String(valor));
}

// Mención Y id en la misma línea. El id en crudo no es decoración: una mención
// de alguien que se fue del servidor se queda en `@unknown-user`, y entonces el
// número es lo único que permite saber a quién estaba enlazada la licencia.
function mencion(discordUserId) {
    return discordUserId ? `<@${discordUserId}> · \`${discordUserId}\`` : '—';
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
//
// DÓNDE PUEDEN IR LOS EMOJIS DEL SERVIDOR, y no es una preferencia de estilo:
// Discord solo renderiza `<:nombre:id>` en el CONTENIDO del mensaje, en la
// DESCRIPCIÓN del embed y en el VALOR de un campo. En el título, en el nombre
// de un campo, en el pie o en el autor se imprime el texto crudo
// (`<a:add:1540603311890104321>`), que es peor que no poner nada. Por eso todo
// el peso visual vive en la descripción y los títulos son texto limpio.
//
// Eso además empuja al diseño compacto que se buscaba: en vez de nueve campos
// en rejilla, tres o cuatro líneas de descripción con el estado, el grupo y las
// dos cuentas, y una sola fila de campos para las fechas.

// Envuelve un valor en un code span. Se quitan las comillas invertidas del
// propio valor: un nombre que las lleve rompería el bloque y dejaría el resto
// de la línea en crudo.
function codigo(valor) {
    return `\`${String(valor).replace(/`/g, '')}\``;
}

// Las tres líneas de identidad que comparten los cuatro embeds: qué grupo, qué
// usuario de Discord y qué usuario de Roblox. Idénticas en todos a propósito —
// leer una licencia tiene que ser el mismo gesto en /addgroup, /deletegroup y
// /checkgroup, y eso vale más que adornar cada uno por su lado.
function bloqueLicencia({ nombreGrupo, groupId, discordUserId, robloxUsername, extra = null }) {
    const grupo = [
        `${EMOJI.grupo} **${texto(nombreGrupo, 'Grupo sin nombre')}**`,
        codigo(groupId),
        extra,
    ].filter(Boolean).join(' · ');

    const discord = discordUserId
        ? `${EMOJI.discord} ${mencion(discordUserId)}`
        : `${EMOJI.discord} Sin usuario de Discord enlazado`;

    const roblox = robloxUsername
        ? `${EMOJI.roblox} ${codigo(robloxUsername)}`
        : `${EMOJI.roblox} Sin usuario de Roblox enlazado`;

    return `${grupo}\n${discord}\n${roblox}`;
}

function buildAddedEmbed({ licencia, nombreGrupo, iconUrl, actorId }) {
    // `created` viene de si Postgres INSERTÓ o ACTUALIZÓ la fila (xmax = 0), no
    // de una suposición de aquí: es el único dato honesto sobre si la licencia
    // es nueva o una readmisión.
    const estado = `${EMOJI.alta} **Activa** · ${licencia.created ? 'Licencia nueva' : 'Licencia reactivada'}`;

    return new EmbedBuilder()
        .setColor(VERDE)
        .setTitle('Licencia agregada')
        .setThumbnail(iconUrl ?? undefined)
        .setDescription(`${estado}\n\n${bloqueLicencia({
            nombreGrupo,
            groupId: licencia.groupId,
            discordUserId: licencia.discordUserId,
            robloxUsername: licencia.robloxUsername,
        })}`)
        .addFields(
            { name: 'Alta original', value: fecha(licencia.createdAt), inline: true },
            { name: 'Enlace actual', value: fecha(licencia.linkedAt),  inline: true },
            { name: 'Agregado por',  value: actorId ? `<@${actorId}>` : '—', inline: true },
        )
        .setFooter({ text: FOOTER })
        .setTimestamp();
}

function buildRemovedEmbed({ licencia, nombreGrupo, iconUrl, actorId, motivo }) {
    return new EmbedBuilder()
        .setColor(ROJO)
        .setTitle('Licencia desactivada')
        .setThumbnail(iconUrl ?? undefined)
        .setDescription(`${EMOJI.baja} **Inactiva**\n\n${bloqueLicencia({
            nombreGrupo,
            groupId: licencia.groupId,
            discordUserId: licencia.discordUserId,
            robloxUsername: licencia.robloxUsername,
        })}`)
        .addFields(
            { name: 'Alta original',   value: fecha(licencia.createdAt),     inline: true },
            { name: 'Fecha de baja',   value: fecha(licencia.deactivatedAt), inline: true },
            { name: 'Desactivado por', value: actorId ? `<@${actorId}>` : '—', inline: true },
            { name: 'Motivo',          value: texto(motivo, 'No especificado'), inline: false },
        )
        .setFooter({ text: FOOTER })
        .setTimestamp();
}

// Tres resultados, tres colores, y la diferencia entre los dos últimos es el
// motivo de que exista: "tuvo licencia y se le retiró" y "nunca tuvo" son
// idénticos si solo se pregunta "¿está autorizado?", y significan cosas muy
// distintas con un cliente esperando respuesta.
function buildCheckEmbed({ estado, groupId, nombreGrupo, iconUrl, miembros }) {
    const autorizada = estado.authorized === true;
    const conocida = estado.found === true;

    const cabecera = autorizada
        ? `${EMOJI.alta} **Autorizado**`
        : conocida
            ? `${EMOJI.baja} **Licencia retirada**`
            : '**Sin licencia** · este grupo nunca fue dado de alta';

    const embed = new EmbedBuilder()
        .setColor(autorizada ? VERDE : conocida ? NARANJA : GRIS)
        .setTitle(autorizada ? 'Licencia activa' : conocida ? 'Licencia desactivada' : 'Sin licencia')
        .setThumbnail(iconUrl ?? undefined)
        .setFooter({ text: FOOTER })
        .setTimestamp();

    const extra = miembros != null ? `${miembros.toLocaleString('es-ES')} miembros` : null;

    // Un grupo que nunca estuvo en la whitelist NO tiene comprador ni fechas:
    // enseñar tres líneas de "—" no informa de nada y alarga el embed. Se
    // muestra solo lo que Roblox sí sabe de él.
    if (!conocida) {
        return embed.setDescription(
            `${cabecera}\n\n${EMOJI.grupo} **${texto(nombreGrupo, 'Grupo sin nombre')}** · ${codigo(groupId)}` +
            (extra ? ` · ${extra}` : '')
        );
    }

    embed.setDescription(`${cabecera}\n\n${bloqueLicencia({
        nombreGrupo,
        groupId,
        discordUserId: estado.discordUserId,
        robloxUsername: estado.robloxUsername,
        extra,
    })}`);

    embed.addFields(
        { name: 'Alta original',  value: fecha(estado.createdAt), inline: true },
        { name: 'Último enlace',  value: fecha(estado.linkedAt),  inline: true },
    );

    // Solo cuando hay una baja que explicar: un "Motivo: —" en una licencia
    // activa es ruido.
    if (!autorizada) {
        embed.addFields(
            { name: 'Fecha de baja',   value: fecha(estado.deactivatedAt), inline: true },
            { name: 'Desactivado por', value: estado.deactivatedBy ? `<@${estado.deactivatedBy}>` : '—', inline: true },
            { name: 'Motivo',          value: texto(estado.deactivationReason, 'No especificado'), inline: false },
        );
    }

    return embed;
}

// Pura, y exportada para los tests: la aritmética de paginado es la parte del
// listado que puede perder una licencia en silencio, así que conviene fijarla
// sin un cliente de Discord cerca.
function paginar(groups, porPagina = GRUPOS_POR_PAGINA) {
    const paginas = [];
    for (let i = 0; i < groups.length; i += porPagina) paginas.push(groups.slice(i, i + porPagina));
    return paginas.length ? paginas : [[]];
}

// Dos líneas por licencia, con el estado en el emoji de la izquierda: es lo que
// permite listar vigentes y retiradas juntas sin partir el listado en dos
// bloques y sin repetir la palabra "activa" veinte veces.
function lineaDeGrupo(group) {
    const marca = group.active ? EMOJI.alta : EMOJI.baja;
    // Aquí SOLO la mención, sin el id en crudo que sí llevan los embeds de
    // detalle: son dos líneas por licencia y ocho licencias por página, y ese
    // número de 18 cifras repetido ocho veces es justo lo que convierte una
    // lista legible en un muro.
    const discord = group.discordUserId ? `<@${group.discordUserId}>` : 'Sin Discord';
    const roblox = group.robloxUsername ? codigo(group.robloxUsername) : 'Sin Roblox';

    return `${marca} **${texto(group.groupName, 'Grupo sin nombre')}** · ${codigo(group.groupId)}\n` +
           `${EMOJI.discord} ${discord} · ${EMOJI.roblox} ${roblox}`;
}

function buildListEmbed({ groups, total, pagina, paginas, truncado }) {
    const activas = groups.filter(g => g.active).length;
    const inactivas = groups.length - activas;
    const enPagina = paginar(groups)[pagina] ?? [];

    const resumen = `**${total}** licencias · **${activas}** activas · **${inactivas}** inactivas`;
    const cuerpo = enPagina.length
        ? enPagina.map(lineaDeGrupo).join('\n\n')
        : '_No hay ninguna licencia registrada todavía._';

    const embed = new EmbedBuilder()
        .setColor(NEUTRO)
        .setTitle('Licencias de grupos')
        .setDescription(`${resumen}\n\n${cuerpo}`)
        .setFooter({ text: `Página ${pagina + 1}/${paginas} · ${FOOTER}` })
        .setTimestamp();

    // Dicho en voz alta en vez de mostrar menos y callarse: un listado que se
    // corta en silencio se lee exactamente igual que uno completo.
    if (truncado) {
        embed.addFields({
            name: 'Listado incompleto',
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
