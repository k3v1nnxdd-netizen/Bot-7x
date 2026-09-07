'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { MessageFlags } = require('discord.js');

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

// Nombre de fichero de una URL de media, sin los parámetros de firma que añade
// la CDN de Discord: `.../7xticket-ab12cd34.gif?ex=…` -> `7xticket-ab12cd34.gif`.
function mediaName(url) {
    return typeof url === 'string' ? url.split('?')[0].split('/').pop() : '';
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
        await msg.delete().catch(e => console.warn(`[${tag}] Could not delete old panel:`, e.message));
        return channel.send(payload(container, banner));
    }
}

module.exports = {
    pickBanner,
    payload,
    editPayload,
    rawComponents,
    collectButtons,
    panelText,
    mediaName,
    signature,
    isUpToDate,
    editOrRecreate,
};
