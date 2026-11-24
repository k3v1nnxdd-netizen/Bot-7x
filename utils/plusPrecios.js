'use strict';

const config = require('../config');

// ── Precios por Roblox Plus ───────────────────────────────────────────────────
//
// Los Robux se mandan con "Enviar Robux", la función de Roblox Plus, desde la
// cuenta de 7x. A diferencia del gamepass, llegan COMPLETOS: Roblox no se
// queda comisión. Lo que sí pone Roblox son límites, y de ellos salen los de
// aquí (ver config.PLUS):
//
//   - MAX_ROBUX: lo que una cuenta puede enviar en un día.
//   - MULTIPLO:  cada envío es de 25, 50, 100 o 200, así que lo que no sea
//                múltiplo de 25 no se puede mandar entero.

const P = config.PLUS;

// Lo que cuestan `robux`, en MXN, redondeado al peso. null para lo que no sea
// una cantidad usable: un "$0" parecería una oferta.
function precioDe(robux) {
    if (!Number.isFinite(robux) || robux <= 0) return null;
    return Math.round((robux / 1000) * P.PRECIO_POR_1K);
}

// Cuántos Robux alcanzan con ese dinero: hacia abajo, a múltiplos de MULTIPLO
// y sin pasar del máximo. null si no llega al mínimo.
function robuxPor(dinero) {
    if (!Number.isFinite(dinero) || dinero <= 0) return null;
    const exacto = (dinero / P.PRECIO_POR_1K) * 1000;
    const robux = Math.min(Math.floor(exacto / P.MULTIPLO) * P.MULTIPLO, P.MAX_ROBUX);
    return robux >= P.MIN_ROBUX ? robux : null;
}

// Si esa cantidad se puede vender por Plus. Devuelve el motivo para poder
// explicarlo: "fuera de rango" y "no es múltiplo" se arreglan distinto.
function revisar(robux) {
    if (!Number.isFinite(robux) || robux < P.MIN_ROBUX || robux > P.MAX_ROBUX) return { ok: false, motivo: 'rango' };
    if (robux % P.MULTIPLO !== 0) return { ok: false, motivo: 'multiplo' };
    return { ok: true };
}

const enRango = robux => revisar(robux).ok;

const fmtRobux = n => n.toLocaleString('es-MX');
const fmtMXN   = n => `$${n.toLocaleString('es-MX')} MXN`;

// El mensaje de error de revisar(), el mismo en el ticket y en la calculadora.
function errorCantidad(robux) {
    const r = revisar(robux);
    if (r.ok) return null;
    if (r.motivo === 'multiplo') {
        const abajo = Math.floor(robux / P.MULTIPLO) * P.MULTIPLO;
        return `La cantidad tiene que ir de **${P.MULTIPLO} en ${P.MULTIPLO}** (Roblox envía en paquetes de 25, 50, 100 y 200). ` +
            `Prueba con **${fmtRobux(abajo)}** o **${fmtRobux(abajo + P.MULTIPLO)}**.`;
    }
    return `Por Plus vendemos entre **${fmtRobux(P.MIN_ROBUX)}** y **${fmtRobux(P.MAX_ROBUX)}** Robux.`;
}

module.exports = { precioDe, robuxPor, revisar, enRango, errorCantidad, fmtRobux, fmtMXN, P };
