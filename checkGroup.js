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
const { ensureGroupEmojis, mencionaIconos } = require('./utils/groupEmojis');

// ── Panel de Check Group's ────────────────────────────────────────────────────
// Un único Container hace de "embed": barra de color a la izquierda y, DENTRO
// del mismo bloque, el texto, una línea por comunidad con su icono y los
// botones. Mismo patrón que panel.js, verif.js y headless.js.
//
// Las comunidades NO están escritas aquí: salen de config.CHECK_GROUPS, que es
// la misma fuente de la que handlers/buttons.js deriva los customId (`cg_
// <clave>`) y de la que el flujo saca el groupId. Añadir una comunidad es
// tocar config y nada más: aparece su línea, su icono y su botón.
//
// El icono va a la IZQUIERDA del nombre, y por eso es un emoji y no la imagen
// grande de una Section: el accessory de una Section lo pinta Discord siempre a
// la derecha, sin alternativa. utils/groupEmojis.js sube el icono real de cada
// comunidad como emoji de la aplicación y explica el porqué con detalle.

const ACCENT = 0x2B2D31;
const TITULO = "Check Group's";

const E = {
    group: '<:followers7x:1525326777071960124>',
    point: '<:point:1501212595464700104>',
    ok:    '<:truepurple:1501214679400190086>',
};

// Etiqueta corta para el botón, sólo donde la de config no cabe bien. Sin
// entrada aquí se usa el label de config tal cual.
const BOTON_CORTO = {
    noctra: '7x (Antes Noctra)',
};

// Las comunidades en el orden en que están escritas en config.
function comunidades() {
    return Object.entries(config.CHECK_GROUPS).map(([clave, grupo]) => ({ clave, ...grupo }));
}

// ── Textos ────────────────────────────────────────────────────────────────────

function buildCabecera() {
    return [
        `# ${E.group} ${TITULO}`,
        '',
        'Presiona el botón de la comunidad en la que quieras comprobar si eres elegible para recibir envíos de Robux.',
    ].join('\n');
}

// Una línea por comunidad: icono a la izquierda, nombre a la derecha y debajo
// el enlace. Quien todavía no pertenece necesita entrar ANTES de que comprobar
// su antigüedad tenga sentido, y ese enlace es justo lo que le hace falta.
//
// Sin emoji propio (Roblox no dio el icono, o Discord rechazó la subida) se usa
// el genérico: la línea sale igual, sólo que sin la foto de la comunidad.
function buildComunidades(emojis = {}) {
    return comunidades()
        .map(c => {
            const icono = emojis[c.clave] ?? E.group;
            const enlace = c.link
                ? `-# [Ver la comunidad en Roblox](${c.link})`
                : '-# Comunidad pendiente de configurar.';
            return `${icono} **${c.label}**\n${enlace}`;
        })
        .join('\n');
}

function buildAviso() {
    const total = comunidades().length;
    return [
        '### Información importante',
        `${E.point} Roblox exige **${config.MIN_GROUP_DAYS} días** dentro de una comunidad antes de poder enviarte Robux desde ella. El bot consulta tu fecha de ingreso directamente en Roblox y calcula los días exactos.`,
        `${E.point} Se recomienda estar en las **${total} comunidades**: si alguna presenta problemas o alcanza sus límites, podremos realizar el envío desde otra.`,
        `${E.point} Los envíos se realizan principalmente por **7x (Antes Noctra Study)**, aunque esto puede cambiar en cualquier momento.`,
        `${E.point} No se realizan envíos mediante **Roblox Plus/Premium**.`,
        `${E.ok} El resultado se publica al instante en <#${config.CHANNELS.CHECKGROUP_RESULTS}>, con tu fecha de ingreso y tus días de antigüedad.`,
    ].join('\n');
}

// ── Botones ───────────────────────────────────────────────────────────────────
// Un customId por comunidad: `cg_<clave>`. handlers/buttons.js deriva de
// config.CHECK_GROUPS exactamente el mismo conjunto para su guardia de canal, y
// el flujo lo vuelve a resolver contra config, así que un customId inventado no
// llega a ninguna parte.
//
// Discord admite 5 botones por fila; se reparten en filas de 3 para que las
// etiquetas largas no se aprieten.
const POR_FILA = 3;

function buildRows() {
    const filas = [];
    const lista = comunidades();

    for (let i = 0; i < lista.length; i += POR_FILA) {
        filas.push(
            new ActionRowBuilder().addComponents(
                lista.slice(i, i + POR_FILA).map(c =>
                    new ButtonBuilder()
                        .setCustomId(`cg_${c.clave}`)
                        .setLabel(BOTON_CORTO[c.clave] ?? c.label)
                        .setStyle(ButtonStyle.Secondary)
                )
            )
        );
    }

    return filas;
}

// ── Contenedor ────────────────────────────────────────────────────────────────

function separador(divisor = true) {
    return new SeparatorBuilder().setDivider(divisor).setSpacing(SeparatorSpacingSize.Small);
}

function buildContainer(emojis = {}) {
    const container = new ContainerBuilder()
        .setAccentColor(ACCENT)
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(buildCabecera()))
        .addSeparatorComponents(separador())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(buildComunidades(emojis)))
        .addSeparatorComponents(separador())
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(buildAviso()))
        .addSeparatorComponents(separador(false));

    for (const fila of buildRows()) container.addActionRowComponents(fila);

    return container;
}

// El panel no lleva ningún adjunto: los iconos son emojis de la aplicación.
const SIN_ADJUNTO = { exists: false, path: null, name: '' };

// ── Identificación ────────────────────────────────────────────────────────────
// Por el customId de cualquiera de sus botones, que es lo único que no cambia
// ni al añadir una comunidad ni al cambiar un icono. El texto se mantiene como
// respaldo para reconocer el panel ANTIGUO (el de embed clásico) y convertirlo
// en su sitio en vez de dejarlo huérfano.

function isCheckGroupMsg(msg, botId) {
    if (msg.author.id !== botId) return false;
    if (v2.collectButtons(msg).some(b => typeof b.custom_id === 'string' && b.custom_id.startsWith('cg_'))) return true;
    return v2.panelText(msg).includes(TITULO);
}

// ¿Reeditar ahora dejaría el panel PEOR de lo que está? Sólo si esta vez no se
// pudo resolver algún icono y el panel publicado sí los tiene. En ese caso se
// deja el bueno: el "no hay icono" se cachea 30 minutos (no 12 horas), así que
// el siguiente arranque lo arregla solo.
function degradaria(msg, faltan) {
    if (!faltan.length) return false;
    return mencionaIconos(v2.panelText(msg));
}

// Las comunidades que se quedan sin su icono real en esta pasada.
function sinIcono(emojis) {
    return comunidades().filter(c => c.groupId && !emojis[c.clave]).map(c => c.label);
}

// ── ensureCheckGroupPanel ─────────────────────────────────────────────────────
// El ÚNICO sitio desde el que se publica o se repinta el panel.

async function ensureCheckGroupPanel(client) {
    const channel = client.channels.cache.get(config.CHANNELS.CHECKGROUP)
        ?? await client.channels.fetch(config.CHANNELS.CHECKGROUP).catch(() => null);
    if (!channel) {
        console.warn('[checkGroup] CheckGroup channel not found — skipping.');
        return null;
    }

    const emojis = await ensureGroupEmojis(client);
    const faltan = sinIcono(emojis);
    if (faltan.length) {
        console.warn(`[checkGroup] Sin icono propio: ${faltan.join(', ')} — esas comunidades irán con el emoji genérico.`);
    }

    const container = buildContainer(emojis);

    const aplicar = async (msg, comoLlego) => {
        if (v2.isUpToDate(msg, container)) {
            console.log(`[checkGroup] Panel ${comoLlego} ya actualizado — nada que hacer.`);
            return msg;
        }
        if (degradaria(msg, faltan)) {
            console.warn('[checkGroup] Faltan iconos y el panel publicado sí los tiene — se deja como está.');
            return msg;
        }
        const editado = await v2.editOrRecreate(msg, container, SIN_ADJUNTO, 'checkGroup');
        console.log(`[checkGroup] Panel ${comoLlego} actualizado.`);
        return editado;
    };

    // 1. Los FIJADOS primero: no dependen de cuántos mensajes haya por encima.
    //    Buscarlo sólo en los últimos 100 significa duplicarlo en cuanto el
    //    canal acumula más de 100 mensajes desde que se publicó.
    const fijados = await v2.fetchPinnedMessages(channel);
    const pinned = fijados.find(m => isCheckGroupMsg(m, client.user.id));
    if (pinned) return aplicar(pinned, 'fijado');

    // 2. Respaldo: los últimos 100 mensajes. Cubre un panel desfijado a mano y
    //    el caso en que Discord no deje leer los fijados.
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const existing = messages?.find(m => isCheckGroupMsg(m, client.user.id));
    if (existing) {
        const msg = await aplicar(existing, 'del historial');
        await msg.pin().catch(err => console.warn('[checkGroup] No se pudo fijar:', err.message));
        return msg;
    }

    // 3. Espera y reintento: protege contra dos instancias arrancando a la vez.
    await new Promise(r => setTimeout(r, 3000));

    const recheck = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const aparecido = recheck?.find(m => isCheckGroupMsg(m, client.user.id));
    if (aparecido) {
        console.log('[checkGroup] El panel apareció mientras esperábamos — no se envía otro.');
        return aparecido;
    }

    const msg = await channel.send(v2.payload(container, SIN_ADJUNTO));
    await msg.pin().catch(err => console.warn('[checkGroup] No se pudo fijar:', err.message));
    console.log('[checkGroup] Panel enviado y fijado.');
    return msg;
}

module.exports = {
    ensureCheckGroupPanel,
    __test: { buildContainer, buildComunidades, buildRows, buildAviso, isCheckGroupMsg, degradaria, sinIcono, comunidades, TITULO, ACCENT },
};
