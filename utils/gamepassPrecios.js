'use strict';

const config = require('../config');

// ── Precios por gamepass ──────────────────────────────────────────────────────
//
// Otra forma de entrega, con otra aritmética que la de los grupos:
//
//   1. El cliente crea un gamepass en su juego por el valor que va a comprar.
//   2. 7x lo compra.
//   3. Roblox se queda su comisión de la venta, y el cliente recibe el resto.
//
// La comisión NO la cubre 7x: se paga por el VALOR DEL GAMEPASS, y lo que llega
// a la cuenta es menos. Es el dato que más fácil se malinterpreta —alguien paga
// "1.000 Robux" y ve llegar 700—, así que las dos cifras se calculan aquí y se
// enseñan siempre juntas. Callar la segunda sería vender una cosa y entregar
// otra.

const G = config.GAMEPASS;

// Lo que cuesta un gamepass de `robux` de valor, en MXN.
//
// Se redondea al peso, como el resto de precios del bot (la tabla de grupos no
// tiene decimales). Devuelve null para cualquier cosa que no sea una cantidad
// usable: un 0 o un NaN convertidos en "$0" parecerían una oferta.
function precioDe(robux) {
    if (!Number.isFinite(robux) || robux <= 0) return null;
    return Math.round((robux / 1000) * G.PRECIO_POR_1K);
}

// Cuánto gamepass se puede crear con ese dinero.
//
// Se redondea HACIA ABAJO y a múltiplos de 10: hacia abajo para que el precio
// resultante nunca pase del presupuesto, y a múltiplos de 10 porque "2.173
// Robux" es un número que nadie teclea en un gamepass. Lo que sobra se dice
// aparte, no se esconde.
function robuxPor(dinero) {
    if (!Number.isFinite(dinero) || dinero <= 0) return null;

    const exacto = (dinero / G.PRECIO_POR_1K) * 1000;
    const robux = Math.floor(exacto / 10) * 10;

    return robux >= G.MIN_ROBUX ? robux : null;
}

// Lo que de verdad llega a su cuenta tras la comisión de Roblox.
function recibe(robux) {
    if (!Number.isFinite(robux) || robux <= 0) return null;
    return Math.floor(robux * (1 - G.TASA_ROBLOX));
}

// Si esa cantidad está dentro de lo que se vende por gamepass.
function enRango(robux) {
    return Number.isFinite(robux) && robux >= G.MIN_ROBUX && robux <= G.MAX_ROBUX;
}

const fmtRobux = n => n.toLocaleString('es-MX');
const fmtMXN   = n => `$${n.toLocaleString('es-MX')} MXN`;

module.exports = { precioDe, robuxPor, recibe, enRango, fmtRobux, fmtMXN, G };
