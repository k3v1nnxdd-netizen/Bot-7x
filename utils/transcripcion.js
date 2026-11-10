'use strict';

const crypto = require('crypto');
const { EmbedBuilder, AttachmentBuilder, AuditLogEvent } = require('discord.js');
const config = require('../config');
const tickets = require('./tickets');
const logCanales = require('./logCanales');
const { ui } = require('./uiIconos');

// ── Transcripciones de tickets ───────────────────────────────────────────────
//
// Antes de borrar un ticket se guarda una copia COMPLETA en HTML, con el
// aspecto de Discord, en el canal de registro "transcripciones" (y, si está
// activado, por MD a quien lo abrió). Es la prueba ante una disputa o un
// contracargo: quién dijo qué, cuándo, y los comprobantes de pago.
//
// Por qué las imágenes van INCRUSTADAS (base64) y no enlazadas: los enlaces del
// CDN de Discord caducan (van firmados) y mueren cuando se borra el canal. Una
// transcripción con los comprobantes como enlaces rotos no prueba nada. Se
// incrustan las de los usuarios primero, hasta el presupuesto de config; lo que
// no quepa queda como enlace con su nombre y tamaño.
//
// Cada transcripción lleva su huella SHA-256 en el registro: si alguien la
// modifica después, la huella deja de coincidir.
//
// Puntos de cierre: botón "Cerrar ticket", cierre automático tras el pago o
// /close, y cierre por inactividad llaman a guardar() ANTES de borrar el canal.
// Si alguien borra el canal a mano desde Discord, alBorrarCanal() guarda lo que
// el bot tenía en memoria, marcado como parcial.

const T = () => config.TRANSCRIPCIONES;
const hechas = new Set();   // canales ya transcritos (no duplicar)

// ── Recopilar ────────────────────────────────────────────────────────────────

async function recopilar(channel) {
    const todos = [];
    let antes;
    while (todos.length < T().MAX_MENSAJES) {
        const lote = await channel.messages.fetch({ limit: 100, ...(antes ? { before: antes } : {}) });
        if (!lote.size) break;
        todos.push(...lote.values());
        antes = lote.last().id;
        if (lote.size < 100) break;
    }
    return todos.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

// Descarga las imágenes adjuntas dentro del presupuesto. Prioriza las de
// personas (comprobantes) sobre las del bot (banners, que pesan mucho y se
// pueden volver a generar). Devuelve Map<url, dataURI>.
async function incrustarImagenes(mensajes) {
    const cand = [];
    for (const m of mensajes) {
        for (const a of m.attachments?.values?.() ?? []) {
            if (!String(a.contentType ?? '').startsWith('image/')) continue;
            if (a.size > T().MAX_IMAGEN_BYTES) continue;
            cand.push({ a, bot: Boolean(m.author?.bot) });
        }
    }
    cand.sort((x, y) => Number(x.bot) - Number(y.bot));

    const out = new Map();
    let total = 0;
    for (const { a } of cand) {
        if (total + a.size > T().MAX_TOTAL_IMAGENES) continue;
        try {
            const r = await fetch(a.url, { signal: AbortSignal.timeout(10_000) });
            if (!r.ok) continue;
            const buf = Buffer.from(await r.arrayBuffer());
            if (total + buf.length > T().MAX_TOTAL_IMAGENES) continue;
            total += buf.length;
            out.set(a.url, `data:${a.contentType};base64,${buf.toString('base64')}`);
        } catch { /* queda como enlace */ }
    }
    return out;
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fechaLarga = ms => new Date(ms).toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City', dateStyle: 'medium', timeStyle: 'medium',
});

// Markdown de Discord, lo suficiente para que se lea igual: bloques de código,
// código, negrita, cursiva, subrayado, tachado, encabezados, citas, subtexto,
// enlaces, menciones, emojis y marcas de tiempo. Todo se escapa ANTES de
// reconstruir el formato: el contenido de un usuario nunca se interpreta como
// HTML.
function markdown(texto, ctx = {}) {
    if (!texto) return '';
    const bloques = [];
    let s = String(texto).replace(/```(?:[a-z0-9+-]*\n)?([\s\S]*?)```/gi, (_, c) => {
        bloques.push(`<pre>${esc(c)}</pre>`);
        return `\u0000${bloques.length - 1}\u0000`;
    });
    const codigos = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => { codigos.push(`<code>${esc(c)}</code>`); return `\u0001${codigos.length - 1}\u0001`; });

    s = esc(s);

    s = s.replace(/&lt;(a?):(\w+):(\d+)&gt;/g, (_, a, n, id) =>
        `<img class="emoji" alt=":${n}:" title=":${n}:" src="https://cdn.discordapp.com/emojis/${id}.${a ? 'gif' : 'webp'}?size=48">`);
    s = s.replace(/&lt;@!?(\d+)&gt;/g, (_, id) => `<span class="mention">@${esc(ctx.usuarios?.get(id) ?? id)}</span>`);
    s = s.replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => `<span class="mention">@${esc(ctx.roles?.get(id) ?? 'rol')}</span>`);
    s = s.replace(/&lt;#(\d+)&gt;/g, (_, id) => `<span class="mention">#${esc(ctx.canales?.get(id) ?? 'canal')}</span>`);
    s = s.replace(/&lt;t:(\d+)(?::[a-zA-Z])?&gt;/g, (_, t) => `<span class="ts">${esc(fechaLarga(Number(t) * 1000))}</span>`);

    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');

    s = s.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([\s\S]+?)__/g, '<u>$1</u>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([\s\S]+?)~~/g, '<s>$1</s>');

    s = s.split('\n').map(l => {
        let m;
        if ((m = l.match(/^(#{1,3}) (.+)$/))) return `<span class="h${m[1].length}">${m[2]}</span>`;
        if ((m = l.match(/^-# (.+)$/))) return `<span class="sub">${m[1]}</span>`;
        if ((m = l.match(/^&gt; ?(.*)$/))) return `<span class="quote">${m[1] || '&nbsp;'}</span>`;
        return l;
    }).join('<br>');

    s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => codigos[i]);
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => bloques[i]);
    return s;
}

const color = n => (n ? `#${Number(n).toString(16).padStart(6, '0')}` : '#4f545c');

function htmlEmbed(e, ctx) {
    const d = e.data ?? e;
    const partes = [];
    if (d.author?.name) partes.push(`<div class="e-author">${esc(d.author.name)}</div>`);
    if (d.title) partes.push(`<div class="e-title">${d.url ? `<a href="${esc(d.url)}">${markdown(d.title, ctx)}</a>` : markdown(d.title, ctx)}</div>`);
    if (d.description) partes.push(`<div class="e-desc">${markdown(d.description, ctx)}</div>`);
    if (d.fields?.length) {
        partes.push(`<div class="e-fields">${d.fields.map(f =>
            `<div class="e-field${f.inline ? ' inline' : ''}"><div class="e-fname">${markdown(f.name, ctx)}</div><div>${markdown(f.value, ctx)}</div></div>`).join('')}</div>`);
    }
    const img = d.image?.url ?? d.thumbnail?.url;
    if (img) partes.push(`<img class="e-img" src="${esc(img)}" loading="lazy">`);
    if (d.footer?.text) partes.push(`<div class="e-footer">${esc(d.footer.text)}</div>`);
    return `<div class="embed" style="border-color:${color(d.color)}">${partes.join('')}</div>`;
}

// Components V2 (las tarjetas de utils/panelV2.js) y botones: se recorren
// como JSON. Texto → markdown; galerías/miniaturas → imagen; botones → píldora.
function htmlComponentes(componentes, ctx) {
    const out = [];
    const walk = c => {
        const j = c?.toJSON ? c.toJSON() : c;
        if (!j) return;
        switch (j.type) {
            case 10: out.push(`<div class="v2-text">${markdown(j.content, ctx)}</div>`); break;
            case 12: for (const it of j.items ?? []) if (it.media?.url) out.push(`<img class="e-img" src="${esc(it.media.url)}" loading="lazy">`); break;
            case 2: out.push(`<span class="btn">${esc(j.emoji?.name && !j.emoji.id ? `${j.emoji.name} ` : '')}${esc(j.label ?? '')}</span>`); break;
            case 3: out.push(`<span class="btn">▾ ${esc(j.placeholder ?? 'Menú')}</span>`); break;
            case 14: out.push('<hr class="sep">'); break;
            default: break;
        }
        for (const h of j.components ?? []) walk(h);
        if (j.accessory) walk(j.accessory);
    };
    componentes.forEach(walk);
    return out.length ? `<div class="v2">${out.join('')}</div>` : '';
}

const kb = n => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

function htmlMensaje(m, ctx, imagenes) {
    const autor = m.author;
    const nombre = autor ? (ctx.usuarios?.get(autor.id) ?? autor.username) : 'Desconocido';
    const avatar = autor?.displayAvatarURL?.({ size: 64 }) ?? '';
    const adjuntos = [...(m.attachments?.values?.() ?? [])].map(a => {
        const data = imagenes.get(a.url);
        return data
            ? `<a class="att-img" href="${data}" download="${esc(a.name)}"><img src="${data}" alt="${esc(a.name)}"></a>`
            : `<div class="att">📎 <a href="${esc(a.url)}">${esc(a.name)}</a> · ${kb(a.size)}${String(a.contentType ?? '').startsWith('image/') ? ' <span class="sub">(no incrustada)</span>' : ''}</div>`;
    }).join('');
    const respuesta = m.reference?.messageId ? `<div class="reply">↪ respuesta a un mensaje</div>` : '';
    const editado = m.editedTimestamp ? ` <span class="sub">(editado ${esc(fechaLarga(m.editedTimestamp))})</span>` : '';

    return `<div class="msg" id="m${m.id}">
<img class="avatar" src="${esc(avatar)}" loading="lazy">
<div class="body">${respuesta}
<div class="head"><span class="name">${esc(nombre)}</span>${autor?.bot ? '<span class="bot">BOT</span>' : ''}<span class="time">${esc(fechaLarga(m.createdTimestamp))}</span>${editado}</div>
<div class="content">${markdown(m.content, ctx)}</div>
${(m.embeds ?? []).map(e => htmlEmbed(e, ctx)).join('')}
${htmlComponentes(m.components ?? [], ctx)}
${adjuntos}
${m.stickers?.size ? `<div class="sub">Sticker: ${esc(m.stickers.map(s => s.name).join(', '))}</div>` : ''}
</div></div>`;
}

function construirHtml({ meta, mensajes, ctx, imagenes }) {
    const filas = Object.entries(meta.filas).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
    return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Transcripción · #${esc(meta.canal)}</title>
<style>
:root{--bg:#313338;--bg2:#2b2d31;--tx:#dbdee1;--mut:#949ba4;--link:#00a8fc;--men:rgba(88,101,242,.3)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.4 "gg sans","Noto Sans",Helvetica,Arial,sans-serif}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--bg2);padding:20px 24px;border-bottom:1px solid #1e1f22}
header h1{margin:0 0 4px;font-size:20px}header p{margin:0;color:var(--mut)}
table.meta{margin-top:14px;border-collapse:collapse;font-size:13px}table.meta th{text-align:left;color:var(--mut);font-weight:600;padding:3px 16px 3px 0;vertical-align:top}table.meta td{padding:3px 0;white-space:pre-wrap}
.parcial{margin-top:12px;padding:8px 12px;background:#5c3b0b;border-radius:6px;color:#fcd34d}
main{padding:8px 0 40px}.msg{display:flex;gap:16px;padding:6px 24px}.msg:hover{background:#2e3035}
.avatar{width:40px;height:40px;border-radius:50%;flex:none;background:#1e1f22}.body{min-width:0;flex:1}
.head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.name{font-weight:600;color:#f2f3f5}.time{font-size:12px;color:var(--mut)}
.bot{background:#5865f2;color:#fff;font-size:10px;font-weight:700;padding:1px 4px;border-radius:3px}
.content{white-space:normal;overflow-wrap:anywhere}.reply{font-size:13px;color:var(--mut)}
code{background:#1e1f22;padding:1px 4px;border-radius:4px;font-size:13px}pre{background:#1e1f22;padding:8px;border-radius:4px;white-space:pre-wrap;overflow-wrap:anywhere}
.mention{background:var(--men);color:#c9cdfb;padding:0 2px;border-radius:3px}.ts{background:#3f4147;padding:0 3px;border-radius:3px}
.quote{display:block;border-left:4px solid #4e5058;padding-left:10px}.sub{font-size:12px;color:var(--mut)}
.h1{font-size:22px;font-weight:700}.h2{font-size:19px;font-weight:700}.h3{font-size:16px;font-weight:700}
.emoji{width:22px;height:22px;vertical-align:-5px}
.embed,.v2{margin-top:6px;max-width:520px;background:var(--bg2);border-left:4px solid #4f545c;border-radius:4px;padding:10px 14px}
.v2{border-left-color:#5865f2}.v2-text{margin:4px 0}.sep{border:0;border-top:1px solid #3f4147;margin:8px 0}
.e-author{font-size:13px;font-weight:600}.e-title{font-weight:700;margin:2px 0}.e-desc{font-size:14px}
.e-fields{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:8px}.e-field{flex:1 1 100%;font-size:14px}.e-field.inline{flex:1 1 30%}.e-fname{font-weight:700}
.e-img{display:block;max-width:100%;max-height:300px;margin-top:8px;border-radius:4px}.e-footer{margin-top:8px;font-size:12px;color:var(--mut)}
.btn{display:inline-block;margin:6px 6px 0 0;padding:4px 12px;background:#4e5058;border-radius:4px;font-size:13px;color:#fff}
.att{margin-top:6px;padding:8px 10px;background:var(--bg2);border:1px solid #1e1f22;border-radius:6px;display:inline-block}
.att-img img{display:block;margin-top:6px;max-width:400px;max-height:400px;border-radius:6px}
footer{padding:16px 24px;color:var(--mut);font-size:12px;border-top:1px solid #1e1f22}
@media (max-width:600px){.msg{padding:6px 12px;gap:10px}.avatar{width:32px;height:32px}.att-img img{max-width:100%}}
</style></head><body>
<header><h1>🎫 #${esc(meta.canal)}</h1><p>${esc(meta.servidor)} · Transcripción de ticket</p>
<table class="meta">${filas}</table>
${meta.parcial ? `<div class="parcial">⚠️ Transcripción PARCIAL: ${esc(meta.parcial)}</div>` : ''}
</header>
<main>${mensajes.map(m => htmlMensaje(m, ctx, imagenes)).join('\n')}</main>
<footer>Generado por 7x Bot el ${esc(fechaLarga(meta.generado))} · ${mensajes.length} mensajes · Hora del centro de México</footer>
</body></html>`;
}

// Nombres para las menciones: los de los propios mensajes y los del servidor.
function contexto(guild, mensajes) {
    const usuarios = new Map();
    for (const m of mensajes) {
        if (m.author) usuarios.set(m.author.id, m.member?.displayName ?? m.author.globalName ?? m.author.username);
        for (const u of m.mentions?.users?.values?.() ?? []) if (!usuarios.has(u.id)) usuarios.set(u.id, u.globalName ?? u.username);
    }
    for (const mem of guild?.members?.cache?.values?.() ?? []) if (!usuarios.has(mem.id)) usuarios.set(mem.id, mem.displayName);
    const roles = new Map([...(guild?.roles?.cache?.values?.() ?? [])].map(r => [r.id, r.name]));
    const canales = new Map([...(guild?.channels?.cache?.values?.() ?? [])].map(c => [c.id, c.name]));
    return { usuarios, roles, canales };
}

const TIPOS = {
    comprar: 'Compra de Robux', gamepass: 'Compra por gamepass', soporte: 'Soporte', duels: 'Duels',
    seguidores: 'Seguidores', alianza: 'Alianza',
};

// ── Generar y publicar ───────────────────────────────────────────────────────

async function generar(channel, { cerradoPor = null, motivo = '', mensajes = null, parcial = null } = {}) {
    const guild = channel.guild;
    const datos = tickets.getTicketData(channel) ?? {};
    const lista = mensajes ?? await recopilar(channel);
    const ctx = contexto(guild, lista);
    const imagenes = await incrustarImagenes(lista);

    const participantes = new Map();
    for (const m of lista) {
        if (!m.author || m.author.bot) continue;
        participantes.set(m.author.id, (participantes.get(m.author.id) ?? 0) + 1);
    }
    const adjuntos = lista.reduce((n, m) => n + (m.attachments?.size ?? 0), 0);
    const ahora = Date.now();
    const abierto = datos.ts ?? channel.createdTimestamp;
    const nombreDe = id => ctx.usuarios.get(id) ?? id;

    const filas = {
        'Ticket': `#${channel.name} (${channel.id})`,
        'Abierto por': datos.userId ? `${nombreDe(datos.userId)} (${datos.userId})` : 'Desconocido',
        'Tipo': TIPOS[datos.type] ?? datos.type ?? 'Desconocido',
        'Abierto': fechaLarga(abierto),
        'Cerrado': fechaLarga(ahora),
        'Cerrado por': cerradoPor ? `${cerradoPor.tag ?? cerradoPor.username} (${cerradoPor.id})` : 'Sistema',
        'Motivo': motivo || '—',
        'Mensajes': String(lista.length),
        'Participantes': [...participantes].map(([id, n]) => `${nombreDe(id)} (${n})`).join(', ') || '—',
    };
    if (datos.pedido && typeof datos.pedido === 'object') {
        filas['Pedido'] = Object.entries(datos.pedido).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
    }

    const html = construirHtml({
        meta: { canal: channel.name, servidor: guild?.name ?? '', filas, parcial, generado: ahora },
        mensajes: lista, ctx, imagenes,
    });
    const buffer = Buffer.from(html, 'utf8');
    const huella = crypto.createHash('sha256').update(buffer).digest('hex');

    return { buffer, huella, datos, lista, participantes, adjuntos, imagenes, abierto, ahora, filas };
}

function embedResumen(channel, r, { cerradoPor, motivo, parcial }) {
    const s = x => Math.floor(x / 1000);
    const duracionMin = Math.max(1, Math.round((r.ahora - r.abierto) / 60_000));
    const duracion = duracionMin >= 1440 ? `${(duracionMin / 1440).toFixed(1)} días`
        : duracionMin >= 60 ? `${(duracionMin / 60).toFixed(1)} h` : `${duracionMin} min`;

    const e = new EmbedBuilder()
        .setColor(parcial ? 0xF59E0B : 0x5865F2)
        .setTitle(`${ui('ticket')} Ticket cerrado · #${channel.name}`)
        .addFields(
            { name: 'Abierto por', value: r.datos.userId ? `<@${r.datos.userId}>\n\`${r.datos.userId}\`` : 'Desconocido', inline: true },
            { name: 'Tipo', value: TIPOS[r.datos.type] ?? r.datos.type ?? 'Desconocido', inline: true },
            { name: 'Cerrado por', value: cerradoPor ? `<@${cerradoPor.id}>` : 'Sistema', inline: true },
            { name: 'Abierto', value: `<t:${s(r.abierto)}:f>`, inline: true },
            { name: 'Duración', value: duracion, inline: true },
            { name: 'Mensajes', value: `${r.lista.length} · ${r.adjuntos} archivo(s)`, inline: true },
            { name: 'Participantes', value: [...r.participantes].slice(0, 10).map(([id, n]) => `<@${id}> · ${n}`).join('\n') || '—' },
            { name: 'Motivo', value: motivo || '—' },
        )
        .setFooter({ text: `SHA-256 ${r.huella.slice(0, 32)}… · ${r.imagenes.size} imagen(es) incrustada(s)` })
        .setTimestamp(r.ahora);
    if (r.filas.Pedido) e.addFields({ name: 'Pedido', value: `\`\`\`${r.filas.Pedido.slice(0, 990)}\`\`\`` });
    if (parcial) e.setDescription(`${ui('alerta')} **Transcripción parcial:** ${parcial}`);
    return e;
}

// Genera la transcripción y la publica. Nunca lanza: un fallo aquí no puede
// impedir que el ticket se cierre (se registra y se sigue).
async function guardar(channel, opciones = {}) {
    if (!channel?.guild || hechas.has(channel.id)) return false;
    hechas.add(channel.id);
    try {
        const r = await generar(channel, opciones);
        const nombre = `transcripcion-${channel.name}-${channel.id}.html`;
        const embed = embedResumen(channel, r, opciones);

        const msg = await logCanales.enviar(channel.guild, 'transcripciones', {
            embeds: [embed],
            files: [new AttachmentBuilder(r.buffer, { name: nombre })],
            allowedMentions: { parse: [] },
        });

        if (T().ENVIAR_AL_CLIENTE && r.datos.userId && !opciones.parcial) {
            const user = await channel.client.users.fetch(r.datos.userId).catch(() => null);
            await user?.send({
                embeds: [new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle(`${ui('ticket')} Copia de tu ticket #${channel.name}`)
                    .setDescription('Tu ticket se cerró. Aquí tienes la conversación completa para tus registros: descarga el archivo y ábrelo en tu navegador.')
                    .setFooter({ text: '7x Community · Tickets' })
                    .setTimestamp()],
                files: [new AttachmentBuilder(r.buffer, { name: nombre })],
            }).catch(() => { /* MD cerrados */ });
        }
        return Boolean(msg);
    } catch (err) {
        console.error(`[transcripcion] Falló la de #${channel.name}:`, err.message);
        return false;
    } finally {
        if (hechas.size > 1000) hechas.clear();
    }
}

// Alguien borró un ticket a mano: ya no se pueden pedir sus mensajes a
// Discord, pero el objeto del canal borrado conserva la caché del bot.
async function alBorrarCanal(channel) {
    try {
        if (!channel?.guild || hechas.has(channel.id)) return;
        if (!tickets.getTicketData(channel)?.userId) return;

        await new Promise(r => setTimeout(r, 1500));
        const logs = await channel.guild.fetchAuditLogs({ type: AuditLogEvent.ChannelDelete, limit: 5 }).catch(() => null);
        const entry = logs?.entries.find(e => e.target?.id === channel.id);

        const mensajes = [...channel.messages.cache.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        await guardar(channel, {
            cerradoPor: entry?.executor ?? null,
            motivo: 'Canal borrado manualmente desde Discord',
            mensajes,
            parcial: 'el canal se borró a mano, así que sólo incluye los mensajes que el bot tenía en memoria (los posteriores a su último reinicio).',
        });
    } catch (err) {
        console.error('[transcripcion] alBorrarCanal:', err.message);
    }
}

module.exports = { guardar, alBorrarCanal, __test: { markdown, construirHtml, htmlMensaje, esc, contexto } };
