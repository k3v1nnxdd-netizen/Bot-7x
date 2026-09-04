'use strict';

const { createSuite, axiosError } = require('./harness');
const config = require('../config');
const limitador = require('../roblox/rateLimiter');
const { crearPuerta, VEREDICTO } = require('../services/pluginSearch/throttleGate');
const { crearStats } = require('../services/pluginSearch/stats');

// Los dos mecanismos que deciden como se convive con los limites de Roblox:
//
//   MARCAPASOS (rateLimiter)  PREVENTIVO. Separa las llamadas de una ruta para
//                             que la ventana de cuota no se agote de golpe.
//                             Arranca en CERO y solo aparece si Roblox se queja.
//
//   PUERTA (throttleGate)     REACTIVA. Cuando la ruta ya esta frenada, duerme
//                             lo que Roblox pidio y deja seguir, en vez de dar
//                             la busqueda por terminada.
//
// EL ERROR QUE LOS DOS CORRIGEN, y conviene tenerlo delante al leer estos casos:
// una busqueda de 10 outfits devolvia 3 a los 18 segundos con
// `stoppedBy: catalogRateLimit`. Roblox no habia dicho "no hay outfits": habia
// dicho "espera unos segundos". Nos rendiamos ante una instruccion de esperar.

const ruta = 'catalogDetails';
const bucket = () => limitador.__buckets[ruta];

module.exports = async function run() {
    const suite = createSuite('pluginThrottle');
    const { test, assert } = suite;

    // Una respuesta correcta con las cabeceras que se le pidan.
    const respuesta = (headers = {}) => ({
        status: 200, headers, data: {}, config: { url: 'https://catalog.roblox.com/v1/catalog/items/details' },
    });

    const ejecutar = fn => limitador.run(ruta, fn, { endpoint: 'catalog.roblox.com/v1/catalog/items/details' });

    // ── Marcapasos ───────────────────────────────────────────────────────────

    test('sin presion de Roblox NO hay marcapasos: el trafico normal no paga nada', async () => {
        limitador.reset();
        for (let i = 0; i < 5; i++) await ejecutar(async () => respuesta());

        assert.strictEqual(limitador.getThrottleState(ruta).spacingMs, 0,
            'se activo separacion entre llamadas sin que Roblox se quejara');
        assert.strictEqual(limitador.getThrottleState(ruta).throttled, false);
    });

    test('un 429 activa el marcapasos de ESA ruta y solo de esa', async () => {
        limitador.reset();
        try {
            await ejecutar(async () => { throw axiosError(429, { 'retry-after': '30' }); });
        } catch { /* se espera que falle: lo que se prueba es el efecto lateral */ }

        assert.ok(limitador.getThrottleState(ruta).spacingMs > 0,
            'un 429 no dejo separacion entre llamadas');
        // Las demas rutas siguen a pelo: los buckets son independientes y una
        // cuota agotada en el catalogo no puede frenar los avatares.
        assert.strictEqual(limitador.getThrottleState('userAvatar').spacingMs, 0);
        limitador.reset();
    });

    test('"remaining: 0" activa el marcapasos AUNQUE la respuesta sea correcta', async () => {
        // Es la señal mas temprana que existe: Roblox aun no nos ha negado
        // nada, solo ha dicho que la ventana esta al limite. Reaccionar aqui es
        // la diferencia entre repartir la cuota y chocarse con ella.
        limitador.reset();
        await ejecutar(async () => respuesta({ 'x-ratelimit-remaining': '0', 'retry-after': '5' }));

        assert.ok(limitador.getThrottleState(ruta).spacingMs > 0,
            'la cuota agotada por cabeceras no activo el marcapasos');
        limitador.reset();
    });

    test('el marcapasos SEPARA de verdad las llamadas seguidas', async () => {
        limitador.reset();
        bucket().spacingMs = 60;

        const instantes = [];
        for (let i = 0; i < 3; i++) {
            await ejecutar(async () => { instantes.push(Date.now()); return respuesta(); });
        }

        // Margen de 15 ms: los temporizadores de Node no son exactos y lo que
        // se prueba es que HAY separacion, no su precision al milisegundo.
        assert.ok(instantes[1] - instantes[0] >= 45,
            `la segunda llamada salio ${instantes[1] - instantes[0]} ms despues de la primera`);
        assert.ok(instantes[2] - instantes[1] >= 45,
            `la tercera llamada salio ${instantes[2] - instantes[1]} ms despues de la segunda`);
        limitador.reset();
    });

    test('el marcapasos se afloja solo y acaba apagandose con llamadas correctas', async () => {
        limitador.reset();
        bucket().spacingMs = config.upstream.pacerBaseMs;

        // Cada exito lo relaja; por debajo del suelo se apaga del todo en vez de
        // dejar temporizadores de 3 ms vivos sin ganar nada.
        for (let i = 0; i < 40; i++) await ejecutar(async () => respuesta());

        assert.strictEqual(limitador.getThrottleState(ruta).spacingMs, 0,
            'el marcapasos no se apago tras cuarenta llamadas correctas');
        limitador.reset();
    });

    test('el marcapasos no pasa de su techo por muchos 429 que lleguen', async () => {
        limitador.reset();
        for (let i = 0; i < 12; i++) {
            try {
                await ejecutar(async () => { throw axiosError(429, { 'retry-after': '30' }); });
            } catch { /* esperado */ }
            // El cooldown que impone el 429 rechazaria las siguientes antes de
            // llegar al marcapasos; se limpia para poder seguir apretandolo.
            bucket().cooldownUntil = 0;
        }

        assert.ok(bucket().spacingMs <= config.upstream.pacerMaxMs,
            `la separacion (${bucket().spacingMs} ms) supero el techo`);
        limitador.reset();
    });

    // ── Puerta ───────────────────────────────────────────────────────────────

    function puertaDePrueba({ presupuesto }) {
        const stats = crearStats();
        let gastado = 0;
        const puerta = crearPuerta(stats, {
            presupuestoDeEspera: () => presupuesto - gastado,
        });
        return {
            stats,
            async abrir(routeKey) {
                const antes = puerta.esperadoMs;
                const veredicto = await puerta.abrir(routeKey);
                gastado += puerta.esperadoMs - antes;
                return veredicto;
            },
            get esperadoMs() { return puerta.esperadoMs; },
            get esperas() { return puerta.esperas; },
        };
    }

    test('con la ruta libre, la puerta no espera ni un milisegundo', async () => {
        limitador.reset();
        const puerta = puertaDePrueba({ presupuesto: 10_000 });

        const t0 = Date.now();
        assert.strictEqual(await puerta.abrir(ruta), VEREDICTO.LIBRE);
        assert.ok(Date.now() - t0 < 40, 'la puerta durmio con la ruta libre');
        assert.strictEqual(puerta.esperas, 0);
    });

    test('con la ruta frenada, la puerta ESPERA lo que pidio Roblox y deja pasar', async () => {
        limitador.reset();
        bucket().cooldownUntil = Date.now() + 120;
        const puerta = puertaDePrueba({ presupuesto: 10_000 });

        const t0 = Date.now();
        const veredicto = await puerta.abrir(ruta);
        const transcurrido = Date.now() - t0;

        assert.strictEqual(veredicto, VEREDICTO.ESPERADO);
        assert.ok(transcurrido >= 100, `solo espero ${transcurrido} ms de los ~120 pedidos`);
        assert.strictEqual(puerta.esperas, 1);
        assert.strictEqual(puerta.stats.contadores.rateLimitWaits, 1);
        assert.ok(puerta.stats.contadores.rateLimitWaitedMs > 0);

        // Y al volver, la ruta ya esta libre: no se desperto antes de tiempo.
        assert.strictEqual(limitador.getThrottleState(ruta).throttled, false,
            'la puerta desperto antes de que se reabriera la ventana');
        limitador.reset();
    });

    test('una espera que no cabe en el presupuesto NO se empieza', async () => {
        // La regla que impide que "esperar en vez de rendirse" se convierta en
        // un plugin colgado: si no se puede terminar la pausa, no se empieza.
        limitador.reset();
        bucket().cooldownUntil = Date.now() + 5_000;
        const puerta = puertaDePrueba({ presupuesto: 500 });

        const t0 = Date.now();
        assert.strictEqual(await puerta.abrir(ruta), VEREDICTO.AGOTADO);
        assert.ok(Date.now() - t0 < 40, 'empezo una espera que no podia terminar');
        assert.strictEqual(puerta.esperas, 0);
        limitador.reset();
    });

    test('una espera mas larga que el techo de UNA pausa tampoco se empieza', async () => {
        limitador.reset();
        bucket().cooldownUntil = Date.now() + config.pluginSearch.rateLimitSingleWaitMs + 5_000;
        // Presupuesto de sobra: lo que corta aqui es el techo por pausa, no el total.
        const puerta = puertaDePrueba({ presupuesto: 10 * 60_000 });

        assert.strictEqual(await puerta.abrir(ruta), VEREDICTO.AGOTADO);
        limitador.reset();
    });

    test('el numero de pausas por busqueda esta acotado', async () => {
        limitador.reset();
        const puerta = puertaDePrueba({ presupuesto: 10 * 60_000 });

        // Pausas cortisimas, muchas veces: lo que corta es el CONTADOR.
        for (let i = 0; i < config.pluginSearch.rateLimitMaxWaits; i++) {
            bucket().cooldownUntil = Date.now() + 5;
            assert.strictEqual(await puerta.abrir(ruta), VEREDICTO.ESPERADO, `pausa ${i + 1}`);
        }

        bucket().cooldownUntil = Date.now() + 5;
        assert.strictEqual(await puerta.abrir(ruta), VEREDICTO.AGOTADO,
            'la puerta paso de su tope de pausas');
        limitador.reset();
    });

    test('la puerta suma el margen para no volver un milisegundo antes de tiempo', async () => {
        // Reintentar justo cuando vence la ventana gasta el intento y renueva el
        // cooldown: hay que volver DESPUES, no exactamente en el limite.
        limitador.reset();
        bucket().cooldownUntil = Date.now() + 50;
        const puerta = puertaDePrueba({ presupuesto: 10_000 });

        await puerta.abrir(ruta);
        assert.ok(puerta.esperadoMs >= 50 + config.pluginSearch.rateLimitWaitMarginMs - 5,
            `espero ${puerta.esperadoMs} ms, sin el margen de seguridad`);
        limitador.reset();
    });

    return suite.run();
};
