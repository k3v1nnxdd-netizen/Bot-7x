'use strict';

const { createSuite } = require('./harness');
const { buildOutfit, normalizeBodyColors, normalizeScale } = require('../services/humanoidDescription');
const fx = require('./fixtures/robloxResponses');

// La normalizacion se prueba contra respuestas REALES de Roblox capturadas en
// vivo (ver fixtures/robloxResponses.js). Es lo que hace que estos tests
// signifiquen algo: no comprueban que el codigo hace lo que el codigo dice,
// comprueban que interpreta bien lo que Roblox devuelve de verdad.

module.exports = async function run() {
    const { test, assert, run: runSuite } = createSuite('humanoidDescription');

    test('ropa por capas: order y puffiness llegan intactos', () => {
        const outfit = buildOutfit(fx.ropaPorCapas);
        const capas = outfit.humanoidDescription.layeredClothing;

        assert.strictEqual(capas.length, 2);
        assert.deepStrictEqual(capas[0], {
            assetId: 101396973232145, typeId: 70, typeName: 'LeftShoeAccessory',
            accessoryType: 'LeftShoe', order: 0, puffiness: 0,
        });
        // Sin order/puffiness, Studio no puede colocar bien una pieza por
        // capas: es el dato que diferencia "lleva zapatos" de "los lleva
        // encima del pantalon o debajo".
        assert.ok(capas.every(c => c.order !== null && c.puffiness !== null));
    });

    test('ropa por capas: el `meta` crudo tambien se reenvia verbatim', () => {
        const outfit = buildOutfit(fx.ropaPorCapas);
        // version=1 no lo usa nuestra normalizacion, pero si lo manda Roblox
        // el juego debe poder verlo: copiar campo a campo perderia callado
        // cualquiera que añadan.
        assert.deepStrictEqual(outfit.assets[0].meta, { order: 0, puffiness: 0, version: 1 });
    });

    test('cabeza dinamica: va a bodyParts.head Y se marca aparte', () => {
        const hd = buildOutfit(fx.cabezaDinamica).humanoidDescription;

        // HumanoidDescription.Head acepta una cabeza dinamica en el mismo
        // hueco que una normal...
        assert.strictEqual(hd.bodyParts.head, 11308945948);
        // ...pero el juego necesita saber que lo es (soporta expresiones).
        assert.strictEqual(hd.dynamicHead, 11308945948);
        assert.strictEqual(hd.animations.mood, 11308935548);
    });

    test('cabeza dinamica: supportsHeadShapes se conserva', () => {
        const outfit = buildOutfit(fx.cabezaDinamica);
        const cabeza = outfit.assets.find(a => a.typeName === 'DynamicHead');
        assert.strictEqual(cabeza.supportsHeadShapes, true);
    });

    test('una ceja por capas aparece a la vez en su categoria y en layeredClothing', () => {
        const hd = buildOutfit(fx.cabezaDinamica).humanoidDescription;
        const ceja = hd.layeredClothing.find(c => c.typeName === 'EyebrowAccessory');

        assert.ok(ceja, 'debe estar entre las piezas por capas');
        assert.strictEqual(ceja.order, 2);
        // Y ademas se recoge como parte de la CARA (ver animatedFace): una ceja
        // mezclada entre camisas y chaquetas es justo lo que un juego deja de
        // aplicar. En `other` no cae nunca.
        assert.ok(hd.other.every(o => o.typeName !== 'EyebrowAccessory'),
            'si tiene datos de capa, se clasifica como capa y no como sobrante');
    });

    // ── LA CARA ANIMADA NUEVA DE ROBLOX ─────────────────────────────────────
    //
    // El fallo que motiva estos tests: los tres trozos de la cara animada
    // existian en la respuesta pero repartidos entre bodyParts, animations y
    // layeredClothing, sin nada que dijera que son UNA cosa. Un juego que
    // aplicaba "las partes del cuerpo", luego "las animaciones de movimiento" y
    // luego "la ropa por capas" montaba la cabeza y se dejaba el mood — y la
    // cara se quedaba quieta.

    test('animatedFace junta las TRES piezas de la cara animada', () => {
        const hd = buildOutfit(fx.cabezaDinamica).humanoidDescription;

        assert.strictEqual(hd.animatedFace.isAnimated, true);
        assert.strictEqual(hd.animatedFace.head, 11308945948, 'la malla con FaceControls');
        assert.strictEqual(hd.animatedFace.mood, 11308935548, 'LO QUE LA ANIMA');
        assert.strictEqual(hd.animatedFace.eyebrow, 11308949065);
        assert.strictEqual(hd.animatedFace.supportsHeadShapes, true);
    });

    test('sin mood no hay cara animada, y eso tiene que verse', () => {
        // Una cabeza dinamica sin su MoodAnimation se monta bien y se queda
        // quieta. Es el sintoma exacto que hay que poder diagnosticar mirando
        // la respuesta, sin abrir Studio.
        const sinMood = {
            ...fx.cabezaDinamica,
            assets: fx.cabezaDinamica.assets.filter(a => a.assetType.name !== 'MoodAnimation'),
        };
        const hd = buildOutfit(sinMood).humanoidDescription;

        assert.strictEqual(hd.animatedFace.head, 11308945948, 'la cabeza si esta');
        assert.strictEqual(hd.animatedFace.mood, null, 'y se ve de un vistazo que le falta el mood');
        assert.strictEqual(hd.animatedFace.isAnimated, true, 'sigue siendo una cabeza dinamica');
    });

    test('animatedFace no se inventa nada: es lo mismo que ya hay en el resto', () => {
        // Es redundante A PROPOSITO, asi que la redundancia tiene que ser
        // exacta. Si algun dia divergen, este test lo caza.
        const hd = buildOutfit(fx.cabezaDinamica).humanoidDescription;

        assert.strictEqual(hd.animatedFace.head, hd.bodyParts.head);
        assert.strictEqual(hd.animatedFace.head, hd.dynamicHead);
        assert.strictEqual(hd.animatedFace.mood, hd.animations.mood);
        assert.strictEqual(hd.animatedFace.classic, hd.face);
        const ceja = hd.layeredClothing.find(c => c.typeName === 'EyebrowAccessory');
        assert.strictEqual(hd.animatedFace.eyebrow, ceja.assetId);
    });

    test('un avatar con cara 2D clasica se distingue de uno con cara animada', () => {
        // Las dos formas conviven en Roblox y un avatar tiene una o la otra.
        // `isAnimated` es la pregunta que el juego quiere hacer de verdad.
        const hd = buildOutfit({
            assets: [{ id: 111, name: 'cara', assetType: { id: 18, name: 'Face' } }],
        }).humanoidDescription;

        assert.strictEqual(hd.animatedFace.isAnimated, false);
        assert.strictEqual(hd.animatedFace.classic, 111, 'va a HumanoidDescription.Face');
        assert.strictEqual(hd.animatedFace.head, null);
        assert.strictEqual(hd.animatedFace.mood, null);
    });

    test('un outfit sin cara de ningun tipo no finge tener una', () => {
        const hd = buildOutfit(fx.partesDelCuerpo).humanoidDescription;

        assert.strictEqual(hd.animatedFace.isAnimated, false);
        assert.deepStrictEqual(
            [hd.animatedFace.head, hd.animatedFace.mood, hd.animatedFace.classic,
             hd.animatedFace.eyebrow, hd.animatedFace.eyelash],
            [null, null, null, null, null]
        );
    });

    test('las pestañas se recogen igual que las cejas', () => {
        const conPestanas = {
            assets: [
                { id: 900, name: 'Head', assetType: { id: 79, name: 'DynamicHead' }, supportsHeadShapes: false },
                { id: 901, name: 'Lash', assetType: { id: 77, name: 'EyelashAccessory' }, meta: { order: 3, puffiness: 0 } },
            ],
        };
        const hd = buildOutfit(conPestanas).humanoidDescription;

        assert.strictEqual(hd.animatedFace.eyelash, 901);
        assert.strictEqual(hd.animatedFace.supportsHeadShapes, false, 'false es un dato, no una ausencia');
    });

    test('cejas y pestañas NO acaban en other[]: son cara, no sobrantes', () => {
        const hd = buildOutfit(fx.cabezaDinamica).humanoidDescription;
        assert.ok(hd.other.every(o => !['EyebrowAccessory', 'EyelashAccessory'].includes(o.typeName)));
    });

    // ── accessoryType, sin el cual las piezas por capas no se pueden aplicar ─

    test('cada pieza por capas trae su Enum.AccessoryType resuelto', () => {
        const hd = buildOutfit(fx.cabezaDinamica).humanoidDescription;
        const ceja = hd.layeredClothing.find(c => c.typeName === 'EyebrowAccessory');

        // Es lo que espera SetAccessories(). Sin esto cada juego se escribe la
        // misma tabla de conversion y las cejas y pestañas son justo las que se
        // quedan fuera.
        assert.strictEqual(ceja.accessoryType, 'Eyebrow');
    });

    test('un tipo por capas desconocido no se inventa un AccessoryType', () => {
        const hd = buildOutfit({
            assets: [{ id: 5, name: 'x', assetType: { id: 999, name: 'AlgoNuevoAccessory' }, meta: { order: 1, puffiness: 0 } }],
        }).humanoidDescription;

        assert.strictEqual(hd.layeredClothing[0].accessoryType, null,
            'null es la verdad; un Enum inventado reventaria en Lua');
        assert.strictEqual(hd.layeredClothing[0].assetId, 5, 'pero el asset no se pierde');
    });

    test('partes del cuerpo: cada una a su hueco', () => {
        const hd = buildOutfit(fx.partesDelCuerpo).humanoidDescription;
        assert.deepStrictEqual(hd.bodyParts, {
            head: null, // este outfit no lleva cabeza
            torso: 27112025,
            leftArm: 27112052,
            rightArm: 27112039,
            leftLeg: 27112056,
            rightLeg: 27112068,
        });
    });

    test('colores: cada parte conserva EL SUYO, sin contagiarse', () => {
        const hd = buildOutfit(fx.partesDelCuerpo).humanoidDescription;
        assert.strictEqual(hd.bodyColorFormat, 'hex');
        assert.deepStrictEqual(hd.bodyColors, {
            head: 'F9F9F9', torso: 'A7C7E7',
            leftArm: 'F9F9F9', rightArm: 'F9F9F9',
            leftLeg: '6495ED', rightLeg: '6495ED',
        });
    });

    test('colores: tambien se entiende el formato de ids de BrickColor', () => {
        const { format, colors } = normalizeBodyColors(fx.coloresPorIdDeBrickColor);
        assert.strictEqual(format, 'brickColorId');
        assert.strictEqual(colors.head, 125);
        assert.strictEqual(colors.leftLeg, 125);
    });

    test('colores: si Roblox no manda ninguno, se dice, no se inventa', () => {
        assert.deepStrictEqual(normalizeBodyColors({}), { format: null, colors: null });
    });

    test('escala: las seis, con sus valores reales', () => {
        assert.deepStrictEqual(normalizeScale(fx.avatarCompleto), {
            height: 1.05, width: 0.95, depth: 1.0, head: 1.0, proportion: 0.3, bodyType: 0.7,
        });
    });

    test('escala: ausente devuelve null, nunca ceros inventados', () => {
        assert.strictEqual(normalizeScale({}), null);
        // Un 0 en proportion/bodyType es un valor LEGITIMO de Roblox; si
        // rellenaramos huecos con ceros, seria indistinguible de "no lo se".
        const parcial = normalizeScale({ scale: { height: 2 } });
        assert.strictEqual(parcial.height, 2);
        assert.strictEqual(parcial.bodyType, null);
    });

    test('avatar completo: todas las categorias caen donde deben', () => {
        const outfit = buildOutfit(fx.avatarCompleto);
        const hd = outfit.humanoidDescription;

        assert.strictEqual(hd.clothing.shirt, 607785314);
        assert.strictEqual(hd.clothing.pants, 301811432);
        assert.strictEqual(hd.clothing.graphicTShirt, null);
        assert.deepStrictEqual(hd.accessories.hat, [607702162]);
        assert.deepStrictEqual(hd.bodyParts, {
            head: 10638267973, // la cabeza dinamica ocupa el hueco de Head
            torso: 12995020128, leftArm: 12995014400, rightArm: 12995017412,
            leftLeg: 12995015868, rightLeg: 12995018829,
        });
        assert.strictEqual(hd.playerAvatarTypeShouldBeOnRoot, undefined);
        assert.strictEqual(outfit.playerAvatarType, 'R15');
    });

    test('avatar completo: las siete animaciones de movimiento', () => {
        const hd = buildOutfit(fx.avatarCompleto).humanoidDescription;
        assert.deepStrictEqual(hd.animations, {
            climb: 2510230574,
            death: null, // Roblox no mando ninguna: null es la verdad, no un hueco a rellenar
            fall: 2510233257,
            idle: 2510235063,
            jump: 2510236649,
            run: 2510238627,
            swim: 2510240941,
            walk: 2510242378,
            pose: null,
            mood: 10647852134,
        });
    });

    test('avatar completo: nada se queda sin clasificar', () => {
        const outfit = buildOutfit(fx.avatarCompleto);
        const hd = outfit.humanoidDescription;

        const clasificados = new Set([
            ...Object.values(hd.bodyParts).filter(Boolean),
            ...Object.values(hd.clothing).filter(Boolean),
            ...Object.values(hd.accessories).flat(),
            ...Object.values(hd.animations).filter(Boolean),
            ...hd.emotes,
            ...hd.layeredClothing.map(c => c.assetId),
            ...hd.other.map(o => o.assetId),
            hd.face,
        ].filter(v => v != null));

        for (const asset of outfit.assets) {
            assert.ok(clasificados.has(asset.id), `el asset ${asset.id} (${asset.typeName}) se perdio`);
        }
    });

    test('la cara 2D y el accesorio de cara NO se confunden', () => {
        // Face(18) es la textura clasica -> HumanoidDescription.Face.
        // FaceAccessory(42) es un accesorio 3D -> grupo de accesorios.
        // Mezclarlos daria un avatar visiblemente mal reconstruido.
        const outfit = buildOutfit({
            id: 1,
            assets: [
                { id: 111, name: 'Cara', assetType: { id: 18, name: 'Face' } },
                { id: 222, name: 'Gafas', assetType: { id: 42, name: 'FaceAccessory' } },
            ],
        });
        assert.strictEqual(outfit.humanoidDescription.face, 111);
        assert.deepStrictEqual(outfit.humanoidDescription.accessories.face, [222]);
    });

    test('varios accesorios de la misma categoria se acumulan', () => {
        const hd = buildOutfit({
            id: 1,
            assets: [
                { id: 1, name: 'a', assetType: { id: 8, name: 'Hat' } },
                { id: 2, name: 'b', assetType: { id: 8, name: 'Hat' } },
                { id: 3, name: 'c', assetType: { id: 41, name: 'HairAccessory' } },
            ],
        }).humanoidDescription;

        assert.deepStrictEqual(hd.accessories.hat, [1, 2]);
        assert.deepStrictEqual(hd.accessories.hair, [3]);
    });

    test('un tipo desconocido de Roblox va a `other`, jamas al vacio', () => {
        const hd = buildOutfit({
            id: 1,
            assets: [{ id: 777, name: 'Categoria del futuro', assetType: { id: 9999, name: 'AlgoNuevo' } }],
        }).humanoidDescription;

        assert.deepStrictEqual(hd.other, [{ assetId: 777, typeId: 9999, typeName: 'AlgoNuevo' }]);
    });

    test('emotes se recogen aparte', () => {
        const hd = buildOutfit({
            id: 1,
            assets: [{ id: 3360692915, name: 'Tilt', assetType: { id: 61, name: 'EmoteAnimation' } }],
        }).humanoidDescription;

        assert.deepStrictEqual(hd.emotes, [3360692915]);
    });

    test('metadatos del outfit: tipo, inventario, editable, universo', () => {
        const outfit = buildOutfit(fx.ropaPorCapas);
        assert.strictEqual(outfit.id, 555869704325162);
        assert.strictEqual(outfit.name, 'adidas Ice Angels');
        assert.strictEqual(outfit.outfitType, 'Shoes');
        assert.strictEqual(outfit.inventoryType, 'Shoes');
        assert.strictEqual(outfit.isEditable, false);
        assert.strictEqual(outfit.universeId, null);
    });

    test('una respuesta vacia no revienta ni se inventa nada', () => {
        const outfit = buildOutfit({}, 42);
        assert.strictEqual(outfit.id, 42, 'cae al id pedido si Roblox no lo devuelve');
        assert.deepStrictEqual(outfit.assets, []);
        assert.strictEqual(outfit.humanoidDescription.scale, null);
        assert.strictEqual(outfit.humanoidDescription.bodyColors, null);
        assert.strictEqual(outfit.playerAvatarType, null);
    });

    test('la salida es JSON serializable y de tamaño razonable', () => {
        const json = JSON.stringify(buildOutfit(fx.avatarCompleto));
        assert.ok(json.length < 6000, `la respuesta ocupa ${json.length} bytes`);
        assert.deepStrictEqual(JSON.parse(json).humanoidDescription.accessories.hat, [607702162]);
    });

    return runSuite();
};
