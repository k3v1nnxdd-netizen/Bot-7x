'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { DATA_DIR } = require('./dataDir');

// ── Archivo de registros en disco ────────────────────────────────────────────
//
// TODO lo que se publica en los canales de registro (mensajes, transcripciones,
// seguridad) se guarda también aquí, en DATA_DIR/archivo/ — el Volume de
// Railway, que sobrevive a los redeploys y que nadie puede borrar desde
// Discord. Es lo que hace que borrar un canal de registro, o un mensaje suelto,
// no pierda nada: utils/proteccion.js lo vuelve a publicar desde aquí.
//
// Formato, por tipo de registro:
//   <tipo>.jsonl          una línea por registro: { id, ts, msgId, content, embeds, archivos }
//   <tipo>/<id>-<nombre>.gz   los archivos adjuntos, comprimidos
// Las líneas `{ alias, de }` apuntan un mensaje re-publicado a su registro
// original: si lo vuelven a borrar, se vuelve a restaurar.

const DIR = path.join(DATA_DIR, 'archivo');
const MAX_ARCHIVO_BYTES = 25 * 1024 * 1024;     // por adjunto
const ROTAR_JSONL_BYTES = 50 * 1024 * 1024;     // <tipo>.jsonl → <tipo>.1.jsonl

function asegurarDir(sub = '') {
    const d = path.join(DIR, sub);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    return d;
}

const jsonl = (tipo, n = 0) => path.join(DIR, n ? `${tipo}.${n}.jsonl` : `${tipo}.jsonl`);
const seguro = n => String(n ?? 'archivo').replace(/[^\w.-]+/g, '_').slice(0, 120);

// Se conservan el actual y 3 rotaciones (unos 200 MB de texto como mucho).
function rotarSiHaceFalta(tipo) {
    const f = jsonl(tipo);
    if (!fs.existsSync(f) || fs.statSync(f).size < ROTAR_JSONL_BYTES) return;
    if (fs.existsSync(jsonl(tipo, 3))) fs.unlinkSync(jsonl(tipo, 3));
    for (const n of [2, 1]) if (fs.existsSync(jsonl(tipo, n))) fs.renameSync(jsonl(tipo, n), jsonl(tipo, n + 1));
    fs.renameSync(f, jsonl(tipo, 1));
}

function datosDeArchivo(a) {
    // AttachmentBuilder (lo que manda el bot) o { attachment, name }.
    const datos = a?.attachment ?? a?.data?.attachment;
    const nombre = a?.name ?? a?.data?.name ?? 'archivo';
    return Buffer.isBuffer(datos) ? { buf: datos, nombre } : null;
}

// Guarda un registro. Nunca lanza: un fallo de disco no puede romper el
// registro en Discord (que ya se publicó).
function registrar(tipo, payload, msgId = null) {
    try {
        asegurarDir(tipo);
        rotarSiHaceFalta(tipo);
        const id = crypto.randomBytes(6).toString('hex');
        const archivos = [];
        for (const a of payload.files ?? []) {
            const d = datosDeArchivo(a);
            if (!d || d.buf.length > MAX_ARCHIVO_BYTES) continue;
            const fichero = `${id}-${seguro(d.nombre)}.gz`;
            fs.writeFileSync(path.join(DIR, tipo, fichero), zlib.gzipSync(d.buf));
            archivos.push({ nombre: d.nombre, fichero });
        }
        const linea = {
            id, ts: Date.now(), msgId,
            content: payload.content ?? null,
            embeds: (payload.embeds ?? []).map(e => (e?.toJSON ? e.toJSON() : e)),
            archivos,
        };
        fs.appendFileSync(jsonl(tipo), JSON.stringify(linea) + '\n');
        indice?.set(msgId, { tipo, id });
        return id;
    } catch (err) {
        console.error(`[archivo] No se pudo archivar un registro de ${tipo}:`, err.message);
        return null;
    }
}

// Todas las entradas de un tipo, de la más antigua a la más reciente.
function entradas(tipo) {
    const out = [];
    for (const n of [3, 2, 1, 0]) {
        const f = jsonl(tipo, n);
        if (!fs.existsSync(f)) continue;
        for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
            if (!l) continue;
            try { const e = JSON.parse(l); if (e.id) out.push(e); } catch { /* línea corrupta */ }
        }
    }
    return out;
}

// msgId de Discord → { tipo, id } (incluye los alias de re-publicaciones).
let indice = null;
function cargarIndice(tipos) {
    indice = new Map();
    for (const tipo of tipos) {
        for (const n of [3, 2, 1, 0]) {
            const f = jsonl(tipo, n);
            if (!fs.existsSync(f)) continue;
            for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
                if (!l) continue;
                try {
                    const e = JSON.parse(l);
                    if (e.id && e.msgId) indice.set(e.msgId, { tipo, id: e.id });
                    else if (e.alias) indice.set(e.alias, { tipo, id: e.de });
                } catch { /* línea corrupta */ }
            }
        }
    }
    return indice;
}

function porMensaje(msgId, tipos) {
    if (!indice) cargarIndice(tipos);
    const ref = indice.get(msgId);
    if (!ref) return null;
    const e = entradas(ref.tipo).find(x => x.id === ref.id);
    return e ? { tipo: ref.tipo, entrada: e } : null;
}

function alias(tipo, nuevoMsgId, entradaId) {
    try {
        fs.appendFileSync(jsonl(tipo), JSON.stringify({ alias: nuevoMsgId, de: entradaId }) + '\n');
        indice?.set(nuevoMsgId, { tipo, id: entradaId });
    } catch (err) {
        console.error('[archivo] alias:', err.message);
    }
}

// El payload para volver a publicar una entrada, con una nota de restauración.
function payloadDe(tipo, e, nota) {
    const embeds = e.embeds.slice(0, 10).map((j, i) => {
        const em = new EmbedBuilder(j);
        if (i === 0 && nota) {
            const pie = j.footer?.text ? `${j.footer.text} · ` : '';
            em.setFooter({ text: `${pie}♻️ ${nota}`.slice(0, 2048) });
        }
        return em;
    });
    const files = [];
    for (const a of e.archivos ?? []) {
        try { files.push(new AttachmentBuilder(zlib.gunzipSync(fs.readFileSync(path.join(DIR, tipo, a.fichero))), { name: a.nombre })); }
        catch { /* archivo perdido */ }
    }
    return { content: e.content ?? undefined, embeds, files, allowedMentions: { parse: [] } };
}

// Resumen en texto de muchas entradas (para no re-publicar miles de mensajes).
function resumenTexto(lista) {
    return lista.map(e => {
        const em = e.embeds[0] ?? {};
        const titulo = String(em.title ?? '').replace(/<a?:\w+:\d+>/g, '').trim();
        const campos = (em.fields ?? []).map(f => `${f.name.replace(/<a?:\w+:\d+>/g, '').trim()}: ${String(f.value).replace(/\s+/g, ' ')}`).join(' | ');
        return `[${new Date(e.ts).toISOString()}] ${titulo}${em.description ? ` — ${String(em.description).replace(/\s+/g, ' ')}` : ''}${campos ? ` — ${campos}` : ''}`;
    }).join('\n');
}

module.exports = {
    registrar, entradas, porMensaje, alias, payloadDe, resumenTexto, cargarIndice, DIR,
    __test: { reset: () => { indice = null; } },
};
