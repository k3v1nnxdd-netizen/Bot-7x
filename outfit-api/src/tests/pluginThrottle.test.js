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

    test('NO hay techo por pausa: una pausa larga se hace mientras quepa en el reloj de pared', async () => {
        // Hubo un techo por pausa, y fue la condicion exacta que terminaba una
        // busqueda asincrona en su PRIMERA pausa: un Retry-After de 25 s con
        // el techo en 20 s -> "2 de 10 · avatarRateLimit" a los 14 s. Ya no
        // existe: solo el presupuesto global decide.
        limitador.reset();
        bucket().cooldownUntil = Date.now() + 150;
        const puerta = puertaDePrueba({ presupuesto: 10 * 60_000 });
        assert.strictEqual(await puerta.abrir(ruta), VEREDICTO.ESPERADO, 'una pausa que cabe en el reloj se rechazo');

        // Y la misma pausa con el reloj casi agotado si se rechaza: es la UNICA
        // condicion, y es global.
        bucket().cooldownUntil = Date.now() + 150;
        const sinReloj = puertaDePrueba({ presupuesto: 50 });
        assert.strictEqual(await sinReloj.abrir(ruta), VEREDICTO.AGOTADO);
        limitador.reset();
    });

    test('MUCHAS pausas seguidas no terminan nada: lo unico que acota es el presupuesto de reloj', async () => {
        // Habia un contador de pausas (ocho), y fue la causa directa de un
        // 2 de 10 en produccion: pausas cortas encadenadas por 429 sin cabecera
        // lo agotaban en veinte segundos. Una pausa individual, por muchas que
        // haya, no es motivo para terminar una busqueda asincrona.
        limitador.reset();
        const puerta = puertaDePrueba({ presupuesto: 10 * 60_000 });

        for (let i = 0; i < 30; i++) {
            bucket().cooldownUntil = Date.now() + 5;
            assert.strictEqual(await puerta.abrir(ruta), VEREDICTO.ESPERADO, `pausa ${i + 1} deberia caber`);
        }
        assert.strictEqual(puerta.esperas, 30);
        limitador.reset();
    });

    test('el breaker ABIERTO cuenta como "cuanto falta": la puerta espera lo que dure, no su margen', async () => {
        // getThrottleState decia cooldownRemainingMs = 0 con el breaker abierto
        // (solo miraba el cooldown de Roblox). La puerta estacionaba entonces
        // su margen de 500 ms, volvia, seguia cerrado, y asi hasta agotarse.
        limitador.reset();
        bucket().circuitOpenUntil = Date.now() + 150;
        const estado = limitador.getThrottleState(ruta);
        assert.strictEqual(estado.throttled, true);
        assert.ok(estado.cooldownRemainingMs >= 100, `con el breaker abierto quedaban ${estado.cooldownRemainingMs} ms`);

        const puerta = puertaDePrueba({ presupuesto: 10_000 });
        const t0 = Date.now();
        assert.strictEqual(await puerta.abrir(ruta), VEREDICTO.ESPERADO);
        assert.ok(Date.now() - t0 >= 140, 'la puerta no espero a que el breaker cerrara');
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
