'use strict';

const { EmbedBuilder } = require('discord.js');
const { isLocked, lock } = require('../utils/spam');
const v2 = require('../utils/panelV2');
const config = require('../config');

// ── Anuncio de mejoras (boosts) del servidor ─────────────────────────────────
//
// Cuando alguien mejora el servidor, Discord manda un GuildMemberUpdate en el
// que `premiumSince` pasa de null a una fecha. Ese salto —y sólo ese— es el
// boost: si ya tenía fecha antes, el evento es cualquier otra cosa (un rol, un
// apodo, un timeout) y no se anuncia nada.
//
// No se usa el mensaje de sistema de Discord para esto: ese aparece en el canal
// de sistema del servidor, que no tiene por qué ser este, y no se puede dar
// formato. El evento sí llega siempre y trae al miembro.

const COLOR = 0x2B2D31; // gris, igual que las tarjetas de reseñas

// La animación que cierra la tarjeta. El fichero del repo se llama .png pero es
// un GIF de verdad (800x320, 234 frames), así que se adjunta con nombre .gif:
// Discord decide por la extensión del adjunto si lo anima o lo deja congelado.
// `boost.gif` va primero para poder sustituirlo dejando caer un fichero con ese
// nombre. pickBanner le añade el hash del contenido, que es lo que hace que
// cambiar la imagen se note.
const IMAGEN = v2.pickBanner(['./boost.gif', './image-1788931423031.png'], 'boost.gif');

const E = {
    boost:    '<a:boost:1547108879828258816>',
    boosters: '<a:boosterls:1182889302166872104>',
};

// Un GuildMemberUpdate puede llegar repetido (varios shards, un reintento de la
// pasarela, o un segundo cambio en el mismo miembro justo después). Sin esto,
// un boost podría anunciarse dos veces.
const ANTI_DUPLICADO_MS = 60_000;

// ¿Este cambio de miembro es un boost que empieza?
//
// `oldMember.partial` es el caso importante: si el miembro no estaba en caché,
// Discord no dice cómo estaba ANTES, así que "pasó de no boostear a boostear"
// no se puede afirmar. Anunciarlo igual convertiría cualquier cambio de rol de
// un booster antiguo en un "¡ha boosteado!" falso. Ante la duda, no se anuncia.
function esBoostNuevo(oldMember, newMember) {
    if (!newMember?.premiumSince) return false;
    if (!oldMember || oldMember.partial) return false;
    return !oldMember.premiumSince;
}

// El número de mejoras que tiene el servidor AHORA.
//
// Se pide el servidor a la API en vez de leer la caché: el GuildMemberUpdate del
// miembro y el GuildUpdate que actualiza el contador son dos eventos distintos,
// y no está garantizado cuál llega antes. Leer la caché puede dar el número de
// antes del boost — justo el que no queremos anunciar. Si la petición falla, se
// usa lo que haya en caché, que es mejor que no anunciar nada.
async function contarMejoras(guild) {
    const fresco = await guild.fetch().catch(err => {
        console.warn('[boost] No se pudo refrescar el servidor para contar mejoras:', err?.message ?? err);
        return null;
    });
    return fresco?.premiumSubscriptionCount ?? guild.premiumSubscriptionCount ?? 0;
}

// "1 mejora" / "3 mejoras": el plural se calcula, no se escribe fijo. Un
// "ahora tenemos 1 mejoras" en el primer boost del servidor es justo el detalle
// que hace que un anuncio parezca hecho a medias.
function frase(userId, mejoras) {
    const plural = mejoras === 1 ? 'mejora' : 'mejoras';
    return `${E.boost} <@${userId}> ha boosteado el servidor, ahora tenemos ${E.boosters} **${mejoras}** ${plural}!`;
}

function buildBoostEmbed(userId, mejoras, avatarURL = null) {
    const embed = new EmbedBuilder()
        .setColor(COLOR)
        .setDescription(frase(userId, mejoras))
        .setFooter({ text: '7x Community • Sistema de boosts' })
        .setTimestamp();

    // Avatar de quien ha boosteado: arriba a la derecha, como en la tarjeta de
    // reseñas. Los emojis del servidor sólo se pintan en la descripción, nunca
    // en el título ni en el footer, así que el texto vive todo en la descripción.
    if (avatarURL) embed.setThumbnail(avatarURL);

    // Y la animación cerrando la tarjeta, abajo del todo.
    if (IMAGEN.exists) embed.setImage(`attachment://${IMAGEN.name}`);

    return embed;
}

function buildBoostPayload(userId, mejoras, avatarURL = null) {
    return {
        embeds: [buildBoostEmbed(userId, mejoras, avatarURL)],
        ...(IMAGEN.exists && { files: [{ attachment: IMAGEN.path, name: IMAGEN.name }] }),
    };
}

async function resolverCanal(client) {
    const id = config.CHANNELS.BOOST;
    if (!id) {
        console.warn('[boost] config.CHANNELS.BOOST sin definir — no se anuncia nada.');
        return null;
    }

    const canal = client.channels.cache.get(id) ?? await client.channels.fetch(id).catch(() => null);
    if (!canal) console.warn(`[boost] Canal ${id} no encontrado — no se anuncia nada.`);
    return canal;
}

async function handleBoost(oldMember, newMember) {
    if (!esBoostNuevo(oldMember, newMember)) return;

    const userId = newMember.id;

    if (isLocked(`boost:${userId}`)) {
        console.log(`[boost] Evento repetido de ${userId} ignorado.`);
        return;
    }
    lock(`boost:${userId}`, ANTI_DUPLICADO_MS);

    const canal = await resolverCanal(newMember.client);
    if (!canal) return;

    const mejoras = await contarMejoras(newMember.guild);
    const avatarURL = newMember.displayAvatarURL({ size: 256 });

    console.log(`[boost] ${newMember.user?.tag ?? userId} ha boosteado — el servidor tiene ${mejoras}.`);

    await canal.send(buildBoostPayload(userId, mejoras, avatarURL)).catch(err => {
        console.error('[boost] No se pudo publicar el anuncio:', err?.message ?? err);
    });
}

module.exports = {
    handleBoost,
    __test: { esBoostNuevo, buildBoostEmbed, buildBoostPayload, frase, contarMejoras, IMAGEN, COLOR, E },
};
