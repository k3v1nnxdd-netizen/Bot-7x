'use strict';

const { createSuite } = require('./harness');
const { normalizeOutfitList } = require('../roblox/client');
const { buildOutfit } = require('../services/humanoidDescription');
const fx = require('./fixtures/robloxResponses');

// Paginacion por CURSOR contra respuestas reales de Roblox.
//
// EL FALLO QUE ESTO CUBRE: `page` esta documentado pero Roblox lo IGNORA —
// page=1, page=2 y page=3 devolvian exactamente los mismos outfits y hasMore
// se quedaba en true para siempre. Lo que si funciona es `paginationToken`, y
// las fixtures de aqui son las dos paginas REALES que devolvio: ids
// completamente distintos.

module.exports = async function run() {
    const { test, assert, run: runSuite } = createSuite('pagination');

    test('primera pagina: devuelve cursor y hasMore=true', () => {
        const r = normalizeOutfitList(fx.listadoPagina1);
        assert.strictEqual(r.hasMore, true);
        assert.strictEqual(r.nextPageToken, fx.listadoPagina1.paginationToken);
        assert.strictEqual(r.outfits.length, 3);
    });

    test('el cursor lleva de verdad a outfits DISTINTOS', () => {
        const p1 = normalizeOutfitList(fx.listadoPagina1);
        const p2 = normalizeOutfitList(fx.listadoPagina2);

        const ids1 = p1.outfits.map(o => o.id);
        const ids2 = p2.outfits.map(o => o.id);

        // Con `page` estas dos listas eran IDENTICAS. Ese era el bug.
        assert.notDeepStrictEqual(ids1, ids2);
        assert.strictEqual(ids1.filter(id => ids2.includes(id)).length, 0, 'no deben solaparse');
        assert.notStrictEqual(p2.nextPageToken, p1.nextPageToken, 'cada pagina encadena un cursor nuevo');
    });

    test('cadena VACIA de Roblox = fin del recorrido', () => {
        const r = normalizeOutfitList(fx.listadoUltimaPagina);
        // Roblox no manda null ni omite el campo: manda "". Tratar "" como un
        // cursor valido dejaria al cliente en un bucle infinito pidiendo una
        // pagina que no existe.
        assert.strictEqual(fx.listadoUltimaPagina.paginationToken, '');
        assert.strictEqual(r.hasMore, false);
        assert.strictEqual(r.nextPageToken, null);
        assert.strictEqual(r.outfits.length, 2);
    });

    test('token ausente tambien es fin del recorrido', () => {
        const r = normalizeOutfitList({ data: [{ id: 1, name: 'x' }] });
        assert.strictEqual(r.hasMore, false);
        assert.strictEqual(r.nextPageToken, null);
    });

    test('hasMore y nextPageToken nunca se contradicen', () => {
        for (const raw of [fx.listadoPagina1, fx.listadoPagina2, fx.listadoUltimaPagina, {}, { data: [] }]) {
            const r = normalizeOutfitList(raw);
            assert.strictEqual(r.hasMore, r.nextPageToken !== null,
                'hasMore=true sin token (o al reves) dejaria al cliente colgado');
        }
    });

    test('una respuesta vacia o rara no revienta', () => {
        for (const raw of [null, undefined, {}, { data: null }, { data: 'no es un array' }]) {
            const r = normalizeOutfitList(raw);
            assert.deepStrictEqual(r.outfits, []);
            assert.strictEqual(r.hasMore, false);
        }
    });

    test('cada outfit del listado conserva outfitType e isEditable', () => {
        const r = normalizeOutfitList(fx.listadoPagina1);
        assert.deepStrictEqual(r.outfits[0], {
            id: 555869704325162, name: 'adidas Ice Angels', outfitType: 'Shoes', isEditable: false,
        });
        assert.deepStrictEqual(r.outfits.map(o => o.outfitType), ['Shoes', 'DynamicHead', 'DynamicHead']);
    });

    test('isEditable distingue lo guardado de lo derivado de bundles', () => {
        // Sin isEditable=true el listado mezcla ambas cosas. Estas dos
        // fixtures son el mismo usuario: 3 entradas del catalogo frente a los
        // 2 outfits que realmente guardo.
        const catalogo = normalizeOutfitList(fx.listadoPagina1);
        const guardados = normalizeOutfitList(fx.listadoUltimaPagina);

        assert.ok(catalogo.outfits.every(o => o.isEditable === false));
        assert.ok(guardados.outfits.every(o => o.isEditable === true));
    });

    // ── Lo que un outfit guardado contiene DE VERDAD ────────────────────────

    test('un outfit guardado NO trae animaciones de movimiento ni emotes', () => {
        // Respuesta real de un outfit guardado (isEditable=true). Roblox no
        // incluye el campo `emotes` en NINGUN outfit, y no aparecio ninguna
        // animacion de movimiento en los outfits guardados examinados.
        assert.strictEqual('emotes' in fx.outfitGuardadoR6, false, 'el campo emotes no existe en outfits');

        const hd = buildOutfit(fx.outfitGuardadoR6).humanoidDescription;
        for (const ranura of ['climb', 'death', 'fall', 'idle', 'jump', 'run', 'swim', 'walk', 'pose']) {
            assert.strictEqual(hd.animations[ranura], null, `${ranura} deberia quedar en null, no inventado`);
        }
        assert.deepStrictEqual(hd.emotes, []);

        // La de expresion SI viene: forma parte del bundle de la cabeza dinamica.
        assert.strictEqual(hd.animations.mood, 73094282779994);
    });

    test('R6 se reporta tal cual, sin asumir R15', () => {
        const outfit = buildOutfit(fx.outfitGuardadoR6);
        assert.strictEqual(outfit.playerAvatarType, 'R6');
        assert.strictEqual(outfit.isEditable, true);
        assert.strictEqual(outfit.inventoryType, 'Avatar');
    });

    test('un outfit guardado resuelve cuerpo, ropa y accesorios completos', () => {
        const hd = buildOutfit(fx.outfitGuardadoR6).humanoidDescription;
        assert.strictEqual(hd.bodyParts.torso, 27112025);
        assert.strictEqual(hd.dynamicHead, 119735386706067);
        assert.strictEqual(hd.clothing.shirt, 13343843);
        assert.strictEqual(hd.clothing.pants, 129458426);
        assert.deepStrictEqual(hd.accessories.hat, [11844853]);
        assert.deepStrictEqual(hd.other, [], 'nada sin clasificar');
    });

    return runSuite();
};
