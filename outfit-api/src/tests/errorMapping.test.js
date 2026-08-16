'use strict';

const { createSuite, axiosError, networkError, timeoutError, captureStdout } = require('./harness');
const rateLimiter = require('../roblox/rateLimiter');
const { errorHandler } = require('../api/errorHandler');
const { ValidationError } = require('../validation/params');
const {
    NotFoundError, UpstreamRateLimitedError, CircuitOpenError, UpstreamError,
} = require('../roblox/errors');

// Dos mitades, que juntas cubren el camino completo de un fallo:
//   1. rateLimiter.run  — de un error de axios a una de nuestras clases.
//   2. errorHandler     — de una de nuestras clases a una respuesta HTTP.
// Todo con errores fabricados: cero red, resultados deterministas.

function mockRes() {
    return {
        headersSent: false,
        locals: {},
        statusCode: null,
        body: null,
        headers: {},
        set(key, value) { this.headers[key] = value; return this; },
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

module.exports = async function run() {
    const { test, assert, run: runSuite } = createSuite('errorMapping');

    // ── rateLimiter: clasificacion de los fallos de Roblox ───────────────────

    test('404 -> NotFoundError con el codigo de la ruta, sin reintentos', async () => {
        rateLimiter.reset();
        let calls = 0;
        await assert.rejects(
            () => rateLimiter.run('usernameLookup', async () => { calls++; throw axiosError(404); }, { notFoundCode: 'user_not_found' }),
            err => err instanceof NotFoundError && err.code === 'user_not_found'
        );
        assert.strictEqual(calls, 1, 'un 404 es definitivo: reintentarlo solo gasta cuota');
    });

    test('404 NO cuenta para el circuit breaker', async () => {
        rateLimiter.reset();
        const bucket = rateLimiter.__buckets.outfitDetails;

        // Cuatro fallos duros, uno por debajo del umbral.
        for (let i = 0; i < 4; i++) {
            await assert.rejects(() => rateLimiter.run('outfitDetails', async () => { throw axiosError(500); }));
        }
        assert.strictEqual(bucket.consecutiveFailures, 4);

        await assert.rejects(
            () => rateLimiter.run('outfitDetails', async () => { throw axiosError(404); }, { notFoundCode: 'outfit_not_found' }),
            err => err instanceof NotFoundError
        );

        // Roblox contesto perfectamente: el recurso es el que no existe.
        assert.strictEqual(bucket.consecutiveFailures, 0, 'un 404 demuestra que Roblox responde bien');
        assert.strictEqual(bucket.circuitOpenUntil, 0);
    });

    test('429 con Retry-After largo -> 503 inmediato con el valor que dijo Roblox', async () => {
        rateLimiter.reset();
        let calls = 0;
        await assert.rejects(
            () => rateLimiter.run('outfitList', async () => { calls++; throw axiosError(429, { 'retry-after': '60' }); }),
            err => err instanceof UpstreamRateLimitedError
                && err.retryAfterSeconds >= 59 && err.retryAfterSeconds <= 61
        );
        // 60 s supera el techo de espera en linea: se devuelve el control al
        // llamador en vez de sostener el socket un minuto.
        assert.strictEqual(calls, 1);
    });

    test('429 sin cabeceras -> backoff y reintentos antes de rendirse', async () => {
        rateLimiter.reset();
        let calls = 0;
        await assert.rejects(
            () => rateLimiter.run('outfitList', async () => { calls++; throw axiosError(429); }),
            err => err instanceof UpstreamRateLimitedError
        );
        assert.strictEqual(calls, 3, 'intento inicial + 2 reintentos');
        assert.ok(rateLimiter.__buckets.outfitList.metrics.retries >= 2);
    });

    test('429 pone la ruta en cooldown para TODOS, no solo para quien choco', async () => {
        rateLimiter.reset();
        await assert.rejects(() => rateLimiter.run('outfitList', async () => { throw axiosError(429, { 'retry-after': '30' }); }));
        assert.ok(rateLimiter.__buckets.outfitList.metrics.rateLimited >= 1);
        assert.ok(rateLimiter.getMetrics().byRoute.outfitList.circuit.cooldownRemainingMs > 25_000);
    });

    test('5xx -> UpstreamError tras agotar los reintentos', async () => {
        rateLimiter.reset();
        let calls = 0;
        await assert.rejects(
            () => rateLimiter.run('usernameLookup', async () => { calls++; throw axiosError(503); }),
            err => err instanceof UpstreamError
        );
        assert.strictEqual(calls, 3);
        assert.strictEqual(rateLimiter.__buckets.usernameLookup.metrics.serverErrors, 3);
    });

    test('error de red -> UpstreamError tras reintentar', async () => {
        rateLimiter.reset();
        let calls = 0;
        await assert.rejects(
            () => rateLimiter.run('usernameLookup', async () => { calls++; throw networkError('ECONNRESET'); }),
            err => err instanceof UpstreamError
        );
        assert.strictEqual(calls, 3);
        assert.strictEqual(rateLimiter.__buckets.usernameLookup.metrics.networkErrors, 3);
    });

    test('timeout -> UpstreamError (mismo camino que un fallo de red)', async () => {
        rateLimiter.reset();
        let calls = 0;
        await assert.rejects(
            () => rateLimiter.run('outfitDetails', async () => { calls++; throw timeoutError(); }),
            err => err instanceof UpstreamError
        );
        assert.strictEqual(calls, 3);
        assert.strictEqual(rateLimiter.__buckets.outfitDetails.metrics.networkErrors, 3);
    });

    test('4xx que no es 404 ni 429 no se reintenta', async () => {
        rateLimiter.reset();
        let calls = 0;
        await assert.rejects(
            () => rateLimiter.run('outfitList', async () => { calls++; throw axiosError(400); }),
            err => err instanceof UpstreamError
        );
        assert.strictEqual(calls, 1, 'si la peticion esta mal, repetirla no la arregla');
        assert.strictEqual(rateLimiter.__buckets.outfitList.consecutiveFailures, 0, 'Roblox respondio: el fallo es nuestro');
    });

    test('una respuesta correcta pasa tal cual y reinicia el contador de fallos', async () => {
        rateLimiter.reset();
        await assert.rejects(() => rateLimiter.run('usernameLookup', async () => { throw axiosError(500); }));
        assert.ok(rateLimiter.__buckets.usernameLookup.consecutiveFailures > 0);

        const response = await rateLimiter.run('usernameLookup', async () => ({ status: 200, headers: {}, data: { ok: true } }));
        assert.deepStrictEqual(response.data, { ok: true });
        assert.strictEqual(rateLimiter.__buckets.usernameLookup.consecutiveFailures, 0);
    });

    test('el circuit breaker abre tras fallos sostenidos y deja de llamar a Roblox', async () => {
        rateLimiter.reset();
        for (let i = 0; i < 5; i++) {
            await assert.rejects(() => rateLimiter.run('outfitList', async () => { throw axiosError(500); }));
        }
        assert.strictEqual(rateLimiter.getMetrics().byRoute.outfitList.circuit.state, 'open');

        let calledWhileOpen = false;
        await assert.rejects(
            () => rateLimiter.run('outfitList', async () => { calledWhileOpen = true; throw axiosError(500); }),
            err => err instanceof CircuitOpenError && err.retryAfterSeconds > 0
        );
        assert.strictEqual(calledWhileOpen, false, 'con el circuito abierto no se toca Roblox en absoluto');
    });

    test('las cabeceras x-ratelimit frenan la ruta ANTES de gastar un 429', async () => {
        rateLimiter.reset();
        // Respuesta correcta, pero Roblox avisa de que no queda cuota.
        await rateLimiter.run('outfitDetails', async () => ({
            status: 200,
            headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '30' },
            data: {},
        }));
        assert.ok(rateLimiter.getMetrics().byRoute.outfitDetails.circuit.cooldownRemainingMs > 25_000);

        // La siguiente peticion no llega a salir: 30 s superan el techo de espera.
        let called = false;
        await assert.rejects(
            () => rateLimiter.run('outfitDetails', async () => { called = true; return { status: 200, headers: {} }; }),
            err => err instanceof UpstreamRateLimitedError
        );
        assert.strictEqual(called, false);
    });

    // ── errorHandler: de nuestras clases a HTTP ─────────────────────────────

    test('ValidationError -> 400 invalid_request', () => {
        const res = mockRes();
        errorHandler(new ValidationError('page debe ser un entero positivo'), {}, res, () => {});
        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.error.code, 'invalid_request');
        assert.strictEqual(res.body.error.message, 'page debe ser un entero positivo');
    });

    test('NotFoundError -> 404 con el codigo semantico correcto', () => {
        for (const code of ['user_not_found', 'outfit_not_found']) {
            const res = mockRes();
            errorHandler(new NotFoundError(code, 'no existe'), {}, res, () => {});
            assert.strictEqual(res.statusCode, 404);
            assert.strictEqual(res.body.error.code, code);
        }
    });

    test('limite de ROBLOX -> 503 upstream_rate_limited con Retry-After', () => {
        const res = mockRes();
        errorHandler(new UpstreamRateLimitedError('Roblox limitando', 12), {}, res, () => {});
        // 503 y no 429 a proposito: el juego debe poder distinguir "frenamos
        // nosotros" (429, baja el ritmo) de "frena Roblox" (503, espera y reintenta).
        assert.strictEqual(res.statusCode, 503);
        assert.strictEqual(res.body.error.code, 'upstream_rate_limited');
        assert.strictEqual(res.body.error.retryAfterSeconds, 12);
        assert.strictEqual(res.headers['Retry-After'], '12');
    });

    test('CircuitOpenError -> 503 upstream_unavailable con Retry-After', () => {
        const res = mockRes();
        errorHandler(new CircuitOpenError('circuito abierto', 5), {}, res, () => {});
        assert.strictEqual(res.statusCode, 503);
        assert.strictEqual(res.body.error.code, 'upstream_unavailable');
        assert.strictEqual(res.headers['Retry-After'], '5');
    });

    test('UpstreamError -> 502 sin filtrar el detalle interno', async () => {
        const res = mockRes();
        const cause = axiosError(500, { 'set-cookie': 'algo-interno' });
        const logged = await captureStdout(async () => {
            errorHandler(new UpstreamError('Roblox respondio 500', cause), { originalUrl: '/v1/x' }, res, () => {});
        });

        assert.strictEqual(res.statusCode, 502);
        assert.strictEqual(res.body.error.code, 'upstream_error');
        const serialized = JSON.stringify(res.body);
        assert.ok(!serialized.includes('set-cookie'), 'el error de axios no puede filtrarse al cliente');
        assert.ok(!serialized.includes('stack'));
        assert.ok(logged.includes('Fallo hablando con Roblox'), 'pero si debe quedar registrado');
    });

    test('un error inesperado -> 500 generico, con el detalle solo en el log', async () => {
        const res = mockRes();
        const logged = await captureStdout(async () => {
            errorHandler(new Error('referencia nula en algun sitio'), { originalUrl: '/v1/x', requestId: 'abc' }, res, () => {});
        });

        assert.strictEqual(res.statusCode, 500);
        assert.strictEqual(res.body.error.code, 'internal_error');
        assert.ok(!JSON.stringify(res.body).includes('referencia nula'), 'el mensaje interno no sale al cliente');
        assert.ok(logged.includes('referencia nula'), 'pero si queda en el log');
    });

    return runSuite();
};
