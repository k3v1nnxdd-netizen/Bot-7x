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

// ── Banner ────────────────────────────────────────────────────────────────────
// Va DENTRO del contenedor, entre el texto y el botón. Se sube como adjunto y se
// referencia con attachment://. Mismo criterio que el panel de tickets: la
// imagen tiene que ser bastante ancha (esta mide 970x371, 92 frames a 30 fps)
// porque Discord nunca amplía una imagen, y por debajo del ancho del bloque
// quedaría un hueco al lado. Pesa 9,3 MiB, con el límite de subida en 10 MiB.
const BANNER = v2.pickBanner(['./7xcomunidades30fps.gif'], '7xcomunidades.gif');

const ACCENT = 0x2B2D31;
const TITULO = "7x Community - Group's";

function buildVerifText() {
    return (
        `# ${TITULO}\n\n` +
        "<:followers7x:1525326777071960124> **7x Community's**\n" +
        'https://www.roblox.com/share/g/59218460\n\n' +
        '<:followers7x:1525326777071960124> **Noctra Study**\n' +
        'https://www.roblox.com/share/g/282134403\n\n' +
        '<:followers7x:1525326777071960124> **7x $tudio**\n' +
        'https://www.roblox.com/share/g/1101699267'
    );
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
function buildVerifContainer() {
    const container = new ContainerBuilder()
        .setAccentColor(ACCENT)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(buildVerifText()))
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

function buildVerifOptions() {
    return v2.payload(buildVerifContainer(), BANNER);
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

    const container = buildVerifContainer();

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (messages) {
        const pinned = messages.find(m => m.pinned && isVerifMsg(m, client.user.id));
        if (pinned) {
            if (v2.isUpToDate(pinned, container)) {
                console.log('[verif] Pinned verif panel already up to date — nothing to do.');
                return;
            }
            await v2.editOrRecreate(pinned, container, BANNER, 'verif');
            console.log('[verif] Pinned verif panel updated.');
            return;
        }
        const existing = messages.find(m => isVerifMsg(m, client.user.id));
        if (existing) {
            const msg = v2.isUpToDate(existing, container)
                ? existing
                : await v2.editOrRecreate(existing, container, BANNER, 'verif');
            await msg.pin().catch(err => console.warn('[verif] Could not pin:', err.message));
            console.log('[verif] Verif panel updated and pinned.');
            return;
        }
    }

    await new Promise(r => setTimeout(r, 3000));

    const recheck = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    if (recheck?.find(m => isVerifMsg(m, client.user.id))) {
        console.log('[verif] Verif panel appeared while waiting — skipping send.');
        return;
    }

    const msg = await channel.send(buildVerifOptions());
    await msg.pin().catch(err => console.warn('[verif] Could not pin:', err.message));
    console.log('[verif] Verif panel sent and pinned.');
}

module.exports = {
    ensureVerifPanel,
    __test: { buildVerifOptions, buildVerifRow, buildVerifContainer, isVerifMsg, BANNER },
};
