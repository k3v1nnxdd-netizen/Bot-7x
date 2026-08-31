'use strict';

const fs = require('fs');
const path = require('path');
const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { safeReply, safeEditReply, safeDeferReply, safeShowModal } = require('../utils/safe');
const { checkMembership, getGroup, getPlayerAvatar, getCommunityIcon, GroupCheckError } = require('../utils/groupMembership');
const config = require('../config');

const EMBED_COLOR = 0x2B2D31; // gray, per request

// Anti-spam: caps how many unresolved requests a single Discord user can have
// in the results channel at once (per Discord user, not per Roblox username).
// In-memory only — resets on restart, same as the rest of this flow's state.
//
// "Unresolved" now means what it says: como el veredicto lo da Roblox
// automáticamente, las únicas tarjetas que quedan abiertas son las que el bot
// NO pudo decidir (Roblox caído, sin API key, rate limit...). Ésas son
// exactamente las que siguen esperando al owner, y son las únicas que este
// límite cuenta.
const MAX_PENDING_PER_USER = 3;
const pendingByUser = new Map(); // discordUserId -> count of unresolved requests

function pendingCount(userId) { return pendingByUser.get(userId) ?? 0; }
function incrementPending(userId) { pendingByUser.set(userId, pendingCount(userId) + 1); }
function decrementPending(userId) {
    const next = pendingCount(userId) - 1;
    if (next <= 0) pendingByUser.delete(userId);
    else pendingByUser.set(userId, next);
}

// Imagen local de respaldo por comunidad. Ya NO es la fuente principal: la
// tarjeta pide a Roblox el icono ACTUAL del grupo (ver getCommunityIcon) y sólo
// cae aquí si Roblox no tiene uno renderizado todavía. El label y el ID de
// Roblox no están en este archivo: viven en config.CHECK_GROUPS.
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
            content: `❌ La comunidad **${group.label}** todavía no está configurada para la comprobación automática. Avisa a un administrador.`,
            ephemeral: true,
        });
    }

    const ok = await safeShowModal(interaction, buildUsernameModal(groupKey, group.label));
    if (!ok) await safeReply(interaction, { content: '❌ No se pudo abrir el formulario. Intenta de nuevo.', ephemeral: true });
}

// ── The result card ──────────────────────────────────────────────────────────
// Los emojis del servidor van SIEMPRE en el value de un field (o en el content
// de un mensaje): Discord no los renderiza en un título, en el NAME de un field
// ni en el footer — ahí se imprimen crudos, como `<:true:1501213776878501899>`.

const EMOJI = {
    user:   '<:member:1501261625523699892>',
    point:  '<:point:1501212595464700104>',
    robux:  '<a:robuxxx:1510070809366892604>',
    ok:     '<:true:1501213776878501899>',
    alert:  '<:alert:1501220021035204658>',
};

// Los nombres de los bloques son la CLAVE de la tarjeta: marcar a mano un
// resultado reescribe el campo "Resultado" buscándolo por su nombre exacto, y
// el ID de quien la solicitó se lee del campo "Solicitud". Cambiar uno de estos
// textos rompe esa correspondencia, así que están aquí y no en línea.
const FIELD = {
    PLAYER:     'Jugador de Roblox',
    COMMUNITY:  'Comunidad',
    MEMBERSHIP: 'Membresía',
    RESULT:     'Resultado',
    REQUEST:    'Solicitud',
};

// Formato heredado: las tarjetas publicadas ANTES de este cambio llevaban todo
// en la descripción, con este encabezado al final. Se conserva para que una
// tarjeta antigua que siguiera pendiente se pueda resolver igual.
const STATUS_HEADING = '**Estado**';

const ts = (date, format) => `<t:${Math.floor(date.getTime() / 1000)}:${format}>`;

function statusLine(status, { days = null } = {}) {
    switch (status) {
        case 'eligible':
            return `${EMOJI.ok} **ELEGIBLE** — Puede recibir envíos de Robux desde esta comunidad.`;
        case 'not_eligible': {
            const left = days === null ? null : Math.max(0, config.MIN_GROUP_DAYS - days);
            const falta = left === null ? '' : ` Le falta${left === 1 ? '' : 'n'} **${left} día${left === 1 ? '' : 's'}** para los **${config.MIN_GROUP_DAYS} días** mínimos.`;
            return `${EMOJI.alert} **NO ELEGIBLE** —${falta || ' No cumple la antigüedad mínima.'}`;
        }
        case 'not_member':
            return `${EMOJI.alert} **NO PERTENECE A ESTA COMUNIDAD** — Roblox no encuentra ninguna membresía de este usuario en el grupo.`;
        case 'unverified':
            return `${EMOJI.alert} **NO VERIFICADO** — No se pudo consultar a Roblox, así que **no** se marca como no elegible. Pendiente de revisión manual.`;
        case 'manual_eligible':
            return `${EMOJI.ok} **ELEGIBLE** — Marcado manualmente por el staff.`;
        case 'manual_not_eligible':
            return `${EMOJI.alert} **NO ELEGIBLE** — Marcado manualmente por el staff.`;
        default:
            return 'Pendiente de revisión.';
    }
}

// De dónde salió el veredicto. Es lo que distingue "Roblox dijo esto" de "esto
// lo decidió una persona", y es justo lo que hay que poder leer meses después
// mirando la tarjeta.
function sourceLine(status) {
    switch (status) {
        case 'eligible':
        case 'not_eligible':
        case 'not_member':
            return `${EMOJI.point} Verificado automáticamente vía Roblox Open Cloud.`;
        case 'unverified':
            return `${EMOJI.point} Pendiente de revisión manual del staff.`;
        case 'manual_eligible':
        case 'manual_not_eligible':
            return `${EMOJI.point} Resuelto manualmente por el staff tras un fallo de la consulta automática.`;
        default:
            return `${EMOJI.point} Pendiente de revisión manual del staff.`;
    }
}

function resultValue(status, { days = null } = {}) {
    return `${statusLine(status, { days })}\n${sourceLine(status)}`;
}

function playerValue({ robloxUsername, robloxDisplayName, robloxUserId }) {
    return (
        `${EMOJI.user} **Username:** \`${robloxUsername}\`\n` +
        `${EMOJI.point} **Display Name:** ${robloxDisplayName ? `\`${robloxDisplayName}\`` : '—'}\n` +
        `${EMOJI.point} **UserId:** ${robloxUserId ? `\`${robloxUserId}\`` : '—'}`
    );
}

function communityValue({ groupLabel, groupId }) {
    return (
        `${EMOJI.point} **${groupLabel}**\n` +
        `${EMOJI.point} **GroupId:** \`${groupId}\``
    );
}

// `joinedAt` se pinta con timestamps de Discord para que cada persona lo vea en
// SU zona horaria y en su idioma, en vez de en la del servidor donde corre el
// bot. Nunca se escribe una fecha a mano.
function membershipValue({ status, joinedAt, days }) {
    const estado = status === 'unverified'
        ? `${EMOJI.alert} **NO SE PUDO COMPROBAR**`
        : status === 'not_member'
            ? `${EMOJI.alert} **NO PERTENECE**`
            : `${EMOJI.ok} **MIEMBRO**`;

    const lineas = [
        `${EMOJI.point} **Estado:** ${estado}`,
        `${EMOJI.point} **Fecha de ingreso:** ${joinedAt ? `${ts(joinedAt, 'F')} · ${ts(joinedAt, 'R')}` : '—'}`,
        `${EMOJI.robux} **Antigüedad:** ${days === null ? '—' : `**${days}** día${days === 1 ? '' : 's'}`}`,
        `${EMOJI.point} **Mínimo requerido:** **${config.MIN_GROUP_DAYS}** días`,
    ];

    // "Cuántos días le faltan" sólo tiene sentido cuando de verdad falta algo:
    // en un no-miembro o en una tarjeta sin verificar sería un número inventado.
    if (days !== null && days < config.MIN_GROUP_DAYS) {
        const left = config.MIN_GROUP_DAYS - days;
        lineas.push(`${EMOJI.alert} **Le faltan:** **${left}** día${left === 1 ? '' : 's'}`);
    }

    return lineas.join('\n');
}

function requestValue({ discordUserId, requestedAt }) {
    return (
        `${EMOJI.user} **Solicitado por:** <@${discordUserId}>\n` +
        `${EMOJI.point} **Discord ID:** \`${discordUserId}\`\n` +
        `${EMOJI.point} **Fecha:** ${ts(requestedAt, 'F')}`
    );
}

// Las dos imágenes: el avatar del jugador arriba a la derecha (thumbnail, es
// quien identifica la tarjeta de un vistazo) y el icono de la comunidad abajo
// (image). Cualquiera de las dos puede faltar sin que pase nada.
function buildResultEmbed({
    groupKey, groupLabel, groupId,
    robloxUsername, robloxDisplayName = null, robloxUserId = null,
    discordUserId, status,
    joinedAt = null, days = null,
    avatarUrl = null, iconUrl = null,
    requestedAt = new Date(),
}) {
    const embed = new EmbedBuilder()
        .setColor(EMBED_COLOR)
        .setTitle("Check Group's")
        .addFields(
            { name: FIELD.PLAYER,     value: playerValue({ robloxUsername, robloxDisplayName, robloxUserId }), inline: true },
            { name: FIELD.COMMUNITY,  value: communityValue({ groupLabel, groupId }),                          inline: true },
            { name: FIELD.MEMBERSHIP, value: membershipValue({ status, joinedAt, days }),                      inline: false },
            { name: FIELD.RESULT,     value: resultValue(status, { days }),                                    inline: false },
            { name: FIELD.REQUEST,    value: requestValue({ discordUserId, requestedAt }),                     inline: false },
        )
        .setFooter({ text: '7x Community • Check Group' })
        .setTimestamp(requestedAt);

    if (avatarUrl) embed.setThumbnail(avatarUrl);

    // Icono actual de Roblox primero; la imagen local del repo sólo como último
    // recurso, y sólo si el archivo existe.
    const fallback = iconUrl ? null : groupFallbackImage(groupKey);
    if (iconUrl) embed.setImage(iconUrl);
    else if (fallback) embed.setImage(`attachment://${fallback.attachName}`);

    return { embed, fallbackFile: fallback };
}

// Reescribe SÓLO el veredicto de una tarjeta ya publicada, dejando intacto todo
// lo demás. Soporta los dos formatos: el actual (por campos) y el heredado (una
// descripción que terminaba en STATUS_HEADING).
function applyManualStatus(oldEmbed, manualStatus) {
    const builder = EmbedBuilder.from(oldEmbed);
    const fields = oldEmbed?.fields ?? [];

    if (fields.some(f => f.name === FIELD.RESULT)) {
        return builder.setFields(fields.map(f => (
            f.name === FIELD.RESULT ? { ...f, value: resultValue(manualStatus) } : f
        )));
    }

    const description = oldEmbed?.description ?? '';
    const idx = description.lastIndexOf(STATUS_HEADING);
    const head = idx === -1 ? `${description}\n\n` : description.slice(0, idx);
    return builder.setDescription(`${head}${STATUS_HEADING}\n${statusLine(manualStatus)}`);
}

// Quién pidió la comprobación. Se busca primero en el campo "Solicitud" y sólo
// después en el resto de la tarjeta, para que una mención que apareciera en otro
// sitio no pueda hacerse pasar por el solicitante.
function extractRequesterId(embed) {
    const fields = embed?.fields ?? [];
    const solicitud = fields.find(f => f.name === FIELD.REQUEST)?.value;
    const haystack = solicitud
        ?? [...fields.map(f => f.value), embed?.description ?? ''].join('\n');
    const match = String(haystack).match(/<@(\d+)>/);
    return match ? match[1] : null;
}

function buildEligibilityRow(disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('cg_elig_yes')
            .setLabel('Elegible')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId('cg_elig_no')
            .setLabel('No elegible')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled),
    );
}

// ── Step 2: username submitted → ask Roblox and publish the verdict ──────────
//
// Estos son los códigos de GroupCheckError que NO son culpa del usuario ni un
// veredicto sobre él: son "no se pudo comprobar". Para ellos la tarjeta se
// publica igualmente, en estado NO VERIFICADO y con los botones del owner
// activos — así el flujo manual de siempre sigue funcionando tal cual, incluso
// si ROBLOX_OPEN_CLOUD_KEY todavía no está puesta en Railway.
const MANUAL_REVIEW_CODES = new Set([
    'open_cloud_not_configured',
    'open_cloud_unauthorized',
    'group_not_found',
    'rate_limited',
    'roblox_unavailable',
    'invalid_create_time',
]);

// Lo que se le dice al usuario en efímero por cada código. Nunca se le enseña
// el detalle técnico (ni una API key, ni una URL interna): eso va al log.
const USER_MESSAGE = {
    open_cloud_not_configured: '⚠️ La comprobación automática no está disponible ahora mismo. Tu solicitud quedó registrada para revisión manual.',
    open_cloud_unauthorized:   '⚠️ La comprobación automática no está disponible ahora mismo. Tu solicitud quedó registrada para revisión manual.',
    group_not_found:           '⚠️ No se pudo consultar esta comunidad en Roblox. Tu solicitud quedó registrada para revisión manual.',
    rate_limited:              '⚠️ Roblox está limitando las consultas en este momento. Tu solicitud quedó registrada para revisión manual.',
    roblox_unavailable:        '⚠️ Roblox no respondió a tiempo. Tu solicitud quedó registrada para revisión manual.',
    invalid_create_time:       '⚠️ Roblox devolvió una fecha de ingreso ilegible. Tu solicitud quedó registrada para revisión manual.',
};

function sendPayload({ embed, fallbackFile }, components) {
    return {
        embeds: [embed],
        components: [components],
        ...(fallbackFile && { files: [{ attachment: fallbackFile.file, name: fallbackFile.attachName }] }),
    };
}

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

// Las dos imágenes en paralelo, y ninguna puede tumbar la solicitud.
async function fetchImages({ robloxUserId, groupId }) {
    const [avatarUrl, iconUrl] = await Promise.all([
        robloxUserId ? getPlayerAvatar(robloxUserId) : Promise.resolve(null),
        groupId ? getCommunityIcon(groupId) : Promise.resolve(null),
    ]);
    return { avatarUrl, iconUrl };
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

    if (pendingCount(interaction.user.id) >= MAX_PENDING_PER_USER) {
        return safeReply(interaction, {
            content: `❌ Ya tienes ${MAX_PENDING_PER_USER} solicitudes pendientes de revisión. Espera a que se resuelvan antes de enviar otra.`,
            ephemeral: true,
        });
    }

    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    const requestedAt = new Date();
    const resultsChannel = await resolveResultsChannel(interaction.client);
    if (!resultsChannel) {
        return safeEditReply(interaction, { content: '❌ No se pudo enviar tu solicitud. Contacta a un administrador.' });
    }

    // ── Consulta a Roblox ────────────────────────────────────────────────────
    let result = null;
    let failure = null;
    try {
        result = await checkMembership(groupKey, username);
    } catch (err) {
        if (!(err instanceof GroupCheckError)) {
            console.error('[checkGroupFlow] Error inesperado consultando la membresía:', err);
            failure = new GroupCheckError('roblox_unavailable', 'Error inesperado.');
        } else {
            failure = err;
        }

        // Errores que sí son responsabilidad del usuario o de la configuración:
        // se responden en efímero y NO ensucian el canal de resultados.
        if (!MANUAL_REVIEW_CODES.has(failure.code)) {
            console.warn(`[checkGroupFlow] ${interaction.user.id} → ${groupKey}/"${username}": ${failure.code}`);
            const texto = failure.code === 'user_not_found'
                ? `❌ No encontramos ninguna cuenta de Roblox llamada **${username}**. Revisa que esté bien escrito.`
                : `❌ ${failure.message}`;
            return safeEditReply(interaction, { content: texto });
        }
    }

    // ── Publicación del resultado ────────────────────────────────────────────
    try {
        if (failure) {
            // No se pudo comprobar: tarjeta abierta, botones del owner activos.
            // checkMembership adjunta el usuario ya resuelto cuando lo que falló
            // fue la membresía, así que la tarjeta sale igual de completa.
            const conocido = failure.robloxUser ?? null;
            console.error(`[checkGroupFlow] Sin veredicto automático para ${groupKey}/"${username}" (${failure.code}) — enviada a revisión manual.`);

            const images = await fetchImages({ robloxUserId: conocido?.id ?? null, groupId: group.groupId });
            const card = buildResultEmbed({
                groupKey,
                groupLabel: group.label,
                groupId: group.groupId,
                robloxUsername: conocido?.name ?? username,
                robloxDisplayName: conocido?.displayName ?? null,
                robloxUserId: conocido?.id ?? null,
                discordUserId: interaction.user.id,
                status: 'unverified',
                requestedAt,
                ...images,
            });
            await resultsChannel.send(sendPayload(card, buildEligibilityRow(false)));
            incrementPending(interaction.user.id);
            return safeEditReply(interaction, {
                content: `${USER_MESSAGE[failure.code] ?? '⚠️ No se pudo comprobar automáticamente. Tu solicitud quedó registrada para revisión manual.'}\n${EMOJI.point} Revisa <#${config.CHANNELS.CHECKGROUP_RESULTS}>.`,
            });
        }

        // Veredicto automático: la tarjeta nace ya resuelta, con los botones
        // deshabilitados — el dato viene de Roblox, no hay nada que decidir, y
        // por eso tampoco cuenta como pendiente.
        const status = !result.isMember ? 'not_member' : result.eligible ? 'eligible' : 'not_eligible';
        console.log(
            `[checkGroupFlow] ${interaction.user.id} → ${group.label} (${group.groupId}) / ${result.robloxUsername} (${result.robloxUserId}): ` +
            `${result.isMember ? `${result.days} día(s), ingreso ${result.joinedAt.toISOString()}` : 'no es miembro'} → ${status}`
        );

        const images = await fetchImages({ robloxUserId: result.robloxUserId, groupId: result.groupId });
        const card = buildResultEmbed({
            groupKey,
            groupLabel: result.groupLabel,
            groupId: result.groupId,
            robloxUsername: result.robloxUsername,
            robloxDisplayName: result.robloxDisplayName,
            robloxUserId: result.robloxUserId,
            discordUserId: interaction.user.id,
            status,
            joinedAt: result.joinedAt,
            days: result.days,
            requestedAt,
            ...images,
        });
        await resultsChannel.send(sendPayload(card, buildEligibilityRow(true)));

        const resumen = !result.isMember
            ? `${EMOJI.alert} **${result.robloxUsername}** no pertenece a **${group.label}**.`
            : result.eligible
                ? `${EMOJI.ok} **${result.robloxUsername}** lleva **${result.days} día${result.days === 1 ? '' : 's'}** en **${group.label}**: elegible.`
                : `${EMOJI.alert} **${result.robloxUsername}** lleva **${result.days} día${result.days === 1 ? '' : 's'}** en **${group.label}**: aún no cumple los **${config.MIN_GROUP_DAYS} días** mínimos.`;

        await safeEditReply(interaction, {
            content: `${resumen}\n${EMOJI.point} Resultado publicado en <#${config.CHANNELS.CHECKGROUP_RESULTS}>.`,
        });
    } catch (err) {
        console.error('[checkGroupFlow] send error:', err);
        await safeEditReply(interaction, { content: '❌ Ocurrió un error al enviar tu solicitud. Intenta de nuevo.' });
    }
}

// ── Step 3: owner marks eligible / not eligible (with a private confirm step) ─
// Sigue existiendo, con los MISMOS permisos y la misma confirmación previa,
// para las tarjetas que el bot no pudo resolver solo (NO VERIFICADO). Una
// tarjeta con veredicto automático nace con los botones deshabilitados, así
// que el guard de "ya fue resuelta" la protege igual que antes.

async function handleEligibilityButton(interaction) {
    if (interaction.replied || interaction.deferred) return;

    if (interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ Solo el owner puede usar este botón.', ephemeral: true });
    }

    const alreadyResolved = interaction.message.components[0]?.components?.every(c => c.disabled);
    if (alreadyResolved) {
        return safeReply(interaction, { content: '❌ Esta solicitud ya fue resuelta.', ephemeral: true });
    }

    const status = interaction.customId === 'cg_elig_yes' ? 'eligible' : 'not_eligible';
    const label = status === 'eligible' ? 'ELEGIBLE' : 'NO ELEGIBLE';

    const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`cg_elig_confirm:${status}:${interaction.message.id}`)
            .setLabel('Confirmar')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`cg_elig_cancel:${interaction.message.id}`)
            .setLabel('Cancelar')
            .setStyle(ButtonStyle.Secondary),
    );

    await safeReply(interaction, {
        content: `¿Confirmas marcar esta solicitud como **${label}**?`,
        components: [confirmRow],
        ephemeral: true,
    });
}

async function handleEligibilityConfirm(interaction) {
    if (interaction.replied || interaction.deferred) return;

    if (interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ Solo el owner puede usar este botón.', ephemeral: true });
    }

    const [, status, messageId] = interaction.customId.split(':');

    const targetMessage = await interaction.channel.messages.fetch(messageId).catch(() => null);
    if (!targetMessage) {
        return safeReply(interaction, { content: '❌ No se encontró el mensaje original.', ephemeral: true });
    }

    const alreadyResolved = targetMessage.components[0]?.components?.every(c => c.disabled);
    if (alreadyResolved) {
        return safeReply(interaction, { content: '❌ Esta solicitud ya fue resuelta.', ephemeral: true });
    }

    const oldEmbed = targetMessage.embeds[0];

    // El resto de la tarjeta (jugador, comunidad, membresía, quién la pidió,
    // ambas imágenes) se conserva TAL CUAL: sólo se reescribe el veredicto.
    const manualStatus = status === 'eligible' ? 'manual_eligible' : 'manual_not_eligible';
    const embed = applyManualStatus(oldEmbed, manualStatus);

    const discordUserId = extractRequesterId(oldEmbed);
    if (discordUserId) decrementPending(discordUserId);

    await targetMessage.edit({ embeds: [embed], components: [buildEligibilityRow(true)] });
    console.log(`[checkGroupFlow] ${interaction.user.id} marcó manualmente la solicitud ${messageId} como ${status}.`);

    await safeReply(interaction, { content: '✅ Confirmado.', ephemeral: true });
}

async function handleEligibilityCancel(interaction) {
    if (interaction.replied || interaction.deferred) return;

    if (interaction.user.id !== config.OWNER_ID) {
        return safeReply(interaction, { content: '❌ Solo el owner puede usar este botón.', ephemeral: true });
    }

    await safeReply(interaction, { content: '❌ Acción cancelada. La solicitud sigue pendiente.', ephemeral: true });
}

// ── Routers (called from handlers/buttons.js and handlers/modals.js) ─────────

async function handleCheckGroupButtonRouter(interaction) {
    const id = interaction.customId;
    if (id === 'cg_elig_yes' || id === 'cg_elig_no') return handleEligibilityButton(interaction);
    if (id.startsWith('cg_elig_confirm:')) return handleEligibilityConfirm(interaction);
    if (id.startsWith('cg_elig_cancel:')) return handleEligibilityCancel(interaction);
    return handleCheckGroupButton(interaction);
}

module.exports = {
    handleCheckGroupButton: handleCheckGroupButtonRouter,
    handleCheckGroupModal,
    __test: { buildResultEmbed, applyManualStatus, statusLine, sourceLine, extractRequesterId, FIELD, STATUS_HEADING },
};
