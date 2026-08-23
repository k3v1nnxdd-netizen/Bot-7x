'use strict';

const { createSuite, axiosError, networkError, captureStdout } = require('./harness');
const roblox = require('../roblox/client');
const rateLimiter = require('../roblox/rateLimiter');
const gameOwnership = require('../services/gameOwnershipService');
const cache = require('../cache/cacheStore');
const { NotFoundError, UpstreamError, UpstreamRateLimitedError } = require('../roblox/errors');

// DE QUIEN ES UNA EXPERIENCIA, y sobre todo: CUANDO tenemos derecho a decir
// que no existe.
//
// Este archivo existe por un fallo concreto y caro. La propiedad se resolvia
// con games.roblox.com/v1/games?universeIds=, que cuando no quiere enseñar una
// experiencia —privada, sin publicar, o publicada con el cuestionario de
// madurez pendiente— NO responde 404 ni 403: responde 200 con una ficha
// censurada que tiene la forma de una respuesta buena y los ids a CERO.
//
//     { "id": 0, "creator": { "id": 0, "type": "Group" },
//       "name": "[TITLE UNAVAILABLE]", "isContentRestricted": true }
//
// El codigo hacia `if (!juego?.id) throw NotFoundError` y, como 0 es falsy,
// traducia "Roblox no me lo quiere contar" por "esa experiencia no existe":
// 403 juego_desconocido definitivo contra un cliente cuyo juego existia y era
// suyo. Caso real: placeId 125691607069384, universo 10751677333, grupo
// 144910779.
//
// LA REGLA QUE SE FIJA AQUI, y que es la leccion entera:
//
//   "no existe"  -> NotFoundError -> juego_desconocido (403, definitivo).
//                   SOLO cuando Roblox lo CONFIRMA.
//   "no lo se"   -> UpstreamError -> 503, reintentable.
//                   TODO lo demas: censura, cuerpos raros, 4xx, 5xx, red.
//
// Equivocarse hacia "no lo se" cuesta un reintento. Equivocarse hacia "no
// existe" echa a un cliente legitimo de su propio juego. Los dos errores no
// son simetricos y este archivo lo trata en consecuencia.

const UNIVERSE_ID = '10751677333';
const GROUP_ID = '144910779';
const ROOT_PLACE = '125691607069384';

// La respuesta buena de develop.roblox.com/v1/universes/{id}, tal cual llega.
const universoReal = (extra = {}) => ({
    id: Number(UNIVERSE_ID),
    name: 'Outfits System group - test',
    description: '',
    isArchived: false,
    rootPlaceId: Number(ROOT_PLACE),
    isActive: true,
    privacyType: 'Public',
    creatorType: 'Group',
    creatorTargetId: Number(GROUP_ID),
    creatorName: '#7x Group',
    ...extra,
});

// La ficha CENSURADA de games.roblox.com, la que provoco el fallo. Se prueba
// tal cual aunque ese endpoint ya no se use: si algun dia otra ruta sirve algo
// parecido, tiene que morir como 503 y no como denegacion.
const FICHA_CENSURADA = {
    id: 0,
    rootPlaceId: 0,
    name: '[TITLE UNAVAILABLE]',
    creator: { id: 0, name: '[UNKNOWN]', type: 'Group' },
    isContentRestricted: true,
};

// El 400 con el que develop.roblox.com dice de verdad "no existe".
const CUERPO_NO_EXISTE = {
    errors: [{ code: 1, message: 'The universe does not exist.', field: 'universeId' }],
};

module.exports = async function run() {
    const suite = createSuite('gameOwnership');
    const { test, assert } = suite;

    // ── Doble del limitador ──────────────────────────────────────────────────
    // Sustituir `rateLimiter.run` deja probar getUniverseOwner sin red y sin
    // reimplementar su clasificacion: lo que se ejercita aqui es lo que hace
    // el cliente CON la respuesta, no como se clasifica el error.
    const runOriginal = rateLimiter.run;
    const responder = data => { rateLimiter.run = async () => ({ data }); };

    // ═══ 1. La respuesta buena ══════════════════════════════════════════════

    test('un universo real se resuelve con su dueño de verdad', async () => {
        responder(universoReal());
        const owner = await roblox.getUniverseOwner(UNIVERSE_ID);

        assert.strictEqual(owner.universeId, UNIVERSE_ID);
        assert.strictEqual(owner.creatorType, 'Group');
        assert.strictEqual(owner.creatorId, GROUP_ID);
        assert.strictEqual(owner.rootPlaceId, ROOT_PLACE);
        assert.strictEqual(owner.privacyType, 'Public');
    });

    test('todos los ids salen como TEXTO, no como numero', async () => {
        // develop.roblox.com los manda como number y `group_id` es TEXT en la
        // base. Comparar un number con un string daria siempre false y la
        // licencia no autorizaria a nadie.
        responder(universoReal());
        const owner = await roblox.getUniverseOwner(UNIVERSE_ID);

        for (const campo of ['universeId', 'creatorId', 'rootPlaceId']) {
            assert.strictEqual(typeof owner[campo], 'string', `${campo} tiene que ser texto`);
        }
    });

    test('una experiencia PRIVADA resuelve igual: es lo que arregla el fallo', async () => {
        // Este es el caso que estaba roto. Un juego sin publicar es lo normal
        // mientras el comprador lo monta, y tiene que poder usar el sistema.
        responder(universoReal({ privacyType: 'Private', isActive: false }));
        const owner = await roblox.getUniverseOwner(UNIVERSE_ID);

        assert.strictEqual(owner.creatorId, GROUP_ID, 'el dueño se conoce aunque el juego sea privado');
        assert.strictEqual(owner.privacyType, 'Private');
    });

    test('una experiencia de un USUARIO se reporta como tal', async () => {
        responder(universoReal({ creatorType: 'User', creatorTargetId: 1848960 }));
        const owner = await roblox.getUniverseOwner(UNIVERSE_ID);

        assert.strictEqual(owner.creatorType, 'User');
        assert.strictEqual(owner.creatorId, '1848960');
    });

    // ═══ 2. LA REGRESION: un 200 inservible NO es "no existe" ═══════════════

    test('la ficha CENSURADA no puede convertirse en NotFoundError', async () => {
        // EL TEST QUE JUSTIFICA ESTE ARCHIVO.
        responder(FICHA_CENSURADA);

        await assert.rejects(
            () => roblox.getUniverseOwner(UNIVERSE_ID),
            err => {
                assert.ok(!(err instanceof NotFoundError), 'JAMAS NotFoundError: eso seria un 403 definitivo');
                assert.ok(err instanceof UpstreamError, 'es "no lo se" -> 503');
                return true;
            }
        );
    });

    test('un creatorTargetId a CERO es censura, no un dueño', async () => {
        // 0 no es un id de Roblox valido: es el relleno de una ficha censurada.
        // Aceptarlo daria grupo_no_coincide, que es otro 403 definitivo con
        // otro nombre — el arreglo ingenuo de este mismo fallo.
        responder(universoReal({ creatorTargetId: 0 }));

        await assert.rejects(() => roblox.getUniverseOwner(UNIVERSE_ID), UpstreamError);
    });

    test('un cuerpo al que le falta lo esencial es "no lo se"', async () => {
        const inservibles = [
            [universoReal({ creatorTargetId: null }), 'sin creatorTargetId'],
            [universoReal({ creatorType: null }), 'sin creatorType'],
            [universoReal({ id: null }), 'sin id'],
            [{}, 'cuerpo vacio'],
            [null, 'cuerpo nulo'],
        ];

        for (const [cuerpo, que] of inservibles) {
            responder(cuerpo);
            await assert.rejects(
                () => roblox.getUniverseOwner(UNIVERSE_ID),
                err => {
                    assert.ok(!(err instanceof NotFoundError), `${que} no puede ser NotFoundError`);
                    assert.ok(err instanceof UpstreamError, `${que} tiene que ser UpstreamError`);
                    return true;
                }
            );
        }
    });

    test('el detalle del cuerpo raro se registra pero no viaja al cliente', async () => {
        responder(FICHA_CENSURADA);
        try {
            await roblox.getUniverseOwner(UNIVERSE_ID);
            assert.fail('deberia haber lanzado');
        } catch (err) {
            // `cause` es para el log (ver errorHandler); el mensaje que llega
            // al juego lo pone OwnershipUnavailableError, no esto.
            assert.ok(err.cause, 'la causa se conserva para poder diagnosticar');
            assert.match(err.cause.message, /creatorTargetId/);
        }
    });

    // ═══ 3. El predicado que decide si un 4xx es "no existe" ════════════════

    test('el 400 de develop.roblox.com SI significa que no existe', async () => {
        assert.strictEqual(roblox.esUniversoInexistente(400, CUERPO_NO_EXISTE), true);
    });

    test('cualquier OTRO 400 no significa que no exista', async () => {
        // La direccion del error importa: pasarse aqui convierte un problema
        // de Roblox en una denegacion definitiva contra un cliente legitimo.
        const otros = [
            [{ errors: [{ code: 5, message: 'Something else', field: 'universeId' }] }, 'otro code'],
            [{ errors: [{ code: 1, message: 'The user does not exist.', field: 'userId' }] }, 'otro field'],
            [{ errors: [] }, 'errors vacio'],
            [{ message: 'The universe does not exist.' }, 'mensaje suelto sin errors'],
            [{}, 'cuerpo vacio'],
            [null, 'sin cuerpo'],
            ['texto plano', 'cuerpo que no es JSON'],
        ];

        for (const [cuerpo, que] of otros) {
            assert.strictEqual(roblox.esUniversoInexistente(400, cuerpo), false, `${que} no puede ser "no existe"`);
        }
    });

    test('ningun otro codigo HTTP entra por el predicado', async () => {
        // 401/403 = Roblox nos bloquea. 429 = nos limita. 5xx = se cae.
        // Ninguno dice nada sobre si la experiencia existe.
        for (const status of [200, 401, 403, 404, 429, 500, 502, 503]) {
            assert.strictEqual(
                roblox.esUniversoInexistente(status, CUERPO_NO_EXISTE), false,
                `${status} no puede clasificarse por el cuerpo de un 400`
            );
        }
    });

    // ═══ 4. El predicado, ya montado en el limitador de verdad ══════════════

    test('a traves del limitador REAL: el 400 correcto sale como NotFoundError', async () => {
        rateLimiter.run = runOriginal;
        rateLimiter.reset();

        await assert.rejects(
            () => rateLimiter.run('universeInfo', () => { throw axiosError(400, {}, CUERPO_NO_EXISTE); },
                { notFoundCode: 'universe_not_found', notFoundWhen: roblox.esUniversoInexistente }),
            err => {
                assert.ok(err instanceof NotFoundError, 'tiene que ser NotFoundError');
                assert.strictEqual(err.code, 'universe_not_found');
                return true;
            }
        );
    });

    test('a traves del limitador REAL: 401, 403, 429, 5xx y red NO son NotFound', async () => {
        rateLimiter.run = runOriginal;

        const casos = [
            [() => axiosError(401, {}, { errors: [{ code: 9002, message: 'Authentication token is missing' }] }), 'Roblox pide autenticacion', UpstreamError],
            [() => axiosError(403, {}, {}), 'Roblox nos bloquea', UpstreamError],
            [() => axiosError(429, {}, {}), 'Roblox nos limita', UpstreamRateLimitedError],
            [() => axiosError(500, {}, {}), 'Roblox se cae', UpstreamError],
            [() => networkError('ECONNRESET'), 'se corta la red', UpstreamError],
        ];

        for (const [construir, que, esperado] of casos) {
            rateLimiter.reset();
            await captureStdout(async () => {
                await assert.rejects(
                    () => rateLimiter.run('universeInfo', () => { throw construir(); },
                        { notFoundCode: 'universe_not_found', notFoundWhen: roblox.esUniversoInexistente }),
                    err => {
                        assert.ok(!(err instanceof NotFoundError), `${que} JAMAS puede ser NotFoundError`);
                        assert.ok(err instanceof esperado, `${que} deberia ser ${esperado.name}`);
                        return true;
                    }
                );
            });
        }
        rateLimiter.reset();
    });

    // ═══ 5. La cadena completa del servicio ═════════════════════════════════

    test('el servicio traduce la censura a "no lo se", no a "no existe"', async () => {
        cache.reset();
        const universoOriginal = roblox.getUniverseIdForPlace;
        const dueñoOriginal = roblox.getUniverseOwner;
        rateLimiter.run = runOriginal;

        roblox.getUniverseIdForPlace = async () => UNIVERSE_ID;
        roblox.getUniverseOwner = async () => {
            throw new UpstreamError('develop/universes respondio 200 sin un propietario utilizable', new Error('censura'));
        };

        try {
            await captureStdout(async () => {
                await assert.rejects(
                    () => gameOwnership.resolveByPlaceId(ROOT_PLACE),
                    err => {
                        assert.strictEqual(err.name, 'OwnershipUnavailableError', 'sube como 503, no como denegacion');
                        assert.strictEqual(err.code, 'verificacion_no_disponible');
                        return true;
                    }
                );
            });
        } finally {
            roblox.getUniverseIdForPlace = universoOriginal;
            roblox.getUniverseOwner = dueñoOriginal;
            cache.reset();
        }
    });

    test('un "no existe" CONFIRMADO si llega como denegacion', async () => {
        // El otro lado de la regla: cuando Roblox lo confirma, la denegacion
        // tiene que producirse. Si no, el fail-closed dejaria de existir.
        cache.reset();
        const universoOriginal = roblox.getUniverseIdForPlace;

        roblox.getUniverseIdForPlace = async () => { throw new NotFoundError('place_not_found', 'no existe'); };
        try {
            const real = await gameOwnership.resolveByPlaceId('999999999999999');
            assert.deepStrictEqual(real, { found: false }, 'esto es lo que acaba en juego_desconocido');
        } finally {
            roblox.getUniverseIdForPlace = universoOriginal;
            cache.reset();
        }
    });

    test('rootPlaceId NO se usa para autorizar', async () => {
        // Un universo tiene varios places y el juego puede llamar desde
        // cualquiera. Exigir placeId === rootPlaceId cerraria la puerta a usos
        // legitimos, asi que el dato se expone pero no decide.
        cache.reset();
        const universoOriginal = roblox.getUniverseIdForPlace;
        const dueñoOriginal = roblox.getUniverseOwner;

        roblox.getUniverseIdForPlace = async () => UNIVERSE_ID;
        roblox.getUniverseOwner = async () => ({
            universeId: UNIVERSE_ID, rootPlaceId: ROOT_PLACE, name: 'x',
            creatorType: 'Group', creatorId: GROUP_ID, creatorName: 'y', privacyType: 'Public',
        });

        try {
            // Se pregunta por un place SECUNDARIO del mismo universo.
            const real = await gameOwnership.resolveByPlaceId('888888888888');
            assert.strictEqual(real.found, true, 'un place que no es el raiz sigue resolviendo');
            assert.strictEqual(real.creatorId, GROUP_ID);
        } finally {
            roblox.getUniverseIdForPlace = universoOriginal;
            roblox.getUniverseOwner = dueñoOriginal;
            cache.reset();
        }
    });

    const ok = await suite.run();

    rateLimiter.run = runOriginal;
    rateLimiter.reset();
    cache.reset();
    return ok;
};
