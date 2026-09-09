'use strict';

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder,
} = require('discord.js');
const config = require('./config');
const v2 = require('./utils/panelV2');
const groupActive = require('./utils/groupActive');
const { ensureGroupEmojis } = require('./utils/groupEmojis');

// ── Panel de estado de entrega ────────────────────────────────────────────────
// Dice, de un vistazo, desde qué comunidades se están enviando Robux ahora
// mismo. Lo mueve el owner con /groupactive, y se repinta al instante.
//
// Es un Container de Components V2 y no un embed clásico por una razón
// concreta: el botón de "Verificar elegibilidad" tiene que ir DENTRO del
// bloque. Un embed no admite botones — en un mensaje clásico quedan colgando
// debajo, fuera del marco de color.
//
// Las comunidades no están escritas aquí: salen de config.CHECK_GROUPS, la
// misma lista de la que viven Check Group's y el panel de comunidades. Añadir
// una comunidad la hace aparecer también en este panel, apagada, y en el
// desplegable del comando.

const VERDE = 0x57F287;
const ROJO  = 0xED4245;

const E = {
    activo:   '<a:active:1529678531473309848>',
    point:    '<:point:1501212595464700104>',
    working:  '<:working:1547108520669741157>',
    down:     '<:down:1547141212530679899>',
    grupo:    '<:followers7x:1525326777071960124>',
};

const TITULO = 'Estado de entrega de Robux';

// El título va como encabezado markdown dentro del texto, no en un setTitle().
// No es una preferencia: Discord no renderiza los emojis del servidor en el
// título de un embed —ni en el nombre de un field, ni en el footer—, ahí
// `<a:active:1529…>` se imprime crudo. En el cuerpo sí se pintan.
function buildDescripcion(estado, emojis = {}) {
    const lineas = [
        `## ${E.activo} ${TITULO}`,
        '',
        `${E.point} Actualmente, los Robux se están enviando desde estos grupos:`,
        '',
        // Icono de la comunidad entre el estado y el nombre: con cinco grupos,
        // el icono es lo que deja distinguirlos de un vistazo sin leer.
        ...estado.map(g => `${g.activa ? E.working : E.down} ${emojis[g.clave] ?? E.grupo} **${g.label}**`),
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

// El pie hace de footer: un Container no tiene footer ni timestamp propios.
//
// La hora sale del fichero de estado, NO de Date.now(): el panel se repinta en
// cada arranque, así que una hora calculada al vuelo cambiaría el texto cada
// vez —obligando a reeditar el mensaje en cada reinicio— y además mentiría
// sobre cuándo cambió el estado de verdad.
function buildPie(actualizado = groupActive.getUpdatedAt()) {
    if (!actualizado) return '-# 7x Community • Estado de entrega';

    const unix = Math.floor(Date.parse(actualizado) / 1000);
    return `-# 7x Community • Estado de entrega • última actualización <t:${unix}:R>`;
}

// ── El botón ──────────────────────────────────────────────────────────────────
// Mismo patrón que el del panel de comunidades: un botón de enlace a un canal
// del propio servidor. Discord no tiene un botón que "navegue a un canal", pero
// una URL discord.com/channels/<guild>/<canal> abre ese canal en el cliente. Al
// ser Link no lleva customId y no pasa por handlers/buttons.js: no hay nada que
// enrutar ni que pueda fallar.
function buildRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Verificar elegibilidad')
            .setEmoji({ id: '1182888883344642180', name: 'rro', animated: true })
            .setStyle(ButtonStyle.Link)
            .setURL(`https://discord.com/channels/${config.GUILD_ID}/${config.CHANNELS.CHECKGROUP}`),
    );
}

function buildContainer(estado = groupActive.getState(), actualizado = groupActive.getUpdatedAt(), emojis = {}) {
    return new ContainerBuilder()
        .setAccentColor(estado.some(g => g.activa) ? VERDE : ROJO)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(buildDescripcion(estado, emojis)))
        .addSeparatorComponents(
            new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small)
        )
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(buildPie(actualizado)))
        .addSeparatorComponents(
            new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small)
        )
        .addActionRowComponents(buildRow());
}

// El panel no lleva ningún adjunto.
const SIN_ADJUNTO = { exists: false, path: null, name: '' };

// ── Identificación ────────────────────────────────────────────────────────────
// Por el texto, que es lo único estable: el botón es de enlace y no tiene
// customId, y el color cambia al encender o apagar una comunidad. panelText()
// lee tanto el panel nuevo (TextDisplay) como el ANTIGUO (embed clásico), que
// es lo que permite convertirlo en su sitio en vez de dejarlo huérfano.

function isStatusMsg(msg, botId) {
    return msg.author.id === botId && v2.panelText(msg).includes(TITULO);
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

    // Los iconos de cada comunidad, subidos como emojis de la aplicación. Si no
    // se pueden resolver, cada línea cae al emoji genérico y el panel sale
    // igual: una foto no puede impedir que se publique el estado.
    const emojis = await ensureGroupEmojis(client).catch(() => ({}));
    const container = buildContainer(groupActive.getState(), groupActive.getUpdatedAt(), emojis);

    const aplicar = async (msg, comoLlego) => {
        if (v2.isUpToDate(msg, container)) {
            console.log(`[groupStatus] Panel ${comoLlego} ya actualizado — nada que hacer.`);
            return msg;
        }
        // editOrRecreate y no msg.edit: el panel publicado hoy es un embed
        // clásico, y Discord NO deja añadirle el flag de Components V2 en un
        // edit. En ese caso se sustituye —y se vuelve a fijar— en vez de fallar.
        const editado = await v2.editOrRecreate(msg, container, SIN_ADJUNTO, 'groupStatus');
        console.log(`[groupStatus] Panel ${comoLlego} actualizado.`);
        return editado;
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

    const msg = await channel.send(v2.payload(container, SIN_ADJUNTO));
    await msg.pin().catch(err => console.warn('[groupStatus] No se pudo fijar:', err.message));
    console.log('[groupStatus] Panel enviado y fijado.');
    return msg;
}

module.exports = {
    ensureGroupStatusPanel,
    __test: { buildContainer, buildDescripcion, buildPie, buildRow, isStatusMsg, TITULO, VERDE, ROJO, E },
};
