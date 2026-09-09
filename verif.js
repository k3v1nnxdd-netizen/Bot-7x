'use strict';

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder,
} = require('discord.js');
const config = require('./config');
const v2 = require('./utils/panelV2');
const { ensureGroupEmojis, mencionaIconos } = require('./utils/groupEmojis');

// ── Banner ────────────────────────────────────────────────────────────────────
// Va DENTRO del contenedor, entre el texto y el botón. Se sube como adjunto y se
// referencia con attachment://. Mismo criterio que el panel de tickets: la
// imagen tiene que ser bastante ancha (esta mide 970x371, 92 frames a 30 fps)
// porque Discord nunca amplía una imagen, y por debajo del ancho del bloque
// quedaría un hueco al lado. Pesa 9,3 MiB, con el límite de subida en 10 MiB.
const BANNER = v2.pickBanner(['./7xcomunidades30fps.gif'], '7xcomunidades.gif');

const ACCENT = 0x2B2D31;
const TITULO = "7x Community - Group's";

// La lista de comunidades sale de config.CHECK_GROUPS, la MISMA de la que vive
// el panel de Check Group's. Antes estaba escrita a mano aquí, y eso significaba
// que añadir una comunidad la dejaba fuera de este panel sin que nada avisara:
// la gente se unía a las que veía aquí y luego el otro panel le decía que no
// pertenecía a una cuarta que nunca le habían enseñado.
//
// El icono de cada una va a la IZQUIERDA del nombre, y por eso es un emoji: en
// Components V2 la imagen de una Section se pinta siempre a la derecha (ver
// utils/groupEmojis.js). Sin emoji propio se cae al genérico.
const EMOJI_GENERICO = '<:followers7x:1525326777071960124>';

function buildVerifText(emojis = {}) {
    const lista = Object.entries(config.CHECK_GROUPS)
        .map(([clave, grupo]) => {
            const icono = emojis[clave] ?? EMOJI_GENERICO;
            const enlace = grupo.link
                ? `-# [Unirme a la comunidad](${grupo.link})`
                : '-# Comunidad pendiente de configurar.';
            return `${icono} **${grupo.label}**\n${enlace}`;
        })
        .join('\n');

    return `# ${TITULO}\n\n${lista}`;
}

function buildVerifAviso() {
    return (
        '<:point:1501212595464700104> **Actualmente los Robux se envían únicamente mediante el grupo *Noctra Study*.** Sin embargo, con el paso del tiempo también se utilizarán las demás comunidades para realizar los pagos.\n\n' +
        `<:rules:1525317070764511343> **Roblox exige que un usuario permanezca al menos ${config.MIN_GROUP_DAYS} días dentro del grupo antes de poder recibir pagos de Robux.** Por ello, es importante unirte cuanto antes.\n\n` +
        '<:point:1501212595464700104> **Es obligatorio unirse a todas las comunidades**, no solo a una. En cualquier momento los pagos pueden realizarse desde cualquiera de estos grupos.'
    );
}

// Mismo patrón que el botón del panel de seguidores: un botón de enlace que
// apunta a un canal del propio servidor. Discord no tiene un botón que "navegue
// a un canal" como tal, pero una URL discord.com/channels/<guild>/<canal> abre
// ese canal en el cliente, que es exactamente el efecto buscado. Al ser Link no
// lleva customId y por tanto no pasa por handlers/buttons.js: no hay nada que
// enrutar ni que pueda fallar.
function buildVerifRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Verificar elegibilidad')
            .setEmoji({ id: '1182888883344642180', name: 'rro', animated: true })
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/channels/${config.GUILD_ID}/${config.CHANNELS.CHECKGROUP}`),
    );
}

// El contenedor hace de "embed": texto arriba, GIF debajo y el botón al final,
// todo dentro del mismo bloque.
function buildVerifContainer(emojis = {}) {
    const container = new ContainerBuilder()
        .setAccentColor(ACCENT)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(buildVerifText(emojis)))
        .addSeparatorComponents(
            new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
        )
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(buildVerifAviso()))
        .addSeparatorComponents(
            new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
        );

    if (BANNER.exists) {
        container
            .addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems(
                    new MediaGalleryItemBuilder().setURL(`attachment://${BANNER.name}`)
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small)
            );
    }

    return container.addActionRowComponents(buildVerifRow());
}

function buildVerifOptions(emojis = {}) {
    return v2.payload(buildVerifContainer(emojis), BANNER);
}

// Las comunidades que se quedan sin su icono real en esta pasada.
function sinIcono(emojis) {
    return Object.entries(config.CHECK_GROUPS)
        .filter(([clave, grupo]) => grupo.groupId && !emojis[clave])
        .map(([, grupo]) => grupo.label);
}

// Reconoce el panel por su texto: sirve igual para el panel nuevo (TextDisplay)
// y para el clásico (embed), y no depende del botón, que al ser de enlace no
// tiene customId. Se mantienen los títulos antiguos para poder reconvertir un
// panel publicado antes de este formato.
function isVerifMsg(msg, botId) {
    if (msg.author.id !== botId) return false;
    const texto = v2.panelText(msg);
    return texto.includes(TITULO) || texto.includes('Verificación de Grupo');
}

async function ensureVerifPanel(client) {
    const channel = client.channels.cache.get(config.CHANNELS.VERIF);
    if (!channel) {
        console.warn('[verif] Verif channel not found — skipping.');
        return;
    }

    if (!BANNER.exists) {
        console.warn('[verif] Banner no encontrado (7xcomunidades30fps.gif) — el panel se enviará sin GIF.');
    }

    const emojis = await ensureGroupEmojis(client);
    const faltan = sinIcono(emojis);
    if (faltan.length) {
        console.warn(`[verif] Sin icono propio: ${faltan.join(', ')} — esas comunidades irán con el emoji genérico.`);
    }

    const container = buildVerifContainer(emojis);

    // Reeditar con menos iconos de los que ya tiene el panel publicado lo
    // dejaría peor: se prefiere el bueno. El "no hay icono" se cachea 30 min,
    // así que el siguiente arranque lo arregla solo.
    const degradaria = msg => faltan.length && mencionaIconos(v2.panelText(msg));

    const aplicar = async (msg, comoLlego) => {
        if (v2.isUpToDate(msg, container)) {
            console.log(`[verif] Panel ${comoLlego} ya actualizado — nada que hacer.`);
            return msg;
        }
        if (degradaria(msg)) {
            console.warn('[verif] Faltan iconos y el panel publicado sí los tiene — se deja como está.');
            return msg;
        }
        const editado = await v2.editOrRecreate(msg, container, BANNER, 'verif');
        console.log(`[verif] Panel ${comoLlego} actualizado.`);
        return editado;
    };

    // Los FIJADOS primero: no dependen de cuántos mensajes haya por encima.
    // Buscar sólo en los últimos 100 acaba duplicando el panel en cuanto el
    // canal acumula más de 100 mensajes desde que se publicó.
    const fijados = await v2.fetchPinnedMessages(channel);
    const pinned = fijados.find(m => isVerifMsg(m, client.user.id));
    if (pinned) return aplicar(pinned, 'fijado');

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const existing = messages?.find(m => isVerifMsg(m, client.user.id));
    if (existing) {
        const msg = await aplicar(existing, 'del historial');
        await msg.pin().catch(err => console.warn('[verif] Could not pin:', err.message));
        return msg;
    }

    await new Promise(r => setTimeout(r, 3000));

    const recheck = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const aparecido = recheck?.find(m => isVerifMsg(m, client.user.id));
    if (aparecido) {
        console.log('[verif] Verif panel appeared while waiting — skipping send.');
        return aparecido;
    }

    const msg = await channel.send(buildVerifOptions(emojis));
    await msg.pin().catch(err => console.warn('[verif] Could not pin:', err.message));
    console.log('[verif] Verif panel sent and pinned.');
    return msg;
}

module.exports = {
    ensureVerifPanel,
    __test: { buildVerifOptions, buildVerifRow, buildVerifContainer, buildVerifText, isVerifMsg, sinIcono, BANNER },
};
