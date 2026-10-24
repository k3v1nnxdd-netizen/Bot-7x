'use strict';

// ── Los iconos del leaderboard de invitaciones ───────────────────────────────
//
// Iconos blancos, planos y modernos, dibujados aquí mismo con geometría (sin
// librerías de imagen, como scripts/barraEmojis.js, de donde se reutilizan el
// escritor de PNG y la subida). Van como emojis de la APLICACIÓN: se ven para
// todo el mundo, con Nitro o sin él.
//
//   node scripts/invIconos.js           -> genera los PNG en assets/invitaciones/
//   node scripts/invIconos.js --subir   -> además los sube e imprime sus ids
//
// Cada icono es una función "¿este punto está dentro?" sobre un lienzo de
// 128×128; el suavizado sale de muestrear 4×4 veces cada píxel.

const fs = require('fs');
const path = require('path');
const { png, subir } = require('./barraEmojis');

const LADO = 128;

// ── Primitivas ───────────────────────────────────────────────────────────────

const circulo = (cx, cy, r) => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const anillo = (cx, cy, r, g) => (x, y) => {
    const d = Math.hypot(x - cx, y - cy);
    return d <= r && d >= r - g;
};
const rect = (x0, y0, x1, y1, r = 0) => (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
// Un trazo recto de grosor 2r con los extremos redondeados.
const trazo = (ax, ay, bx, by, r) => (x, y) => {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= r * r;
};
const linea = (puntos, r) => union(...puntos.slice(1).map((p, i) => trazo(puntos[i][0], puntos[i][1], p[0], p[1], r)));
const poligono = pts => (x, y) => {
    let dentro = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i], [xj, yj] = pts[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
    }
    return dentro;
};
// Puntos de un arco (ángulos en grados, con la y hacia abajo como en pantalla).
const arco = (cx, cy, r, a0, a1, pasos = 24) => Array.from({ length: pasos + 1 }, (_, i) => {
    const a = ((a0 + ((a1 - a0) * i) / pasos) * Math.PI) / 180;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
});
const union = (...fs) => (x, y) => fs.some(f => f(x, y));
const menos = (a, ...b) => (x, y) => a(x, y) && !b.some(f => f(x, y));
const si = (f, cond) => (x, y) => cond(x, y) && f(x, y);

// ── Los iconos ───────────────────────────────────────────────────────────────

const ICONOS = {
    // Corona: el título del top semanal.
    inv_corona: union(
        poligono([[22, 92], [22, 40], [44, 64], [64, 30], [84, 64], [106, 40], [106, 92]]),
        circulo(22, 36, 8), circulo(64, 26, 8), circulo(106, 36, 8),
        rect(22, 98, 106, 110, 5),
    ),

    // Regalo: el premio.
    inv_regalo: union(
        menos(rect(22, 44, 106, 60, 5), rect(58, 0, 70, 128)),
        menos(rect(28, 66, 100, 110, 5), rect(58, 0, 70, 128)),
        anillo(50, 30, 14, 7), anillo(78, 30, 14, 7),
    ),

    // Reloj: cuándo se reinicia.
    inv_reloj: union(
        anillo(64, 64, 50, 11),
        trazo(64, 64, 64, 34, 6),
        trazo(64, 64, 86, 76, 6),
    ),

    // Trofeo: el ganador de la semana pasada.
    inv_trofeo: union(
        union(rect(34, 18, 94, 50), si(circulo(64, 50, 30), (x, y) => y >= 50)),
        si(anillo(34, 42, 18, 8), (x) => x <= 38),
        si(anillo(94, 42, 18, 8), (x) => x >= 90),
        rect(57, 76, 71, 94),
        rect(38, 94, 90, 110, 5),
    ),

    // Reloj de arena: esperando al nuevo ganador.
    inv_arena: union(
        rect(28, 14, 100, 26, 5),
        rect(28, 102, 100, 114, 5),
        linea([[38, 28], [64, 62], [90, 28]], 5),
        linea([[38, 100], [64, 66], [90, 100]], 5),
        poligono([[50, 36], [78, 36], [64, 54]]),
        poligono([[64, 76], [84, 98], [44, 98]]),
    ),

    // Barras: el top de todos los tiempos.
    inv_grafica: union(
        rect(20, 70, 44, 110, 6),
        rect(52, 46, 76, 110, 6),
        rect(84, 18, 108, 110, 6),
    ),

    // Escudo con check: sólo cuentan las invitaciones válidas.
    inv_escudo: menos(
        poligono([[64, 12], [106, 28], [104, 62], [94, 86], [64, 114], [34, 86], [24, 62], [22, 28]]),
        linea([[42, 62], [58, 78], [88, 46]], 7),
    ),

    // Persona con "+": alguien que entra invitado.
    inv_entra: union(
        circulo(50, 40, 20),
        si(circulo(50, 112, 40), (x, y) => y <= 108),
        trazo(100, 46, 100, 82, 6),
        trazo(82, 64, 118, 64, 6),
    ),

    // Puestos 1, 2 y 3.
    inv_1: union(anillo(64, 64, 54, 8), linea([[52, 46], [68, 34], [68, 94]], 7)),
    inv_2: union(anillo(64, 64, 54, 8), linea([...arco(64, 50, 16, 190, 400), [46, 90], [82, 90]], 7)),
    inv_3: union(anillo(64, 64, 54, 8), linea([...arco(63, 47, 13, 200, 450), ...arco(63, 77, 16, 270, 510)], 7)),
};

function dibujar(dentro, fondo = null) {
    const N = 4;
    const px = Buffer.alloc(LADO * LADO * 4);
    for (let y = 0; y < LADO; y++) {
        for (let x = 0; x < LADO; x++) {
            let c = 0;
            for (let sy = 0; sy < N; sy++) {
                for (let sx = 0; sx < N; sx++) if (dentro(x + (sx + 0.5) / N, y + (sy + 0.5) / N)) c++;
            }
            const a = c / (N * N);
            const i = (y * LADO + x) * 4;
            if (fondo) {
                // Para la muestra: blanco sobre el gris de Discord.
                for (let k = 0; k < 3; k++) px[i + k] = Math.round(fondo[k] + (255 - fondo[k]) * a);
                px[i + 3] = 255;
            } else {
                px[i] = px[i + 1] = px[i + 2] = 255;
                px[i + 3] = Math.round(a * 255);
            }
        }
    }
    return px;
}

function generar() {
    const out = {};
    for (const [nombre, f] of Object.entries(ICONOS)) out[nombre] = png(dibujar(f), LADO, LADO);
    return out;
}

// Todos en fila sobre el fondo de las tarjetas de Discord, para revisarlos.
function muestra() {
    const lista = Object.values(ICONOS);
    const ancho = LADO * lista.length;
    const tira = Buffer.alloc(ancho * LADO * 4);
    lista.forEach((f, k) => {
        const px = dibujar(f, [43, 45, 49]);
        for (let y = 0; y < LADO; y++) px.copy(tira, (y * ancho + k * LADO) * 4, y * LADO * 4, (y + 1) * LADO * 4);
    });
    return png(tira, ancho, LADO);
}

module.exports = { generar, muestra, ICONOS };

if (require.main === module) {
    (async () => {
        const dir = path.join(__dirname, '..', 'assets', 'invitaciones');
        fs.mkdirSync(dir, { recursive: true });
        const pngs = generar();
        for (const [nombre, buf] of Object.entries(pngs)) fs.writeFileSync(path.join(dir, `${nombre}.png`), buf);
        fs.writeFileSync(path.join(dir, 'muestra.png'), muestra());
        console.log(`Generados ${Object.keys(pngs).length} iconos en assets/invitaciones/`);

        if (process.argv.includes('--subir')) {
            const ids = await subir(pngs);
            console.log('\nPara config.js:');
            console.log(JSON.stringify(ids, null, 2));
        }
    })().catch(err => { console.error(err); process.exit(1); });
}
