'use strict';

const http = require('http');
const { createSuite, axiosError, networkError } = require('./harness');
const { createApp } = require('../app');
const config = require('../config');
const ownRateLimit = require('../security/rateLimit');
const robloxRateLimiter = require('../roblox/rateLimiter');
const db = require('../db/pool');
const roblox = require('../roblox/client');
const cache = require('../cache/cacheStore');
const singleFlight = require('../cache/singleFlight');
const licenseToken = require('../security/licenseToken');
const observability = require('../observability/metrics');

// POST /v1/outfits/batch — por HTTP real y SIN red hacia fuera.
//
// EL PORQUE DE ESTE ENDPOINT, MEDIDO DEL LADO DE ROBLOX: el buscador enseña
// hasta 24 outfits y cada GetOutfit cuesta 3 fichas del limitador del servidor
// de Roblox, con un cubo de 40 y recarga de 8/s. Veinticuatro llamadas cuestan
// 72 fichas y once se quedan sin datos aunque el cliente limite el pico a
// cinco. Con un lote, el juego gasta 3 fichas en vez de 72.
//
// Lo que este archivo protege, por orden de importancia:
//   1. Que un outfit que falla NO tumba el lote — es lo que hace utilizable
//      esto sobre outfits reales, donde siempre hay alguno borrado.
//   2. Que la licencia se comprueba IGUAL que en la ruta individual.
//   3. Que la cache, el single-flight y la deduplicacion de verdad evitan
//      llamadas, que es el motivo entero de existir del endpoint.

const GROUP_ID = '35216530';
const PLACE_ID = '1234567890';
const UNIVERSE_ID = '5432109876';

function pedir(port, ruta, { metodo = 'POST', cuerpo, headers = {} } = {}) {
    ownRateLimit.reset();
    const payload = cuerpo === undefined ? null : JSON.stringify(cuerpo);
    const cabeceras = { ...headers };
    if (payload !== null) {
        cabeceras['content-type'] = 'application/json';
        cabeceras['content-length'] = Buffer.byteLength(payload);
    }

    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: ruta, method: metodo, headers: cabeceras }, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch { /* no-JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
            });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

module.exports = async function run() {
    const suite = createSuite('outfitsBatch');
    const { test, assert } = suite;

    const app = createApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;

    // ── Licencia viva, igual que en licensedDataRoutes ──────────────────────
    const TOKEN = licenseToken.generateToken();
    const original = {
        query: db.query,
        universo: roblox.getUniverseIdForPlace,
        dueño: roblox.getUniverseOwner,
        detalles: roblox.getOutfitDetailsRaw,
    };

    db.query = async () => ({
        rows: [{ group_id: GROUP_ID, active: true, license_token_hash: licenseToken.hashToken(TOKEN) }],
        rowCount: 1,
    });
    roblox.getUniverseIdForPlace = async () => UNIVERSE_ID;
    roblox.getUniverseOwner = async () => ({ creatorType: 'Group', creatorId: GROUP_ID, universeId: UNIVERSE_ID });

    const AUTORIZADO = {
        'x-license-token': TOKEN,
        'x-game-id': UNIVERSE_ID,
        'x-place-id': PLACE_ID,
    };

    const lote = (port, outfitIds, headers = AUTORIZADO) =>
        pedir(port, '/v1/outfits/batch', { cuerpo: { outfitIds }, headers });

    // ── Doble de Roblox: un outfit por id, con fallos a medida ──────────────
    let mundo = {};
    const llamadas = { detalles: 0 };

    function poblar({ falla = () => null, retraso = 0 } = {}) {
        mundo = { falla, retraso };
        llamadas.detalles = 0;
        cache.reset();
        singleFlight.reset();
        robloxRateLimiter.reset();
    }

    // El doble pasa POR EL LIMITADOR REAL, igual que el cliente de verdad. Es lo
    // que hace fiel al test: asi los errores se clasifican como en produccion
    // (un 404 crudo se convierte en outfit_not_found), el cubo correcto recibe
    // el 429 y las llamadas se contabilizan. Un throw suelto se saltaria justo
    // las piezas que este endpoint tiene que respetar.
    roblox.getOutfitDetailsRaw = async outfitId => robloxRateLimiter.run('outfitDetails', async () => {
        llamadas.detalles++;
        const fallo = mundo.falla(outfitId);
        if (fallo) throw fallo;
        if (mundo.retraso) await new Promise(r => setTimeout(r, mundo.retraso));
        return { data: contenidoDe(outfitId) };
    }, {
        endpoint: 'avatar.roblox.com/v3/outfits/{id}/details',
        notFoundCode: 'outfit_not_found',
    }).then(respuesta => respuesta.data);

    function contenidoDe(outfitId) {
        return {
            id: outfitId,
            name: `Outfit ${outfitId}`,
            assets: [{ id: outfitId * 10, name: 'Hat', assetType: { id: 8, name: 'Hat' } }],
            bodyColor3s: {}, scale: {}, playerAvatarType: 'R15',
            outfitType: 'Avatar', isEditable: true,
        };
    }

    const ids = n => Array.from({ length: n }, (_, i) => 1000 + i);

    // Manda el cuerpo TAL CUAL, sin serializar: es la unica forma de probar un
    // JSON roto o un cuerpo por encima del limite del parser.
    function crudo(payload, headers = AUTORIZADO) {
        ownRateLimit.reset();
        const cabeceras = {
            ...headers,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
        };
        return new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port, path: '/v1/outfits/batch', method: 'POST', headers: cabeceras,
            }, res => {
                let d = '';
                res.on('data', c => { d += c; });
                res.on('end', () => {
                    let body = null;
                    try { body = JSON.parse(d); } catch { /* no-JSON */ }
                    resolve({ status: res.statusCode, body, raw: d });
                });
            });
            req.on('error', reject);
            req.write(payload);
            req.end();
        });
    }

    // ── Tamaños ─────────────────────────────────────────────────────────────

    for (const cuantos of [1, 5, 10, 24]) {
        test(`un lote de ${cuantos} ids devuelve ${cuantos} resultados en UNA peticion`, async () => {
            poblar();
            const res = await lote(port, ids(cuantos));

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.requested, cuantos);
            assert.strictEqual(res.body.unique, cuantos);
            assert.strictEqual(res.body.succeeded, cuantos);
            assert.strictEqual(res.body.failed, 0);
            assert.strictEqual(res.body.results.length, cuantos);
            assert.strictEqual(llamadas.detalles, cuantos,
                'una llamada a Roblox por outfit sin cachear, ni una mas');

            for (const resultado of res.body.results) {
                assert.strictEqual(resultado.ok, true);
                assert.ok(Number.isInteger(resultado.outfitId), 'falta el outfitId explicito');
                assert.strictEqual(resultado.outfit.id, resultado.outfitId);
            }
        });
    }

    test('los 24 del buscador salen en una sola peticion HTTP', async () => {
        // Es LA razon de ser del endpoint: 24 GetOutfit desde Lua cuestan 72
        // fichas contra un cubo de 40. Aqui es una peticion.
        poblar();
        const res = await lote(port, ids(24));
        assert.strictEqual(res.body.succeeded, 24);
        assert.strictEqual(res.body.stats.upstreamCalls, 24);
    });

    // ── Orden y duplicados ──────────────────────────────────────────────────

    test('el orden de los resultados es el de los ids pedidos', async () => {
        poblar();
        const pedidos = [4004, 1001, 9009, 2002, 7007];
        const res = await lote(port, pedidos);

        assert.deepStrictEqual(res.body.results.map(r => r.outfitId), pedidos,
            'los resultados no conservan el orden de la peticion');
    });

    test('los ids repetidos se deduplican y solo cuestan una llamada', async () => {
        poblar();
        const res = await lote(port, [1001, 1001, 2002, 1001, 2002]);

        assert.strictEqual(res.body.requested, 5);
        assert.strictEqual(res.body.unique, 2);
        assert.strictEqual(res.body.results.length, 2, 'un id repetido deberia salir una sola vez');
        assert.deepStrictEqual(res.body.results.map(r => r.outfitId), [1001, 2002],
            'el orden deberia ser el de primera aparicion');
        assert.strictEqual(llamadas.detalles, 2, 'se llamo a Roblox por un id repetido');
    });

    // ── Cache ───────────────────────────────────────────────────────────────

    test('un lote ya cacheado no gasta ni una llamada a Roblox', async () => {
        // Conjunto pequeño a proposito: el runner de la suite baja
        // CACHE_MAX_ENTRIES a 5 para poder ejercitar la expulsion LRU en
        // cache.test.js, asi que un lote grande se expulsaria a si mismo y este
        // caso no probaria la cache, sino la expulsion.
        poblar();
        await lote(port, ids(3));
        assert.strictEqual(llamadas.detalles, 3);

        llamadas.detalles = 0;
        const segunda = await lote(port, ids(3));

        assert.strictEqual(segunda.body.succeeded, 3);
        assert.strictEqual(llamadas.detalles, 0, 'la segunda vez volvio a llamar a Roblox');
        assert.strictEqual(segunda.body.stats.cacheHits, 3);
        assert.strictEqual(segunda.body.stats.cacheMisses, 0);
        assert.strictEqual(segunda.body.stats.upstreamCalls, 0);
    });

    test('un lote mixto solo pide a Roblox lo que le falta', async () => {
        poblar();
        await lote(port, [1001, 1002]);   // se calientan dos
        llamadas.detalles = 0;

        const res = await lote(port, [1001, 1002, 1003, 1004]);

        assert.strictEqual(res.body.stats.cacheHits, 2);
        assert.strictEqual(res.body.stats.cacheMisses, 2);
        assert.strictEqual(llamadas.detalles, 2, 'pidio a Roblox algo que ya tenia en cache');
        assert.strictEqual(res.body.succeeded, 4);
    });

    // ── Fallos parciales ────────────────────────────────────────────────────

    test('un outfit borrado no tumba el lote: falla solo el suyo', async () => {
        poblar({ falla: id => (id === 1002 ? axiosError(404) : null) });
        const res = await lote(port, [1001, 1002, 1003]);

        assert.strictEqual(res.status, 200, 'un 404 de un outfit no puede ser un error de la peticion');
        assert.strictEqual(res.body.succeeded, 2);
        assert.strictEqual(res.body.failed, 1);

        const caido = res.body.results.find(r => r.outfitId === 1002);
        assert.strictEqual(caido.ok, false);
        assert.strictEqual(caido.error.code, 'outfit_not_found');
        assert.ok(!('outfit' in caido), 'un resultado fallido no deberia traer outfit');

        for (const id of [1001, 1003]) {
            assert.strictEqual(res.body.results.find(r => r.outfitId === id).ok, true);
        }
    });

    test('varios fallos distintos conviven en el mismo lote', async () => {
        poblar({
            falla: id => {
                if (id === 1002) return axiosError(404);
                if (id === 1003) return networkError();
                return null;
            },
        });

        const res = await lote(port, [1001, 1002, 1003, 1004]);

        assert.strictEqual(res.body.succeeded, 2);
        assert.strictEqual(res.body.failed, 2);
        assert.strictEqual(res.body.results.find(r => r.outfitId === 1002).error.code, 'outfit_not_found');
        assert.strictEqual(res.body.results.find(r => r.outfitId === 1003).error.code, 'upstream_error');
    });

    test('un 429 de Roblox se reporta por id y NO se cachea como respuesta valida', async () => {
        poblar({ falla: id => (id === 1002 ? axiosError(429, { 'retry-after': '30' }) : null) });

        const res = await lote(port, [1001, 1002]);
        const limitado = res.body.results.find(r => r.outfitId === 1002);

        assert.strictEqual(res.status, 200);
        assert.strictEqual(limitado.ok, false);
        assert.strictEqual(limitado.error.code, 'upstream_rate_limited');
        assert.ok(limitado.error.retryAfterSeconds > 0, 'un 429 deberia decir cuanto esperar');

        // Y sobre todo: NO se guardo nada. Al reintentar con Roblox sano, el
        // outfit se resuelve — si el 429 se hubiera cacheado, seguiria fallando.
        robloxRateLimiter.reset();
        mundo.falla = () => null;
        const reintento = await lote(port, [1002]);
        assert.strictEqual(reintento.body.results[0].ok, true,
            'el 429 quedo cacheado como si fuera una respuesta valida');
    });

    test('un 5xx tampoco se cachea', async () => {
        poblar({ falla: id => (id === 1005 ? axiosError(500) : null) });
        const primero = await lote(port, [1005]);
        assert.strictEqual(primero.body.results[0].ok, false);

        robloxRateLimiter.reset();
        mundo.falla = () => null;
        const segundo = await lote(port, [1005]);
        assert.strictEqual(segundo.body.results[0].ok, true, 'el 5xx quedo cacheado');
    });

    // ── single-flight ───────────────────────────────────────────────────────

    test('dos lotes simultaneos con los mismos ids comparten vuelo', async () => {
        // Con retraso, los dos lotes se solapan de verdad: el segundo encuentra
        // los vuelos del primero en curso y se engancha en vez de abrir otros.
        poblar({ retraso: 40 });

        const [a, b] = await Promise.all([lote(port, ids(6)), lote(port, ids(6))]);

        assert.strictEqual(a.body.succeeded, 6);
        assert.strictEqual(b.body.succeeded, 6);
        assert.strictEqual(llamadas.detalles, 6,
            `dos lotes identicos gastaron ${llamadas.detalles} llamadas en vez de 6`);

        const joins = a.body.stats.singleFlightJoins + b.body.stats.singleFlightJoins;
        assert.ok(joins > 0, 'no se registro ningun enganche a un vuelo en curso');
    });

    test('un id repetido DENTRO del lote no abre dos vuelos', async () => {
        poblar({ retraso: 20 });
        await lote(port, [1001, 1001, 1001, 1001]);
        assert.strictEqual(llamadas.detalles, 1);
    });

    // ── Licencia: exactamente la misma que la ruta individual ───────────────

    test('sin token de licencia el lote se rechaza IGUAL que la ruta individual', async () => {
        poblar();

        // 400 y no 401: la cabecera que falta la caza `parseLicenseTokenHeader`
        // como cuerpo mal formado, y ese es el comportamiento que /v1/outfits
        // lleva teniendo desde siempre (ver licensedDataRoutes). Lo que importa
        // aqui no es el numero, es que el lote NO relaja nada: se rechaza en la
        // misma capa y con el mismo codigo que un outfit suelto.
        const delLote = await lote(port, ids(3), {});
        const individual = await pedir(port, '/v1/outfits/1001', { metodo: 'GET' });

        assert.strictEqual(delLote.status, individual.status,
            'el lote y la ruta individual deberian rechazarse igual sin token');
        assert.strictEqual(delLote.status, 400);
        assert.strictEqual(delLote.body.error.code, individual.body.error.code);
        assert.strictEqual(llamadas.detalles, 0, 'llamo a Roblox sin licencia');
    });

    test('con token pero sin los ids del juego, 400 y sin tocar Roblox', async () => {
        poblar();
        const res = await lote(port, ids(3), { 'x-license-token': TOKEN });

        assert.strictEqual(res.status, 400);
        assert.strictEqual(llamadas.detalles, 0);
    });

    test('un juego que NO es del grupo con licencia recibe 403', async () => {
        poblar();
        roblox.getUniverseOwner = async () => ({
            creatorType: 'Group', creatorId: '99999999', universeId: UNIVERSE_ID,
        });

        try {
            const res = await lote(port, ids(3));
            assert.strictEqual(res.status, 403);
            assert.strictEqual(llamadas.detalles, 0, 'resolvio outfits para un juego sin licencia');
        } finally {
            roblox.getUniverseOwner = async () => ({
                creatorType: 'Group', creatorId: GROUP_ID, universeId: UNIVERSE_ID,
            });
        }
    });

    test('la licencia se comprueba UNA sola vez por lote', async () => {
        poblar();
        let comprobaciones = 0;
        const universoBase = roblox.getUniverseIdForPlace;
        roblox.getUniverseIdForPlace = async (...args) => { comprobaciones++; return universoBase(...args); };

        try {
            cache.reset(); // sin cache de propiedad: la verificacion sale de verdad
            await lote(port, ids(24));
            assert.strictEqual(comprobaciones, 1,
                `la propiedad del juego se verifico ${comprobaciones} veces para un solo lote`);
        } finally {
            roblox.getUniverseIdForPlace = universoBase;
        }
    });

    // ── Limites y validacion ────────────────────────────────────────────────

    test('el tope de ids admite holgadamente los 24 del buscador', async () => {
        assert.ok(config.outfitsBatch.maxIds >= 24,
            `el tope es ${config.outfitsBatch.maxIds} y el buscador necesita 24`);
    });

    test('pasarse del tope es 400 y no cuesta ni una llamada', async () => {
        poblar();
        const res = await lote(port, ids(config.outfitsBatch.maxIds + 1));

        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error.code, 'invalid_request');
        assert.strictEqual(llamadas.detalles, 0);
    });

    test('una lista vacia, ausente o con basura es 400', async () => {
        poblar();
        for (const cuerpo of [{}, { outfitIds: [] }, { outfitIds: 'x' }, { outfitIds: [1001, 'abc'] }, { outfitIds: [0] }]) {
            const res = await pedir(port, '/v1/outfits/batch', { cuerpo, headers: AUTORIZADO });
            assert.strictEqual(res.status, 400, `deberia rechazar ${JSON.stringify(cuerpo)}`);
            assert.strictEqual(res.body.error.code, 'invalid_request');
        }
        assert.strictEqual(llamadas.detalles, 0);
    });

    test('sin Content-Type json es 400, no 500', async () => {
        poblar();
        const res = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port, path: '/v1/outfits/batch', method: 'POST', headers: AUTORIZADO,
            }, r => {
                let d = ''; r.on('data', c => { d += c; });
                r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(d) }));
            });
            req.on('error', reject);
            req.end();
        });
        assert.strictEqual(res.status, 400);
    });

    // ── Metricas y latencias ────────────────────────────────────────────────

    test('stats trae el desglose completo y sin datos sensibles', async () => {
        poblar();
        const res = await lote(port, [1001, 1001, 1002]);
        const s = res.body.stats;

        for (const campo of ['requested', 'unique', 'succeeded', 'failed',
            'cacheHits', 'cacheMisses', 'singleFlightJoins', 'upstreamCalls']) {
            assert.ok(Number.isInteger(s[campo]), `stats.${campo} deberia ser un entero`);
        }
        assert.strictEqual(s.requested, 3);
        assert.strictEqual(s.unique, 2);
        assert.strictEqual(s.upstreamCalls, 2);

        for (const campo of ['licenseMs', 'cacheMs', 'rateLimiterWaitMs', 'robloxMs', 'totalMs']) {
            const valor = s.timings[campo];
            assert.ok(valor === null || (Number.isFinite(valor) && valor >= 0),
                `timings.${campo} invalido: ${valor}`);
        }

        // Ni el token ni el hash de licencia pueden aparecer en la respuesta.
        assert.ok(!res.raw.includes(TOKEN), 'el token de licencia se filtro en la respuesta');
    });

    test('las latencias reparten el tiempo entre espera y Roblox', async () => {
        poblar({ retraso: 30 });
        const res = await lote(port, ids(4));
        const t = res.body.stats.timings;

        assert.ok(t.robloxMs >= 30, `robloxMs (${t.robloxMs}) deberia recoger el retraso real`);
        assert.ok(t.totalMs >= 30);
        assert.ok(t.rateLimiterWaitMs >= 0);
        // Con cuatro llamadas y un gate de 3, algo de espera tiene que haber.
        assert.ok(t.robloxMs + t.rateLimiterWaitMs > 0);
    });

    // ── Cuerpos mal formados y desmedidos ───────────────────────────────────
    //
    // Los dos casos los resuelve el parser de cuerpo, no la validacion, y por
    // eso hay que fijarlos: son la clase de cosa que se rompe en silencio al
    // tocar el limite del parser o el orden de los middlewares, y el sintoma
    // seria un 500 culpando al servidor de un error del cliente.

    test('JSON malformado -> 400, no 500', async () => {
        poblar();
        const res = await crudo('{"outfitIds": [1001, 1002');

        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error.code, 'invalid_request');
        assert.strictEqual(llamadas.detalles, 0, 'llego a Roblox con un cuerpo roto');
    });

    test('un cuerpo por encima de 8kb -> 413, y no se parsea', async () => {
        poblar();

        // Ids largos de sobra para pasar del limite del parser sin depender del
        // tope de `outfitIds`: lo que tiene que cortar aqui es el TAMAÑO, antes
        // de que la validacion llegue siquiera a contar cuantos ids hay.
        const payload = JSON.stringify({
            outfitIds: Array.from({ length: 900 }, (_, i) => 10_000_000_000 + i),
        });
        assert.ok(Buffer.byteLength(payload) > 8 * 1024,
            'el cuerpo de prueba deberia pasar de 8kb');

        const res = await crudo(payload);

        assert.strictEqual(res.status, 413);
        assert.strictEqual(res.body.error.code, 'payload_too_large');
        assert.strictEqual(llamadas.detalles, 0);
    });

    test('un cuerpo grande pero por debajo del limite se valida con normalidad', async () => {
        // Justo por el otro lado de la frontera: aqui el que corta es el tope de
        // ids, no el parser, y el codigo tiene que ser el de validacion.
        poblar();
        const payload = JSON.stringify({
            outfitIds: Array.from({ length: 200 }, (_, i) => 1000 + i),
        });
        assert.ok(Buffer.byteLength(payload) < 8 * 1024);

        const res = await crudo(payload);
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error.code, 'invalid_request');
        assert.ok(/maximo/.test(res.body.error.message), 'deberia quejarse del numero de ids');
    });

    // ── Metricas acumuladas en /v1/metrics ──────────────────────────────────

    test('el lote alimenta los contadores acumulados del proceso', async () => {
        poblar();
        observability.reset();

        await lote(port, [1001, 1001, 1002]);   // 3 pedidos, 2 unicos, 2 upstream
        await lote(port, [1002, 1003]);          // 1 hit (1002) + 1 miss

        const m = observability.getBatchMetrics();

        assert.strictEqual(m.requests, 2);
        assert.strictEqual(m.idsRequested, 5);
        assert.strictEqual(m.idsUnique, 4);
        assert.strictEqual(m.cacheHits, 1);
        assert.strictEqual(m.cacheMisses, 3);
        assert.strictEqual(m.upstreamCalls, 3);
        assert.strictEqual(m.succeeded, 4);
        assert.strictEqual(m.failed, 0);

        // Lo que el lote AHORRO: ids pedidos que no acabaron en una llamada.
        assert.strictEqual(m.savedCalls, 2);
    });

    test('los fallos parciales se acumulan sin contaminar los aciertos', async () => {
        poblar({ falla: id => (id === 1002 ? axiosError(404) : null) });
        observability.reset();

        await lote(port, [1001, 1002, 1003]);
        const m = observability.getBatchMetrics();

        assert.strictEqual(m.succeeded, 2);
        assert.strictEqual(m.failed, 1);
        assert.strictEqual(m.requests, 1);
    });

    test('/v1/metrics publica el bloque del lote y no filtra nada sensible', async () => {
        poblar();
        observability.reset();
        await lote(port, ids(3));

        const res = await pedir(port, '/v1/metrics', {
            metodo: 'GET', headers: { 'x-api-key': config.apiKey },
        });

        assert.strictEqual(res.status, 200);
        assert.ok(res.body.outfitsBatch, 'a /v1/metrics le falta el bloque outfitsBatch');

        const esperados = ['requests', 'idsRequested', 'idsUnique', 'cacheHits', 'cacheMisses',
            'singleFlightJoins', 'upstreamCalls', 'succeeded', 'failed', 'savedCalls'];
        assert.deepStrictEqual(Object.keys(res.body.outfitsBatch).sort(), [...esperados].sort());

        for (const [clave, valor] of Object.entries(res.body.outfitsBatch)) {
            assert.ok(Number.isInteger(valor), `outfitsBatch.${clave} deberia ser un entero`);
        }
        assert.strictEqual(res.body.outfitsBatch.requests, 1);

        // Ni el token de licencia ni la api key pueden aparecer en las metricas.
        assert.ok(!res.raw.includes(TOKEN), 'el token de licencia se filtro en /v1/metrics');
        assert.ok(!res.raw.includes(config.apiKey), 'la api key se filtro en /v1/metrics');
    });

    const ok = await suite.run();

    db.query = original.query;
    roblox.getUniverseIdForPlace = original.universo;
    roblox.getUniverseOwner = original.dueño;
    roblox.getOutfitDetailsRaw = original.detalles;
    cache.reset();
    singleFlight.reset();
    ownRateLimit.reset();
    robloxRateLimiter.reset();
    await new Promise(resolve => server.close(resolve));
    return ok;
};
