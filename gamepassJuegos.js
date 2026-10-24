'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('./config');
const v2 = require('./utils/panelV2');

// ── Panel de gamepasses y objetos de juegos ──────────────────────────────────
// Mismo molde que el de gamepass.js: un Container de Components V2 con el
// texto, el GIF y el botón DENTRO del bloque, publicado y fijado al arrancar,
// y editado en su sitio si cambia (nunca duplicado).
//
// Aquí no se compra nada desde el panel: el botón es un ENLACE al canal de
// tickets, donde el cliente abre el suyo y pide lo que quiere.

const ACCENT = 0x2B2D31;

const TITULO = '7x Community - Gamepasses y objetos de juegos';

// Pesa 8,8 MiB y el límite de subida de Discord son 10: si se cambia por otro
// más pesado, el panel dejará de publicarse.
const BANNER = v2.pickBanner(['./7xCommunity_Gamepasses_Juegos_Discord.gif'], '7xgamepassesjuegos.gif');

const E = {
    point: '<:point:1501212595464700104>',
    alert: '<:alert:1501220021035204658>',
    ok:    '<:true:1501213776878501899>',
    shop:  '<a:shop:1190502129748676650>',
    shopBoton: { id: '1190502129748676650', name: 'shop', animated: true },
};

const urlTickets = () => `https://discord.com/channels/${config.GUILD_ID}/${config.CHANNELS.PANEL}`;

function buildTexto() {
    return [
        `# ${TITULO}`,
        '',
        `${E.shop} Te conseguimos **gamepasses de cualquier juego de Roblox** que permita **regalarlos**, ` +
        'y **objetos, armas, mascotas y más** de los juegos donde se puedan **tradear**.',
        '',
        `### ${E.point} Qué puedes pedir`,
        `${E.ok} Gamepasses de cualquier juego con la opción de **regalo** activada.`,
        `${E.ok} Objetos, armas, frutas, mascotas o lo que quieras de juegos con **trading**.`,
        `${E.ok} ¿No sabes si tu juego entra? Pregúntanos y lo revisamos.`,
        '',
        `### ${E.point} Cómo funciona`,
        '**1.** Abre un ticket y dinos **el juego** y **lo que quieres**.',
        '**2.** Te confirmamos la disponibilidad y el precio.',
        '**3.** Pagas con cualquiera de nuestros métodos y te lo entregamos: el gamepass **regalado a tu cuenta** o el objeto **por trade** dentro del juego.',
        '',
        `### ${E.point} Por qué con nosotros`,
        '**Entrega rápida** · **Pagos en pesos** · **Atención por ticket, paso a paso** · **Todo queda registrado en tu ticket**',
        '',
        `-# ${E.alert} Si el juego no permite regalar gamepasses ni tradear objetos, no es posible hacer la entrega.`,
        '',
        'Presiona el botón para abrir tu ticket.',
    ].join('\n');
}

function buildRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Abrir ticket')
            .setEmoji(E.shopBoton)
            .setStyle(ButtonStyle.Link)
            .setURL(urlTickets()),
    );
}

function buildContainer() {
    return v2.tarjeta({
        color: ACCENT,
        texto: buildTexto(),
        imagen: BANNER.exists ? `attachment://${BANNER.name}` : null,
        filas: [buildRow()],
    });
}

function buildPayload() {
    return v2.payload(buildContainer(), BANNER);
}

// ── Identificación ────────────────────────────────────────────────────────────
// Un botón de enlace no tiene customId, así que se reconoce por el título.

function isPanelMsg(msg, botId) {
    if (msg.author?.id !== botId) return false;
    return v2.panelText(msg).includes(TITULO);
}

// ── ensureGamepassJuegosPanel ─────────────────────────────────────────────────
// El ÚNICO sitio desde el que se publica. Los fijados primero: buscar sólo en
// los últimos 100 acaba duplicando el panel en un canal con movimiento.

async function ensureGamepassJuegosPanel(client) {
    const id = config.CHANNELS.GAMEPASS_JUEGOS;
    if (!id) {
        console.warn('[gamepassJuegos] config.CHANNELS.GAMEPASS_JUEGOS sin definir — panel omitido.');
        return null;
    }

    const channel = client.channels.cache.get(id) ?? await client.channels.fetch(id).catch(() => null);
    if (!channel) {
        console.warn(`[gamepassJuegos] Canal ${id} no encontrado — panel omitido.`);
        return null;
    }

    if (!BANNER.exists) {
        console.warn('[gamepassJuegos] 7xCommunity_Gamepasses_Juegos_Discord.gif no encontrado — el panel irá sin GIF.');
    }

    const container = buildContainer();

    const aplicar = async (msg, comoLlego) => {
        if (v2.isUpToDate(msg, container)) {
            console.log(`[gamepassJuegos] Panel ${comoLlego} ya actualizado — nada que hacer.`);
            return msg;
        }
        const editado = await v2.editOrRecreate(msg, container, BANNER, 'gamepassJuegos');
        console.log(`[gamepassJuegos] Panel ${comoLlego} actualizado.`);
        return editado;
    };

    const fijados = await v2.fetchPinnedMessages(channel);
    const pinned = fijados.find(m => isPanelMsg(m, client.user.id));
    if (pinned) return aplicar(pinned, 'fijado');

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const existing = messages?.find(m => isPanelMsg(m, client.user.id));
    if (existing) {
        const msg = await aplicar(existing, 'del historial');
        await msg.pin().catch(err => console.warn('[gamepassJuegos] No se pudo fijar:', err.message));
        return msg;
    }

    // Espera y reintento: protege contra dos instancias arrancando a la vez.
    await new Promise(r => setTimeout(r, 3000));

    const recheck = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const aparecido = recheck?.find(m => isPanelMsg(m, client.user.id));
    if (aparecido) {
        console.log('[gamepassJuegos] El panel apareció mientras esperábamos — no se envía otro.');
        return aparecido;
    }

    const msg = await channel.send(buildPayload());
    await msg.pin().catch(err => console.warn('[gamepassJuegos] No se pudo fijar:', err.message));
    console.log('[gamepassJuegos] Panel enviado y fijado.');
    return msg;
}

module.exports = {
    ensureGamepassJuegosPanel,
    __test: { buildContainer, buildPayload, buildTexto, buildRow, isPanelMsg, urlTickets, TITULO, BANNER },
};
