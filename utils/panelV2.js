'use strict';

const fs = require('fs');
const crypto = require('crypto');
const {
    ContainerBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags,
    SectionBuilder, SeparatorBuilder, SeparatorSpacingSize, TextDisplayBuilder, ThumbnailBuilder,
} = require('discord.js');

// ── Paneles con Components V2 ─────────────────────────────────────────────────
// Un panel V2 es un único Container que hace de "embed": dentro van el texto, el
// GIF y los botones, en vez de quedar los botones colgando debajo del mensaje.
//
// Ese mensaje no lleva ni content ni embeds, así que reconocerlo, compararlo y
// reeditarlo funciona distinto que en un panel clásico. Todo eso vive aquí, y lo
// comparten panel.js (tickets) y verif.js (comunidades de Roblox).

// Primer fichero de la lista que exista, con un nombre de adjunto que incluye el
// hash de su contenido. Ese nombre es lo ÚNICO del GIF que sobrevive en el
// mensaje ya publicado —Discord devuelve la URL de su CDN, firmada y con
// caducidad—, así que es lo que permite a isUpToDate() darse cuenta de que la
// imagen ha cambiado y reeditar el panel en vez de dejar el GIF viejo.
function pickBanner(candidates, attachName) {
    const path = candidates.find(p => fs.existsSync(p)) ?? null;
    if (!path) return { path: null, name: attachName, exists: false };

    const hash = crypto.createHash('sha1').update(fs.readFileSync(path)).digest('hex').slice(0, 8);
    return { path, name: attachName.replace(/(\.\w+)$/, `-${hash}$1`), exists: true };
}

// ── Tarjeta: texto + botones DENTRO del mismo bloque ─────────────────────────
//
// Un embed clásico no admite botones: siempre quedan colgando debajo, fuera del
// marco de color. Esto monta la misma tarjeta como Container, que sí los mete
// dentro.
//
// Lo que un Container NO tiene y hay que rehacer a mano:
//   - título  -> un encabezado markdown al principio del texto (y ahí Discord
//                SÍ pinta los emojis del servidor, al revés que en el título de
//                un embed);
//   - pie     -> una línea de subtexto al final;
//   - imagen  -> `imagen` como `attachment://…` o una URL, en una galería.
//
// `thumbnail` va a la derecha del texto, como el de un embed, y por eso el
// texto entra en una Section: es el único sitio donde Discord admite una imagen
// pegada a un bloque de texto.
// `mencion` va DENTRO del texto, y no como `content` del mensaje, porque
// Discord rechaza los dos juntos:
//
//   MESSAGE_CANNOT_USE_LEGACY_FIELDS_WITH_COMPONENTS_V2
//
// Un mensaje con el flag de Components V2 no puede llevar `content` ni
// `embeds`: TODO tiene que ir en los componentes. Pasarlo por aquí es lo que
// evita que alguien lo vuelva a intentar — y no se pierde el aviso, porque una
// mención dentro de un bloque de texto notifica igual.
function tarjeta({ color, texto, mencion = null, pie = null, thumbnail = null, imagen = null, filas = [] }) {
    const container = new ContainerBuilder();
    if (color !== undefined && color !== null) container.setAccentColor(color);

    const bloque = new TextDisplayBuilder().setContent(mencion ? `${mencion}\n${texto}` : texto);
    if (thumbnail) {
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(bloque)
                .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnail))
        );
    } else {
        container.addTextDisplayComponents(bloque);
    }

    if (imagen) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(imagen))
        );
    }

    if (pie) {
        container
            .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${pie}`));
    }

    const conFilas = filas.filter(Boolean);
    if (conFilas.length) {
        container.addSeparatorComponents(
            new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small)
        );
        for (const fila of conFilas) container.addActionRowComponents(fila);
    }

    return container;
}

// El mensaje listo para enviar. `files` para los adjuntos que referencie la
// tarjeta (una imagen con `attachment://`).
function tarjetaPayload(opciones, files = []) {
    return {
        flags: MessageFlags.IsComponentsV2,
        components: [tarjeta(opciones)],
        ...(files.length && { files }),
    };
}

function payload(container, banner) {
    return {
        flags: MessageFlags.IsComponentsV2,
        components: [container],
        ...(banner.exists && { files: [{ attachment: banner.path, name: banner.name }] }),
    };
}

// El edit tiene que limpiar lo que dejó el panel clásico (content y embed) y
// volver a subir el adjunto: `attachments: []` descarta el anterior.
function editPayload(container, banner) {
    return { ...payload(container, banner), content: null, embeds: [], attachments: [] };
}

function rawComponents(msg) {
    return (msg.components ?? []).map(c => (typeof c.toJSON === 'function' ? c.toJSON() : c));
}

// Los mensajes FIJADOS del canal, como array plano.
//
// Existe porque buscar el panel en los últimos 100 mensajes tiene un fondo
// falso: en cuanto se acumulan más de 100 mensajes por encima, el panel deja de
// aparecer en esa ventana y el siguiente arranque publica un DUPLICADO. Los
// fijados no dependen de cuántos mensajes haya encima, así que son la búsqueda
// fiable; el barrido de 100 se queda como respaldo (cubre un panel que alguien
// haya desfijado).
//
// discord.js cambió la API a mitad de la v14 y por eso esto no llama a una sola
// función: fetchPins() devuelve { items: [{ message }] } y fetchPinned() —ya
// deprecado— devuelve una Collection. Se aceptan las dos formas.
//
// Cualquier fallo devuelve un array vacío en vez de propagarse: sin fijados el
// llamante cae al barrido de siempre, que es exactamente lo que hacía antes.
async function fetchPinnedMessages(channel) {
    const manager = channel?.messages;
    if (!manager) return [];

    try {
        if (typeof manager.fetchPins === 'function') {
            const res = await manager.fetchPins();
            if (Array.isArray(res?.items)) return res.items.map(i => i?.message).filter(Boolean);
            if (typeof res?.values === 'function') return [...res.values()];
            return [];
        }
        if (typeof manager.fetchPinned === 'function') {
            const col = await manager.fetchPinned();
            return typeof col?.values === 'function' ? [...col.values()] : [];
        }
    } catch (err) {
        console.warn('[panelV2] No se pudieron leer los mensajes fijados:', err.message);
    }

    return [];
}

// `accessory` es la otra rama por la que cuelgan componentes: lo que va a la
// derecha de una Section (la miniatura del panel del Headless, por ejemplo) no
// está en `components`, sino ahí. Sin recorrerla, un cambio de imagen sería
// invisible para signature() y el panel se quedaría con la miniatura vieja.
function walk(node, visit) {
    if (Array.isArray(node)) {
        for (const child of node) walk(child, visit);
        return;
    }
    if (!node || typeof node !== 'object') return;
    visit(node);
    walk(node.components, visit);
    walk(node.accessory, visit);
}

function collectButtons(msg) {
    const out = [];
    walk(rawComponents(msg), n => { if (n.type === 2) out.push(n); });
    return out;
}

// Todo el texto visible de un mensaje, sea panel V2 (TextDisplay) o clásico
// (content + embeds). Sirve para reconocer un panel por lo que dice, que es lo
// único estable cuando sus botones son de enlace y no tienen customId.
function panelText(msg) {
    const out = [msg.content ?? ''];
    for (const embed of msg.embeds ?? []) out.push(embed.title ?? '', embed.description ?? '');
    walk(rawComponents(msg), n => { if (n.type === 10) out.push(n.content ?? ''); });
    return out.join('\n');
}

// Identidad estable de una imagen, para poder comparar lo que se ACABA de
// construir (`attachment://x.png`) con lo que Discord devuelve ya publicado.
//
// De la CDN de Discord sólo vale el nombre del fichero: esas URLs vienen
// firmadas y con caducidad (`…/x.gif?ex=…`), así que cambian en cada fetch
// aunque la imagen sea exactamente la misma, y compararlas enteras provocaría
// una reedición en cada arranque.
//
// De cualquier OTRA imagen —el icono de un grupo de Roblox, por ejemplo— vale
// la URL entera sin query: ahí la ruta es la identidad, y recortarla al último
// segmento sería peor que inútil, porque todos los iconos de Roblox terminan en
// `/420/420/` y los cinco parecerían el mismo (o, con la barra final, cadena
// vacía).
const CDN_DISCORD = /^https?:\/\/[^/]*\b(discordapp\.(com|net)|discord\.com)\//i;

function mediaName(url) {
    if (typeof url !== 'string') return '';

    const sinQuery = url.split('?')[0];
    if (sinQuery.startsWith('attachment://') || CDN_DISCORD.test(sinQuery)) {
        return sinQuery.split('/').filter(Boolean).pop() ?? '';
    }
    return sinQuery;
}

// Firma de lo que se ve: color, textos, imágenes y botones. Sirve para no
// reeditar (ni resubir un GIF de varios MB) en cada arranque si nada ha cambiado.
function signature(node) {
    const out = [];
    walk(node, n => {
        switch (n.type) {
            case 17: out.push(`accent:${n.accent_color ?? ''}`); break;
            case 10: out.push(`text:${n.content}`); break;
            case 11: out.push(`thumb:${mediaName(n.media?.url)}`); break;
            case 12: out.push(`media:${(n.items ?? []).map(i => mediaName(i.media?.url)).join(',')}`); break;
            case 2:  out.push(`btn:${n.custom_id ?? n.url}|${n.label}|${n.style}|${n.emoji?.id ?? n.emoji?.name ?? ''}`); break;
        }
    });
    return out.join('\n');
}

function isUpToDate(msg, container) {
    return signature([container.toJSON()]) === signature(rawComponents(msg));
}

// Pasa el panel al contenido actual. Un mensaje enviado sin el flag de
// Components V2 —los paneles antiguos, hechos con embed— puede rechazar el edit;
// en ese caso se sustituye: se borra el viejo y se manda el nuevo.
async function editOrRecreate(msg, container, banner, tag) {
    try {
        await msg.edit(editPayload(container, banner));
        return msg;
    } catch (err) {
        console.warn(`[${tag}] Edit rechazado, recreando el panel:`, err.message);

        const channel = msg.channel;
        // Recrear es borrar y mandar OTRO mensaje, y el pin se va con el que se
        // borra. Sin volver a fijarlo, el panel deja de encontrarse por la vía
        // fiable (los fijados) y pasa a depender del barrido de 100 mensajes,
        // que es justo lo que acaba duplicándolo en un canal con movimiento.
        const estabaFijado = msg.pinned === true;

        await msg.delete().catch(e => console.warn(`[${tag}] Could not delete old panel:`, e.message));
        const nuevo = await channel.send(payload(container, banner));

        if (estabaFijado) {
            await nuevo.pin().catch(e => console.warn(`[${tag}] No se pudo volver a fijar el panel recreado:`, e.message));
        }
        return nuevo;
    }
}

module.exports = {
    pickBanner,
    tarjeta,
    tarjetaPayload,
    payload,
    editPayload,
    rawComponents,
    fetchPinnedMessages,
    collectButtons,
    panelText,
    mediaName,
    signature,
    isUpToDate,
    editOrRecreate,
};
