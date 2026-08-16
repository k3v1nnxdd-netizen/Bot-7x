'use strict';

const { createSuite } = require('./harness');
const {
    ValidationError, parseUsername, parseUserId, parseOutfitId, parsePagination,
} = require('../validation/params');

module.exports = async function run() {
    const { test, assert, run: runSuite } = createSuite('validation');

    function rejects(fn) {
        assert.throws(fn, err => err instanceof ValidationError);
    }

    test('parseUsername acepta nombres validos y recorta espacios', () => {
        assert.strictEqual(parseUsername('sombrapapoi'), 'sombrapapoi');
        assert.strictEqual(parseUsername('  Builderman  '), 'Builderman');
        assert.strictEqual(parseUsername('a_b_c'), 'a_b_c');
        assert.strictEqual(parseUsername('abc'), 'abc');
        assert.strictEqual(parseUsername('a'.repeat(20)), 'a'.repeat(20));
    });

    test('parseUsername rechaza longitudes y caracteres invalidos', () => {
        rejects(() => parseUsername('ab'));               // demasiado corto
        rejects(() => parseUsername('a'.repeat(21)));     // demasiado largo
        rejects(() => parseUsername('con espacio'));
        rejects(() => parseUsername('acento-ñ'));
        rejects(() => parseUsername('drop;table'));
        rejects(() => parseUsername(undefined));
        rejects(() => parseUsername(123));
        rejects(() => parseUsername(['abc']));            // parametro repetido en la query
    });

    test('parseUserId / parseOutfitId aceptan solo enteros positivos completos', () => {
        assert.strictEqual(parseUserId('1'), 1);
        assert.strictEqual(parseUserId('156'), 156);
        assert.strictEqual(parseOutfitId('987654321'), 987654321);
    });

    test('parseUserId rechaza lo que parseInt aceptaria por error', () => {
        rejects(() => parseUserId('123abc')); // parseInt daria 123
        rejects(() => parseUserId('12.5'));
        rejects(() => parseUserId('-1'));
        rejects(() => parseUserId('0'));
        rejects(() => parseUserId(''));
        rejects(() => parseUserId('1e3'));
        rejects(() => parseUserId(' 1'));
    });

    test('parseUserId rechaza enteros fuera del rango seguro de JS', () => {
        // Por encima de 2^53 Number pierde precision: consultariamos un id
        // distinto del que pidio el llamador.
        rejects(() => parseUserId('9007199254740993'));
    });

    test('parsePagination aplica los valores por defecto', () => {
        assert.deepStrictEqual(parsePagination({}), { page: 1, limit: 25 });
    });

    test('parsePagination acepta solo los limites del conjunto cerrado', () => {
        assert.deepStrictEqual(parsePagination({ limit: '10' }), { page: 1, limit: 10 });
        assert.deepStrictEqual(parsePagination({ limit: '50' }), { page: 1, limit: 50 });
        rejects(() => parsePagination({ limit: '7' }));
        rejects(() => parsePagination({ limit: '0' }));
        rejects(() => parsePagination({ limit: '100' }));
    });

    test('parsePagination no se deja engañar por un limit repetido', () => {
        // Express entrega un array cuando el parametro se repite, y
        // Number(['10']) vale 10 — sin comprobar el tipo, se colaria.
        rejects(() => parsePagination({ limit: ['10', '25'] }));
        rejects(() => parsePagination({ limit: ['10'] }));
    });

    test('parsePagination acota el rango de page', () => {
        assert.deepStrictEqual(parsePagination({ page: '100' }), { page: 100, limit: 25 });
        rejects(() => parsePagination({ page: '0' }));
        rejects(() => parsePagination({ page: '101' }));
        rejects(() => parsePagination({ page: '-3' }));
        rejects(() => parsePagination({ page: 'abc' }));
        rejects(() => parsePagination({ page: ['1'] }));
    });

    return runSuite();
};
