'use strict';

// ── Las piezas de la barra de progreso ────────────────────────────────────────
//
// La barra de fidelidad se arma con emojis: una pieza de inicio, las del medio
// y una de fin, cada una llena (azul) o vacía. Van como emojis de la
// APLICACIÓN, no del servidor: así se ven para todo el mundo —con Nitro o sin
// él— y no gastan los huecos de emojis del servidor.
//
// Este script las DIBUJA. No usa ninguna librería de imagen (el proyecto no
// tiene ninguna, y añadir una nativa sólo para esto es mucho): escribe los PNG
// a mano, con zlib, que viene con Node.
//
//   node scripts/barraEmojis.js           -> genera los PNG en assets/barra/
//   node scripts/barraEmojis.js --subir   -> además los sube como emojis de la
//                                            aplicación e imprime sus ids
//
// Cada pieza es de 128×128 y la barra va centrada en vertical. Las del medio
// llegan a los dos bordes para que, puestas en fila, el trazo blanco quede
// continuo; las de inicio y fin redondean su extremo.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const LADO = 128;
const CY = 64;

// Capas, de fuera a dentro. Todas comparten el centro de los extremos
// redondeados, así que el redondeo es concéntrico y el trazo tiene el mismo
// grosor en todo el contorno.
const R_SOMBRA = 33;   // borde oscuro finísimo: da contorno en el tema claro
const R_TRAZO  = 31;   // la línea blanca
const R_DENTRO = 22;   // el relleno

const MARGEN = 4;      // aire en el extremo de las piezas de inicio y fin

const BLANCO = [255, 255, 255, 255];
const SOMBRA = [0, 0, 0, 90];
const VACIO  = [24, 25, 28, 255];          // el carril vacío, un poco más oscuro que el fondo
const AZUL_ARRIBA = [96, 165, 250];         // #60A5FA
const AZUL_ABAJO  = [37, 99, 235];          // #2563EB

// Una cápsula horizontal: un rectángulo con los extremos redondeados. Un
// extremo "abierto" (en las piezas del medio) se manda fuera del lienzo.
function dentro(x, y, izq, der, r) {
    const dy = y - CY;
    if (Math.abs(dy) > r) return false;
    const cxI = izq + r, cxD = der - r;
    if (x >= cxI && x <= cxD) return true;
    const cx = x < cxI ? cxI : cxD;
    return (x - cx) ** 2 + dy ** 2 <= r * r;
}

function colorEn(x, y, tipo, lleno) {
    const abreIzq = tipo !== 'ini';
    const abreDer = tipo !== 'fin';
    // Los centros de los extremos son los mismos para todas las capas.
    const izqS = abreIzq ? -1e4 : MARGEN;
    const derS = abreDer ? 1e4 : LADO - MARGEN;
    const desplazar = (borde, r, lado) => (borde === -1e4 || borde === 1e4 ? borde : borde + lado * (R_SOMBRA - r));

    const capa = r => dentro(x, y, desplazar(izqS, r, 1), desplazar(derS, r, -1), r);

    if (capa(R_DENTRO)) {
        if (!lleno) return VACIO;
        const t = (y - (CY - R_DENTRO)) / (2 * R_DENTRO);
        return [
            Math.round(AZUL_ARRIBA[0] + (AZUL_ABAJO[0] - AZUL_ARRIBA[0]) * t),
            Math.round(AZUL_ARRIBA[1] + (AZUL_ABAJO[1] - AZUL_ARRIBA[1]) * t),
            Math.round(AZUL_ARRIBA[2] + (AZUL_ABAJO[2] - AZUL_ARRIBA[2]) * t),
            255,
        ];
    }
    if (capa(R_TRAZO)) return BLANCO;
    if (capa(R_SOMBRA)) return SOMBRA;
    return [0, 0, 0, 0];
}

// Suavizado: cada píxel es la media de 4×4 muestras. Sin esto los extremos
// redondeados salen dentados al verse a 22 px en el chat.
function dibujar(tipo, lleno) {
    const N = 4;
    const px = Buffer.alloc(LADO * LADO * 4);
    for (let y = 0; y < LADO; y++) {
        for (let x = 0; x < LADO; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let sy = 0; sy < N; sy++) {
                for (let sx = 0; sx < N; sx++) {
                    const c = colorEn(x + (sx + 0.5) / N, y + (sy + 0.5) / N, tipo, lleno);
                    // Media premultiplicada: si no, los bordes transparentes
                    // oscurecen el color de al lado.
                    r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3];
                }
            }
            const i = (y * LADO + x) * 4;
            const muestras = N * N;
            px[i + 3] = Math.round(a / muestras);
            if (a > 0) {
                px[i]     = Math.round(r / a);
                px[i + 1] = Math.round(g / a);
                px[i + 2] = Math.round(b / a);
            }
        }
    }
    return px;
}

// ── PNG a mano ───────────────────────────────────────────────────────────────

const TABLA_CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = TABLA_CRC[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function trozo(tipo, datos) {
    const largo = Buffer.alloc(4);
    largo.writeUInt32BE(datos.length);
    const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(cuerpo));
    return Buffer.concat([largo, cuerpo, crc]);
}

function png(rgba, ancho, alto) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(ancho, 0);
    ihdr.writeUInt32BE(alto, 4);
    ihdr[8] = 8;    // 8 bits por canal
    ihdr[9] = 6;    // RGBA
    // compresión, filtro y entrelazado: 0

    // Cada fila empieza con su byte de filtro (0 = ninguno).
    const filas = Buffer.alloc((ancho * 4 + 1) * alto);
    for (let y = 0; y < alto; y++) {
        rgba.copy(filas, y * (ancho * 4 + 1) + 1, y * ancho * 4, (y + 1) * ancho * 4);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        trozo('IHDR', ihdr),
        trozo('IDAT', zlib.deflateSync(filas, { level: 9 })),
        trozo('IEND', Buffer.alloc(0)),
    ]);
}

// ── Las seis piezas ──────────────────────────────────────────────────────────

const PIEZAS = [];
for (const tipo of ['ini', 'med', 'fin']) {
    for (const lleno of [true, false]) {
        PIEZAS.push({ nombre: `barra7x_${tipo}_${lleno ? 'on' : 'off'}`, tipo, lleno });
    }
}

function generar() {
    const salida = {};
    for (const p of PIEZAS) salida[p.nombre] = png(dibujar(p.tipo, p.lleno), LADO, LADO);
    return salida;
}

// Una tira de muestra, para ver la barra entera antes de subir nada.
function muestra(hechas, total = 5) {
    const piezas = [];
    for (let i = 0; i < total; i++) {
        const tipo = i === 0 ? 'ini' : i === total - 1 ? 'fin' : 'med';
        piezas.push(dibujar(tipo, i < hechas));
    }
    const ancho = LADO * total;
    const tira = Buffer.alloc(ancho * LADO * 4);
    piezas.forEach((px, k) => {
        for (let y = 0; y < LADO; y++) px.copy(tira, (y * ancho + k * LADO) * 4, y * LADO * 4, (y + 1) * LADO * 4);
    });
    return png(tira, ancho, LADO);
}

async function subir(pngs) {
    require('dotenv').config();
    const token = process.env.TOKEN;
    if (!token) throw new Error('Falta TOKEN en .env');
    const H = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };

    const app = await (await fetch('https://discord.com/api/v10/applications/@me', { headers: H })).json();
    const existentes = (await (await fetch(`https://discord.com/api/v10/applications/${app.id}/emojis`, { headers: H })).json()).items ?? [];

    const ids = {};
    for (const [nombre, buf] of Object.entries(pngs)) {
        const ya = existentes.find(e => e.name === nombre);
        if (ya) { ids[nombre] = ya.id; console.log(`  ${nombre}: ya existía (${ya.id})`); continue; }

        const r = await fetch(`https://discord.com/api/v10/applications/${app.id}/emojis`, {
            method: 'POST', headers: H,
            body: JSON.stringify({ name: nombre, image: `data:image/png;base64,${buf.toString('base64')}` }),
        });
        const e = await r.json();
        if (!r.ok) throw new Error(`${nombre}: ${r.status} ${JSON.stringify(e)}`);
        ids[nombre] = e.id;
        console.log(`  ${nombre}: subido (${e.id})`);
    }
    return ids;
}

module.exports = { generar, muestra, PIEZAS, png, subir };

if (require.main === module) {
    (async () => {
        const dir = path.join(__dirname, '..', 'assets', 'barra');
        fs.mkdirSync(dir, { recursive: true });
        const pngs = generar();
        for (const [nombre, buf] of Object.entries(pngs)) fs.writeFileSync(path.join(dir, `${nombre}.png`), buf);
        fs.writeFileSync(path.join(dir, 'muestra-3de5.png'), muestra(3));
        console.log(`Generadas ${Object.keys(pngs).length} piezas en assets/barra/`);

        if (process.argv.includes('--subir')) {
            const ids = await subir(pngs);
            console.log('\nPara config.js:');
            console.log(JSON.stringify(ids, null, 2));
        }
    })().catch(err => { console.error(err); process.exit(1); });
}
