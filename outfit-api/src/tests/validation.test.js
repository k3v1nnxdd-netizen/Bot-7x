'use strict';

const { createSuite } = require('./harness');
const {
    ValidationError, parseUsername, parseUserId, parseOutfitId, parsePagination, parsePageToken, parseBooleanFlag,
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
        assert.deepStrictEqual(parsePagination({}), { limit: 25, pageToken: undefined, outfitType: undefined });
    });

    test('parsePagination acepta solo los limites del conjunto cerrado', () => {
        assert.strictEqual(parsePagination({ limit: '10' }).limit, 10);
        assert.strictEqual(parsePagination({ limit: '50' }).limit, 50);
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

    test('parsePagination RECHAZA page, porque Roblox lo ignora', () => {
        // Comprobado en vivo: page=1 y page=2 devuelven exactamente los mismos
        // outfits. Reenviarlo daria paginacion falsa; ignorarlo dejaria a quien
        // lo mande convencido de estar paginando. Un 400 que explica el
        // mecanismo real es la unica salida honesta.
        rejects(() => parsePagination({ page: '1' }));
        rejects(() => parsePagination({ page: '2' }));

        let mensaje = '';
        try { parsePagination({ page: '2' }); } catch (err) { mensaje = err.message; }
        assert.match(mensaje, /pageToken/, 'el error debe indicar cual es el mecanismo correcto');
    });

    test('parsePageToken acepta un cursor real de Roblox', () => {
        // Token literal devuelto por avatar.roblox.com en la sonda.
        const real = 'MXx8fGlkXzJ6d0FBQVlubHF4WFl4QkJSU3podXJ0aWFSS2FjeVV4b3NnMjF8fHww';
        assert.strictEqual(parsePageToken(real), real);
        assert.strictEqual(parsePagination({ pageToken: real }).pageToken, real);
        assert.strictEqual(parsePageToken(undefined), undefined);
    });

    test('parsePageToken restaura el "+" que la query convierte en espacio', () => {
        // base64 puede contener '+', y un '+' sin codificar en una query llega
        // como espacio. El espacio no existe en base64, asi que encontrarlo
        // solo puede significar eso: se restaura en vez de romper un token
        // que en realidad era valido.
        assert.strictEqual(parsePageToken('ab cd+ef'), 'ab+cd+ef');
    });

    test('parsePageToken rechaza lo que no puede ser un cursor', () => {
        rejects(() => parsePageToken(''));
        rejects(() => parsePageToken('token con \n salto'));
        rejects(() => parsePageToken('¿acentos?'));
        rejects(() => parsePageToken('a'.repeat(513)));
        rejects(() => parsePageToken(['abc']));
        rejects(() => parsePageToken(123));
    });

    test('parsePagination acepta los outfitType que Roblox usa de verdad', () => {
        // Los tres valores estan confirmados en vivo en las respuestas de
        // avatar.roblox.com/v2, tanto como campo de cada outfit como filtro.
        for (const tipo of ['Avatar', 'DynamicHead', 'Shoes']) {
            assert.strictEqual(parsePagination({ outfitType: tipo }).outfitType, tipo);
        }
        assert.strictEqual(parsePagination({}).outfitType, undefined);
    });

    test('parsePagination rechaza un outfitType desconocido antes de gastar una llamada', () => {
        rejects(() => parsePagination({ outfitType: 'Basura' }));
        rejects(() => parsePagination({ outfitType: 'avatar' })); // Roblox distingue mayusculas
        rejects(() => parsePagination({ outfitType: ['Avatar'] }));
        rejects(() => parsePagination({ outfitType: '' }));
    });

    test('parseBooleanFlag solo acepta la forma explicita', () => {
        assert.strictEqual(parseBooleanFlag(undefined, 'bundles'), false);
        assert.strictEqual(parseBooleanFlag('1', 'bundles'), true);
        assert.strictEqual(parseBooleanFlag('true', 'bundles'), true);
        assert.strictEqual(parseBooleanFlag('0', 'bundles'), false);
        assert.strictEqual(parseBooleanFlag('false', 'bundles'), false);
        // Un "si" ambiguo activaria llamadas extra a Roblox sin que nadie lo
        // haya pedido de verdad: mejor un 400.
        rejects(() => parseBooleanFlag('yes', 'bundles'));
        rejects(() => parseBooleanFlag('', 'bundles'));
        rejects(() => parseBooleanFlag(['1'], 'bundles'));
    });

    return runSuite();
};
