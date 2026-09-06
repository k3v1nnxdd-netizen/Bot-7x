'use strict';

const http = require('http');
const { createSuite, axiosError } = require('./harness');
const { createApp } = require('../app');
const ownRateLimit = require('../security/rateLimit');
const robloxRateLimiter = require('../roblox/rateLimiter');
const db = require('../db/pool');
const roblox = require('../roblox/client');
const cache = require('../cache/cacheStore');
const singleFlight = require('../cache/singleFlight');
const licenseToken = require('../security/licenseToken');
const config = require('../config');

// LA CUADRICULA ENTERA EN UNA SOLA PETICION —
// GET /v1/users/by-username/:u/outfits?details=1&catalog=1
//
// EL PROBLEMA QUE RESUELVE, DEL LADO DE ROBLOX. El juego hacia dos peticiones:
// listar y luego pedir los detalles. Cada peticion de HttpService cuesta 3
// fichas de un cubo de 40 que recarga a 8/s en el servidor de Roblox, y esas
// fichas las comparte con TODO lo demas que haga el juego. Dos peticiones por
// busqueda es el doble de presupuesto gastado en lo mismo.
//
// LO QUE SE PROTEGE AQUI, por orden de importancia:
//
//   1. COMPATIBILIDAD. Sin banderas, la respuesta es byte a byte la de antes.
//      Es lo unico que permite desplegar esto sin tocar el juego publicado.
//   2. PARIDAD DE PRECIOS con GET /v1/outfits/:id?catalog=1. Si no salen
//      identicos, migrar la cuadricula cambia lo que ve el jugador.
//   3. ORDEN Y AISLAMIENTO. El orden de la lista se respeta, y un outfit
//      borrado no puede dejar sin cuadricula a los demas.
//   4. QUE NO HAYA TRABAJO REDUNDANTE. El catalogo se resuelve UNA vez para
//      todos los outfits, con los assets unidos y deduplicados.
//
// NOTA SOBRE LA CACHE EN ESTA SUITE. El runner corre con CACHE_MAX_ENTRIES=5
// para poder probar la expulsion LRU. Los casos que miden reutilizacion de
// cache usan por eso conjuntos minusculos; los que miden llamadas DENTRO de una
// sola peticion no se ven afectados, porque ahi cada id se resuelve una vez
// pase lo que pase con la expulsion posterior.

const GROUP_ID = '35216530';
const PLACE_ID = '1234567890';
const UNIVERSE_ID = '5432109876';
const USER_ID = 777;

function pedir(port, ruta, headers) {
    ownRateLimit.reset();
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: ruta, method: 'GET', headers }, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch { /* no-JSON */ }
                resolve({ status: res.statusCode, body: parsed, bytes: Buffer.byteLength(data) });
            });
        });
        req.on('error', reject);
        req.end();
    });
}

module.exports = async function run() {
    const suite = createSuite('outfitsByUsernameDetails');
    const { test, assert } = suite;

    const app = createApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;

    const TOKEN = licenseToken.generateToken();
    const original = {
        query: db.query,
        universo: roblox.getUniverseIdForPlace,
        dueño: roblox.getUniverseOwner,
        usuario: roblox.lookupUserByUsername,
        lista: roblox.listOutfits,
        detalles: roblox.getOutfitDetailsRaw,
        catalogo: roblox.getCatalogDetails,
    };

    db.query = async () => ({
        rows: [{ group_id: GROUP_ID, active: true, license_token_hash: licenseToken.hashToken(TOKEN) }],
        rowCount: 1,
    });
    roblox.getUniverseIdForPlace = async () => UNIVERSE_ID;
    roblox.getUniverseOwner = async () => ({ creatorType: 'Group', creatorId: GROUP_ID, universeId: UNIVERSE_ID });

    const AUTORIZADO = {
        'x-license-token': TOKEN,
        'x-game-id': UNIVERSE_ID,
        'x-place-id': PLACE_ID,
    };

    // ── El mundo falso ───────────────────────────────────────────────────────
    //
    // Los outfits COMPARTEN assets, como los de una persona de verdad: el asset
    // 10 lo llevan todos y los 1-3 rotan. Con veinticuatro outfits son 48
    // referencias y CUATRO assets distintos — que es justo lo que la
    // deduplicacion global tiene que aprovechar.
    const COMPARTIDOS = outfitId => [1 + (outfitId % 3), 10];

    // Seis assets PROPIOS por outfit y ninguno compartido. Sirve para el unico
    // caso que necesita superar MAX_CATALOG_BATCH_SIZE y ver el troceado.
    const PROPIOS = outfitId => Array.from({ length: 6 }, (_, k) => (outfitId - 2000) * 6 + k + 1);

    let assetsDe = COMPARTIDOS;

    let cuantos = 3;
    const llamadas = { usuario: 0, lista: 0, detalles: 0, catalogo: 0, assetsPedidos: [] };
    let fallaOutfit = () => null;

    function limpiar(n = 3) {
        cuantos = n;
        llamadas.usuario = 0; llamadas.lista = 0; llamadas.detalles = 0;
        llamadas.catalogo = 0; llamadas.assetsPedidos = [];
        fallaOutfit = () => null;
        assetsDe = COMPARTIDOS;
        cache.reset();
        singleFlight.reset();
        robloxRateLimiter.reset();
    }

    const idsEsperados = n => Array.from({ length: n }, (_, i) => 2000 + i);

    roblox.lookupUserByUsername = async nombre => {
        llamadas.usuario++;
        return { userId: USER_ID, username: nombre, displayName: 'Kevin' };
    };

    roblox.listOutfits = async () => {
        llamadas.lista++;
        return {
            outfits: idsEsperados(cuantos).map(id => ({
                id, name: `Outfit ${id}`, outfitType: 'Avatar', isEditable: true,
            })),
            nextPageToken: null,
            hasMore: false,
        };
    };

    // Los dobles pasan POR EL LIMITADOR REAL, como el cliente de verdad: asi los
    // errores se clasifican igual que en produccion y las llamadas se cuentan en
    // el cubo que les toca.
    roblox.getOutfitDetailsRaw = async outfitId => robloxRateLimiter.run('outfitDetails', async () => {
        llamadas.detalles++;
        const fallo = fallaOutfit(outfitId);
        if (fallo) throw fallo;
        return {
            data: {
                id: outfitId,
                name: `Outfit ${outfitId}`,
                assets: assetsDe(outfitId).map(id => ({
                    id, name: `Asset ${id}`, assetType: { id: 8, name: 'Hat' },
                })),
                bodyColor3s: { headColor3: 'A3A2A5', torsoColor3: 'A3A2A5' },
                scale: { height: 1, width: 1 },
                playerAvatarType: 'R15',
                outfitType: 'Avatar',
                isEditable: true,
            },
        };
    }, { endpoint: 'avatar.roblox.com/v3/outfits/{id}/details', notFoundCode: 'outfit_not_found' })
        .then(r => r.data);

    roblox.getCatalogDetails = async assetIds => robloxRateLimiter.run('catalogDetails', async () => {
        llamadas.catalogo++;
        llamadas.assetsPedidos.push(...assetIds);
        const mapa = new Map();
        for (const id of assetIds) {
            mapa.set(id, {
                available: true, restrictions: ['Limited'], isLimited: true, offSale: false,
                price: id * 100, lowestPrice: id * 90, lowestResalePrice: id * 120,
                hasResellers: true, creatorType: 'User', creatorTargetId: 55, creatorName: 'Creador',
            });
        }
        return { data: mapa };
    }, { endpoint: 'catalog.roblox.com/v1/catalog/items/details' }).then(r => r.data);

    const listar = (query = '') => pedir(port, `/v1/users/by-username/kevin/outfits${query}`, AUTORIZADO);
    const individual = (id, query = '') => pedir(port, `/v1/outfits/${id}${query}`, AUTORIZADO);

    // ── 1. Compatibilidad: sin banderas, nada cambia ─────────────────────────

    test('SIN banderas la respuesta es exactamente la de antes', async () => {
        limpiar(3);
        const res = await listar();

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(Object.keys(res.body).sort(), [
            'count', 'displayName', 'hasMore', 'limit', 'nextPageToken',
            'outfitType', 'outfits', 'userId', 'username',
        ]);
        // Los outfits siguen siendo las cuatro claves del listado, sin detalles.
        assert.deepStrictEqual(res.body.outfits[0], {
            id: 2000, name: 'Outfit 2000', outfitType: 'Avatar', isEditable: true,
        });
        assert.strictEqual(res.body.stats, undefined, 'aparecio un campo stats que antes no estaba');
        assert.strictEqual(llamadas.detalles, 0, 'se pidieron detalles sin que nadie los pidiera');
        assert.strictEqual(llamadas.catalogo, 0);
    });

    test('details=0 explicito tampoco cambia nada', async () => {
        limpiar(3);
        const res = await listar('?details=0');
        assert.strictEqual(res.body.outfits[0].assets, undefined);
        assert.strictEqual(llamadas.detalles, 0);
    });

    // ── 2. details=1 ─────────────────────────────────────────────────────────

    test('details=1 devuelve el outfit completo con cuerpo, colores y escalas', async () => {
        limpiar(1);
        const res = await listar('?details=1');

        assert.strictEqual(res.status, 200);
        const entrada = res.body.outfits[0];
        assert.strictEqual(entrada.outfitId, 2000);
        assert.strictEqual(entrada.ok, true);

        const o = entrada.outfit;
        assert.strictEqual(o.name, 'Outfit 2000');
        assert.strictEqual(o.outfitType, 'Avatar');
        assert.strictEqual(o.isEditable, true);
        assert.ok(Array.isArray(o.assets) && o.assets.length === 2, 'faltan los assets');
        assert.strictEqual(o.playerAvatarType, 'R15');

        // El cuerpo completo va agrupado en humanoidDescription, listo para
        // montar el rig sin que el juego tenga que repartir assets por tipo.
        const hd = o.humanoidDescription;
        assert.ok(hd, 'falta humanoidDescription');
        for (const campo of [
            'scale', 'bodyColorFormat', 'bodyColors', 'bodyParts', 'clothing',
            'face', 'animatedFace', 'accessories', 'layeredClothing', 'animations', 'emotes',
        ]) {
            assert.ok(campo in hd, `falta ${campo} en humanoidDescription`);
        }
        assert.strictEqual(hd.bodyColorFormat, 'hex');
        assert.strictEqual(hd.bodyColors.head, 'A3A2A5');
        assert.strictEqual(hd.scale.height, 1);
        // Sin catalog, ni precios ni bandera de catalogo.
        assert.strictEqual(o.catalogResolved, undefined);
        assert.strictEqual(llamadas.catalogo, 0);
    });

    test('details=1 no vuelve a pedir la lista ni el usuario', async () => {
        limpiar(1);
        await listar('?details=1');
        assert.strictEqual(llamadas.usuario, 1);
        assert.strictEqual(llamadas.lista, 1);
    });

    // ── 3. details=1&catalog=1 ───────────────────────────────────────────────

    test('details=1&catalog=1 trae todos los campos de catalogo por asset', async () => {
        limpiar(1);
        const res = await listar('?details=1&catalog=1');

        const o = res.body.outfits[0].outfit;
        assert.strictEqual(o.catalogResolved, true);
        for (const asset of o.assets) {
            const c = asset.catalog;
            assert.ok(c, `el asset ${asset.id} llego sin ficha`);
            for (const campo of [
                'available', 'restrictions', 'isLimited', 'offSale', 'price',
                'lowestPrice', 'lowestResalePrice', 'hasResellers',
                'creatorType', 'creatorTargetId', 'creatorName',
            ]) {
                assert.ok(campo in c, `falta ${campo} en la ficha del asset ${asset.id}`);
            }
            assert.strictEqual(c.price, asset.id * 100);
            assert.strictEqual(c.lowestPrice, asset.id * 90);
            assert.strictEqual(c.lowestResalePrice, asset.id * 120);
        }
    });

    test('los precios son IDENTICOS a los de la ruta individual', async () => {
        limpiar(1);
        const porLista = await listar('?details=1&catalog=1');

        limpiar(1);
        const porRuta = await individual(2000, '?catalog=1');

        assert.deepStrictEqual(
            porLista.body.outfits[0].outfit,
            porRuta.body,
            'el outfit de la busqueda no es identico al de la ruta individual'
        );
    });

    test('catalog=1 sin details=1 se rechaza y explica por que', async () => {
        limpiar(1);
        const res = await listar('?catalog=1');
        assert.strictEqual(res.status, 400);
        assert.match(res.body.error.message, /catalog necesita details=1/);
    });

    test('details=1 con un limit por encima del tope del lote se rechaza', async () => {
        limpiar(1);
        const res = await listar('?details=1&limit=50');
        assert.strictEqual(res.status, 400);
        assert.match(res.body.error.message, /details=1 admite como maximo limit=40/);
    });

    // Los dos valores, no solo el que "pide" bundles: `bundles=0` tambien se
    // rechaza porque el problema no es el valor sino la expectativa. Quien lo
    // manda cree que este endpoint entiende de bundles, y no.
    for (const valor of ['1', '0']) {
        test(`bundles=${valor} se rechaza en la busqueda y dice donde pedirlo`, async () => {
            limpiar(1);
            const res = await listar(`?details=1&catalog=1&bundles=${valor}`);

            assert.strictEqual(res.status, 400,
                'un parametro que no existe se estaba ignorando en silencio');
            assert.match(res.body.error.message, /no forma parte de la busqueda masiva/);
            assert.match(res.body.error.message, /una llamada a Roblox por asset/);
            assert.match(res.body.error.message, /GET \/v1\/outfits\/:outfitId\?bundles=1/);
            assert.strictEqual(llamadas.detalles, 0, 'se llego a pedir algo antes de rechazar');
        });
    }

    test('bundles se rechaza aunque no se pidan details', async () => {
        limpiar(1);
        const res = await listar('?bundles=1');
        assert.strictEqual(res.status, 400);
    });

    // ── 4. Tamaños: 1, 5, 10 y 24 outfits ────────────────────────────────────

    for (const n of [1, 5, 10, 24]) {
        test(`${n} outfit(s): una peticion, ${n} llamadas de detalle y UNA de catalogo`, async () => {
            limpiar(n);
            const res = await listar('?details=1&catalog=1&limit=25');

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.outfits.length, n);
            assert.strictEqual(res.body.count, n);

            // Los detalles no se pueden evitar: son un outfit distinto cada uno.
            assert.strictEqual(llamadas.detalles, n,
                `se hicieron ${llamadas.detalles} llamadas de detalle para ${n} outfits`);

            // El catalogo SI: los assets de los n outfits van juntos en una sola
            // resolucion. Es el ahorro que justifica todo esto.
            assert.strictEqual(llamadas.catalogo, 1,
                `se hicieron ${llamadas.catalogo} tandas de catalogo para ${n} outfits: no se estan uniendo`);

            // Los assets distintos se calculan del mismo mundo falso, no se
            // escriben a mano: como mucho son cuatro (el 10 lo llevan todos y
            // los 1-3 rotan) por muchos outfits que haya.
            const esperados = [...new Set(idsEsperados(n).flatMap(assetsDe))].sort((a, b) => a - b);
            const distintos = [...new Set(llamadas.assetsPedidos)].sort((a, b) => a - b);
            assert.deepStrictEqual(distintos, esperados);
            assert.strictEqual(llamadas.assetsPedidos.length, distintos.length,
                `se pidieron assets repetidos: ${llamadas.assetsPedidos.join(',')}`);

            for (const entrada of res.body.outfits) {
                assert.strictEqual(entrada.ok, true);
                assert.strictEqual(entrada.outfit.catalogResolved, true);
                assert.ok(entrada.outfit.assets.every(a => a.catalog));
            }
        });
    }

    test('el catalogo se trocea segun MAX_CATALOG_BATCH_SIZE, no por outfit', async () => {
        limpiar(24);
        // 24 outfits x 6 assets propios = 144 distintos, por encima del tope de
        // 120 por llamada. Es el unico caso que llega a trocear: los demas usan
        // assets compartidos y caben de sobra en una tanda.
        assetsDe = PROPIOS;

        const res = await listar('?details=1&catalog=1&limit=25');
        assert.strictEqual(res.status, 200);

        const distintos = [...new Set(llamadas.assetsPedidos)];
        assert.strictEqual(distintos.length, 144);
        assert.strictEqual(res.body.stats.catalogAssets, 144);

        // Lo que se comprueba: el numero de tandas sale del TOPE, no del numero
        // de outfits. Por outfit serian 24; troceando por el tope son 2.
        const esperadas = Math.ceil(144 / config.maxCatalogBatchSize);
        assert.strictEqual(llamadas.catalogo, esperadas,
            `se hicieron ${llamadas.catalogo} tandas y el tope de ${config.maxCatalogBatchSize} pide ${esperadas}`);

        // Y ni un asset pedido dos veces, ni siquiera entre tandas distintas.
        assert.strictEqual(llamadas.assetsPedidos.length, distintos.length,
            'un asset viajo en mas de una tanda');
    });

    // ── 5. Orden y aislamiento ───────────────────────────────────────────────

    test('el orden de la lista se conserva exactamente', async () => {
        limpiar(10);
        const res = await listar('?details=1&catalog=1');

        assert.deepStrictEqual(
            res.body.outfits.map(o => o.outfitId),
            idsEsperados(10),
            'la cuadricula saldria desordenada respecto a la lista'
        );
    });

    test('un outfit borrado entre varios no tumba a los demas', async () => {
        limpiar(5);
        fallaOutfit = id => (id === 2002 ? axiosError(404) : null);

        const res = await listar('?details=1&catalog=1');

        assert.strictEqual(res.status, 200, 'un outfit borrado tumbo la busqueda entera');
        assert.deepStrictEqual(res.body.outfits.map(o => o.outfitId), idsEsperados(5),
            'el hueco del outfit fallido descoloco el orden');

        const roto = res.body.outfits.find(o => o.outfitId === 2002);
        assert.strictEqual(roto.ok, false);
        assert.strictEqual(roto.error.code, 'outfit_not_found');
        assert.strictEqual(roto.outfit, undefined);

        for (const entrada of res.body.outfits.filter(o => o.outfitId !== 2002)) {
            assert.strictEqual(entrada.ok, true, `el outfit ${entrada.outfitId} cayo con el que fallo`);
            assert.ok(entrada.outfit.assets.every(a => a.catalog), 'se perdieron precios por el outfit roto');
        }
        assert.strictEqual(res.body.stats.succeeded, 4);
        assert.strictEqual(res.body.stats.failed, 1);
    });

    // ── 6. Cache caliente ────────────────────────────────────────────────────

    test('la segunda busqueda identica no toca Roblox', async () => {
        // UN outfit y SIN catalogo, a proposito. La suite corre con
        // CACHE_MAX_ENTRIES=5 para poder probar la expulsion LRU, y el conjunto
        // de una busqueda con precios son SEIS entradas —propiedad del juego,
        // usuario, lista, detalle y dos assets—, asi que se expulsaria a si
        // mismo y el caso mediria la expulsion en vez de la reutilizacion.
        // Sin catalogo son cuatro y caben.
        limpiar(1);
        await listar('?details=1');
        const enFrio = { detalles: llamadas.detalles };

        llamadas.usuario = 0; llamadas.lista = 0; llamadas.detalles = 0; llamadas.catalogo = 0;
        const res = await listar('?details=1');

        assert.strictEqual(res.status, 200);
        assert.strictEqual(llamadas.usuario, 0, 'se volvio a resolver el nombre');
        assert.strictEqual(llamadas.lista, 0, 'se volvio a pedir la lista');
        assert.strictEqual(llamadas.detalles, 0, 'se volvieron a pedir los detalles');
        assert.ok(enFrio.detalles > 0, 'la primera vuelta no llego a pedir nada');

        // Y la respuesta caliente es igual de completa que la fria.
        assert.strictEqual(res.body.outfits[0].ok, true);
        assert.ok(res.body.outfits[0].outfit.humanoidDescription, 'la respuesta caliente llego incompleta');
    });

    test('las stats dicen que todo salio de cache', async () => {
        limpiar(1);
        await listar('?details=1');
        const res = await listar('?details=1');

        assert.strictEqual(res.body.stats.cacheHits, 1);
        assert.strictEqual(res.body.stats.cacheMisses, 0);
    });

    // ── 7. Una sola peticion desde el punto de vista del juego ───────────────

    test('UNA peticion basta: trae todo lo que la cuadricula necesita pintar', async () => {
        limpiar(24);
        const res = await listar('?details=1&catalog=1&limit=25');

        // Lo que el juego necesitaba y antes le costaba una segunda peticion.
        assert.strictEqual(res.body.username, 'kevin');
        assert.strictEqual(res.body.displayName, 'Kevin');
        assert.strictEqual(res.body.outfits.length, 24);

        for (const entrada of res.body.outfits) {
            const o = entrada.outfit;
            assert.ok(o.name && o.outfitType, 'falta identidad del outfit');
            assert.ok(o.assets.length > 0, 'faltan assets');
            assert.ok(o.humanoidDescription?.bodyColors && o.humanoidDescription?.scale, 'falta el cuerpo');
            assert.ok(o.humanoidDescription.animations && o.humanoidDescription.emotes, 'falta animaciones/emotes');
            assert.ok(o.assets.every(a => a.catalog.price != null), 'faltan precios');
        }
        // Nada que obligue a una segunda vuelta.
        assert.strictEqual(res.body.hasMore, false);
    });

    const ok = await suite.run();

    db.query = original.query;
    roblox.getUniverseIdForPlace = original.universo;
    roblox.getUniverseOwner = original.dueño;
    roblox.lookupUserByUsername = original.usuario;
    roblox.listOutfits = original.lista;
    roblox.getOutfitDetailsRaw = original.detalles;
    roblox.getCatalogDetails = original.catalogo;
    cache.reset();
    singleFlight.reset();
    ownRateLimit.reset();
    robloxRateLimiter.reset();
    await new Promise(resolve => server.close(resolve));
    return ok;
};
