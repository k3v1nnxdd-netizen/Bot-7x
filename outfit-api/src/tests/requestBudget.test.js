'use strict';

const { createSuite, axiosError, timeoutError, networkError } = require('./harness');
const rateLimiter = require('../roblox/rateLimiter');
const requestContext = require('../observability/requestContext');
const config = require('../config');

// PRESUPUESTO DE TIEMPO DE UNA PETICION DEL JUEGO.
//
// Este archivo existe por un numero medido: con Roblox sin contestar, un listado
// de outfits tardaba 18,6 s en devolver el mismo error que el primer intento ya
// tenia a los 6 s. `UPSTREAM_TIMEOUT_MS` acota UNA llamada; nada acotaba la
// peticion, asi que tres intentos de 6 s se sumaban enteros. Y eso es el coste
// de UNA llamada: el listado encadena dos (usuario -> outfits), de modo que lo
// que tarde la segunda se suma encima. El jugador ya se habia ido.
//
// LO QUE SE PRUEBA AQUI, y en este orden:
//
//   1. Que el reintento CARO se abandona (es el fallo que se arregla).
//   2. Que el reintento BARATO se conserva (es lo que no se puede romper).
//   3. Que sin presupuesto abierto no cambia nada (el trabajo de fondo).
//
// El 3 importa tanto como el 1: el indexado y las busquedas del plugin corren
// durante minutos y no tienen a nadie esperando. Un corte a los ocho segundos
// ahi seria exactamente lo contrario de lo que se quiere.

// Ejecuta `fn` con un presupuesto de `ms` milisegundos, como haria el
// middleware de api/requestBudget.js en una peticion real.
function conPresupuesto(ms, fn) {
    return requestContext.ejecutarCon({ fechaLimite: Date.now() + ms }, fn);
}

// Un doble de Roblox que siempre falla, contando los intentos y tardando lo que
// se le diga. `duracionMs` es lo que separa un fallo BARATO (un 5xx inmediato,
// que merece reintento) de uno CARO (un timeout, que no).
function robloxQueFalla(error, duracionMs) {
    const estado = { intentos: 0 };
    estado.fn = async () => {
        estado.intentos++;
        if (duracionMs > 0) await new Promise(r => setTimeout(r, duracionMs));
        throw error();
    };
    return estado;
}

async function correr(routeKey, fn) {
    const t0 = Date.now();
    try {
        await rateLimiter.run(routeKey, fn, { endpoint: 'test' });
        return { ms: Date.now() - t0, ok: true };
    } catch (err) {
        return { ms: Date.now() - t0, ok: false, code: err.code, name: err.name };
    }
}

const INTENTOS_COMPLETOS = config.upstream.maxRetries + 1;

module.exports = async function run() {
    const suite = createSuite('requestBudget');
    const { test, assert } = suite;

    // ── 1. El reintento caro se abandona ─────────────────────────────────────

    test('un fallo CARO no se reintenta si el siguiente intento no cabe en el presupuesto', async () => {
        rateLimiter.reset();
        // Cada intento cuesta 200 ms y solo quedan 250: el segundo no cabe.
        const roblox = robloxQueFalla(timeoutError, 200);

        const r = await conPresupuesto(250, () => correr('outfitList', roblox.fn));

        assert.strictEqual(roblox.intentos, 1,
            'se hicieron ' + roblox.intentos + ' intentos: el presupuesto no corto el reintento caro');
        assert.strictEqual(r.ok, false);
    });

    test('el error que se devuelve es el MISMO que sin presupuesto, no uno nuevo', async () => {
        rateLimiter.reset();
        const conCorte = await conPresupuesto(250,
            () => correr('outfitList', robloxQueFalla(timeoutError, 200).fn));

        rateLimiter.reset();
        const sinCorte = await correr('outfitList', robloxQueFalla(timeoutError, 0).fn);

        // Cortar antes no puede cambiar QUE se le dice al juego. El presupuesto
        // decide cuando se deja de insistir, no como se llama el fallo: si el
        // codigo cambiara, el cliente tendria que aprender un caso nuevo por un
        // detalle interno nuestro.
        assert.strictEqual(conCorte.code, sinCorte.code,
            'el presupuesto cambio el codigo de error: ' + conCorte.code + ' en vez de ' + sinCorte.code);
    });

    test('el presupuesto es de la PETICION, no de cada llamada: la segunda hereda lo gastado', async () => {
        rateLimiter.reset();
        const primera = robloxQueFalla(timeoutError, 200);
        const segunda = robloxQueFalla(timeoutError, 200);

        await conPresupuesto(260, async () => {
            // Dos llamadas encadenadas, como en el listado: usuario -> outfits.
            await correr('usernameLookup', primera.fn);
            await correr('outfitList', segunda.fn);
        });

        assert.strictEqual(primera.intentos, 1, 'la primera llamada agoto sus reintentos');
        // La primera se comio el presupuesto entero, asi que a la segunda no le
        // queda margen ni para su propio reintento.
        assert.strictEqual(segunda.intentos, 1,
            'la segunda llamada hizo ' + segunda.intentos + ' intentos: el presupuesto no se comparte entre llamadas');
    });

    // ── 2. El reintento barato se conserva ───────────────────────────────────

    test('un fallo BARATO si se reintenta: el presupuesto no apaga los reintentos', async () => {
        rateLimiter.reset();
        // Falla al instante: reintentar cuesta casi nada y suele salir bien.
        const roblox = robloxQueFalla(() => axiosError(503), 0);

        const r = await conPresupuesto(5_000, () => correr('outfitList', roblox.fn));

        assert.strictEqual(roblox.intentos, INTENTOS_COMPLETOS,
            'solo ' + roblox.intentos + ' intentos: el presupuesto se comio reintentos que si cabian');
        assert.strictEqual(r.ok, false);
    });

    test('un fallo de red barato conserva sus reintentos', async () => {
        rateLimiter.reset();
        const roblox = robloxQueFalla(() => networkError('ECONNRESET'), 0);

        await conPresupuesto(5_000, () => correr('outfitList', roblox.fn));

        assert.strictEqual(roblox.intentos, INTENTOS_COMPLETOS,
            'solo ' + roblox.intentos + ' intentos para un fallo de red instantaneo');
    });

    test('una llamada que va bien no paga nada por el presupuesto', async () => {
        rateLimiter.reset();
        let intentos = 0;
        const r = await conPresupuesto(5_000, () => correr('outfitList', async () => {
            intentos++;
            return { status: 200, headers: {}, data: { ok: true } };
        }));

        assert.strictEqual(r.ok, true);
        assert.strictEqual(intentos, 1);
    });

    // ── 3. Sin presupuesto, nada cambia ──────────────────────────────────────

    test('SIN presupuesto abierto, un fallo caro conserva TODOS sus reintentos', async () => {
        rateLimiter.reset();
        const roblox = robloxQueFalla(timeoutError, 200);

        // Sin `ejecutarCon`: es el trabajo de fondo (indexado, plugin), que no
        // tiene a nadie esperando y para el que abandonar pronto no ahorra nada.
        await correr('outfitList', roblox.fn);

        assert.strictEqual(roblox.intentos, INTENTOS_COMPLETOS,
            'el trabajo de fondo perdio reintentos: hizo ' + roblox.intentos);
    });

    test('un contexto SIN fechaLimite tampoco corta nada', async () => {
        rateLimiter.reset();
        const roblox = robloxQueFalla(timeoutError, 200);

        // Contexto abierto solo para correlacionar logs, como hace la busqueda
        // del plugin. No trae fecha limite y no puede empezar a cortar por su
        // cuenta.
        await requestContext.ejecutarCon({ requestId: 'r-1', searchId: 's-1' },
            () => correr('outfitList', roblox.fn));

        assert.strictEqual(roblox.intentos, INTENTOS_COMPLETOS,
            'un contexto sin fecha limite corto reintentos: hizo ' + roblox.intentos);
    });

    // ── 4. El cooldown tampoco se espera si no cabe ──────────────────────────

    test('no se espera un cooldown que no cabe en el presupuesto', async () => {
        rateLimiter.reset();

        // Cooldown de 80 ms: por DEBAJO del techo de espera en linea de la suite
        // (100 ms), asi que sin presupuesto el limitador lo absorberia durmiendo.
        rateLimiter.imponerCooldown('outfitList', Date.now() + 80, 'test');

        let llamadas = 0;
        // Presupuesto de 20 ms: la espera de 80 no cabe.
        const r = await conPresupuesto(20, () => correr('outfitList', async () => {
            llamadas++;
            return { status: 200, headers: {}, data: {} };
        }));

        assert.strictEqual(llamadas, 0, 'salio una llamada durante el cooldown');
        assert.strictEqual(r.ok, false);
        // Y se devuelve DEPRISA, sin gastar durmiendo el tiempo que le queda al
        // jugador: el Retry-After que se le va a dar ya se sabe ahora mismo.
        assert.ok(r.ms < 60, 'se tardo ' + r.ms + ' ms en rechazar algo que ya se sabia');
    });

    test('SIN presupuesto, un cooldown corto se sigue absorbiendo en linea', async () => {
        rateLimiter.reset();
        rateLimiter.imponerCooldown('outfitList', Date.now() + 40, 'test');

        let llamadas = 0;
        const r = await correr('outfitList', async () => {
            llamadas++;
            return { status: 200, headers: {}, data: {} };
        });

        // El comportamiento de siempre: esperar los 40 ms y salir. Que el
        // presupuesto no lo haya cambiado es lo que se comprueba.
        assert.strictEqual(r.ok, true);
        assert.strictEqual(llamadas, 1);
    });

    // ── 5. El middleware ─────────────────────────────────────────────────────

    test('el middleware deja la fecha limite en el contexto', async () => {
        const { requestBudget } = require('../api/requestBudget');
        const antes = Date.now();

        let visto = null;
        await new Promise(resolve => {
            requestBudget({}, {}, () => {
                visto = requestContext.fechaLimite();
                resolve();
            });
        });

        assert.ok(visto !== null, 'el middleware no dejo fecha limite');
        assert.ok(visto >= antes + config.upstream.requestBudgetMs,
            'la fecha limite es anterior al presupuesto configurado');
        assert.ok(visto <= Date.now() + config.upstream.requestBudgetMs,
            'la fecha limite va mas alla del presupuesto configurado');
    });

    test('fuera del middleware no hay fecha limite que herede nadie', async () => {
        assert.strictEqual(requestContext.fechaLimite(), null);
    });

    const ok = await suite.run();
    rateLimiter.reset();
    return ok;
};
