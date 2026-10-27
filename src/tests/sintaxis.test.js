'use strict';

// Que TODO el código del bot se pueda cargar. Muchos tests leen main.js como
// texto y nunca lo ejecutan, así que un error de sintaxis en main.js pasaba
// todos los tests y tumbaba el bot entero en Railway (pasó: un apóstrofo en
// "Check Group's" cerraba el texto de la descripción de /gactive).
//
// Se compila cada fichero con el mismo envoltorio que usa Node para los
// módulos, sin ejecutarlo: rápido y sin efectos.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { createSuite } = require('./testHarness');

const RAIZ = path.join(__dirname, '..', '..');
const FUERA = new Set(['node_modules', '.git', 'data', 'storage', 'outfit-api', 'assets']);

function ficheros(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (FUERA.has(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...ficheros(p));
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

module.exports = async function run() {
    const { assert, finish } = createSuite('sintaxis');
    const lista = ficheros(RAIZ);
    assert(lista.some(f => f.endsWith(`${path.sep}main.js`)), 'incluye main.js');

    for (const f of lista) {
        let error = null;
        try {
            new vm.Script(Module.wrap(fs.readFileSync(f, 'utf8').replace(/^#!.*/, '')), { filename: f });
        } catch (err) {
            error = err;
        }
        assert(!error, `${path.relative(RAIZ, f)} compila${error ? ` — ${error.message}` : ''}`);
    }
    return finish();
};
