'use strict';

const { EmbedBuilder } = require('discord.js');
const config = require('./config');
const v2 = require('./utils/panelV2');
const groupActive = require('./utils/groupActive');

// ── Panel de estado de entrega ────────────────────────────────────────────────
// Dice, de un vistazo, desde qué comunidades se están enviando Robux ahora
// mismo. Lo mueve el owner con /groupactive, y se repinta al instante.
//
// Las comunidades no están escritas aquí: salen de config.CHECK_GROUPS, la
// misma lista de la que viven Check Group's y el panel de comunidades. Añadir
// una comunidad la hace aparecer también en este panel, activa por defecto.

const VERDE = 0x57F287;
const ROJO  = 0xED4245;

const E = {
    activo:   '<a:active:1529678531473309848>',
    point:    '<:point:1501212595464700104>',
    working:  '<:working:1547108520669741157>',
    down:     '<:down:1547141212530679899>',
};

const TITULO = 'Estado de entrega de Robux';

// El título va DENTRO de la descripción, como encabezado markdown, y no en
// setTitle(). No es una preferencia: Discord no renderiza los emojis del
// servidor en el título de un embed — ni en el nombre de un field, ni en el
// footer. Ahí `<a:active:1529…>` se imprime crudo, tal cual. En la descripción
// sí se pintan.
function buildDescripcion(estado) {
    const lineas = [
        `## ${E.activo} ${TITULO}`,
        '',
        `${E.point} Actualmente, los Robux se están enviando desde estos grupos:`,
        '',
        ...estado.map(g => `${g.activa ? E.working : E.down} **${g.label}**`),
    ];

    // Con todo apagado, un panel verde diciendo "se están enviando desde estos
    // grupos" seguido de cinco cruces sería justo lo contrario de informar. Se
    // dice en una línea, y el color acompaña.
    if (!estado.some(g => g.activa)) {
        lineas.push(
            '',
            `${E.down} **Ninguna comunidad está enviando Robux ahora mismo.** Los pedidos se entregarán en cuanto se restablezca alguna.`
        );
    }

    return lineas.join('\n');
}

function buildEmbed(estado = groupActive.getState()) {
    const hayActivas = estado.some(g => g.activa);

    return new EmbedBuilder()
        .setColor(hayActivas ? VERDE : ROJO)
        .setDescription(buildDescripcion(estado))
        .setFooter({ text: '7x Community • Estado de entrega' })
        .setTimestamp();
}

// ── Identificación y comparación ──────────────────────────────────────────────
// El panel se reconoce por su título, que es lo único que no cambia al
// encender o apagar una comunidad.

function isStatusMsg(msg, botId) {
    return msg.author.id === botId && (msg.embeds?.[0]?.description ?? '').includes(TITULO);
}

// Se comparan sólo color y descripción, NO el timestamp: el timestamp cambia en
// cada construcción, y compararlo obligaría a reeditar el panel en cada
// arranque. Dejándolo fuera, la hora que enseña el panel es la del último
// cambio de verdad — que es justo lo que quiere leer un cliente en un panel de
// estado.
function estaAlDia(msg, embed) {
    const publicado = msg.embeds?.[0];
    if (!publicado) return false;

    const nuevo = embed.toJSON();
    return publicado.description === nuevo.description && publicado.color === nuevo.color;
}

// ── ensureGroupStatusPanel ────────────────────────────────────────────────────
// El ÚNICO sitio desde el que se publica o se repinta el panel. Se llama al
// arrancar y otra vez tras cada /groupactive.

async function ensureGroupStatusPanel(client) {
    const id = config.CHANNELS.GROUP_STATUS;
    if (!id) {
        console.warn('[groupStatus] config.CHANNELS.GROUP_STATUS sin definir — panel omitido.');
        return null;
    }

    const channel = client.channels.cache.get(id) ?? await client.channels.fetch(id).catch(() => null);
    if (!channel) {
        console.warn(`[groupStatus] Canal ${id} no encontrado — panel omitido.`);
        return null;
    }

    const embed = buildEmbed();

    const aplicar = async (msg, comoLlego) => {
        if (estaAlDia(msg, embed)) {
            console.log(`[groupStatus] Panel ${comoLlego} ya actualizado — nada que hacer.`);
            return msg;
        }
        await msg.edit({ embeds: [embed] });
        console.log(`[groupStatus] Panel ${comoLlego} actualizado.`);
        return msg;
    };

    // Los FIJADOS primero: no dependen de cuántos mensajes haya por encima.
    // Buscar sólo en los últimos 100 acaba duplicando el panel en cuanto el
    // canal acumula más de 100 mensajes desde que se publicó.
    const fijados = await v2.fetchPinnedMessages(channel);
    const pinned = fijados.find(m => isStatusMsg(m, client.user.id));
    if (pinned) return aplicar(pinned, 'fijado');

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const existing = messages?.find(m => isStatusMsg(m, client.user.id));
    if (existing) {
        const msg = await aplicar(existing, 'del historial');
        await msg.pin().catch(err => console.warn('[groupStatus] No se pudo fijar:', err.message));
        return msg;
    }

    // Espera y reintento: protege contra dos instancias arrancando a la vez.
    await new Promise(r => setTimeout(r, 3000));

    const recheck = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const aparecido = recheck?.find(m => isStatusMsg(m, client.user.id));
    if (aparecido) {
        console.log('[groupStatus] El panel apareció mientras esperábamos — no se envía otro.');
        return aparecido;
    }

    const msg = await channel.send({ embeds: [embed] });
    await msg.pin().catch(err => console.warn('[groupStatus] No se pudo fijar:', err.message));
    console.log('[groupStatus] Panel enviado y fijado.');
    return msg;
}

module.exports = {
    ensureGroupStatusPanel,
    __test: { buildEmbed, buildDescripcion, isStatusMsg, estaAlDia, TITULO, VERDE, ROJO, E },
};
