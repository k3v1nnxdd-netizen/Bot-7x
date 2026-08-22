'use strict';

const crypto = require('crypto');
const { createSuite } = require('./harness');
const licenseToken = require('../security/licenseToken');

// La pieza criptografica del sistema de licencias, probada aparte de HTTP y de
// la base. Es codigo corto y sin dependencias, y justamente por eso conviene
// fijarlo: un fallo aqui no se ve en ninguna pantalla — un token con poca
// entropia o un hash mal calculado funcionan perfectamente hasta el dia que
// alguien los adivina.

module.exports = async function run() {
    const suite = createSuite('licenseToken');
    const { test, assert } = suite;

    test('un token es prefijo + 256 bits en base64url', () => {
        const token = licenseToken.generateToken();

        assert.match(token, /^7xl_[A-Za-z0-9_-]{43}$/);
        assert.ok(token.startsWith('7xl_'), 'el prefijo permite reconocerlo pegado en el sitio equivocado');
        // 43 caracteres base64url = 258 bits de representacion para 256 bits
        // reales. Si esto bajara, bajaria la entropia sin que nada fallara.
        assert.strictEqual(token.length, 47);
    });

    test('dos tokens nunca coinciden', () => {
        const vistos = new Set();
        for (let i = 0; i < 2000; i++) vistos.add(licenseToken.generateToken());
        assert.strictEqual(vistos.size, 2000, 'sin una sola colision en 2000 tokens');
    });

    test('el hash es el SHA-256 del token, y es determinista', () => {
        const token = licenseToken.generateToken();
        const esperado = crypto.createHash('sha256').update(token, 'utf8').digest('hex');

        assert.strictEqual(licenseToken.hashToken(token), esperado);
        assert.strictEqual(licenseToken.hashToken(token), licenseToken.hashToken(token));
        assert.match(licenseToken.hashToken(token), /^[0-9a-f]{64}$/);
    });

    test('del hash no se puede leer el token', () => {
        const token = licenseToken.generateToken();
        const hash = licenseToken.hashToken(token);

        // Obvio, pero es LA propiedad por la que se guarda el hash y no el
        // token: si esta fila se filtra, nadie puede suplantar al cliente.
        assert.notStrictEqual(hash, token);
        assert.ok(!hash.includes(token.slice(4)), 'el hash no contiene el token');
        assert.ok(!hash.includes('7xl_'));
    });

    test('dos tokens parecidos dan hashes completamente distintos', () => {
        const a = licenseToken.hashToken('7xl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
        const b = licenseToken.hashToken('7xl_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab');

        assert.notStrictEqual(a, b);
        // Un solo caracter de diferencia tiene que cambiar aproximadamente la
        // mitad de los bits. Se comprueba burdamente: que no compartan ni
        // siquiera los primeros 8 caracteres.
        assert.notStrictEqual(a.slice(0, 8), b.slice(0, 8));
    });

    test('hashToken no revienta con entradas absurdas', () => {
        for (const malo of [null, undefined, '', 0, {}, [], true]) {
            assert.strictEqual(licenseToken.hashToken(malo), null, `${JSON.stringify(malo)} deberia dar null`);
        }
    });

    test('looksLikeToken filtra la basura antes de tocar la base', () => {
        assert.ok(licenseToken.looksLikeToken(licenseToken.generateToken()));

        const malos = [
            '', ' ', null, undefined, 0, {}, [],
            'no-es-un-token',
            '7xl_corto',
            '7xl_' + 'a'.repeat(44),          // uno de mas
            '7xl_' + 'a'.repeat(42),          // uno de menos
            'xxx_' + 'a'.repeat(43),          // prefijo ajeno
            '7xl_' + 'a'.repeat(42) + '+',    // base64 clasico, no base64url
            '7xl_' + 'a'.repeat(42) + '/',
            '7xl_' + 'a'.repeat(42) + '=',
            "7xl_'; DROP TABLE group_whitelist; --",
        ];
        for (const malo of malos) {
            assert.strictEqual(licenseToken.looksLikeToken(malo), false, `${String(malo).slice(0, 20)} no es un token`);
        }
    });

    test('matchesHash acepta el par correcto y rechaza cualquier otro', () => {
        const token = licenseToken.generateToken();
        const hash = licenseToken.hashToken(token);

        assert.strictEqual(licenseToken.matchesHash(token, hash), true);
        assert.strictEqual(licenseToken.matchesHash(licenseToken.generateToken(), hash), false);
        assert.strictEqual(licenseToken.matchesHash(token + 'x', hash), false);
        assert.strictEqual(licenseToken.matchesHash(token.slice(0, -1), hash), false);
    });

    test('matchesHash rechaza un hash guardado que no tiene forma de hash', () => {
        const token = licenseToken.generateToken();

        // Si la columna trajera algo raro (una migracion a medias, una fila
        // tocada a mano), la comparacion tiene que decir NO en vez de romperse
        // o, peor, colarse.
        for (const raro of [null, undefined, '', 'no-es-un-hash', licenseToken.hashToken(token).toUpperCase(),
            licenseToken.hashToken(token).slice(0, 63), 12345, {}]) {
            assert.strictEqual(licenseToken.matchesHash(token, raro), false, `hash guardado invalido: ${String(raro).slice(0, 16)}`);
        }
    });

    test('matchesHash no lanza nunca, con nada', () => {
        for (const token of [null, undefined, '', 0, {}, []]) {
            for (const hash of [null, undefined, '', 'x'.repeat(64), licenseToken.hashToken('a')]) {
                assert.strictEqual(licenseToken.matchesHash(token, hash), false);
            }
        }
    });

    return suite.run();
};
