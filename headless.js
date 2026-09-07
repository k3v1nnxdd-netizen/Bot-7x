'use strict';

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    SectionBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder,
    ThumbnailBuilder,
} = require('discord.js');
const config = require('./config');
const v2 = require('./utils/panelV2');
const headlessSale = require('./utils/headlessSale');

// ── Panel de venta del Headless Horseman ──────────────────────────────────────
// Un único Container naranja hace de "embed": dentro van el texto, la imagen del
// Headless como miniatura a la derecha y los DOS botones, en vez de quedar
// colgando debajo del mensaje. Mismo patrón que panel.js y verif.js.
//
// El panel se REPINTA cuando cambia el estado de la venta (/headless on|off):
// la línea de estado forma parte de la firma del contenedor, así que
// ensureHeadlessPanel() detecta la diferencia y edita el mensaje en su sitio en
// vez de duplicarlo.

// La imagen va como accessory de una Section, o sea arriba a la derecha, igual
// que el thumbnail de un embed clásico. `headless.png` va primero para que
// baste con dejar caer un archivo con ese nombre para reemplazarla; el que hay
// hoy en el repo es "transparent (1).png" (420x420, con canal alfa, así que se
// ve bien en tema claro y oscuro).
const IMAGEN = v2.pickBanner(['./headless.png', './transparent (1).png'], 'headless.png');

const ACCENT = 0xFF8C00; // naranja

const E = {
    headless: '<:Headlesss:1546349270486220976>',
    shop:     '<a:shop:1190502129748676650>',
    roblox:   '<:RobloxPrice:1501213200153313565>',
    robux:    '<a:robuxxx:1510070809366892604>',
    money:    '<:money:1544123920897019906>',
    group:    '<:followers7x:1525326777071960124>',
    point:    '<:point:1501212595464700104>',
    alert:    '<:alert:1501220021035204658>',
    abierta:  '<a:add:1540603311890104321>',
    cerrada:  '<a:remove:1540604743234228364>',
};

const TITULO = 'HEADLESS HORSEMAN — 7X';

// ── Cifras ────────────────────────────────────────────────────────────────────
// Todas salen de config.HEADLESS. El porcentaje de ahorro se CALCULA: si mañana
// sube el precio, el panel no puede quedarse anunciando el ahorro de ayer.

const H = config.HEADLESS;

const fmt = n => n.toLocaleString('es-MX');

function ahorroPct() {
    return (100 * (1 - H.PRECIO_MXN / H.PRECIO_ROBLOX_MXN)).toFixed(2);
}

// ── Textos ────────────────────────────────────────────────────────────────────

function buildCabecera(abierta) {
    const estado = abierta
        ? `${E.abierta} **Venta abierta** · pulsa **Comprar** para abrir tu ticket`
        : `${E.cerrada} **Venta cerrada** · todavía no está disponible, vuelve pronto`;

    return [
        `## ${E.headless} ${TITULO}`,
        '',
        'Consigue tu **Headless Horseman** por mucho menos de lo que te costaría comprando los Robux directamente en Roblox.',
        '',
        `${E.shop} **Precio con nosotros** · \`$${fmt(H.PRECIO_MXN)} MXN\``,
        `${E.roblox} **Precio aprox. en Roblox** · \`$${fmt(H.PRECIO_ROBLOX_MXN)} MXN\` · \`${fmt(H.PRECIO_ROBLOX_USD)} USD\``,
        '',
        `${E.point} Ahorras aproximadamente un **${ahorroPct()}%**.`,
        '',
        `-# ${estado}`,
    ].join('\n');
}

function buildRecibes() {
    return [
        '### ¿QUÉ RECIBES?',
        `${E.robux} **${fmt(H.ROBUX)} Robux exactos** para comprar el Headless Horseman.`,
        `${E.point} Los Robux se entregan directamente **mediante grupo de Roblox**.`,
        `${E.point} **Sin descuentos**: recibes los ${fmt(H.ROBUX)} Robux completos.`,
        `${E.money} **Pago único** de \`$${fmt(H.PRECIO_MXN)} MXN\`.`,
    ].join('\n');
}

function buildRequisitos() {
    const comunidades = H.COMUNIDADES
        .map(c => `${E.group} [**${c.label}**](${c.link})`)
        .join('\n');

    return [
        '### REQUISITOS',
        `Debes permanecer un mínimo de **${H.DIAS_REQ} días** dentro de **ambas comunidades** antes de poder recibir los Robux:`,
        '',
        comunidades,
        '',
        `${E.point} Una vez cumplidos los **${H.DIAS_REQ} días**, la entrega puede realizarse de inmediato.`,
        `${E.point} Comprueba tu antigüedad con el botón **Verificar** de abajo.`,
    ].join('\n');
}

function buildImportante() {
    return [
        `### ${E.alert} IMPORTANTE`,
        '・No realizamos envíos por **Roblox Premium/Plus**.',
        '・No realizamos envíos mediante **Gamepass**, excepto si el comprador cubre completamente el **tax de Roblox**.',
        '・**No hay reembolsos** una vez realizado el pago.',
        '・El precio publicado **no admite descuentos adicionales**.',
        `・La promoción incluye **únicamente ${fmt(H.ROBUX)} Robux**.`,
    ].join('\n');
}

function buildCierre() {
    return [
        `${E.point} ¿Necesitas más o menos Robux? Abre un ticket en <#${config.CHANNELS.PANEL}> y solicita una cotización personalizada.`,
        '',
        `-# Headless por solo $${fmt(H.PRECIO_MXN)} MXN — ahorra más de la mitad frente al precio aproximado de comprar los Robux directamente en Roblox.`,
    ].join('\n');
}

// ── Botones ───────────────────────────────────────────────────────────────────
// "Comprar" es el único con customId: lo enruta handlers/buttons.js hacia
// handlers/headlessFlow.js. Sigue pulsable con la venta cerrada A PROPÓSITO —
// así quien llega puede leer POR QUÉ no puede comprar todavía, en vez de
// encontrarse un botón gris sin explicación.
//
// "Verificar" es un botón de enlace al canal de Check Group's: como los de
// verif.js y seguidores.js, no tiene customId y por tanto no pasa por ningún
// handler, no hay nada que pueda fallar.
function buildRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('headless_comprar')
            .setLabel('Comprar')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji({ id: '1190502129748676650', name: 'shop', animated: true }),
        new ButtonBuilder()
            .setLabel('Verificar')
            .setEmoji({ id: '1182888883344642180', name: 'rro', animated: true })
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/channels/${config.GUILD_ID}/${config.CHANNELS.CHECKGROUP}`),
    );
}

// ── Contenedor ────────────────────────────────────────────────────────────────

function separador(divisor = true) {
    return new SeparatorBuilder().setDivider(divisor).setSpacing(SeparatorSpacingSize.Small);
}

function buildContainer(abierta = headlessSale.isOpen()) {
    const container = new ContainerBuilder().setAccentColor(ACCENT);

    // La cabecera va dentro de una Section para poder colgarle la miniatura a la
    // derecha. Si la imagen no está en el repo, se degrada a un bloque de texto
    // normal: el panel sale igual, sólo que sin foto.
    if (IMAGEN.exists) {
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(buildCabecera(abierta)))
                .setThumbnailAccessory(
                    new ThumbnailBuilder()
                        .setURL(`attachment://${IMAGEN.name}`)
                        .setDescription('Headless Horseman')
                )
        );
    } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(buildCabecera(abierta)));
    }

    return container
        .addSeparatorComponents(separador())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(buildRecibes()))
        .addSeparatorComponents(separador())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(buildRequisitos()))
        .addSeparatorComponents(separador())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(buildImportante()))
        .addSeparatorComponents(separador())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(buildCierre()))
        .addSeparatorComponents(separador(false))
        .addActionRowComponents(buildRow());
}

function buildPayload() {
    return v2.payload(buildContainer(), IMAGEN);
}

// ── Identificación ────────────────────────────────────────────────────────────
// Por el customId del botón de comprar, que es lo único del panel que no cambia
// nunca: ni el precio, ni el estado de la venta, ni la imagen.

function isHeadlessMsg(msg, botId) {
    if (msg.author.id !== botId) return false;
    if (v2.collectButtons(msg).some(b => b.custom_id === 'headless_comprar')) return true;
    return v2.panelText(msg).includes(TITULO);
}

// ── ensureHeadlessPanel ───────────────────────────────────────────────────────
// El ÚNICO sitio desde el que se publica o se repinta el panel. Se llama al
// arrancar el bot y otra vez después de cada /headless on|off — en ese segundo
// caso el panel ya existe y lo único que cambia es la línea de estado, así que
// acaba en un edit del mismo mensaje.

async function ensureHeadlessPanel(client) {
    const channelId = config.CHANNELS.HEADLESS;
    if (!channelId) {
        console.warn('[headless] config.CHANNELS.HEADLESS sin definir — panel omitido.');
        return null;
    }

    const channel = client.channels.cache.get(channelId)
        ?? await client.channels.fetch(channelId).catch(() => null);
    if (!channel) {
        console.warn(`[headless] Canal ${channelId} no encontrado — panel omitido.`);
        return null;
    }

    if (!IMAGEN.exists) {
        console.warn('[headless] Imagen no encontrada (headless.png / "transparent (1).png") — el panel se enviará sin foto.');
    }

    const container = buildContainer();

    // 1. Los FIJADOS primero. Es la única búsqueda que no depende de cuánta
    //    gente haya escrito en el canal desde que se publicó el panel: con más
    //    de 100 mensajes encima, el barrido de abajo ya no lo encontraría y el
    //    arranque publicaría un duplicado.
    const fijados = await v2.fetchPinnedMessages(channel);
    const pinned = fijados.find(m => isHeadlessMsg(m, client.user.id));
    if (pinned) {
        if (v2.isUpToDate(pinned, container)) {
            console.log('[headless] Panel fijado ya actualizado — nada que hacer.');
            return pinned;
        }
        const msg = await v2.editOrRecreate(pinned, container, IMAGEN, 'headless');
        console.log('[headless] Panel fijado actualizado.');
        return msg;
    }

    // 2. Respaldo: los últimos 100 mensajes. Cubre el panel que alguien haya
    //    desfijado y el caso en el que Discord no deje leer los fijados.
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (messages) {
        const existing = messages.find(m => isHeadlessMsg(m, client.user.id));
        if (existing) {
            const msg = v2.isUpToDate(existing, container)
                ? existing
                : await v2.editOrRecreate(existing, container, IMAGEN, 'headless');
            await msg.pin().catch(err => console.warn('[headless] No se pudo fijar:', err.message));
            console.log('[headless] Panel encontrado en el historial — actualizado y fijado.');
            return msg;
        }
    }

    // Espera y reintento: protege contra dos instancias del bot arrancando a la
    // vez, igual que en panel.js.
    await new Promise(r => setTimeout(r, 3000));

    const recheck = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const aparecido = recheck?.find(m => isHeadlessMsg(m, client.user.id));
    if (aparecido) {
        console.log('[headless] El panel apareció mientras esperábamos — no se envía otro.');
        return aparecido;
    }

    const msg = await channel.send(buildPayload());
    await msg.pin().catch(err => console.warn('[headless] No se pudo fijar:', err.message));
    console.log('[headless] Panel enviado y fijado.');
    return msg;
}

module.exports = {
    ensureHeadlessPanel,
    __test: { buildContainer, buildRow, isHeadlessMsg, ahorroPct, buildCabecera, TITULO, ACCENT, IMAGEN },
};
