'use strict';

// ── Precios en USD ────────────────────────────────────────────────────────────
// El USD es una referencia al lado del MXN. Lo que no puede romperse:
//   1. Una respuesta absurda de la API no cambia el tipo de cambio.
//   2. Sin red, se sigue con el último bueno (o el respaldo de config).
//   3. El USD del ticket va FUERA del bloque que lee el registro de pedidos.

const { createSuite } = require('./testHarness');
const config = require('../../config');
const divisas = require('../../utils/divisas');
const flujo = require('../../handlers/compraFlow');

const respuesta = (mxn, result = 'success', ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => ({ result, rates: { MXN: mxn } }) });

module.exports = async function run() {
    const { assert, finish } = createSuite('divisas');
    const t = divisas.__test;
    const avisos = console.warn;
    console.warn = () => {};

    try {
        t._set(null);
        assert(divisas.usdMxn() === config.DIVISAS.USD_MXN_RESPALDO || divisas.usdMxn() > 0, 'sin consultar, usa el respaldo (o el último guardado)');

        assert(await divisas.actualizar(respuesta(20)) === 20, 'una respuesta buena actualiza el tipo de cambio');
        assert(divisas.aUSD(100) === 5 && divisas.usdTexto(115) === '≈ $5.75 USD', '$100 MXN = $5.00 USD a 20');
        assert(divisas.mxnUsd(130) === '$130 MXN · ≈ $6.50 USD', 'el par completo');

        for (const [f, msg] of [
            [respuesta(1), 'un tipo de cambio absurdo (1)'],
            [respuesta(2000), 'uno absurdo por arriba (2000)'],
            [respuesta(19, 'error'), 'una respuesta marcada como error'],
            [respuesta(19, 'success', false), 'un HTTP 500'],
            [async () => { throw new Error('sin red'); }, 'sin red'],
        ]) {
            assert(await divisas.actualizar(f) === null && divisas.usdMxn() === 20, `${msg}: no cambia nada, sigue el último bueno`);
        }
        assert(divisas.aUSD(-1) === null && divisas.aUSD(NaN) === null && divisas.usdTexto(NaN) === '', 'sin precio, sin USD');

        // El ticket: el USD debajo del precio, y el registro sigue leyendo MXN.
        const txt = flujo.__test.lineasPrecio({ precio: 133 }, null);
        assert(/Precio a pagar\*\*\n```\$133 MXN```/.test(txt), 'el bloque del precio sigue igual (lo lee el registro)');
        assert(/En dólares: ≈ \$6\.65 USD/.test(txt), 'y debajo, el USD');
    } finally {
        console.warn = avisos;
        t._set(null);
    }
    return finish();
};
