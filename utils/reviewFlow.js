'use strict';

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    MessageFlags, SectionBuilder, TextDisplayBuilder,
} = require('discord.js');
const config = require('../config');
const reviews = require('./reviews');
const tickets = require('./tickets');
const { safeMessageEdit } = require('./safe');
const v2 = require('./panelV2');
const { panelText } = v2;

const SHOP_EMOJI  = '<a:shop:1190502129748676650>';
const STAR_EMOJI  = '<a:star:1514369366878064650>';
const STATS_EMOJI = '<:stats:1190502686886481991>';
const OK_EMOJI    = '<:true:1501213776878501899>';

const PLAZO_MS = config.RESENAS.PLAZO_HORAS * 3600_000;

// ── La tarjeta de valoración ──────────────────────────────────────────────────
//
// Cinco botones, de una a cinco estrellas: se valora con UN clic. Antes era un
// botón que abría un formulario donde había que escribir el número y un
// comentario obligatorio, y cada paso de más es gente que no termina.
//
// Tres estados, y el texto y los botones cambian con cada uno:
//
//   'abierta'    — se puede valorar
//   'calificada' — ya valoró: los botones se apagan y el elegido se resalta
//   'cerrada'    — pasó el plazo sin valorar: los botones se apagan y lo dice
//
// La tarjeta va SIEMPRE entera, también al apagarla: en un mensaje V2 un edit
// con sólo `components: [fila]` borraría el texto.

function buildReviewPayload(buyerId, ticketChannelId, estado = 'abierta', score = null, comentado = false) {
    // Compatibilidad con la firma vieja (disabled = true/false).
    if (estado === true) estado = 'calificada';
    if (estado === false) estado = 'abierta';

    const horas = config.RESENAS.PLAZO_HORAS;
    let texto;
    if (estado === 'calificada') {
        texto =
            `${SHOP_EMOJI} Compra por <@${buyerId}>\n\n` +
            `${OK_EMOJI} **¡Gracias por tu valoración!**` +
            (score ? ` Calificaste la atención con **${score}/5**.` : '') +
            '\n\nNos ayuda a mejorar y a que otros compren con confianza.' +
            (comentado ? '' : '\n-# Si quieres, cuéntanos más con **Agregar comentario**.');
    } else if (estado === 'cerrada') {
        texto =
            `${SHOP_EMOJI} Compra por <@${buyerId}>\n\n` +
            '⏱️ **El plazo para valorar esta compra terminó.**\n\n' +
            `Las valoraciones se pueden dejar durante las ${horas} horas siguientes a la compra. ¡Gracias por comprar en 7x!`;
    } else {
        texto =
            `${SHOP_EMOJI} Compra por <@${buyerId}>\n\n` +
            'Gracias por tu compra. **¿Cómo fue la atención en tu ticket?**\n\n' +
            `Elige tu valoración: **1/5** es la peor y **5/5** la mejor.\n-# Tienes ${horas} horas para valorar.`;
    }

    // Las valoraciones van DEBAJO del pie, cada una en su fila, y el botón de
    // comentario al final.
    const container = v2.tarjeta({ color: 0x2B2D31, texto, pie: '7x Community • Sistema de reseñas' });
    container.addSectionComponents(...buildEstrellas(ticketChannelId, estado, score));
    container.addActionRowComponents(buildCommentRow(ticketChannelId, estado, comentado));
    return { flags: MessageFlags.IsComponentsV2, components: [container] };
}

// Una fila por valoración: los emojis a la izquierda, como TEXTO, y su botón a
// la derecha. Va así porque un botón de Discord sólo admite UN emoji: en el
// texto sí caben los que hagan falta — de 1 a 4 el de estadísticas, tantos
// como la puntuación, y en el 5 las cinco estrellas animadas.
function emojisDe(n) {
    return n >= 5 ? STAR_EMOJI.repeat(5) : STATS_EMOJI.repeat(n);
}

function buildEstrellas(ticketChannelId, estado = 'abierta', score = null) {
    if (estado === true) estado = 'calificada';
    if (estado === false) estado = 'abierta';
    const apagada = estado !== 'abierta';

    return [1, 2, 3, 4, 5].map(n =>
        new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(emojisDe(n)))
            .setButtonAccessory(
                new ButtonBuilder()
                    .setCustomId(`review_star:${ticketChannelId}:${n}`)
                    .setLabel(`${n}/5`)
                    // La que eligió queda en verde: al volver al mensaje se ve
                    // qué puso sin tener que leer el texto.
                    .setStyle(estado === 'calificada' && n === score ? ButtonStyle.Success : ButtonStyle.Secondary)
                    .setDisabled(apagada)
            )
    );
}

// El comentario va aparte de las estrellas: valorar sigue siendo un clic, y
// quien quiera contar más lo hace antes o después. Una vez, dentro del plazo.
function buildCommentRow(ticketChannelId, estado = 'abierta', comentado = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`review_comment:${ticketChannelId}`)
            .setEmoji({ id: '1501217620437897227' })
            .setLabel(comentado ? 'Comentario enviado' : 'Agregar comentario')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(comentado || estado === 'cerrada')
    );
}

// Figures out what the ticket was for, so the review announcement can show
// it ("Pedido: 1,500 Robux" / "Pedido: Duels" / "Pedido: Seguidores").
// Robux amount is only known from the "Resumen de tu compra" embed sent
// when the ticket was created — no other record of it exists, so it's
// scraped from channel history rather than stored redundantly.
async function detectOrderLabel(channel, ticketType) {
    if (ticketType === 'duels')      return 'Duels';
    if (ticketType === 'seguidores') return 'Seguidores';
    if (ticketType === 'soporte')    return 'Soporte';
    if (ticketType !== 'comprar')    return null;

    try {
        const messages = await channel.messages.fetch({ limit: 100 });

        // panelText lee tanto el embed clásico como el bloque de texto de un
        // contenedor V2: los resúmenes son contenedores desde que llevan sus
        // botones dentro, pero un ticket abierto antes del cambio sigue con el
        // embed de entonces, y los dos tienen que seguir funcionando.
        for (const m of messages.values()) {
            const match = panelText(m).match(/Robux a recibir\*\*\n```([^`]+)```/);
            if (match) return match[1];
        }
        return 'Robux';
    } catch {
        return 'Robux';
    }
}

// ── El anuncio en el canal de reseñas ─────────────────────────────────────────
//
// Se publica en cuanto se confirma el pago y se edita cuando se resuelve.
//
// Lo que dice mientras no hay valoración, y lo que dice si nunca la hay, es
// SIEMPRE verdad. No se pone una valoración inventada a nombre del cliente
// cuando no la dejó: quien lee este canal decide si comprar fiándose de que
// cada reseña la escribió un cliente de verdad. Lo que sí se enseña, porque es
// cierto, es que la compra se entregó — que es justo lo que alguien que duda
// quiere saber.
function buildAnnounceEmbed(buyerId, score = null, avatarURL = null, orderLabel = null, comment = null, cerrada = false) {
    let value;
    if (score !== null) {
        value = `${score >= 5 ? STAR_EMOJI.repeat(5) : STATS_EMOJI.repeat(score)} **(${score}/5)**`;
    } else if (cerrada) {
        value = `${OK_EMOJI} Entrega verificada\n-# El cliente no dejó valoración`;
    } else {
        value = '⏳ Esperando la valoración del cliente';
    }

    const embed = new EmbedBuilder()
        .setColor(0x2B2D31) // reviews channel is always gray, pending or rated
        .setDescription(
            // No bullet on the "Reseña" line — a "•" right next to the
            // repeated star/stats emojis breaks the line rendering.
            `${SHOP_EMOJI} • Compra hecha por <@${buyerId}>\n\n` +
            (orderLabel ? `**Pedido:** ${orderLabel}\n\n` : '') +
            `**Reseña:** ${value}` +
            (comment ? `\n**Comentario:** ${comment}` : '')
        )
        .setFooter({ text: '7x Community • Sistema de reseñas' })
        .setTimestamp();

    if (avatarURL) embed.setThumbnail(avatarURL);
    return embed;
}

// Sends the DM-side review prompt and stores the message ref so it can be
// disabled later. Mirrors sendPurchaseDM's "never throw" style — a DM failure
// (closed DMs, etc.) must not block the rest of the purchase flow.
async function sendReviewDM(client, buyerId, ticketChannelId) {
    try {
        const user = await client.users.fetch(buyerId);
        const msg  = await user.send(buildReviewPayload(buyerId, ticketChannelId));
        reviews.setDmMessageRef(ticketChannelId, msg.channelId, msg.id);
    } catch (err) {
        console.warn('[reviewFlow] Could not DM review request:', err.message);
    }
}

async function sendPendingAnnouncement(client, ticketChannelId, buyerId, orderLabel) {
    try {
        const ch        = await client.channels.fetch(config.CHANNELS.REVIEWS);
        const user       = await client.users.fetch(buyerId).catch(() => null);
        const avatarURL  = user?.displayAvatarURL({ size: 256 }) ?? null;
        const msg = await ch.send({ embeds: [buildAnnounceEmbed(buyerId, null, avatarURL, orderLabel)] });
        reviews.setAnnounceMessageRef(ticketChannelId, msg.channelId, msg.id);
    } catch (err) {
        console.warn('[reviewFlow] Could not send pending review announcement:', err.message);
    }
}

// Single entry point for kicking off a review request — called both from the
// "PAGO REALIZADO" ticket button and from /pagoverified. Idempotent: a
// second call for the same ticket (either trigger firing twice) is a no-op.
async function requestReview(client, channel, ticketChannelId, buyerId) {
    if (reviews.getReview(ticketChannelId)) return;

    const ticketType = tickets.getType(channel);
    const orderLabel = await detectOrderLabel(channel, ticketType);
    reviews.createReviewRequest(ticketChannelId, buyerId, orderLabel);

    try {
        const ticketMsg = await channel.send(buildReviewPayload(buyerId, ticketChannelId));
        reviews.setTicketMessageRef(ticketChannelId, ticketMsg.channelId, ticketMsg.id);
    } catch (err) {
        console.warn('[reviewFlow] Could not send ticket review prompt:', err.message);
    }

    await sendReviewDM(client, buyerId, ticketChannelId);
    await sendPendingAnnouncement(client, ticketChannelId, buyerId, orderLabel);
}

// Re-pinta los dos sitios donde se pidió la valoración (el ticket y el DM) con
// el estado nuevo. Nunca lanza: el canal del ticket ya se habrá borrado casi
// siempre, y que no se pueda editar no puede tirar lo demás.
async function repintarPeticiones(client, rec, ticketChannelId, estado, score = null) {
    const payload = buildReviewPayload(rec.buyerId, ticketChannelId, estado, score, !!rec.comment);

    if (rec.ticketMessageRef) {
        try {
            const ch  = await client.channels.fetch(rec.ticketMessageRef.channelId);
            const msg = await ch.messages.fetch(rec.ticketMessageRef.messageId);
            await safeMessageEdit(msg, payload);
        } catch {
            // El ticket se cierra solo a los 10 minutos del pago: lo normal es
            // que ya no exista.
        }
    }

    if (rec.dmMessageRef) {
        try {
            const user = await client.users.fetch(rec.buyerId);
            const dm   = await user.createDM();
            const msg  = await dm.messages.fetch(rec.dmMessageRef.messageId);
            await safeMessageEdit(msg, payload);
        } catch (err) {
            console.warn('[reviewFlow] No se pudo actualizar la valoración del DM:', err.message);
        }
    }
}

async function repintarAnuncio(client, rec, embed) {
    if (rec.announceMessageRef) {
        try {
            const ch  = await client.channels.fetch(rec.announceMessageRef.channelId);
            const msg = await ch.messages.fetch(rec.announceMessageRef.messageId);
            await safeMessageEdit(msg, { embeds: [embed] });
            return;
        } catch (err) {
            console.warn('[reviewFlow] Could not edit review announcement, sending new one:', err.message);
        }
    }

    // Fallback — no ref was ever stored (e.g. the pending send failed), so
    // there's nothing to edit; post it now rather than losing it.
    try {
        const announceCh = await client.channels.fetch(config.CHANNELS.REVIEWS);
        await announceCh.send({ embeds: [embed] });
    } catch (err) {
        console.warn('[reviewFlow] Could not send review announcement:', err.message);
    }
}

// Called once a rating is submitted (from either the DM or the ticket
// channel) — disables both prompts and edits the pending announcement in
// place to show the real score.
async function finalizeReview(client, ticketChannelId, score, comment = null) {
    const rec = reviews.getReview(ticketChannelId);
    if (!rec) return;

    await repintarPeticiones(client, rec, ticketChannelId, 'calificada', score);

    const user      = await client.users.fetch(rec.buyerId).catch(() => null);
    const avatarURL = user?.displayAvatarURL({ size: 256 }) ?? null;
    await repintarAnuncio(client, rec, buildAnnounceEmbed(rec.buyerId, score, avatarURL, rec.orderLabel, comment ?? rec.comment));
}

// Tras guardar un comentario: los dos avisos apagan su botón y el anuncio lo
// enseña, con las estrellas si ya las puso o "esperando" si aún no.
async function actualizarComentario(client, ticketChannelId) {
    const rec = reviews.getReview(ticketChannelId);
    if (!rec) return;

    const estado = rec.rating !== null ? 'calificada' : rec.cerradoEn ? 'cerrada' : 'abierta';
    await repintarPeticiones(client, rec, ticketChannelId, estado, rec.rating);

    const user      = await client.users.fetch(rec.buyerId).catch(() => null);
    const avatarURL = user?.displayAvatarURL({ size: 256 }) ?? null;
    await repintarAnuncio(client, rec,
        buildAnnounceEmbed(rec.buyerId, rec.rating, avatarURL, rec.orderLabel, rec.comment, !!rec.cerradoEn));
}

// ── El plazo ──────────────────────────────────────────────────────────────────
//
// Pasadas RESENAS.PLAZO_HORAS sin valorar, la valoración se cierra: los botones
// se apagan diciendo que el plazo terminó, y el anuncio pasa a "Entrega
// verificada". Lo que NO se hace es inventar la valoración.
//
// No va con un setTimeout de 12 horas: el bot se reinicia en cada despliegue y
// un temporizador así no sobreviviría a ninguno. Se revisa al arrancar y cada
// pocos minutos, a partir de la fecha guardada de cada petición, así que una
// valoración vence a su hora aunque el bot haya reiniciado diez veces entre
// medias.

async function cerrarResena(client, ticketChannelId) {
    // cerrarPorPlazo comprueba y escribe sin pausas: si en ese mismo instante
    // llega la valoración, gana una de las dos y nunca quedan las dos.
    if (!reviews.cerrarPorPlazo(ticketChannelId)) return false;

    const rec = reviews.getReview(ticketChannelId);
    await repintarPeticiones(client, rec, ticketChannelId, 'cerrada');

    const user      = await client.users.fetch(rec.buyerId).catch(() => null);
    const avatarURL = user?.displayAvatarURL({ size: 256 }) ?? null;
    await repintarAnuncio(client, rec, buildAnnounceEmbed(rec.buyerId, null, avatarURL, rec.orderLabel, rec.comment, true));
    return true;
}

async function cerrarVencidas(client, ahora = Date.now()) {
    let cerradas = 0;
    for (const id of reviews.vencidas(PLAZO_MS, ahora)) {
        try {
            if (await cerrarResena(client, id)) cerradas++;
        } catch (err) {
            console.warn(`[reviewFlow] No se pudo cerrar la valoración de ${id}:`, err.message);
        }
    }
    if (cerradas) console.log(`[reviewFlow] ${cerradas} valoración(es) cerrada(s) por plazo.`);
    return cerradas;
}

const REVISION_MS = 10 * 60_000;

// Arranca la revisión periódica. Devuelve el intervalo para poder pararlo.
function iniciarCaducidad(client) {
    cerrarVencidas(client).catch(err => console.warn('[reviewFlow] Revisión de plazos falló:', err.message));
    const t = setInterval(() => {
        cerrarVencidas(client).catch(err => console.warn('[reviewFlow] Revisión de plazos falló:', err.message));
    }, REVISION_MS);
    // Que no mantenga vivo el proceso por sí solo (tests, cierre limpio).
    t.unref?.();
    return t;
}

module.exports = {
    buildReviewPayload, buildEstrellas, requestReview, finalizeReview, actualizarComentario,
    cerrarResena, cerrarVencidas, iniciarCaducidad, PLAZO_MS,
    __test: { buildAnnounceEmbed },
};
