'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('./config');
const v2 = require('./utils/panelV2');
const gp = require('./utils/gamepassPrecios');

// ── Panel de precios por gamepass ─────────────────────────────────────────────
// Mismo molde que el de la calculadora: un Container de Components V2 con el
// texto, el GIF y los dos botones DENTRO del bloque.
//
// Lo que cambia es lo que cuenta. Aquí hay dos cifras y no una —lo que se paga
// y lo que llega a la cuenta—, y la segunda es menor porque Roblox se queda su
// comisión de la venta del gamepass. Las dos se dicen en el panel y en las dos
// calculadoras: alguien que pague por "1.000 Robux" y vea llegar 700 sin que
// nadie se lo hubiera avisado tiene razón en quejarse.

const ACCENT = 0x2B2D31;

const TITULO = '7x Community - Gamepass';

// Pesa 9,4 MiB y el límite de subida de Discord son 10: si se cambia por otro
// más pesado, el panel dejará de publicarse.
const BANNER = v2.pickBanner(['./7xCommunity_Gamepass_Discord.gif'], '7xgamepass.gif');

const E = {
    money: { id: '1544123920897019906', name: 'money' },
    robux: { id: '1510070809366892604', name: 'robuxxx', animated: true },
    point: '<:point:1501212595464700104>',
    alert: '<:alert:1501220021035204658>',
    // El carrito animado del panel de tickets, que es el que ya se usa para
    // "comprar" en el resto del bot.
    shop:  '<a:shop:1190502129748676650>',
};

function buildTexto() {
    // El ejemplo se calcula, no se escribe: con el precio a mano, cambiarlo en
    // config dejaría el panel enseñando una cuenta que ya no sale.
    const ejemplo = 1000;

    return [
        `# ${TITULO}`,
        '',
        'Compra Robux por **gamepass**. Tú creas el gamepass en tu juego y nosotros te lo compramos.',
        '',
        `${E.shop} **${gp.fmtRobux(1000)} Robux = ${gp.fmtMXN(gp.G.PRECIO_POR_1K)}**`,
        `-# Por cada 1.000 Robux de **valor del gamepass**.`,
        '',
        `### ${E.point} Cómo funciona`,
        '**1.** Mira aquí abajo cuánto cuesta lo que quieres.',
        '**2.** Crea un gamepass en tu juego **por el valor que vas a comprar**.',
        '**3.** Abre tu ticket, pásanos el enlace y lo compramos.',
        '',
        `### ${E.alert} Roblox cobra su comisión y no la cubrimos`,
        `Roblox se queda el **${Math.round(gp.G.TASA_ROBLOX * 100)}%** de toda venta de gamepass. Pagas por el **valor del ` +
        'gamepass**, y a tu cuenta llega el resto.',
        '',
        `${E.point} Gamepass de **${gp.fmtRobux(ejemplo)}** → pagas **${gp.fmtMXN(gp.precioDe(ejemplo))}** ` +
        `→ recibes **${gp.fmtRobux(gp.recibe(ejemplo))} Robux**`,
        '',
        `### ${E.point} Consulta tu precio`,
        `<:${E.money.name}:${E.money.id}> = Tienes un presupuesto y quieres saber qué gamepass te alcanza.`,
        `<a:${E.robux.name}:${E.robux.id}> = Sabes cuántos Robux quieres y quieres el precio exacto.`,
        '',
        'Presiona uno de los botones para comenzar.',
    ].join('\n');
}

function buildGamepassRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('gp_dinero')
            .setEmoji(E.money)
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('gp_robux')
            .setEmoji(E.robux)
            .setStyle(ButtonStyle.Secondary),
    );
}

function buildContainer() {
    return v2.tarjeta({
        color: ACCENT,
        texto: buildTexto(),
        imagen: BANNER.exists ? `attachment://${BANNER.name}` : null,
        filas: [buildGamepassRow()],
    });
}

function buildPayload() {
    return v2.payload(buildContainer(), BANNER);
}

// ── Identificación ────────────────────────────────────────────────────────────
// Por el customId del botón, que es lo único que no cambia al retocar el texto
// o el precio. El título queda de respaldo.

function isGamepassMsg(msg, botId) {
    if (msg.author?.id !== botId) return false;
    if (v2.collectButtons(msg).some(b => b.custom_id === 'gp_dinero')) return true;
    return v2.panelText(msg).includes(TITULO);
}

// ── ensureGamepassPanel ───────────────────────────────────────────────────────
// El ÚNICO sitio desde el que se publica. Los fijados primero: buscar sólo en
// los últimos 100 acaba duplicando el panel en un canal con movimiento.

async function ensureGamepassPanel(client) {
    const id = config.CHANNELS.GAMEPASS;
    if (!id) {
        console.warn('[gamepass] config.CHANNELS.GAMEPASS sin definir — panel omitido.');
        return null;
    }

    const channel = client.channels.cache.get(id) ?? await client.channels.fetch(id).catch(() => null);
    if (!channel) {
        console.warn(`[gamepass] Canal ${id} no encontrado — panel omitido.`);
        return null;
    }

    if (!BANNER.exists) {
        console.warn('[gamepass] 7xCommunity_Gamepass_Discord.gif no encontrado — el panel irá sin GIF.');
    }

    const container = buildContainer();

    const aplicar = async (msg, comoLlego) => {
        if (v2.isUpToDate(msg, container)) {
            console.log(`[gamepass] Panel ${comoLlego} ya actualizado — nada que hacer.`);
            return msg;
        }
        const editado = await v2.editOrRecreate(msg, container, BANNER, 'gamepass');
        console.log(`[gamepass] Panel ${comoLlego} actualizado.`);
        return editado;
    };

    const fijados = await v2.fetchPinnedMessages(channel);
    const pinned = fijados.find(m => isGamepassMsg(m, client.user.id));
    if (pinned) return aplicar(pinned, 'fijado');

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const existing = messages?.find(m => isGamepassMsg(m, client.user.id));
    if (existing) {
        const msg = await aplicar(existing, 'del historial');
        await msg.pin().catch(err => console.warn('[gamepass] No se pudo fijar:', err.message));
        return msg;
    }

    // Espera y reintento: protege contra dos instancias arrancando a la vez.
    await new Promise(r => setTimeout(r, 3000));

    const recheck = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const aparecido = recheck?.find(m => isGamepassMsg(m, client.user.id));
    if (aparecido) {
        console.log('[gamepass] El panel apareció mientras esperábamos — no se envía otro.');
        return aparecido;
    }

    const msg = await channel.send(buildPayload());
    await msg.pin().catch(err => console.warn('[gamepass] No se pudo fijar:', err.message));
    console.log('[gamepass] Panel enviado y fijado.');
    return msg;
}

module.exports = {
    ensureGamepassPanel,
    __test: { buildContainer, buildPayload, buildTexto, buildGamepassRow, isGamepassMsg, TITULO, ACCENT, BANNER },
};
