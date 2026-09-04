'use strict';

const http = require('http');
const { createSuite } = require('./harness');
const { createApp } = require('../app');
const ownRateLimit = require('../security/rateLimit');

// Tests de POST /plugin/outfits/search por HTTP real. SIN red, SIN base y SIN
// dobles: esta ruta todavia no llama a nada — devuelve una respuesta fija — y
// eso es justo lo que se comprueba aqui, junto con la validacion de `amount`.
//
// Lo que este archivo protege de verdad son los BORDES del rango (1, 500 pasan;
// 0, 501 no) y el TIPO (un "100" de texto no es un entero). Son los cuatro
// casos que un plugin recien escrito falla, y los que dejarian de ser gratis el
// dia que cada unidad de `amount` valga una llamada a Roblox.

function buscar(port, body, { raw, contentType = 'application/json' } = {}) {
    // El limitador del runner esta bajado a 25/min para que otro archivo pueda
    // provocar un 429 a proposito; sin este reset, los casos de aqui lo
    // heredarian.
    ownRateLimit.reset();

    const payload = raw !== undefined
        ? raw
        : body !== undefined ? JSON.stringify(body) : null;

    const headers = {};
    if (contentType) headers['content-type'] = contentType;
    if (payload !== null) headers['content-length'] = Buffer.byteLength(payload);

    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, path: '/plugin/outfits/search', method: 'POST', headers,
        }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch { /* respuesta no-JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
            });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

module.exports = async function run() {
    const suite = createSuite('plugin');
    const { test, assert } = suite;

    const app = createApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;

    // ── amount valido ────────────────────────────────────────────────────────

    test('amount = 1 (minimo) -> 200 y requested = 1', async () => {
        const res = await buscar(port, { amount: 1 });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.requested, 1);
    });

    test('amount = 100 -> 200 con la forma completa de la respuesta', async () => {
        const res = await buscar(port, { amount: 100 });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.body, {
            success: true,
            requested: 100,
            found: 3,
            outfits: [
                { userId: 3156911153, username: 'Soykevinsitop' },
                { userId: 156, username: 'Test1' },
                { userId: 261, username: 'Test2' },
            ],
        });
    });

    test('amount = 500 (maximo) -> 200 y requested = 500', async () => {
        const res = await buscar(port, { amount: 500 });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.requested, 500);
    });

    // `found` sale de la lista, no de una constante: si algun dia se toca la
    // respuesta de prueba y se olvida el contador, esto lo caza.
    test('found coincide con el numero de outfits devueltos', async () => {
        const res = await buscar(port, { amount: 10 });
        assert.strictEqual(res.body.found, res.body.outfits.length);
    });

    // ── amount invalido -> 400, siempre con el formato de error del servicio ──

    async function esperar400(descripcion, peticion) {
        const res = await peticion();
        assert.strictEqual(res.status, 400, `${descripcion}: se esperaba 400 y llego ${res.status}`);
        assert.strictEqual(res.body.error.code, 'invalid_request');
        assert.ok(typeof res.body.error.message === 'string' && res.body.error.message.length > 0);
        return res;
    }

    test('amount = 0 -> 400 (por debajo del minimo)', async () => {
        await esperar400('amount=0', () => buscar(port, { amount: 0 }));
    });

    test('amount = 501 -> 400 (por encima del maximo)', async () => {
        await esperar400('amount=501', () => buscar(port, { amount: 501 }));
    });

    test('amount = "abc" -> 400 (no es un numero)', async () => {
        await esperar400('amount="abc"', () => buscar(port, { amount: 'abc' }));
    });

    test('amount ausente -> 400', async () => {
        await esperar400('sin amount', () => buscar(port, {}));
    });

    // ── Casos vecinos que el plugin puede provocar sin querer ────────────────

    test('amount = "100" (numero como texto) -> 400', async () => {
        await esperar400('amount="100"', () => buscar(port, { amount: '100' }));
    });

    test('amount = 1.5 (decimal) -> 400', async () => {
        await esperar400('amount=1.5', () => buscar(port, { amount: 1.5 }));
    });

    test('sin cuerpo ni content-type -> 400, no 500', async () => {
        await esperar400('sin cuerpo', () => buscar(port, undefined, { contentType: null }));
    });

    test('JSON malformado -> 400, no 500', async () => {
        await esperar400('json roto', () => buscar(port, undefined, { raw: '{"amount":' }));
    });

    // ── Que no se haya movido nada de lo de al lado ──────────────────────────

    test('la ruta no exige x-api-key, x-admin-key ni token de licencia', async () => {
        const res = await buscar(port, { amount: 25 });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.requested, 25);
    });

    test('otra ruta bajo /plugin sigue siendo 404 route_not_found', async () => {
        ownRateLimit.reset();
        const res = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port, path: '/plugin/loquesea', method: 'GET',
            }, r => {
                let data = '';
                r.on('data', c => { data += c; });
                r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.end();
        });
        assert.strictEqual(res.status, 404);
        assert.strictEqual(res.body.error.code, 'route_not_found');
    });

    const ok = await suite.run();

    ownRateLimit.reset();
    await new Promise(resolve => server.close(resolve));
    return ok;
};
