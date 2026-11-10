'use strict';

// ── Iconos de /userinfo, logs y seguridad ────────────────────────────────────
//
// Mismo estilo que scripts/notifierIconos.js (insignia de color + glifo
// blanco), como emojis de la APLICACIÓN.
//
//   node scripts/uiIconos.js           -> genera los PNG en assets/ui/
//   node scripts/uiIconos.js --subir   -> además los sube e imprime sus ids
//
// Los ids van a config.UI_ICONOS. Si falta alguno, se usa un unicode de reserva
// (utils/uiIconos.js).

const fs = require('fs');
const path = require('path');
const { png, subir } = require('./barraEmojis');
const { primitivas: P } = require('./invIconos');
const { dibujar, LADO } = require('./notifierIconos');
const { circulo, anillo, rect, trazo, linea, poligono, union, menos, si } = P;

const AZUL = [59, 130, 246], VERDE = [34, 197, 94], MORADO = [139, 92, 246],
    ROJO = [239, 68, 68], GRIS = [100, 116, 139], CIAN = [6, 182, 212],
    NARANJA = [249, 115, 22], ROSA = [236, 72, 153], DORADO = [234, 170, 8],
    INDIGO = [99, 102, 241];

const escudo = poligono([[64, 18], [102, 32], [100, 64], [90, 86], [64, 110], [38, 86], [28, 64], [26, 32]]);

const ICONOS = {
    // Persona: perfil.
    ui_perfil: [AZUL, union(circulo(64, 46, 20), si(circulo(64, 124, 46), (x, y) => y <= 106))],

    // Medalla: insignias.
    ui_insignia: [DORADO, union(
        poligono([[44, 18], [60, 18], [70, 52], [56, 56]]),
        poligono([[84, 18], [68, 18], [58, 52], [72, 56]]),
        menos(circulo(64, 80, 30), anillo(64, 80, 20, 5)),
    )],

    // Diamante: boost.
    ui_boost: [ROSA, menos(
        poligono([[64, 18], [100, 56], [64, 110], [28, 56]]),
        poligono([[64, 34], [86, 56], [64, 88], [42, 56]]),
    )],

    // Estrella: Nitro.
    ui_nitro: [INDIGO, poligono(Array.from({ length: 10 }, (_, i) => {
        const a = -Math.PI / 2 + (Math.PI / 5) * i;
        const r = i % 2 ? 20 : 46;
        return [64 + r * Math.cos(a), 66 + r * Math.sin(a)];
    }))],

    // Escudo: roles.
    ui_roles: [MORADO, menos(escudo, poligono([[64, 34], [88, 42], [87, 62], [64, 92]]))],

    // Bolsa: compras.
    ui_compras: [VERDE, union(
        rect(28, 46, 100, 108, 10),
        menos(anillo(64, 46, 22, 8), rect(0, 46, 128, 128)),
    )],

    // Persona con +: invitaciones.
    ui_invita: [CIAN, union(
        circulo(50, 44, 18),
        si(circulo(50, 118, 40), (x, y) => y <= 106),
        trazo(98, 48, 98, 84, 6), trazo(80, 66, 116, 66, 6),
    )],

    // Triángulo con "!": alerta.
    ui_alerta: [ROJO, menos(
        poligono([[64, 18], [112, 104], [16, 104]]),
        trazo(64, 48, 64, 74, 6), circulo(64, 89, 6),
    )],

    // Ticket.
    ui_ticket: [NARANJA, menos(
        rect(18, 36, 110, 92, 8),
        circulo(18, 64, 12), circulo(110, 64, 12),
        trazo(46, 44, 46, 50, 3), trazo(46, 60, 46, 68, 3), trazo(46, 78, 46, 84, 3),
    )],

    // Lápiz: editado.
    ui_editado: [AZUL, union(
        poligono([[86, 22], [106, 42], [52, 96], [32, 76]]),
        poligono([[30, 82], [46, 98], [22, 106]]),
    )],

    // Papelera: borrado.
    ui_borrado: [ROJO, union(
        menos(rect(34, 42, 94, 108, 8), rect(48, 52, 54, 98), rect(74, 52, 80, 98), rect(61, 52, 67, 98)),
        rect(26, 30, 102, 38, 3),
        rect(52, 20, 76, 30, 3),
    )],

    // Escudo con check: seguridad.
    ui_escudo: [VERDE, menos(escudo, linea([[44, 62], [58, 76], [86, 46]], 7))],

    // Reloj.
    ui_reloj: [GRIS, union(anillo(64, 64, 46, 10), trazo(64, 64, 64, 36, 6), trazo(64, 64, 84, 74, 6))],

    // Dos personas: servidor / miembros.
    ui_server: [INDIGO, union(
        circulo(44, 46, 16), si(circulo(44, 110, 34), (x, y) => y <= 100),
        circulo(86, 46, 16), si(circulo(86, 110, 34), (x, y) => y <= 100),
    )],
};

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

module.exports = { generar, muestra, ICONOS };

if (require.main === module) {
    (async () => {
        const dir = path.join(__dirname, '..', 'assets', 'ui');
        fs.mkdirSync(dir, { recursive: true });
        const pngs = generar();
        for (const [nombre, buf] of Object.entries(pngs)) fs.writeFileSync(path.join(dir, `${nombre}.png`), buf);
        fs.writeFileSync(path.join(dir, 'muestra.png'), muestra());
        console.log(`Generados ${Object.keys(pngs).length} iconos en assets/ui/`);
        if (process.argv.includes('--subir')) {
            const ids = await subir(pngs);
            console.log('\nPara config.UI_ICONOS:');
            console.log(JSON.stringify(ids, null, 2));
        }
    })().catch(err => { console.error(err); process.exit(1); });
}
