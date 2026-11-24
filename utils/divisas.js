'use strict';

const fs = require('fs');
const config = require('../config');
const { dataPath, ensureDataDir } = require('./dataDir');

// ── MXN → USD ─────────────────────────────────────────────────────────────────
//
// Los precios se cobran en MXN; el USD se enseña al lado, como referencia
// ("≈ $6.00 USD"), en las calculadoras, la confirmación y el ticket.
//
// El tipo de cambio se consulta a una API pública (sin clave) al arrancar y
// cada DIVISAS.REFRESCO_HORAS, y el último bueno se guarda en disco. Lo que
// pide un precio lo lee de memoria y NUNCA espera a la red: una calculadora
// tiene 3 segundos para responder, y un tipo de cambio de hace unas horas es
// igual de bueno para una referencia. Sin ninguno (primer arranque sin red),
// se usa DIVISAS.USD_MXN_RESPALDO.

const FILE = dataPath('divisas.json');
const TMP = FILE + '.tmp';
const API = 'https://open.er-api.com/v6/latest/USD';
const TIMEOUT_MS = 5000;

const D = () => config.DIVISAS;

let actual = null;  // { usdMxn, ts }

function cargar() {
    if (actual) return actual;
    try {
        const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        if (valido(d?.usdMxn)) actual = { usdMxn: d.usdMxn, ts: d.ts ?? 0 };
    } catch { /* sin fichero: se usa el respaldo */ }
    return actual;
}

// Un tipo de cambio creíble. Una API que devuelve 0, 1 o 2.000 por un fallo no
// puede acabar poniendo "$115 MXN ≈ $115 USD" en un ticket.
function valido(n) {
    return Number.isFinite(n) && n >= D().USD_MXN_MIN && n <= D().USD_MXN_MAX;
}

function usdMxn() {
    return cargar()?.usdMxn ?? D().USD_MXN_RESPALDO;
}

// Cuántos USD son esos MXN, a dos decimales. null para lo que no es un precio.
function aUSD(mxn) {
    if (!Number.isFinite(mxn) || mxn < 0) return null;
    return Math.round((mxn / usdMxn()) * 100) / 100;
}

const fmtUSD = usd => `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;

// "≈ $6.00 USD", o '' si no hay precio que convertir.
function usdTexto(mxn) {
    const usd = aUSD(mxn);
    return usd === null ? '' : `≈ ${fmtUSD(usd)}`;
}

// "$115 MXN · ≈ $6.00 USD": el par completo, para las fichas de precio.
function mxnUsd(mxn) {
    if (!Number.isFinite(mxn)) return '';
    return `$${mxn.toLocaleString('es-MX')} MXN · ${usdTexto(mxn)}`;
}

async function actualizar(fetchFn = global.fetch) {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        const res = await fetchFn(API, { signal: ctrl.signal }).finally(() => clearTimeout(t));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        const n = j?.rates?.MXN;
        if (j?.result !== 'success' || !valido(n)) throw new Error(`respuesta no válida (${n})`);
        actual = { usdMxn: Math.round(n * 10000) / 10000, ts: Date.now() };
        ensureDataDir();
        fs.writeFileSync(TMP, JSON.stringify(actual), 'utf8');
        fs.renameSync(TMP, FILE);
        return actual.usdMxn;
    } catch (err) {
        console.warn(`[divisas] No se pudo actualizar el tipo de cambio (se sigue con ${usdMxn()}):`, err.message);
        return null;
    }
}

function iniciar() {
    cargar();
    actualizar().then(n => { if (n) console.log(`[divisas] 1 USD = ${n} MXN`); });
    const t = setInterval(() => actualizar(), D().REFRESCO_HORAS * 3_600_000);
    t.unref?.();
    return t;
}

module.exports = {
    aUSD, usdTexto, mxnUsd, fmtUSD, usdMxn, actualizar, iniciar,
    __test: { valido, _set: v => { actual = v; }, FILE },
};
