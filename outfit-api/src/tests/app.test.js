'use strict';

const http = require('http');
const { createSuite, captureStdout } = require('./harness');
const { createApp } = require('../app');
const config = require('../config');
const logger = require('../observability/logger');
const ownRateLimit = require('../security/rateLimit');
const robloxRateLimiter = require('../roblox/rateLimiter');
const db = require('../db/pool');
const roblox = require('../roblox/client');
const licenseToken = require('../security/licenseToken');

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

    // Las rutas de datos que consume el juego (/v1/users, /v1/outfits) van
    // ahora con el token de licencia y NADA mas: el comprador configura un
    // solo Secret. Se sustituye db.query por una licencia viva para que estos
    // tests puedan seguir ejercitando lo suyo, que es la VALIDACION de
    // parametros — la del token tiene su propio archivo.
    const TOKEN = licenseToken.generateToken();
    const GROUP_ID = '35216530';
    const PLACE_ID = '1234567890';
    const UNIVERSE_ID = '5432109876';

    const queryOriginal = db.query;
    db.query = async () => ({
        rows: [{ group_id: GROUP_ID, active: true, license_token_hash: licenseToken.hashToken(TOKEN) }],
        rowCount: 1,
    });

    // Las rutas de datos resuelven ahora la propiedad REAL de la experiencia
    // contra Roblox antes de dejar pasar nada. Se sustituyen las dos llamadas
    // por un doble que dice "este place es del grupo con licencia": lo que
    // ejercita este archivo es el CABLEADO y la validacion de parametros, no
    // la cadena de autorizacion — esa tiene sus propios archivos.
    const propiedadOriginal = {
        getUniverseIdForPlace: roblox.getUniverseIdForPlace,
        getUniverseOwner: roblox.getUniverseOwner,
    };
    roblox.getUniverseIdForPlace = async () => UNIVERSE_ID;
    roblox.getUniverseOwner = async universeId => ({
        universeId, rootPlaceId: PLACE_ID, name: 'Juego de prueba',
        creatorType: 'Group', creatorId: GROUP_ID, creatorName: 'Grupo de prueba',
    });

    // El juego manda SIEMPRE los dos ids de la experiencia: son con lo que se
    // le pregunta a Roblox de quien es. Sin ellos la peticion es un 400, asi
    // que sin ellos estos tests no probarian lo que dicen probar.
    const auth = { 'x-license-token': TOKEN, 'x-game-id': UNIVERSE_ID, 'x-place-id': PLACE_ID };
    const authMetrics = { 'x-api-key': KEY };   // /v1/metrics no se migra: es observabilidad nuestra

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
            request(port, '/v1/metrics', authMetrics),
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
        const res = await request(port, '/v1/metrics', authMetrics);
        assert.ok(res.headers['x-request-id'], 'hace falta un id para poder cruzar log y reporte');
        assert.match(res.headers['x-request-id'], /^[0-9a-f-]{36}$/);
    });

    test('una ruta inexistente -> 404 route_not_found', async () => {
        // Con la clave de /v1: asi la peticion llega al router y se ve el 404
        // de verdad. Sin credencial ninguna, un prefijo desconocido responde
        // 401 y no revela que rutas existen, que tambien es lo correcto.
        const res = await request(port, '/v1/no-existe', authMetrics);
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
            '/v1/users/156/outfits?page=2',          // Roblox ignora page: se rechaza en vez de fingir
            '/v1/users/156/outfits?pageToken=',      // cursor vacio
            '/v1/users/156/outfits?pageToken=%C2%BFacentos%3F', // no puede ser base64
            '/v1/users/156/outfits?outfitType=Basura', // tipo que Roblox no usa
            '/v1/users/156/outfits?outfitType=avatar',  // Roblox distingue mayusculas
            '/v1/outfits/abc',                       // outfitId no numerico
            '/v1/outfits/123?bundles=yes',           // bandera ambigua
            '/v1/outfits/123?catalog=yes',
        ];

        for (const path of casos) {
            const res = await request(port, path, auth);
            assert.strictEqual(res.status, 400, `${path} debia dar 400`);
            assert.strictEqual(res.body.error.code, 'invalid_request');
        }

        // Lo importante: rechazar en el borde cuesta microsegundos y CERO
        // trafico saliente hacia los endpoints de DATOS. Una peticion basura no
        // puede gastar cuota de usernameLookup / outfitList / outfitDetails.
        //
        // (La propiedad de la experiencia si se resuelve antes que el
        // parametro, porque la puerta va delante de la ruta. Cuesta dos
        // llamadas la PRIMERA vez que se ve un placeId y ninguna despues: se
        // cachea 6 h. Aqui esta ademas sustituida por un doble, que no pasa por
        // el limitador y por eso no mueve estos contadores.)
        assert.deepStrictEqual(robloxCallCounts(), before);
    });

    test('GET /v1/metrics devuelve las secciones de observabilidad', async () => {
        const res = await request(port, '/v1/metrics', authMetrics);
        assert.strictEqual(res.status, 200);
        for (const seccion of ['process', 'http', 'cache', 'ownRateLimit', 'roblox']) {
            assert.ok(res.body[seccion], `falta la seccion ${seccion}`);
        }
        assert.ok(res.body.roblox.byRoute.usernameLookup, 'debe verse el estado por ruta de Roblox');
        assert.ok('state' in res.body.roblox.byRoute.usernameLookup.circuit);
        // El camino opcional de bundles tiene bucket propio: asi se ve por
        // separado si esta consumiendo cuota o con el circuito abierto, sin
        // confundirlo con los tres endpoints principales.
        assert.ok(res.body.roblox.byRoute.assetBundles, 'assetBundles debe medirse aparte');
        assert.ok(res.body.roblox.byRoute.catalogDetails, 'catalogDetails debe medirse aparte');
    });

    test('el 400 de page explica cual es el mecanismo real', async () => {
        const res = await request(port, '/v1/users/156/outfits?page=2', auth);
        assert.strictEqual(res.status, 400);
        assert.match(res.body.error.message, /pageToken/);
        assert.match(res.body.error.message, /ignora/);
    });

    test('el limite propio corta con 429 y Retry-After', async () => {
        ownRateLimit.reset(); // el tope es 25 en el runner
        const { maxPerWindow } = ownRateLimit.getMetrics();

        for (let i = 0; i < maxPerWindow; i++) {
            const res = await request(port, '/v1/metrics', authMetrics);
            assert.strictEqual(res.status, 200, `la peticion ${i + 1} debia pasar`);
        }

        const res = await request(port, '/v1/metrics', authMetrics);
        assert.strictEqual(res.status, 429);
        // 429 = limite NUESTRO. Es un codigo distinto del 503 que devuelve un
        // limite de Roblox, justamente para que el juego pueda reaccionar bien
        // a cada uno.
        assert.strictEqual(res.body.error.code, 'rate_limited');
        assert.ok(Number(res.headers['retry-after']) >= 1);
    });

    const ok = await suite.run();

    db.query = queryOriginal;
    Object.assign(roblox, propiedadOriginal);
    await new Promise(resolve => server.close(resolve));
    return ok;
};
