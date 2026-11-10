'use strict';

// ── Los emojis del notificador de Roblox ─────────────────────────────────────
//
// Insignias de color con un glifo blanco encima (el estilo del "ID" morado de
// los notificadores de catálogo), dibujadas con la misma geometría que
// scripts/invIconos.js y subidas como emojis de la APLICACIÓN: se ven en
// cualquier servidor, con Nitro o sin él.
//
//   node scripts/notifierIconos.js           -> genera los PNG en assets/notifier/
//   node scripts/notifierIconos.js --subir   -> además los sube e imprime sus ids
//
// Los ids que imprime van a config.ROBLOX_NOTIFIER.ICONOS. Si falta alguno, el
// notificador usa un emoji unicode en su lugar (utils/robloxNotifierEmbeds.js).

const fs = require('fs');
const path = require('path');
const { png, subir } = require('./barraEmojis');
const { primitivas: P } = require('./invIconos');
const { circulo, anillo, rect, trazo, linea, poligono, arco, union, menos, si } = P;

const LADO = 128;
const fondo = rect(4, 4, 124, 124, 26);

// Colores de cada insignia (r, g, b).
const AZUL = [59, 130, 246], DORADO = [234, 170, 8], VERDE = [34, 197, 94],
    MORADO = [139, 92, 246], ROJO = [239, 68, 68], GRIS = [100, 116, 139],
    CIAN = [6, 182, 212], NARANJA = [249, 115, 22], ROSA = [236, 72, 153];

// Una letra "D" (trazo vertical + medio arco), centrada en x.
const letraD = (x0, y0, y1, g) => union(
    trazo(x0, y0, x0, y1, g),
    linea([[x0, y0], [x0 + 10, y0], ...arco(x0 + 10, (y0 + y1) / 2, (y1 - y0) / 2, -90, 90), [x0, y1]], g),
);

const ICONOS = {
    // Destello: item nuevo.
    rn_nuevo: [AZUL, union(
        poligono([[64, 22], [72, 56], [106, 64], [72, 72], [64, 106], [56, 72], [22, 64], [56, 56]]),
        poligono([[96, 22], [99, 33], [110, 36], [99, 39], [96, 50], [93, 39], [82, 36], [93, 33]]),
    )],

    // "L": Limited.
    rn_limited: [DORADO, linea([[46, 30], [46, 98], [86, 98]], 9)],

    // "U": Limited U (unique, stock fijo).
    rn_limitedu: [NARANJA, linea([[40, 30], [40, 70], ...arco(64, 70, 24, 180, 0, 20), [88, 30]], 9)],

    // Etiqueta: ya a la venta.
    rn_venta: [VERDE, menos(
        poligono([[30, 30], [70, 30], [104, 64], [70, 98], [30, 98]]),
        circulo(46, 64, 9),
    )],

    // Flechas en círculo: actualizado / cambio de precio.
    rn_update: [MORADO, union(
        linea(arco(64, 64, 32, 200, 340, 20), 7),
        linea(arco(64, 64, 32, 20, 160, 20), 7),
        poligono([[100, 46], [86, 56], [104, 66]].map(([x, y]) => [x - 2, y - 4])),
        poligono([[28, 82], [42, 72], [24, 62]].map(([x, y]) => [x + 2, y + 4])),
    )],

    // "%": oferta.
    rn_oferta: [ROJO, union(
        anillo(42, 42, 14, 7), anillo(86, 86, 14, 7),
        trazo(92, 30, 36, 98, 7),
    )],

    // "ID".
    rn_id: [MORADO, union(trazo(36, 34, 36, 94, 8), letraD(56, 34, 94, 8))],

    // Moneda hexagonal: precio.
    rn_precio: [VERDE, menos(
        poligono(Array.from({ length: 6 }, (_, i) => {
            const a = (Math.PI / 3) * i + Math.PI / 6;
            return [64 + 44 * Math.cos(a), 64 + 44 * Math.sin(a)];
        })),
        rect(50, 50, 78, 78, 4),
    )],

    // Calendario: fecha de creación.
    rn_fecha: [ROJO, union(
        menos(rect(24, 32, 104, 104, 10), rect(32, 52, 96, 96, 4)),
        rect(40, 62, 52, 72, 2), rect(58, 62, 70, 72, 2), rect(76, 62, 88, 72, 2),
        rect(40, 78, 52, 88, 2), rect(58, 78, 70, 88, 2),
        trazo(44, 22, 44, 36, 6), trazo(84, 22, 84, 36, 6),
    )],

    // Lupa: propiedades.
    rn_props: [CIAN, union(anillo(56, 56, 28, 10), trazo(76, 76, 102, 102, 8))],

    // Percha: tipo de item.
    rn_tipo: [GRIS, union(
        linea([...arco(64, 38, 10, 180, 360 + 60, 16), [64, 54]], 6),
        linea([[64, 54], [24, 88], [104, 88], [64, 54]], 6),
    )],

    // Caja: stock.
    rn_stock: [NARANJA, union(
        menos(rect(24, 40, 104, 104, 8), rect(32, 56, 96, 96, 4)),
        rect(24, 40, 104, 56, 4),
        rect(56, 62, 72, 70, 3),
        poligono([[30, 40], [44, 22], [84, 22], [98, 40]]),
    )],

    // Gráfica subiendo: RAP.
    rn_rap: [AZUL, union(
        linea([[24, 92], [50, 64], [68, 78], [100, 40]], 7),
        poligono([[104, 34], [104, 58], [82, 36]]),
        trazo(24, 104, 104, 104, 5),
    )],

    // Flecha abajo: descuento.
    rn_baja: [ROJO, union(trazo(64, 24, 64, 84, 9), poligono([[34, 70], [94, 70], [64, 106]]))],

    // Flecha arriba: ganancia.
    rn_sube: [VERDE, union(trazo(64, 104, 64, 44, 9), poligono([[34, 58], [94, 58], [64, 22]]))],

    // Persona: límite por usuario.
    rn_limite: [ROSA, union(circulo(64, 44, 18), si(circulo(64, 118, 42), (x, y) => y <= 104))],

    // Enlace (cadena): ver en Roblox.
    rn_link: [GRIS, union(
        anillo(48, 80, 22, 9),
        anillo(80, 48, 22, 9),
        trazo(54, 74, 74, 54, 6),
    )],
};

function dibujar([color, glifo], fondoMuestra = null) {
    const N = 4;
    const px = Buffer.alloc(LADO * LADO * 4);
    for (let y = 0; y < LADO; y++) {
        for (let x = 0; x < LADO; x++) {
            let cf = 0, cg = 0;
            for (let sy = 0; sy < N; sy++) {
                for (let sx = 0; sx < N; sx++) {
                    const fx = x + (sx + 0.5) / N, fy = y + (sy + 0.5) / N;
                    if (fondo(fx, fy)) { cf++; if (glifo(fx, fy)) cg++; }
                }
            }
            const a = cf / (N * N);
            const g = cf ? cg / cf : 0;
            const i = (y * LADO + x) * 4;
            const rgb = [0, 1, 2].map(k => Math.round(color[k] + (255 - color[k]) * g));
            if (fondoMuestra) {
                for (let k = 0; k < 3; k++) px[i + k] = Math.round(fondoMuestra[k] + (rgb[k] - fondoMuestra[k]) * a);
                px[i + 3] = 255;
            } else {
                rgb.forEach((v, k) => { px[i + k] = v; });
                px[i + 3] = Math.round(a * 255);
            }
        }
    }
    return px;
}

function generar() {
    const out = {};
    for (const [nombre, def] of Object.entries(ICONOS)) out[nombre] = png(dibujar(def), LADO, LADO);
    return out;
}

function muestra() {
    const lista = Object.values(ICONOS);
    const ancho = LADO * lista.length;
    const tira = Buffer.alloc(ancho * LADO * 4);
    lista.forEach((def, k) => {
        const px = dibujar(def, [43, 45, 49]);
        for (let y = 0; y < LADO; y++) px.copy(tira, (y * ancho + k * LADO) * 4, y * LADO * 4, (y + 1) * LADO * 4);
    });
    return png(tira, ancho, LADO);
}

module.exports = { generar, muestra, ICONOS, dibujar, LADO };

if (require.main === module) {
    (async () => {
        const dir = path.join(__dirname, '..', 'assets', 'notifier');
        fs.mkdirSync(dir, { recursive: true });
        const pngs = generar();
        for (const [nombre, buf] of Object.entries(pngs)) fs.writeFileSync(path.join(dir, `${nombre}.png`), buf);
        fs.writeFileSync(path.join(dir, 'muestra.png'), muestra());
        console.log(`Generados ${Object.keys(pngs).length} iconos en assets/notifier/`);

        if (process.argv.includes('--subir')) {
            const ids = await subir(pngs);
            console.log('\nPara config.ROBLOX_NOTIFIER.ICONOS:');
            console.log(JSON.stringify(ids, null, 2));
        }
    })().catch(err => { console.error(err); process.exit(1); });
}
