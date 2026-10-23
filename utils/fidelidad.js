'use strict';

const fs = require('fs');
const { dataPath, ensureDataDir } = require('./dataDir');
const config = require('../config');
const leaderboard = require('./robuxLeaderboard');

// ── Descuento por fidelidad ───────────────────────────────────────────────────
//
// Cada FIDELIDAD.CADA compras se gana un descuento para UNA compra, y el
// cliente decide en cuál usarlo.
//
// Hay dos números y salen de sitios distintos, a propósito:
//
//   - LAS COMPRAS salen del ranking de compradores (robuxLeaderboard.json). Es
//     el registro que ya cuenta cada compra completada, sin duplicados, y que
//     se reconstruye desde el canal de pedidos en cada arranque. Un segundo
//     contador sólo para esto acabaría descuadrado con el ranking tarde o
//     temprano, y el cliente vería dos cifras distintas para lo mismo.
//
//   - LOS DESCUENTOS USADOS van en su propio fichero. No pueden ir en el
//     ranking: ese se BORRA y se rehace desde el canal de pedidos en cada
//     arranque, y con él se perdería qué descuentos se gastaron — cada
//     despliegue devolvería los usados.
//
// Los disponibles no se guardan: se calculan. Ganados = compras / CADA,
// disponibles = ganados − usados. Así no hay estado que pueda contradecirse.
//
// Y "compras" son las de DESPUÉS de activar el programa, salvo que
// FIDELIDAD.RETROACTIVO esté en true. Al activarse se apunta cuántas llevaba
// cada cliente (la base) y se cuentan las que hace a partir de ahí. Ver
// inicializar().

const FILE = dataPath('fidelidad.json');
const TMP  = FILE + '.tmp';

const F = config.FIDELIDAD;

function load() {
    const objeto = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    try {
        const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        return {
            usados: objeto(data?.usados),
            base: objeto(data?.base),
            inicio: typeof data?.inicio === 'string' ? data.inicio : null,
        };
    } catch {
        return { usados: {}, base: {}, inicio: null };
    }
}

function save(data) {
    ensureDataDir();
    fs.writeFileSync(TMP, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(TMP, FILE);
}

// Todas las compras completadas de alguien, desde siempre.
function comprasDe(userId) {
    const n = Number(leaderboard.getEntry(userId)?.purchases);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Las que cuentan para la fidelidad: las de después de activar el programa.
//
// Sin inicializar no cuenta NINGUNA. Es el lado seguro: si por lo que sea no se
// tomó la base, lo peor que pasa es que nadie gana descuentos todavía — no que
// se regalen por todo el historial.
function comprasFidelidad(userId) {
    const total = comprasDe(userId);
    if (F.RETROACTIVO) return total;

    const data = load();
    if (!data.inicio) return 0;

    const base = Number(data.base[String(userId)]);
    return Math.max(0, total - (Number.isFinite(base) ? base : 0));
}

// Activa el programa: apunta cuántas compras lleva cada cliente en ese momento,
// y desde ahí se empieza a contar. Sólo la primera vez — después no hace nada,
// así que llamarlo en cada arranque es seguro.
//
// Tiene que llamarse DESPUÉS de reconstruir el ranking desde el canal de
// pedidos (ver main.js): una base tomada sobre un ranking a medio reconstruir
// valdría 0 para muchos clientes, y les regalaría su historial entero.
function inicializar() {
    const data = load();
    if (data.inicio) return false;

    data.inicio = new Date().toISOString();
    data.base = {};
    for (const u of leaderboard.getRanked()) {
        const n = Number(u.purchases);
        if (Number.isFinite(n) && n > 0) data.base[String(u.userId)] = Math.floor(n);
    }
    save(data);
    console.log(`[fidelidad] Programa activado: base de ${Object.keys(data.base).length} cliente(s).`);
    return true;
}

function usadosDe(userId) {
    const n = Number(load().usados[String(userId)]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Todo lo que hace falta para pintar el progreso de alguien.
//
//   compras     — completadas en total
//   progreso    — cuántas lleva hacia el siguiente descuento (0..CADA-1)
//   faltan      — cuántas le faltan para ganarlo (1..CADA)
//   disponibles — descuentos ganados y sin usar
function estado(userId) {
    const compras = comprasFidelidad(userId);
    const ganados = Math.floor(compras / F.CADA);
    const usados = usadosDe(userId);
    const progreso = compras % F.CADA;

    return {
        compras,
        comprasTotales: comprasDe(userId),
        ganados,
        usados,
        // Nunca negativo: si el canal de pedidos se limpiara, las compras
        // bajarían por debajo de lo ya gastado, y "-1 descuentos" no significa
        // nada.
        disponibles: Math.max(0, ganados - usados),
        progreso,
        faltan: F.CADA - progreso,
    };
}

function tieneDescuento(userId) {
    return estado(userId).disponibles > 0;
}

// Gasta uno. Devuelve false si no tenía ninguno: un descuento no se puede
// gastar dos veces, ni gastar uno que no se ha ganado.
function usar(userId) {
    if (!tieneDescuento(userId)) return false;

    const data = load();
    // Se escribe sobre lo leído aquí, que conserva la base y el inicio.
    const key = String(userId);
    data.usados[key] = usadosDe(userId) + 1;
    save(data);
    return true;
}

// El precio con el descuento, al peso, como el resto de precios del bot.
function aplicar(precio) {
    if (!Number.isFinite(precio) || precio <= 0) return null;
    return Math.round(precio * (1 - F.DESCUENTO / 100));
}

// La barra de progreso, hecha de emojis de la aplicación: una pieza de inicio,
// las del medio y una de fin, cada una llena (azul) o vacía. Puestas en fila
// forman una sola barra con su línea blanca alrededor.
//
// Son de la aplicación y no del servidor para que se vean para todo el mundo:
// un emoji del servidor, fuera de él o sin Nitro, sale como texto.
function barra(hechas, total = F.CADA) {
    const h = Math.max(0, Math.min(total, Math.floor(hechas)));
    let out = '';
    for (let i = 0; i < total; i++) {
        const tipo = i === 0 ? 'ini' : i === total - 1 ? 'fin' : 'med';
        const estado = i < h ? 'on' : 'off';
        out += `<:barra7x_${tipo}_${estado}:${F.BARRA[`${tipo}_${estado}`]}>`;
    }
    return out;
}

// Los totales del servidor, de la misma fuente que el ranking.
function totalesServidor() {
    const todos = leaderboard.getRanked();
    return {
        compras: todos.reduce((s, u) => s + (Number(u.purchases) || 0), 0),
        robux: todos.reduce((s, u) => s + (Number(u.totalRobux) || 0), 0),
        clientes: todos.filter(u => (Number(u.purchases) || 0) > 0).length,
    };
}

module.exports = { estado, tieneDescuento, usar, aplicar, barra, totalesServidor, inicializar, F };
