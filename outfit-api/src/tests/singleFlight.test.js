'use strict';

const { createSuite } = require('./harness');
const singleFlight = require('../cache/singleFlight');
const cacheStore = require('../cache/cacheStore');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async function run() {
    const { test, assert, run: runSuite } = createSuite('singleFlight');

    test('N llamadas concurrentes con la misma clave producen UNA sola ejecucion', async () => {
        singleFlight.reset();
        let executions = 0;
        const fn = async () => { executions++; await sleep(20); return 'resultado'; };

        const results = await Promise.all(
            Array.from({ length: 100 }, () => singleFlight.run('misma-clave', fn))
        );

        assert.strictEqual(executions, 1, '100 peticiones simultaneas debieron colapsar en una');
        assert.strictEqual(results.length, 100);
        assert.ok(results.every(r => r === 'resultado'), 'todas reciben el mismo valor');

        const metrics = singleFlight.getMetrics();
        assert.strictEqual(metrics.started, 1);
        assert.strictEqual(metrics.joined, 99);
        assert.strictEqual(metrics.inFlight, 0, 'el vuelo debe limpiarse al terminar');
    });

    test('claves distintas se ejecutan por separado', async () => {
        singleFlight.reset();
        const executed = [];
        const fn = key => async () => { executed.push(key); await sleep(5); return key; };

        const results = await Promise.all([
            singleFlight.run('a', fn('a')),
            singleFlight.run('b', fn('b')),
            singleFlight.run('a', fn('a')),
        ]);

        assert.deepStrictEqual(results, ['a', 'b', 'a']);
        assert.deepStrictEqual(executed.sort(), ['a', 'b']);
        assert.strictEqual(singleFlight.getMetrics().started, 2);
    });

    test('el rechazo se comparte con todos los enganchados', async () => {
        singleFlight.reset();
        let executions = 0;
        const fn = async () => { executions++; await sleep(10); throw new Error('roblox caido'); };

        const outcomes = await Promise.allSettled(
            Array.from({ length: 10 }, () => singleFlight.run('k', fn))
        );

        assert.strictEqual(executions, 1, 'un fallo tampoco debe multiplicarse en 10 llamadas');
        assert.ok(outcomes.every(o => o.status === 'rejected' && o.reason.message === 'roblox caido'));
    });

    test('tras terminar, la siguiente llamada arranca un vuelo nuevo', async () => {
        singleFlight.reset();
        let executions = 0;
        const fn = async () => { executions++; return executions; };

        assert.strictEqual(await singleFlight.run('k', fn), 1);
        assert.strictEqual(await singleFlight.run('k', fn), 2);
        assert.strictEqual(singleFlight.getMetrics().joined, 0);
    });

    test('el vuelo se limpia tambien cuando la ejecucion falla', async () => {
        singleFlight.reset();
        await assert.rejects(() => singleFlight.run('k', async () => { throw new Error('boom'); }));
        assert.strictEqual(singleFlight.getMetrics().inFlight, 0);
        assert.strictEqual(await singleFlight.run('k', async () => 'ok'), 'ok');
    });

    test('a traves de la cache: una estampida sobre una clave fria da una sola llamada', async () => {
        cacheStore.reset();
        let upstreamCalls = 0;
        const fetchFn = async () => { upstreamCalls++; await sleep(20); return { userId: 156 }; };

        // El escenario real que esto evita: mil jugadores pidiendo el mismo
        // usuario justo cuando su entrada acaba de caducar.
        const results = await Promise.all(
            Array.from({ length: 500 }, () => cacheStore.withCache('v1:user:name:x', 60_000, fetchFn))
        );

        assert.strictEqual(upstreamCalls, 1, '500 peticiones simultaneas = 1 llamada a Roblox');
        assert.ok(results.every(r => r.userId === 156));

        // Y despues, servido desde cache sin ninguna llamada mas.
        await cacheStore.withCache('v1:user:name:x', 60_000, fetchFn);
        assert.strictEqual(upstreamCalls, 1);
    });

    return runSuite();
};
