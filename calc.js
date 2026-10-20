'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('./config');
const v2 = require('./utils/panelV2');

// ── Panel de la calculadora ───────────────────────────────────────────────────
// Un Container de Components V2, como el resto de paneles: barra gris a la
// izquierda y, DENTRO del mismo bloque, el texto y los dos botones. Antes era
// un embed clásico, que no admite botones — quedaban colgando debajo del marco.
//
// Los customId NO cambian (`calc_dinero`, `calc_robux`): son los que enruta
// handlers/buttons.js y los que identifican el panel para reeditarlo.

const ACCENT = 0x2B2D31;

const TITULO = '7x Community - Robux';

const E = {
    money: { id: '1544123920897019906', name: 'money' },
    robux: { id: '1510070809366892604', name: 'robuxxx', animated: true },
    point: '<:point:1501212595464700104>',
};

function buildTexto() {
    return [
        `# ${TITULO}`,
        '',
        '¿Quieres saber cuántos Robux puedes comprar o cuánto costarán los que necesitas?',
        '',
        `<:${E.money.name}:${E.money.id}> = Ingresa la cantidad de dinero que tienes y el bot te dirá cuántos Robux puedes obtener.`,
        '',
        `<a:${E.robux.name}:${E.robux.id}> = Ingresa la cantidad de Robux que deseas y el bot calculará el precio exacto.`,
        '',
        `${E.point} Cálculo instantáneo y automático.`,
        `${E.point} Precios actualizados.`,
        `${E.point} Fácil y rápido.`,
        '',
        'Presiona uno de los botones para comenzar.',
    ].join('\n');
}

function buildCalcRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('calc_dinero')
            .setEmoji(E.money)
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('calc_robux')
            .setEmoji(E.robux)
            .setStyle(ButtonStyle.Secondary),
    );
}

function buildContainer() {
    return v2.tarjeta({ color: ACCENT, texto: buildTexto(), filas: [buildCalcRow()] });
}

function buildPayload() {
    return v2.tarjetaPayload({ color: ACCENT, texto: buildTexto(), filas: [buildCalcRow()] });
}

// ── Identificación ────────────────────────────────────────────────────────────
// Reconoce el panel NUEVO (contenedor, sin embeds) y el VIEJO (embed clásico).
//
// Las dos cosas hacen falta, y cada una por su motivo:
//
//   - Por el customId del botón: un mensaje V2 no tiene `embeds`, así que la
//     comprobación de antes (`msg.embeds.length > 0`) no encontraría nunca el
//     panel nuevo y cada arranque publicaría otro.
//   - Por el texto: es lo que localiza el panel viejo, el que ya está publicado
//     y fijado en el canal, para convertirlo en sitio en vez de dejarlo
//     huérfano al lado del nuevo.
function isCalcMsg(msg, botId) {
    if (msg.author?.id !== botId) return false;
    if (v2.collectButtons(msg).some(b => b.custom_id === 'calc_dinero')) return true;
    return v2.panelText(msg).includes(TITULO) || Boolean(msg.embeds?.[0]?.title?.includes(TITULO));
}

// ── ensureCalcPanel ───────────────────────────────────────────────────────────
// El ÚNICO sitio desde el que se publica. Los fijados primero: buscar sólo en
// los últimos 100 mensajes acaba duplicando el panel en cuanto el canal
// acumula más de 100 por encima.

async function ensureCalcPanel(client) {
    const id = config.CHANNELS.CALC;
    const channel = client.channels.cache.get(id) ?? await client.channels.fetch(id).catch(() => null);
    if (!channel) {
        console.warn('[calc] Canal de la calculadora no encontrado — panel omitido.');
        return null;
    }

    const container = buildContainer();

    const aplicar = async (msg, comoLlego) => {
        if (v2.isUpToDate(msg, container)) {
            console.log(`[calc] Panel ${comoLlego} ya actualizado — nada que hacer.`);
            return msg;
        }
        // editOrRecreate se encarga del caso que importa aquí: el panel viejo
        // es un embed clásico, y Discord puede rechazar el edit que le añade el
        // flag de Components V2. Si lo rechaza, lo sustituye y lo vuelve a fijar.
        const editado = await v2.editOrRecreate(msg, container, { exists: false }, 'calc');
        console.log(`[calc] Panel ${comoLlego} actualizado.`);
        return editado;
    };

    const fijados = await v2.fetchPinnedMessages(channel);
    const pinned = fijados.find(m => isCalcMsg(m, client.user.id));
    if (pinned) return aplicar(pinned, 'fijado');

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const existing = messages?.find(m => isCalcMsg(m, client.user.id));
    if (existing) {
        const msg = await aplicar(existing, 'del historial');
        await msg.pin().catch(err => console.warn('[calc] No se pudo fijar:', err.message));
        return msg;
    }

    // Espera y reintento: protege contra dos instancias arrancando a la vez.
    await new Promise(r => setTimeout(r, 3000));

    const recheck = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const aparecido = recheck?.find(m => isCalcMsg(m, client.user.id));
    if (aparecido) {
        console.log('[calc] El panel apareció mientras esperábamos — no se envía otro.');
        return aparecido;
    }

    const msg = await channel.send(buildPayload());
    await msg.pin().catch(err => console.warn('[calc] No se pudo fijar:', err.message));
    console.log('[calc] Panel enviado y fijado.');
    return msg;
}

module.exports = {
    ensureCalcPanel,
    __test: { buildContainer, buildPayload, buildTexto, buildCalcRow, isCalcMsg, TITULO, ACCENT },
};
