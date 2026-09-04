'use strict';

// ETAPA 4 — PRECIO. Funcion pura sobre el indice de catalogo: no hace ninguna
// llamada y no conoce la red. Eso la hace trivial de probar y es donde vive la
// unica regla de negocio delicada de esta fase.
//
// PRECIO COMPRABLE, Y CON UNA REGLA DURA: O SE SABE ENTERO, O NO SE SABE.
// Devuelve el total, o un motivo si ALGUN asset del avatar no tiene precio
// fiable — y entonces el candidato se descarta.
//
// Es la diferencia entre un numero y una mentira. Si un asset no se puede
// resolver y se contara como 0, un avatar de tres piezas caras del que solo se
// resuelve una barata daria un total pequeño y se colaria en un rango de precio
// bajo donde no pinta nada. El plugin no tendria forma de notarlo: un
// totalPrice es un totalPrice. Devolver menos candidatos es recuperable;
// devolver precios falsos, no.
//
// UN PRECIO REAL DE 0 SI ES VALIDO. Roblox devuelve price 0 para los articulos
// gratuitos, y eso es un dato fiable, no una ausencia: un avatar entero de
// piezas gratis vale 0 de verdad y tiene que poder salir con minPrice 0. Por
// eso la comprobacion es sobre el TIPO y no sobre el valor.
//
// QUE CUENTA COMO "NO FIABLE" HOY:
//   - el asset no se pudo resolver (Roblox no respondio, o su ruta esta
//     limitada): motivo `catalogError`, porque el problema es nuestro/de la red
//     y reintentar mas tarde puede arreglarlo;
//   - el asset no vino en el lote (borrado, moderado, fuera del catalogo) o su
//     `price` no es un numero: motivo `unknownPrice`, porque Roblox contesto
//     perfectamente y aun asi no hay precio que sumar.
//
// Esa segunda casilla es la que hoy se lleva a los Limiteds (su valor vive en
// la reventa, `price` llega null) y a parte de lo que esta fuera de venta.
// Distinguirla de `catalogError` es justo lo que permite decidir si la
// siguiente fase tiene que tocar los precios de reventa o la cuota de Roblox.

function calcularPrecio(assetIds, indice) {
    let total = 0;

    for (const assetId of assetIds) {
        if (indice.irresoluble(assetId)) return { ok: false, motivo: 'catalogError' };

        const ficha = indice.ficha(assetId);
        // Sin ficha en el indice a estas alturas significa que la etapa de
        // catalogo se corto antes de llegar a este asset (429 a mitad de ola).
        if (ficha === undefined) return { ok: false, motivo: 'catalogError' };

        if (ficha.available !== true) return { ok: false, motivo: 'unknownPrice' };
        if (typeof ficha.price !== 'number' || !Number.isFinite(ficha.price) || ficha.price < 0) {
            return { ok: false, motivo: 'unknownPrice' };
        }

        total += ficha.price;
    }

    return { ok: true, totalPrice: total };
}

// ETAPA 5 — FILTROS. Tambien pura, y deliberadamente separada del calculo: un
// candidato que se cae por precio no es lo mismo que uno al que no se le pudo
// poner precio, y mezclarlas en la misma funcion es como se acaban confundiendo
// tambien en las estadisticas.
//
// `maxPrice` null significa "sin techo". Los dos limites son INCLUSIVOS.
function dentroDelRango(totalPrice, minPrice, maxPrice) {
    if (totalPrice < minPrice) return { ok: false, motivo: 'minPrice' };
    if (maxPrice !== null && totalPrice > maxPrice) return { ok: false, motivo: 'maxPrice' };
    return { ok: true };
}

module.exports = { calcularPrecio, dentroDelRango };
