'use strict';

const http = require('http');
const { createSuite, axiosError } = require('./harness');
const { createApp } = require('../app');
const config = require('../config');
const roblox = require('../roblox/client');
const cache = require('../cache/cacheStore');
const limitador = require('../roblox/rateLimiter');
const ownRateLimit = require('../security/rateLimit');
const colaDeGrupos = require('../services/pluginSearch/groupQueue');
const rotationRepo = require('../db/pluginRotationRepo');
const jobRepo = require('../db/pluginJobRepo');
const avatarRepo = require('../db/avatarIndexRepo');
const crawlRepo = require('../db/indexCrawlRepo');
const memberRepo = require('../db/groupMemberRepo');
const catalogoRepo = require('../db/assetCatalogRepo');
const pool = require('../db/pool');
const jobs = require('../services/pluginSearch/jobs');
const { crearWorker } = require('../services/indexWorker/worker');
const { crearBaseFalsa } = require('./fakeDb');

// EL WORKER RESUELVE AVATARES POR v2.
//
// Lo que se midio en Railway, y que es la razon de todo este archivo:
//
//   v1  seis por HORA, y contestando 429. Cuarenta y dos avatares indexados
//       sobre 111.653 miembros conocidos.
//   v2  cincuenta llamadas seguidas sin un solo 429; doscientas sostenidas a
//       3,59 por segundo con 199 respuestas buenas y un 500 suelto.
//
// De ahi las cuatro decisiones que estos casos vigilan:
//
//   BUCKET PROPIO   v1 esta cerrada permanentemente. Si compartieran cuota, su
//                   cooldown congelaria tambien a v2 — el unico camino que
//                   funciona.
//   SIN RESPALDO    caer a v1 gastaria su unica llamada por hora y marcaria su
//                   ruta como limitada, sin obtener nada.
//   RITMO PROPIO    3 por segundo desde la primera llamada, por debajo de lo
//                   medido. La cabecera anuncia numeros enormes y ya demostro
//                   no ser un contador fiable.
//   MISMA FORMA     assets, assetType y cuenta de accesorios, identicos a v1.

const GRUPO = 59218460;
const T = { Hat: 8, Hair: 41, Back: 46, Waist: 47, Shirt: 11, Torso: 27 };

module.exports = async function run() {
    const suite = createSuite('indexWorkerV2');
    const { test, assert } = suite;

    const original = {
        listGroupMembers: roblox.listGroupMembers,
        getCurrentAvatar: roblox.getCurrentAvatar,
        getCurrentAvatarV2: roblox.getCurrentAvatarV2,
        getCatalogItemDetails: roblox.getCatalogItemDetails,
        getBundlesForAsset: roblox.getBundlesForAsset,
        rotationRepo: { ...rotationRepo },
        jobRepo: { ...jobRepo },
        avatarRepo: { ...avatarRepo },
        crawlRepo: { ...crawlRepo },
        memberRepo: { ...memberRepo },
        catalogoRepo: { ...catalogoRepo },
        pool: { isConfigured: pool.isConfigured, withTransaction: pool.withTransaction },
        cfg: { ...config.indexWorker },
        serveEnabled: config.indexServe.enabled,
        minAccessories: config.pluginSearch.minAccessories,
        cache: config.cache.maxEntries,
    };

    config.indexWorker.crawlPagesPerCycle = 1;
    config.indexWorker.avatarsPerCycle = 10;
    config.indexWorker.pricingBatchUsers = 40;
    config.indexWorker.leaseMs = 5_000;
    config.indexWorker.avatarTtlMs = 600_000;
    config.indexWorker.priceTtlMs = 300_000;
    config.indexWorker.catalogTtlMs = 300_000;
    config.indexWorker.revisitEveryMs = 0;
    config.pluginSearch.minAccessories = 3;
    config.cache.maxEntries = 20_000;

    const base = crearBaseFalsa();
    base.instalar();

    const app = createApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;

    const mundo = {
        miembros: 0,
        v1: 0, v2: 0,                 // llamadas por version
        v2Falla: null,                // (userId, n) -> Error | null
        pocosAccesorios: new Set(),
    };

    roblox.listGroupMembers = async (groupId, { cursor = null } = {}) => {
        const pagina = cursor ? Number(String(cursor).slice(1)) : 0;
        const desde = pagina * 100;
        const hasta = Math.min(desde + 100, mundo.miembros);
        const members = [];
        for (let i = desde; i < hasta; i++) members.push({ userId: 1000 + i, username: `U${1000 + i}` });
        return { members, nextCursor: hasta < mundo.miembros ? `p${pagina + 1}` : null };
    };

    // El cuerpo que devuelve v2 es el MISMO que el de v1: assets con assetType
    // anidado. Por eso los dos dobles construyen lo mismo.
    const cuerpoDeAvatar = u => {
        const tipos = mundo.pocosAccesorios.has(u)
            ? [T.Shirt, T.Torso]                    // ninguno cuenta como accesorio
            : [T.Hat, T.Hair, T.Back, T.Waist];
        return {
            assets: tipos.map((tipo, i) => ({
                id: 100 + ((u + i * 7) % 25),
                name: `A${i}`,
                assetType: { id: tipo, name: `T${tipo}` },
            })),
            playerAvatarType: 'R15',
        };
    };

    // v1: la ruta vieja. En estos casos esta CERRADA, como en produccion.
    roblox.getCurrentAvatar = async userId => {
        const r = await limitador.run('userAvatar', async () => {
            mundo.v1++;
            return { status: 200, headers: {}, data: cuerpoDeAvatar(Number(userId)) };
        }, { endpoint: 'avatar.roblox.com/v1/users/{id}/avatar', notFoundCode: 'user_not_found' });
        return roblox.normalizeAvatarAssets(r.data);
    };

    // v2: la ruta del worker, con su propio bucket.
    roblox.getCurrentAvatarV2 = async userId => {
        const r = await limitador.run('userAvatarV2', async () => {
            mundo.v2++;
            const fallo = mundo.v2Falla?.(Number(userId), mundo.v2);
            if (fallo) throw fallo;
            return { status: 200, headers: {}, data: cuerpoDeAvatar(Number(userId)) };
        }, { endpoint: 'avatar.roblox.com/v2/avatar/users/{id}/avatar', notFoundCode: 'user_not_found' });
        return roblox.normalizeAvatarAssets(r.data);
    };

    roblox.getCatalogItemDetails = async items => {
        await limitador.run('catalogDetails', async () => ({ status: 200, headers: {}, data: {} }),
            { endpoint: 'catalog.roblox.com/v1/catalog/items/details' });
        const mapa = new Map();
        for (const item of items) {
            mapa.set(roblox.catalogKey('Asset', item.id), {
                available: true, assetTypeId: 8, isLimited: false, offSale: false, price: 200,
            });
        }
        return mapa;
    };
    roblox.getBundlesForAsset = async () => [];

    function poblar({ miembros = 200 } = {}) {
        Object.assign(mundo, { miembros, v1: 0, v2: 0, v2Falla: null, pocosAccesorios: new Set() });
        cache.reset();
        limitador.reset();
        colaDeGrupos.reset();
        jobs.reset();
        base.limpiar();
    }

    // v1 cerrada de por vida, como en Railway.
    const cerrarV1 = () => { limitador.__buckets.userAvatar.cooldownUntil = Date.now() + 60 * 60_000; };
    const cerrarV2 = (ms = 60_000) => { limitador.__buckets.userAvatarV2.cooldownUntil = Date.now() + ms; };

    const nuevoWorker = nombre => crearWorker({ instancia: nombre });
    const ciclos = async (worker, veces) => {
        for (let i = 0; i < veces; i++) {
            await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });
            await worker.ciclo();
        }
    };

    // ── 1. v1 bloqueada, v2 disponible ──────────────────────────────────────

    test('con v1 BLOQUEADA permanentemente, avatarsIndexed sigue subiendo por v2', async () => {
        poblar({ miembros: 200 });
        cerrarV1();

        const worker = nuevoWorker('w-v2');
        await ciclos(worker, 5);

        assert.strictEqual(mundo.v1, 0, `el worker llamo a v1 ${mundo.v1} veces`);
        assert.ok(mundo.v2 > 0, 'no llamo a v2');
        assert.ok(worker.metricas.avatarsIndexed >= 40,
            `solo indexo ${worker.metricas.avatarsIndexed} avatares con v2 libre`);
        assert.ok(base.avatares.size > 0);
    });

    test('NO hay respaldo a v1: si v2 falla, no se intenta la ruta vieja', async () => {
        poblar({ miembros: 50 });
        cerrarV1();
        mundo.v2Falla = () => axiosError(500);

        const worker = nuevoWorker('w-sin-respaldo');
        await ciclos(worker, 2);

        assert.strictEqual(mundo.v1, 0, 'se cayo a v1 cuando v2 fallo');
        assert.ok(mundo.v2 > 0);
        assert.strictEqual(base.avatares.size, 0, 'se escribio algo pese a fallar todo');
    });

    test('la forma interna es la MISMA que con v1: assets, assetType y accesorios', async () => {
        poblar({ miembros: 20 });
        cerrarV1();
        const worker = nuevoWorker('w-forma');
        await ciclos(worker, 3);

        const fila = await avatarRepo.leer(1000);
        assert.ok(fila, 'no se indexo a nadie');
        assert.strictEqual(fila.assetIds.length, 4, 'no se guardaron los assets');
        assert.deepStrictEqual(fila.assetTypeIds, [T.Hat, T.Hair, T.Back, T.Waist],
            'se perdio el tipo de cada asset');
        assert.strictEqual(fila.accessories, 4, 'la cuenta de accesorios cambio');
        assert.strictEqual(fila.state, 'valid');
        assert.ok(fila.totalPrice > 0);
    });

    // ── 2. El 500 aislado ───────────────────────────────────────────────────

    test('un 500 de UN usuario no mata el ciclo: el siguiente continua', async () => {
        poblar({ miembros: 50 });
        cerrarV1();
        // El tercero de cada ciclo revienta con un 500, como el que se vio en
        // la medicion real (199 buenas y una mala de doscientas).
        mundo.v2Falla = (userId, n) => (n === 3 ? axiosError(500) : null);

        const worker = nuevoWorker('w-500');
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });
        const r = await worker.ciclo();
        assert.strictEqual(r.hecho, true, `el ciclo no encontro trabajo: ${r.motivo}`);

        // El limitador REINTENTA un 5xx y lo absorbe, que es lo que debe pasar
        // con un fallo transitorio del servidor. Lo que se comprueba aqui es
        // que el ciclo no se corta y que los diez usuarios se procesan igual.
        assert.strictEqual(r.avataresEscritos, 10,
            `un 500 corto el ciclo: solo ${r.avataresEscritos} escritos de 10`);
        assert.ok(mundo.v2 > 10, 'no consta el reintento del 500');
    });

    test('el usuario del 500 no pierde datos buenos y queda PENDIENTE para otro ciclo', async () => {
        poblar({ miembros: 30 });
        cerrarV1();

        // Primero se indexa a todos con normalidad.
        const worker = nuevoWorker('w-500-pendiente');
        await ciclos(worker, 4);
        const antes = await avatarRepo.leer(1000);
        assert.ok(antes && antes.state === 'valid');

        // Ahora 1000 vence y su llamada devuelve 500.
        base.envejecerAvatar(1000, { avatarMs: 700_000 });
        cache.reset();
        mundo.v2Falla = userId => (userId === 1000 ? axiosError(500) : null);
        await ciclos(worker, 2);

        const despues = await avatarRepo.leer(1000);
        assert.ok(despues, 'el 500 borro la fila del usuario');
        assert.strictEqual(despues.state, antes.state, 'el 500 cambio su estado');
        assert.strictEqual(despues.totalPrice, antes.totalPrice, 'el 500 tiro su precio');

        // Y sigue en la cola: su avatar sigue vencido, asi que se reintentara.
        const cola = await avatarRepo.pendientesDeAvatar(GRUPO, {
            limite: 5, ttlAvatarMs: config.indexWorker.avatarTtlMs,
        });
        assert.ok(cola.some(c => c.userId === '1000'),
            'el usuario del 500 desaparecio de la cola en vez de quedar pendiente');

        // Cuando Roblox se recupera, entra como cualquiera.
        mundo.v2Falla = null;
        cache.reset();
        await ciclos(worker, 2);
        assert.ok((await avatarRepo.leer(1000)).avatarFetchedAt > antes.avatarFetchedAt);
    });

    // ── 3. El 429 de v2 ─────────────────────────────────────────────────────

    test('un 429 de v2 pausa SOLO v2: el crawler y el pricing siguen', async () => {
        poblar({ miembros: 400 });
        cerrarV1();

        // Se indexa un poco para que haya trabajo de precio pendiente.
        const worker = nuevoWorker('w-429-v2');
        await ciclos(worker, 2);
        for (const fila of base.avatares.values()) { fila.pricedAt = null; fila.state = 'avatar_only'; }
        base.catalogo.clear();

        const avataresAntes = mundo.v2;
        const miembrosAntes = base.miembros.size;
        const valoradosAntes = worker.metricas.usersPriced;

        cerrarV2(60_000);
        await ciclos(worker, 3);

        assert.strictEqual(mundo.v2, avataresAntes, 'salieron llamadas de v2 con su ruta cerrada');
        assert.ok(base.miembros.size > miembrosAntes,
            'el crawler se paro por un 429 de v2');
        assert.ok(worker.metricas.usersPriced > valoradosAntes,
            'el pricing se paro por un 429 de v2');
        assert.ok(worker.metricas.cooldowns > 0);
    });

    test('el cooldown de v1 NO frena a v2: son buckets independientes', async () => {
        poblar({ miembros: 100 });
        limitador.__buckets.userAvatar.cooldownUntil = Date.now() + 60 * 60_000;

        assert.strictEqual(limitador.getThrottleState('userAvatar').throttled, true);
        assert.strictEqual(limitador.getThrottleState('userAvatarV2').throttled, false,
            'el cooldown de v1 cerro tambien v2');

        const worker = nuevoWorker('w-independiente');
        await ciclos(worker, 3);
        assert.ok(worker.metricas.avatarsIndexed > 0, 'v2 no trabajo con v1 cerrada');
    });

    test('v2 sale a 3 por segundo desde la PRIMERA llamada, sin esperar un 429', async () => {
        poblar({ miembros: 20 });
        const bucket = limitador.__buckets.userAvatarV2;
        assert.strictEqual(bucket.spacingMs, config.upstream.routeMinSpacingMs.userAvatarV2,
            'v2 arranco sin marcapasos');
        assert.ok(bucket.spacingMs >= 333 && bucket.spacingMs <= 400,
            `el ritmo de v2 es ${bucket.spacingMs} ms, fuera de los 3 por segundo`);
        // Y v1 sigue arrancando suelta: el suelo es de ESTA ruta, no global.
        assert.strictEqual(limitador.__buckets.userAvatar.spacingMs, 0);
    });

    // ── 4. Lo que no debe cambiar ───────────────────────────────────────────

    test('quien no llega a 3 accesorios se sigue descartando ANTES del catalogo', async () => {
        poblar({ miembros: 20 });
        cerrarV1();
        for (let i = 0; i < 20; i += 2) mundo.pocosAccesorios.add(1000 + i);

        const worker = nuevoWorker('w-accesorios');
        await ciclos(worker, 3);

        const bajo = await avatarRepo.leer(1000);
        assert.strictEqual(bajo.accessories, 0, 'camisa y torso no son accesorios');
        assert.strictEqual(bajo.state, 'avatar_only', 'quedo como servible');
        assert.strictEqual(bajo.pricedAt, null, 'se le gasto catalogo sin llegar al minimo');
        assert.ok(worker.metricas.belowMinAccessories > 0);

        const alto = await avatarRepo.leer(1001);
        assert.strictEqual(alto.state, 'valid');
    });

    test('el POST sigue haciendo CERO llamadas a Roblox', async () => {
        poblar({ miembros: 100 });
        cerrarV1();
        const worker = nuevoWorker('w-post');
        await ciclos(worker, 4);

        config.indexServe.enabled = true;
        const v1Antes = mundo.v1;
        const v2Antes = mundo.v2;
        try {
            ownRateLimit.reset();
            const payload = JSON.stringify({
                amount: 10, groupId: GRUPO, minPrice: 100, maxPrice: 100_000_000,
                requireCompletePrice: false, async: true,
            });
            const respuesta = await new Promise((res, rej) => {
                const q = http.request({
                    host: '127.0.0.1', port, path: '/plugin/outfits/search', method: 'POST',
                    headers: {
                        'x-plugin-key': config.pluginApiKey, 'content-type': 'application/json',
                        'content-length': Buffer.byteLength(payload),
                    },
                }, r => { let d = ''; r.on('data', c => { d += c; }); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(d) })); });
                q.on('error', rej); q.write(payload); q.end();
            });

            assert.strictEqual(respuesta.status, 200);
            assert.strictEqual(mundo.v1, v1Antes, 'el POST llamo a v1');
            assert.strictEqual(mundo.v2, v2Antes, 'el POST llamo a v2');
        } finally {
            config.indexServe.enabled = false;
        }
    });

    const ok = await suite.run();

    roblox.listGroupMembers = original.listGroupMembers;
    roblox.getCurrentAvatar = original.getCurrentAvatar;
    roblox.getCurrentAvatarV2 = original.getCurrentAvatarV2;
    roblox.getCatalogItemDetails = original.getCatalogItemDetails;
    roblox.getBundlesForAsset = original.getBundlesForAsset;
    Object.assign(rotationRepo, original.rotationRepo);
    Object.assign(jobRepo, original.jobRepo);
    Object.assign(avatarRepo, original.avatarRepo);
    Object.assign(crawlRepo, original.crawlRepo);
    Object.assign(memberRepo, original.memberRepo);
    Object.assign(catalogoRepo, original.catalogoRepo);
    pool.isConfigured = original.pool.isConfigured;
    pool.withTransaction = original.pool.withTransaction;
    Object.assign(config.indexWorker, original.cfg);
    config.indexServe.enabled = original.serveEnabled;
    config.pluginSearch.minAccessories = original.minAccessories;
    config.cache.maxEntries = original.cache;
    cache.reset();
    limitador.reset();
    ownRateLimit.reset();
    colaDeGrupos.reset();
    jobs.reset();
    await new Promise(resolve => server.close(resolve));
    return ok;
};
