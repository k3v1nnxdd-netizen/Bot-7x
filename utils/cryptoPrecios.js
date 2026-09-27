'use strict';

const { CRIPTO } = require('../metodos');

// ── Precio de las criptos que acepta 7x ───────────────────────────────────────
//
// Las monedas salen de metodos.js, la MISMA lista con la que se cobra: no tiene
// sentido convertir a una cripto que no se acepta, ni que añadir una al panel
// de pagos la deje fuera de la calculadora. Un test comprueba que ninguna se
// queda sin identificador aquí.
//
// La fuente es CoinGecko: da MXN y USD directamente —sin encadenar un tipo de
// cambio, que es un error más que cometer— y no pide clave.

const API = 'https://api.coingecko.com/api/v3/simple/price';

// Corto a propósito. Quien pide esto es /crypto, que responde SIN diferir: la
// tarjeta va en Components V2 y ese flag no se puede añadir al editar una
// respuesta ya diferida, así que hay que contestar dentro de los 3 segundos que
// da Discord antes de invalidar el token. Medido, CoinGecko tarda ~250 ms; con
// 2,5 s de tope cabe incluso yendo diez veces peor, y si no llega se contesta
// igual —con el precio anterior o diciendo que no se pudo— dentro de plazo.
const TIMEOUT_MS = 2500;

// Cuánto vale un precio antes de volver a pedirlo. 60 s es de sobra: nadie
// nota el movimiento de un minuto, y protege el límite de la API gratuita de
// un comando que se puede usar en ráfaga.
const FRESCO_MS = 60_000;

// Hasta cuándo sirve un precio viejo si la API se cae. Diez minutos es la
// frontera entre "esto sigue siendo orientativo" y "esto ya es inventar": pasado
// eso se prefiere no dar número antes que dar uno que no se sostiene. Y cuando
// se usa uno viejo, se DICE de cuándo es.
const RANCIO_MS = 10 * 60_000;

// El id de cada moneda en CoinGecko. La clave es el ticker de metodos.js.
const IDS = {
    BTC:  'bitcoin',
    ETH:  'ethereum',
    LINK: 'chainlink',
    LTC:  'litecoin',
    UNI:  'uniswap',
};

const DIVISAS = ['MXN', 'USD'];

// Las monedas que se pueden convertir: las de los pagos que además tienen id.
// Se deriva de metodos.js para que el comando y el panel de pagos no puedan
// acabar ofreciendo cosas distintas.
const MONEDAS = CRIPTO.filter(c => IDS[c.ticker]);

let cache = null;   // { ts, porDivisa: { MXN: {BTC: 123, …}, USD: {…} } }

function idsPedidos() {
    return MONEDAS.map(c => IDS[c.ticker]).join(',');
}

// { ok, precios: {TICKER: number}, ts, edadMs, rancio } | { ok:false, error }
//
// `rancio` en true = el número es de hace un rato porque la API no contestó.
// Quien lo pinte TIENE que decirlo: un precio viejo presentado como actual es
// peor que no dar precio.
async function obtenerPrecios(divisa = 'MXN') {
    const div = DIVISAS.includes(divisa) ? divisa : 'MXN';

    const ahora = Date.now();
    if (cache && ahora - cache.ts < FRESCO_MS && cache.porDivisa[div]) {
        return { ok: true, precios: cache.porDivisa[div], ts: cache.ts, edadMs: ahora - cache.ts, rancio: false };
    }

    try {
        const url = `${API}?ids=${encodeURIComponent(idsPedidos())}` +
            `&vs_currencies=${DIVISAS.join(',').toLowerCase()}`;

        const res = await fetch(url, {
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();

        // Se rellenan LAS DOS divisas de la misma respuesta: ya vienen pagadas
        // en la misma petición, y así cambiar de divisa no gasta otra.
        const porDivisa = {};
        for (const d of DIVISAS) {
            const precios = {};
            for (const moneda of MONEDAS) {
                const valor = Number(data?.[IDS[moneda.ticker]]?.[d.toLowerCase()]);
                if (Number.isFinite(valor) && valor > 0) precios[moneda.ticker] = valor;
            }
            porDivisa[d] = precios;
        }

        // Una respuesta sin ni un precio útil no se guarda: dejaría la caché
        // vacía pero "fresca", y la siguiente consulta tampoco pediría nada.
        if (!Object.keys(porDivisa[div]).length) throw new Error('sin precios');

        cache = { ts: Date.now(), porDivisa };
        return { ok: true, precios: porDivisa[div], ts: cache.ts, edadMs: 0, rancio: false };
    } catch {
        const edadMs = cache ? Date.now() - cache.ts : Infinity;
        if (cache?.porDivisa[div] && edadMs < RANCIO_MS) {
            return { ok: true, precios: cache.porDivisa[div], ts: cache.ts, edadMs, rancio: true };
        }
        return { ok: false, error: 'sin_precio' };
    }
}

// Cuánta cripto dan por ese dinero. Devuelve null si no hay precio para esa
// moneda, y nunca un 0 disfrazado: un "0 BTC" en pantalla parecería un cambio
// real y es un dato que no se tiene.
function convertir(cantidad, precioUnidad) {
    if (!Number.isFinite(cantidad) || cantidad <= 0) return null;
    if (!Number.isFinite(precioUnidad) || precioUnidad <= 0) return null;
    return cantidad / precioUnidad;
}

// Decimales según lo que valga la moneda: 0,0024 BTC y 20,84 UNI son el mismo
// dinero, y redondear los dos igual deja uno en "0,00" o al otro con ceros de
// relleno. Se recortan los ceros sobrantes del final.
function formatearCripto(n) {
    if (!Number.isFinite(n) || n <= 0) return null;

    const decimales = n >= 1000 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 6 : 8;
    const texto = n.toFixed(decimales);
    return texto.includes('.') ? texto.replace(/0+$/, '').replace(/\.$/, '') : texto;
}

function formatearDinero(n, divisa) {
    return `${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${divisa}`;
}

// Sólo para los tests: deja la caché como recién arrancado el bot.
function _reset() {
    cache = null;
}

module.exports = {
    obtenerPrecios, convertir, formatearCripto, formatearDinero,
    MONEDAS, DIVISAS, IDS, FRESCO_MS, RANCIO_MS, _reset,
};
