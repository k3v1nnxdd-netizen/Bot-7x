'use strict';

const assert = require('assert');

// Arnes minimo, sin dependencias de test. Mismo patron que el runner que ya
// existe en la raiz del repo (src/tests/): cada archivo exporta una funcion
// async que devuelve true/false, y el runner los encadena.

function createSuite(name) {
    const cases = [];
    return {
        assert,
        test(label, fn) {
            cases.push([label, fn]);
        },
        async run() {
            let allOk = true;
            for (const [label, fn] of cases) {
                try {
                    await fn();
                    console.log(`  ok   ${label}`);
                } catch (err) {
                    allOk = false;
                    console.error(`  FAIL ${label}`);
                    console.error(`       ${err?.message}`);
                }
            }
            if (!allOk) console.error(`  -> ${name}: hay casos fallidos`);
            return allOk;
        },
    };
}

// Error con la forma de uno de axios, para ejercitar la clasificacion del
// limitador sin red: axios cuelga la respuesta HTTP de `err.response`, y deja
// esa propiedad AUSENTE cuando no hubo respuesta (timeout, DNS, socket).
// `data` importa cuando la clasificacion depende del CUERPO y no solo del
// codigo: develop.roblox.com dice "el universo no existe" con un 400 cuyo
// cuerpo es lo unico que lo distingue de cualquier otro 400.
function axiosError(status, headers = {}, data = {}) {
    const err = new Error(`Request failed with status code ${status}`);
    err.response = { status, headers, data };
    return err;
}

function networkError(code = 'ECONNRESET') {
    const err = new Error(`socket hang up (${code})`);
    err.code = code;
    return err; // sin `response`: asi distingue axios un fallo de transporte
}

function timeoutError() {
    const err = new Error('timeout of 6000ms exceeded');
    err.code = 'ECONNABORTED';
    return err;
}

// Ejecuta `fn` capturando todo lo que se escriba en stdout. Sirve para dos
// cosas a la vez: mantener limpia la salida de los tests que provocan un log
// de error a proposito, y poder afirmar sobre lo que ese log contiene — en
// particular, que el secreto NO aparece por ningun lado.
async function captureStdout(fn) {
    const original = process.stdout.write.bind(process.stdout);
    const captured = [];
    process.stdout.write = chunk => { captured.push(String(chunk)); return true; };
    try {
        await fn();
    } finally {
        process.stdout.write = original;
    }
    return captured.join('');
}

module.exports = { createSuite, axiosError, networkError, timeoutError, captureStdout };
