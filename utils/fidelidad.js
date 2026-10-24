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
// Todo sale del ranking de compradores (robuxLeaderboard.json), que se BORRA y
// se rehace desde el canal de pedidos en cada arranque. Eso es lo que hace que
// el progreso no se pierda nunca: no hay un contador propio que un reinicio o
// un despliegue pueda dejar a cero — se vuelve a contar desde los pedidos.
//
//   - LAS COMPRAS: los pedidos de cada cliente con fecha desde FIDELIDAD.INICIO.
//     La fecha de un pedido es la de su mensaje en el canal de pedidos (va
//     dentro del id del mensaje), así que se sabe aunque el bot reinicie.
//
//   - LOS DESCUENTOS USADOS: los pedidos de ese canal marcados con el descuento
//     de fidelidad. Además se apuntan en fidelidad.json en el momento de
//     gastarse (el pedido se registra unos segundos después); de los dos se
//     toma el mayor, así que perder el fichero no devuelve ningún descuento.
//
// Los disponibles no se guardan: se calculan. Ganados = compras / CADA,
// disponibles = ganados − usados. Así no hay estado que pueda contradecirse.
//
// Las compras de antes de INICIO no cuentan, salvo que FIDELIDAD.RETROACTIVO
// esté en true: contar todo el historial regalaría varios descuentos de golpe.

const FILE = dataPath('fidelidad.json');
const TMP  = FILE + '.tmp';

const F = config.FIDELIDAD;

function load() {
    const objeto = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    try {
        const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        return { ...data, usados: objeto(data?.usados) };
    } catch {
        return { usados: {} };
    }
}

function save(data) {
    ensureDataDir();
    fs.writeFileSync(TMP, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(TMP, FILE);
}

// La fecha de un pedido, sacada del id de su mensaje (un snowflake de Discord
// lleva dentro el momento en que se creó). null si no es un id de Discord.
const EPOCH_DISCORD = 1420070400000n;
function fechaPedido(orderId) {
    if (!/^\d{15,20}$/.test(String(orderId))) return null;
    return Number((BigInt(orderId) >> 22n) + EPOCH_DISCORD);
}

// Si un pedido cuenta para la fidelidad. Uno sin fecha legible NO cuenta: es
// el lado seguro — no regala nada.
function cuenta(orderId) {
    if (F.RETROACTIVO) return true;
    const fecha = fechaPedido(orderId);
    const inicio = Date.parse(F.INICIO);
    return fecha !== null && Number.isFinite(inicio) && fecha >= inicio;
}

// Todas las compras completadas de alguien, desde siempre.
function comprasDe(userId) {
    const n = Number(leaderboard.getEntry(userId)?.purchases);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// Las que cuentan para la fidelidad: las de desde INICIO.
function comprasFidelidad(userId) {
    const entry = leaderboard.getEntry(userId);
    if (F.RETROACTIVO) return comprasDe(userId);
    return (entry?.ordenes ?? []).filter(cuenta).length;
}

function usadosDe(userId) {
    const enPedidos = (leaderboard.getEntry(userId)?.descuentos ?? []).filter(cuenta).length;
    const n = Number(load().usados[String(userId)]);
    const enFichero = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    return Math.max(enPedidos, enFichero);
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

module.exports = { estado, tieneDescuento, usar, aplicar, barra, totalesServidor, fechaPedido, F };
