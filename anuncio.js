'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('./config');
const precios = require('./data/prices');
const v2 = require('./utils/panelV2');
const { safeReply } = require('./utils/safe');

// ── Anuncio del servidor ──────────────────────────────────────────────────────
// El escaparate: qué vende 7x y por cuánto. Se publica y se fija solo al
// arrancar, y un reinicio NO lo reenvía — se busca primero entre los fijados y
// sólo se reedita si lo que dice cambió.
//
// El botón "Copiar" entrega el mismo anuncio listo para pegar en OTROS
// servidores, y por eso existen dos versiones del texto (ver buildPortable).

const ACCENT = 0x2B2D31; // gris, el mismo del resto de paneles del bot

const BANNER = v2.pickBanner(['./7xwidebanner.gif'], '7xwidebanner.gif');

// El gancho del anuncio es el precio, así que no se escribe a mano: sale de
// data/prices, la MISMA tabla con la que cobra el ticket. Un anuncio con un
// precio viejo es peor que no anunciarlo, y subir los precios ya es tocar un
// fichero. Si no hubiera tabla, la línea del precio desaparece sola en vez de
// publicar un número inventado (ver el .filter(Boolean) de VENTAJAS).
const REF_ROBUX = 1000;
const PRECIO_REF = precios.lookup(REF_ROBUX)?.price ?? null;

const E = {
    robux:     '<a:robuxxx:1510070809366892604>',
    precio:    '<:sale:1501212817502502913>',
    pagos:     '<:cripto:1552521783406497822>',
    sorteos:   '<a:sorteos:1525333836181934081>',
    comunidad: '<:comunidad:1544122190017077308>',
    servicios: '<a:star:1514369366878064650>',
    soporte:   '<a:soporte:1544122300985643090>',
    cierre:    '<:truepurple:1501214679400190086>',
    copiar:    { id: '1501213108935332013', name: 'copiar' },
};

// Las ventajas, en un solo sitio: de aquí salen LAS DOS versiones del anuncio,
// la del panel y la que entrega el botón, así que no pueden acabar diciendo
// cosas distintas.
const VENTAJAS = [
    PRECIO_REF && {
        emoji: E.precio,
        texto: `**${REF_ROBUX.toLocaleString('en-US')} Robux por ${PRECIO_REF} MXN** · aún más baratos por volumen`,
    },
    { emoji: E.pagos,     texto: '**Crypto · Transferencia · Depósito · Gift Cards**' },
    { emoji: E.sorteos,   texto: 'Sorteos de Robux, Nitro y decoraciones' },
    { emoji: E.comunidad, texto: 'Comunidad grande, activa y amable' },
    { emoji: E.servicios, texto: 'Servicios automatizados para una mejor experiencia' },
    { emoji: E.soporte,   texto: 'Atención rápida y soporte al instante' },
].filter(Boolean);

const TITULO  = '7x COMMUNITY';
const GANCHO  = 'VENDEMOS ROBUX BARATOS';
const ENTRADA = 'Entrega **rápida**, precios **bajos** y trato **serio**. Miles de compras hechas.';
const CIERRE  = '**Compra barato, participa en los sorteos y forma parte de 7x**';

// ── El anuncio del panel ──────────────────────────────────────────────────────
// Aquí sí valen los emojis del servidor y el enlace enmascarado en el título:
// lo publica el bot, y a un bot Discord le permite las dos cosas.
function buildTexto() {
    return [
        `# [${TITULO}](${config.INVITE_URL})`,
        `### ${E.robux} ${GANCHO}`,
        ENTRADA,
        '',
        ...VENTAJAS.map(v => `${v.emoji} ${v.texto}`),
        '',
        `${E.cierre} ${CIERRE}`,
    ].join('\n');
}

// ── El anuncio portable ───────────────────────────────────────────────────────
// El que entrega el botón "Copiar", para pegarlo en otros servidores. Es el
// mismo anuncio, con los mismos emojis de 7x —Discord los pinta por id para
// cualquiera que LEA el mensaje, con Nitro o sin él; lo que hace falta Nitro es
// para ESCRIBIRLOS fuera del servidor, y eso ya es cosa de quien lo pegue—.
//
// Cambian dos cosas, y las dos porque aquí publica una PERSONA y no el bot:
//
//   - EL TÍTULO NO LLEVA EL ENLACE OCULTO. `[texto](url)` es cosa de bots y
//     webhooks: en un mensaje de usuario se imprime tal cual, con los
//     corchetes. No hay Nitro que arregle eso. Así que el enlace va desnudo — y
//     así, además, Discord despliega debajo la tarjeta de invitación del
//     servidor, que para anunciarse es mejor que esconderla.
//   - EL GIF VA COMO ENLACE, no adjunto: pegada la URL, Discord la reconoce y
//     lo pinta solo. Pero no se puede escribir a mano aquí, porque las URLs de
//     la CDN de Discord van firmadas y caducan; sale del PROPIO mensaje del
//     panel, que es el que lleva el botón (ver handleCopiarAnuncio).
function buildPortable(gifUrl = null) {
    return [
        `# ${TITULO}`,
        `### ${E.robux} ${GANCHO}`,
        ENTRADA,
        '',
        ...VENTAJAS.map(v => `${v.emoji} ${v.texto}`),
        '',
        `${E.cierre} ${CIERRE}`,
        config.INVITE_URL,
        ...(gifUrl ? [gifUrl] : []),
    ].join('\n');
}

// ── Botón ─────────────────────────────────────────────────────────────────────

function buildRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('anuncio_copiar')
            .setLabel('Copiar')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji(E.copiar),
    );
}

// El GIF va dentro del contenedor y el botón DEBAJO de él: tarjeta() monta el
// bloque en ese orden (texto → imagen → filas), así que el orden no se decide
// aquí, se hereda.
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

// Lo que entrega el botón: UN mensaje efímero con el anuncio y nada más, para
// que el "Copiar texto" de Discord entregue justo eso. Efímero porque es para
// quien va a reenviarlo, no para volver a llenar el canal.
//
// La URL del GIF sale del mensaje del panel, que es el mismo que lleva el
// botón: `interaction.message` llega con los adjuntos ya firmados de nuevo en
// cada clic. Escribirla a mano no vale —las de la CDN de Discord caducan en
// horas— y adjuntar el fichero tampoco: son 9 MB por clic, y pegado en otro
// servidor lo que hace falta es una URL que Discord reconozca, no un adjunto.
async function handleCopiarAnuncio(interaction) {
    const gif = interaction.message?.attachments?.first?.()?.url ?? null;

    await safeReply(interaction, { content: buildPortable(gif), ephemeral: true });
}

// ── Identificación ────────────────────────────────────────────────────────────
// Por el customId del botón, que es lo único que no cambia al retocar el texto
// o el GIF. El título queda de respaldo.

function isAnuncioMsg(msg, botId) {
    if (msg.author.id !== botId) return false;
    if (v2.collectButtons(msg).some(b => b.custom_id === 'anuncio_copiar')) return true;
    return v2.panelText(msg).includes(TITULO);
}

// ── ensureAnuncioPanel ────────────────────────────────────────────────────────
// El ÚNICO sitio desde el que se publica. Un reinicio no reenvía nada: si el
// anuncio ya está y dice lo mismo, no se toca.

async function ensureAnuncioPanel(client) {
    const id = config.CHANNELS.ANUNCIO;
    if (!id) {
        console.warn('[anuncio] config.CHANNELS.ANUNCIO sin definir — anuncio omitido.');
        return null;
    }

    const channel = client.channels.cache.get(id) ?? await client.channels.fetch(id).catch(() => null);
    if (!channel) {
        console.warn(`[anuncio] Canal ${id} no encontrado — anuncio omitido.`);
        return null;
    }

    if (!BANNER.exists) {
        console.warn('[anuncio] 7xwidebanner.gif no encontrado — el anuncio irá sin GIF.');
    }

    const container = buildContainer();

    const aplicar = async (msg, comoLlego) => {
        if (v2.isUpToDate(msg, container)) {
            console.log(`[anuncio] Anuncio ${comoLlego} ya actualizado — nada que hacer.`);
            return msg;
        }
        const editado = await v2.editOrRecreate(msg, container, BANNER, 'anuncio');
        console.log(`[anuncio] Anuncio ${comoLlego} actualizado.`);
        return editado;
    };

    // Los FIJADOS primero: no dependen de cuántos mensajes haya por encima.
    // Buscar sólo en los últimos 100 acaba reenviando el anuncio en cuanto el
    // canal acumula más de 100 mensajes desde que se publicó.
    const fijados = await v2.fetchPinnedMessages(channel);
    const pinned = fijados.find(m => isAnuncioMsg(m, client.user.id));
    if (pinned) return aplicar(pinned, 'fijado');

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const existing = messages?.find(m => isAnuncioMsg(m, client.user.id));
    if (existing) {
        const msg = await aplicar(existing, 'del historial');
        await msg.pin().catch(err => console.warn('[anuncio] No se pudo fijar:', err.message));
        return msg;
    }

    // Espera y reintento: protege contra dos instancias arrancando a la vez.
    await new Promise(r => setTimeout(r, 3000));

    const recheck = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const aparecido = recheck?.find(m => isAnuncioMsg(m, client.user.id));
    if (aparecido) {
        console.log('[anuncio] El anuncio apareció mientras esperábamos — no se envía otro.');
        return aparecido;
    }

    const msg = await channel.send(buildPayload());
    await msg.pin().catch(err => console.warn('[anuncio] No se pudo fijar:', err.message));
    console.log('[anuncio] Anuncio enviado y fijado.');
    return msg;
}

module.exports = {
    ensureAnuncioPanel,
    handleCopiarAnuncio,
    __test: {
        buildContainer, buildTexto, buildPortable, buildRow, buildPayload, isAnuncioMsg,
        VENTAJAS, TITULO, GANCHO, ENTRADA, CIERRE, ACCENT, BANNER, E,
        REF_ROBUX, PRECIO_REF,
    },
};
