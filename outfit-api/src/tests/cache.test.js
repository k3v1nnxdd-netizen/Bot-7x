'use strict';

const { createSuite } = require('./harness');
const cacheStore = require('../cache/cacheStore');
const memoryDriver = require('../cache/memoryDriver');
const { NotFoundError, UpstreamError } = require('../roblox/errors');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function run() {
    const { test, assert, run: runSuite } = createSuite('cache');

    test('un miss ejecuta el fetch y un hit posterior no', async () => {
        cacheStore.reset();
        let calls = 0;
        const fetchFn = async () => { calls++; return { userId: 1 }; };

        const first = await cacheStore.withCache('k1', 60_000, fetchFn);
        const second = await cacheStore.withCache('k1', 60_000, fetchFn);

        assert.deepStrictEqual(first, { userId: 1 });
        assert.deepStrictEqual(second, { userId: 1 });
        assert.strictEqual(calls, 1, 'el fetch debio ejecutarse una sola vez');
    });

    test('onStatus informa hit / miss', async () => {
        cacheStore.reset();
        const seen = [];
        const fetchFn = async () => 'v';

        await cacheStore.withCache('k1', 60_000, fetchFn, { onStatus: s => seen.push(s) });
        await cacheStore.withCache('k1', 60_000, fetchFn, { onStatus: s => seen.push(s) });

        assert.deepStrictEqual(seen, ['miss', 'hit']);
    });

    test('el TTL expira y obliga a un fetch nuevo', async () => {
        cacheStore.reset();
        let calls = 0;
        const fetchFn = async () => { calls++; return calls; };

        assert.strictEqual(await cacheStore.withCache('k1', 20, fetchFn), 1);
        assert.strictEqual(await cacheStore.withCache('k1', 20, fetchFn), 1, 'dentro del TTL debe servir cache');
        await sleep(40);
        assert.strictEqual(await cacheStore.withCache('k1', 20, fetchFn), 2, 'pasado el TTL debe re-consultar');
    });

    test('claves distintas no se pisan', async () => {
        cacheStore.reset();
        await cacheStore.withCache('a', 60_000, async () => 'valor-a');
        await cacheStore.withCache('b', 60_000, async () => 'valor-b');

        assert.strictEqual(await cacheStore.withCache('a', 60_000, async () => 'otro'), 'valor-a');
        assert.strictEqual(await cacheStore.withCache('b', 60_000, async () => 'otro'), 'valor-b');
    });

    test('cache negativa: un 404 se recuerda y no se vuelve a preguntar a Roblox', async () => {
        cacheStore.reset();
        let calls = 0;
        const fetchFn = async () => {
            calls++;
            throw new NotFoundError('user_not_found', 'no existe');
        };

        await assert.rejects(
            () => cacheStore.withCache('k', 60_000, fetchFn, { negativeTtlMs: 60_000 }),
            err => err instanceof NotFoundError && err.code === 'user_not_found'
        );

        const seen = [];
        await assert.rejects(
            () => cacheStore.withCache('k', 60_000, fetchFn, { negativeTtlMs: 60_000, onStatus: s => seen.push(s) }),
            err => err instanceof NotFoundError && err.code === 'user_not_found'
        );

        assert.strictEqual(calls, 1, 'el segundo 404 debio salir de la cache');
        assert.deepStrictEqual(seen, ['negative-hit']);
    });

    test('un fallo que NO es 404 nunca se cachea', async () => {
        cacheStore.reset();
        let calls = 0;
        const fetchFn = async () => {
            calls++;
            throw new UpstreamError('Roblox respondio 503');
        };

        await assert.rejects(() => cacheStore.withCache('k', 60_000, fetchFn, { negativeTtlMs: 60_000 }));
        await assert.rejects(() => cacheStore.withCache('k', 60_000, fetchFn, { negativeTtlMs: 60_000 }));

        // Un 429/5xx/timeout no dice nada sobre si el recurso existe:
        // guardarlo convertiria un bache de Roblox en minutos de 404 falsos.
        assert.strictEqual(calls, 2, 'un fallo de infraestructura debe reintentarse');
    });

    test('sin negativeTtlMs no se cachea la ausencia', async () => {
        cacheStore.reset();
        let calls = 0;
        const fetchFn = async () => { calls++; throw new NotFoundError('user_not_found', 'no existe'); };

        await assert.rejects(() => cacheStore.withCache('k', 60_000, fetchFn));
        await assert.rejects(() => cacheStore.withCache('k', 60_000, fetchFn));
        assert.strictEqual(calls, 2);
    });

    test('el tope LRU expulsa siempre la entrada menos usada recientemente', async () => {
        cacheStore.reset(); // CACHE_MAX_ENTRIES vale 5 en el runner
        for (let i = 1; i <= 5; i++) {
            await cacheStore.withCache(`k${i}`, 60_000, async () => `v${i}`);
        }
        assert.strictEqual(memoryDriver.getMetrics().entries, 5);

        // Tocar k1 la rejuvenece: la victima debe pasar a ser k2.
        await cacheStore.withCache('k1', 60_000, async () => 'no-deberia-ejecutarse');
        await cacheStore.withCache('k6', 60_000, async () => 'v6');

        const metrics = memoryDriver.getMetrics();
        assert.strictEqual(metrics.entries, 5, 'nunca debe superarse el tope');
        assert.strictEqual(metrics.evictions, 1);

        let k1Refetched = false;
        await cacheStore.withCache('k1', 60_000, async () => { k1Refetched = true; return 'x'; });
        assert.strictEqual(k1Refetched, false, 'k1 se uso hace poco: debia sobrevivir');

        let k2Refetched = false;
        await cacheStore.withCache('k2', 60_000, async () => { k2Refetched = true; return 'x'; });
        assert.strictEqual(k2Refetched, true, 'k2 era la mas antigua: debia ser la expulsada');
    });

    test('las claves van namespaced y versionadas', () => {
        assert.strictEqual(cacheStore.key('user', 'name', 'sombra'), 'v1:user:name:sombra');
        assert.strictEqual(cacheStore.key('outfits', 'list', 156, 1, 25), 'v1:outfits:list:156:1:25');
    });

    test('las metricas de cache reflejan aciertos y fallos', async () => {
        cacheStore.reset();
        await cacheStore.withCache('k', 60_000, async () => 'v'); // miss
        await cacheStore.withCache('k', 60_000, async () => 'v'); // hit
        await cacheStore.withCache('k', 60_000, async () => 'v'); // hit

        const metrics = cacheStore.getMetrics();
        assert.strictEqual(metrics.hits, 2);
        assert.strictEqual(metrics.misses, 1);
        assert.strictEqual(metrics.hitRate, 0.6667);
    });

    return runSuite();
};
