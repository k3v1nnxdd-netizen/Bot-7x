'use strict';

const http = require('http');
const { createSuite, captureStdout } = require('./harness');
const { createApp } = require('../app');
const config = require('../config');
const logger = require('../observability/logger');
const ownRateLimit = require('../security/rateLimit');
const robloxRateLimiter = require('../roblox/rateLimiter');

// Tests de la app completa por HTTP real, pero SIN red hacia fuera: todos los
// casos se resuelven antes de que ningun servicio llame a Roblox (healthcheck,
// 401, ruta inexistente, validacion, metricas, limite propio). Es la
// verificacion del CABLEADO — orden de middlewares, formato de errores,
// cabeceras — que los tests unitarios por si solos no cubren.

function request(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let body = null;
                try { body = JSON.parse(data); } catch { /* respuesta no-JSON: se deja en raw */ }
                resolve({ status: res.statusCode, headers: res.headers, body, raw: data });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// Solo los contadores de llamadas por ruta. Comparar el objeto de metricas
// entero seria fragil: incluye un `cooldownRemainingMs` que se recalcula
// contra el reloj en cada lectura.
function robloxCallCounts() {
    const byRoute = robloxRateLimiter.getMetrics().byRoute;
    return Object.fromEntries(Object.entries(byRoute).map(([route, m]) => [route, m.calls]));
}

module.exports = async function run() {
    const suite = createSuite('app');
    const { test, assert } = suite;

    const app = createApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;
    const KEY = config.apiKey;
    const auth = { 'x-api-key': KEY };

    test('GET /health responde 200 sin API key y sin tocar Roblox', async () => {
        const before = robloxCallCounts();
        const res = await request(port, '/health');

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'ok');
        assert.strictEqual(typeof res.body.uptimeSeconds, 'number');

        assert.deepStrictEqual(robloxCallCounts(), before, 'el healthcheck jamas debe llamar a Roblox');
    });

    test('sin x-api-key -> 401', async () => {
        const res = await request(port, '/v1/metrics');
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.error.code, 'unauthorized');
    });

    test('con x-api-key incorrecta -> 401 identico (no revela si existe o no)', async () => {
        const sinKey = await request(port, '/v1/metrics');
        const conKeyMala = await request(port, '/v1/metrics', { 'x-api-key': 'clave-incorrecta' });

        assert.strictEqual(conKeyMala.status, 401);
        assert.deepStrictEqual(conKeyMala.body, sinKey.body, 'las dos respuestas deben ser indistinguibles');
    });

    test('la API key nunca aparece en una respuesta', async () => {
        const responses = await Promise.all([
            request(port, '/v1/metrics', auth),
            request(port, '/v1/metrics'),
            request(port, '/v1/users/by-username/ab', auth),
            request(port, '/health'),
        ]);

        for (const res of responses) {
            const everything = res.raw + JSON.stringify(res.headers);
            assert.ok(!everything.includes(KEY), 'el secreto no puede salir en cuerpo ni cabeceras');
        }
    });

    test('la API key nunca llega al log, ni aunque se pase como campo', async () => {
        const captured = await captureStdout(async () => {
            logger.error('caso de prueba', { 'x-api-key': KEY, apiKey: KEY, Authorization: KEY, ruta: '/v1/x' });
        });

        assert.ok(!captured.includes(KEY), 'el logger debe redactar cualquier campo que suene a credencial');
        assert.ok(captured.includes('[redacted]'));
        assert.ok(captured.includes('/v1/x'), 'lo que no es secreto si debe registrarse');
    });

    test('toda respuesta de /v1 trae X-Request-Id', async () => {
        const res = await request(port, '/v1/metrics', auth);
        assert.ok(res.headers['x-request-id'], 'hace falta un id para poder cruzar log y reporte');
        assert.match(res.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    });

    test('una ruta inexistente -> 404 route_not_found', async () => {
        const res = await request(port, '/v1/no-existe', auth);
        assert.strictEqual(res.status, 404);
        assert.strictEqual(res.body.error.code, 'route_not_found');
    });

    test('un parametro invalido -> 400 sin gastar una sola llamada a Roblox', async () => {
        const before = robloxCallCounts();

        const casos = [
            '/v1/users/by-username/ab',              // username demasiado corto
            '/v1/users/by-username/nombre%20con%20espacio',
            '/v1/users/abc/outfits',                 // userId no numerico
            '/v1/users/156/outfits?limit=7',         // limit fuera del conjunto
            '/v1/users/156/outfits?page=0',
            '/v1/outfits/abc',                       // outfitId no numerico
        ];

        for (const path of casos) {
            const res = await request(port, path, auth);
            assert.strictEqual(res.status, 400, `${path} debia dar 400`);
            assert.strictEqual(res.body.error.code, 'invalid_request');
        }

        // Lo importante: rechazar en el borde cuesta microsegundos y CERO
        // trafico saliente. Una peticion basura no puede gastar cuota de Roblox.
        assert.deepStrictEqual(robloxCallCounts(), before);
    });

    test('GET /v1/metrics devuelve las secciones de observabilidad', async () => {
        const res = await request(port, '/v1/metrics', auth);
        assert.strictEqual(res.status, 200);
        for (const seccion of ['process', 'http', 'cache', 'ownRateLimit', 'roblox']) {
            assert.ok(res.body[seccion], `falta la seccion ${seccion}`);
        }
        assert.ok(res.body.roblox.byRoute.usernameLookup, 'debe verse el estado por ruta de Roblox');
        assert.ok('state' in res.body.roblox.byRoute.usernameLookup.circuit);
    });

    test('el limite propio corta con 429 y Retry-After', async () => {
        ownRateLimit.reset(); // el tope es 25 en el runner
        const { maxPerWindow } = ownRateLimit.getMetrics();

        for (let i = 0; i < maxPerWindow; i++) {
            const res = await request(port, '/v1/metrics', auth);
            assert.strictEqual(res.status, 200, `la peticion ${i + 1} debia pasar`);
        }

        const res = await request(port, '/v1/metrics', auth);
        assert.strictEqual(res.status, 429);
        // 429 = limite NUESTRO. Es un codigo distinto del 503 que devuelve un
        // limite de Roblox, justamente para que el juego pueda reaccionar bien
        // a cada uno.
        assert.strictEqual(res.body.error.code, 'rate_limited');
        assert.ok(Number(res.headers['retry-after']) >= 1);
    });

    const ok = await suite.run();
    await new Promise(resolve => server.close(resolve));
    return ok;
};
