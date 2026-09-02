'use strict';

const fs = require('fs');
const crypto = require('crypto');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    MessageFlags,
    SeparatorBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder,
} = require('discord.js');
const config = require('./config');

// ── Banner ────────────────────────────────────────────────────────────────────
// El GIF va DENTRO del contenedor, justo encima de los botones. Se sube como
// adjunto y se referencia con attachment://, igual que en reglas.js/metodos.js.
//
// 7xticket30fps.gif es el banner en alta (1024x391, 92 frames a 30 fps).
// Discord NUNCA amplía una imagen: con el arte antiguo, de 400x153, el banner se
// quedaba corto dentro del contenedor y dejaba hueco al lado. A 1024 px Discord
// lo ajusta al ancho del bloque, así que ocupa TODO el ancho, alineado con el
// texto y los botones. 7xticket916x350.gif queda solo de respaldo.
//
// Ese fichero pesa 9,3 MiB y el límite de subida de Discord son 10 MiB: si
// alguna vez se cambia por otro más pesado, el panel dejará de publicarse.
//
// El nombre del adjunto lleva el hash del fichero: es lo único del GIF que
// sobrevive en el mensaje ya publicado (Discord devuelve su URL de CDN, firmada
// y con caducidad), así que es lo que permite a isUpToDate() darse cuenta de que
// el GIF ha cambiado y reeditar el panel.
const BANNER_CANDIDATES = ['./7xticket30fps.gif', './7xticket916x350.gif'];
const BANNER_PATH   = BANNER_CANDIDATES.find(p => fs.existsSync(p)) ?? null;
const BANNER_EXISTS = BANNER_PATH !== null;
const BANNER_NAME   = BANNER_EXISTS
    ? `7xticket-${crypto.createHash('sha1').update(fs.readFileSync(BANNER_PATH)).digest('hex').slice(0, 8)}.gif`
    : '7xticket.gif';

const ACCENT = 0x2B2D31;

// Emojis del panel. Cada opción de la lista usa el MISMO emoji que su botón,
// para que el texto y los botones se lean como una sola cosa.
const E = {
    buy:        '<:buy:1501212698556371004>',
    duels:      '<:duels7x2:1525325282624540732>',
    seguidores: '<:followers7x:1525326777071960124>',
    otra:       '<:up:1501217620437897227>',
    alert:      '<:alert:1501220021035204658>',
};

// ── Contenido ─────────────────────────────────────────────────────────────────

const HEADER = [
    `## ${E.buy} 7x COMMUNITY — Soporte & Compras`,
    '¿Quieres comprar **Robux** o tienes alguna **duda**?',
    'Elige una opción abajo y se abrirá tu ticket al instante.',
].join('\n');

const OPCIONES = [
    `${E.buy} **Comprar** — Ticket para comprar **Robux**`,
    `${E.duels} **Duels** — Ticket para comprar **sets de Duels**`,
    `${E.seguidores} **Seguidores** — Ticket para comprar **seguidores**`,
    `${E.otra} **Otra cosa** — Dudas, problemas o consultas`,
].join('\n');

const AVISO = [
    `${E.alert} **Antes de abrir un ticket**`,
    '',
    'Los tickets de **Robux** son **automáticos** y los atiende el **bot**: ' +
    'no necesitas staff, owner ni mencionar a **@kevvv7x** para completar tu compra.',
    '',
    'El staff solo interviene en tickets de **soporte, dudas o problemas**.',
    '-# Evita crear tickets innecesarios · Un ticket por compra',
].join('\n');

// ── Construcción del panel (Components V2) ────────────────────────────────────
// Un único Container hace de "embed": barra de color a la izquierda, y dentro
// del mismo bloque el GIF, el texto y los BOTONES.

function buildButtons() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('comprar')
            .setLabel('Comprar')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(E.buy),
        new ButtonBuilder()
            .setCustomId('duels')
            .setLabel('Duels')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(E.duels),
        new ButtonBuilder()
            .setCustomId('seguidores')
            .setLabel('Seguidores')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(E.seguidores),
        new ButtonBuilder()
            .setCustomId('otra_cosa')
            .setLabel('Otra cosa')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(E.otra),
    );
}

function buildContainer() {
    const container = new ContainerBuilder()
        .setAccentColor(ACCENT)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${HEADER}\n\n${OPCIONES}`))
        .addSeparatorComponents(
            new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
        )
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(AVISO))
        .addSeparatorComponents(
            new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
        );

    // El GIF cierra el bloque de texto y deja los botones justo debajo.
    if (BANNER_EXISTS) {
        container
            .addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems(
                    new MediaGalleryItemBuilder().setURL(`attachment://${BANNER_NAME}`)
                )
            )
            .addSeparatorComponents(
                new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small)
            );
    }

    return container.addActionRowComponents(buildButtons());
}

function buildPayload() {
    return {
        flags: MessageFlags.IsComponentsV2,
        components: [buildContainer()],
        ...(BANNER_EXISTS && { files: [{ attachment: BANNER_PATH, name: BANNER_NAME }] }),
    };
}

// El edit tiene que limpiar lo que dejó el panel viejo (embed) y volver a subir
// el adjunto: `attachments: []` descarta el GIF anterior antes de subir el nuevo.
function buildEditPayload() {
    return { ...buildPayload(), content: null, embeds: [], attachments: [] };
}

// ── Identificación y firma ────────────────────────────────────────────────────

function rawComponents(msg) {
    return msg.components.map(c => (typeof c.toJSON === 'function' ? c.toJSON() : c));
}

function collectButtons(node, out = []) {
    if (Array.isArray(node)) {
        for (const child of node) collectButtons(child, out);
        return out;
    }
    if (!node || typeof node !== 'object') return out;
    if (node.type === 2 && node.custom_id) out.push(node);
    collectButtons(node.components, out);
    return out;
}

// Reconoce tanto el panel nuevo (contenedor V2) como el viejo (embed), porque
// los customId de los botones no han cambiado.
function isPanelMsg(msg, botId) {
    if (msg.author.id !== botId) return false;
    if (collectButtons(rawComponents(msg)).some(b => b.custom_id === 'comprar')) return true;
    return msg.embeds[0]?.title?.includes('7x COMMUNITY') ?? false;
}

// Nombre de fichero de una URL de media, sin los parámetros de firma que añade
// la CDN de Discord: `.../7xticket-ab12cd34.gif?ex=…` -> `7xticket-ab12cd34.gif`.
function mediaName(url) {
    return typeof url === 'string' ? url.split('?')[0].split('/').pop() : '';
}

// Firma de lo que se ve: color, textos, nº de imágenes y botones. Sirve para no
// reeditar (ni resubir el GIF de 4,6 MB) en cada arranque si nada ha cambiado.
function signature(node, out = []) {
    if (Array.isArray(node)) {
        for (const child of node) signature(child, out);
        return out;
    }
    if (!node || typeof node !== 'object') return out;
    switch (node.type) {
        case 17: out.push(`accent:${node.accent_color ?? ''}`); break;
        case 10: out.push(`text:${node.content}`); break;
        case 12: out.push(`media:${(node.items ?? []).map(i => mediaName(i.media?.url)).join(',')}`); break;
        case 2:  out.push(`btn:${node.custom_id}|${node.label}|${node.style}|${node.emoji?.id ?? node.emoji?.name ?? ''}`); break;
    }
    signature(node.components, out);
    return out;
}

function isUpToDate(msg) {
    const wanted  = signature([buildContainer().toJSON()]).join('\n');
    const current = signature(rawComponents(msg)).join('\n');
    return wanted === current;
}

// ── ensurePanel ───────────────────────────────────────────────────────────────
// El ÚNICO sitio desde el que se envía el panel.
// Usa channel.messages.fetch() a secas — fetchPinned/fetchPins devuelven tipos
// distintos según el parche de discord.js. Los fijados se detectan con m.pinned.

async function updatePanel(msg) {
    try {
        await msg.edit(buildEditPayload());
        return msg;
    } catch (err) {
        // Un mensaje enviado sin el flag de Components V2 puede rechazar el edit.
        // En ese caso se sustituye: se borra el viejo y se manda el nuevo.
        console.warn('[panel] Edit rechazado, recreando el panel:', err.message);
        const channel = msg.channel;
        await msg.delete().catch(e => console.warn('[panel] Could not delete old panel:', e.message));
        return channel.send(buildPayload());
    }
}

async function ensurePanel(client) {
    const channel = client.channels.cache.get(config.CHANNELS.PANEL);
    if (!channel) {
        console.warn('[panel] Panel channel not found — skipping.');
        return;
    }

    if (!BANNER_EXISTS) {
        console.warn(`[panel] Banner no encontrado (${BANNER_CANDIDATES.join(', ')}) — el panel se enviará sin GIF.`);
    }

    // ── 1. Scan last 100 messages ─────────────────────────────────────────────
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (messages) {
        // Prefer a pinned panel — edit it in place to reflect current layout
        const pinned = messages.find(m => m.pinned && isPanelMsg(m, client.user.id));
        if (pinned) {
            if (isUpToDate(pinned)) {
                console.log('[panel] Pinned panel already up to date — nothing to do.');
                return;
            }
            await updatePanel(pinned);
            console.log('[panel] Pinned panel updated in place.');
            return;
        }
        // Any panel in history — edit and pin it
        const existing = messages.find(m => isPanelMsg(m, client.user.id));
        if (existing) {
            const msg = isUpToDate(existing) ? existing : await updatePanel(existing);
            await msg.pin().catch(err => console.warn('[panel] Could not pin:', err.message));
            console.log('[panel] Found in history — updated and pinned.');
            return;
        }
    }

    // ── 2. Wait then re-check ─────────────────────────────────────────────────
    // Guards against two bot instances starting simultaneously.
    await new Promise(r => setTimeout(r, 3000));

    const recheck = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    if (recheck?.find(m => isPanelMsg(m, client.user.id))) {
        console.log('[panel] Panel appeared while waiting — skipping send.');
        return;
    }

    // ── 3. Send and pin ───────────────────────────────────────────────────────
    const msg = await channel.send(buildPayload());
    await msg.pin().catch(err => console.warn('[panel] Could not pin:', err.message));
    console.log('[panel] Panel sent and pinned.');
}

module.exports = { ensurePanel };
