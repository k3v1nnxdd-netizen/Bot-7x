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

// PRECIOS EN LOTE — POST /v1/outfits/batch con `catalog: true`.
//
// POR QUE EXISTE ESTO. La cuadricula del juego enseña hasta 24 outfits CON SU
// PRECIO. El lote resolvia nombres, assets y cuerpo, pero no precios: pedirlos
// obligaba a volver a la ruta individual outfit por outfit, que es justo lo que
// el lote existe para evitar. Sin esto, la cuadricula no puede usar el lote.
//
// LO QUE SE PROTEGE, por orden de importancia:
//
//   1. PARIDAD. Un outfit pedido por lote con catalog tiene que salir
//      EXACTAMENTE igual que por GET /v1/outfits/:id?catalog=1. Si no, migrar
//      la cuadricula cambia lo que ve el jugador, y eso no es una migracion.
//   2. QUE AHORRE DE VERDAD. Los assets se unen entre todos los outfits y se
//      deduplican: N outfits no pueden costar N tandas de catalogo. Es la razon
//      entera de resolver el catalogo aqui y no por outfit.
//   3. AISLAMIENTO. Un outfit roto, o un asset que Roblox no supo resolver, no
//      puede dejar sin precios a los demas.

const GROUP_ID = '35216530';
const PLACE_ID = '1234567890';
const UNIVERSE_ID = '5432109876';

function pedir(port, ruta, { metodo = 'POST', cuerpo, headers = {} } = {}) {
    ownRateLimit.reset();
    const payload = cuerpo === undefined ? null : JSON.stringify(cuerpo);
    const cabeceras = { ...headers };
    if (payload !== null) {
        cabeceras['content-type'] = 'application/json';
        cabeceras['content-length'] = Buffer.byteLength(payload);
    }
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: ruta, method: metodo, headers: cabeceras }, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch { /* no-JSON */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

module.exports = async function run() {
    const suite = createSuite('outfitsBatchCatalog');
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
    // Los outfits COMPARTEN assets a proposito: es lo normal en outfits reales
    // de una misma persona (la misma camiseta en varios conjuntos) y es
    // exactamente lo que la deduplicacion tiene que aprovechar.
    //
    //   outfit 1000 -> assets 1, 2
    //   outfit 1001 -> assets 2, 3      (comparte el 2)
    //   outfit 1002 -> assets 1, 3      (comparte los dos)
    //
    // Tres outfits, seis referencias, TRES assets distintos.
    const ASSETS_DE = { 1000: [1, 2], 1001: [2, 3], 1002: [1, 3] };

    const llamadas = { detalles: 0, catalogo: 0, assetsPedidos: [] };
    let fallaOutfit = () => null;
    let fallaCatalogo = () => null;

    function limpiar() {
        llamadas.detalles = 0;
        llamadas.catalogo = 0;
        llamadas.assetsPedidos = [];
        fallaOutfit = () => null;
        fallaCatalogo = () => null;
        cache.reset();
        singleFlight.reset();
        robloxRateLimiter.reset();
    }

    // Los dos dobles pasan POR EL LIMITADOR REAL, como el cliente de verdad:
    // asi los errores se clasifican igual que en produccion y las llamadas se
    // contabilizan en el cubo que les toca.
    roblox.getOutfitDetailsRaw = async outfitId => robloxRateLimiter.run('outfitDetails', async () => {
        llamadas.detalles++;
        const fallo = fallaOutfit(outfitId);
        if (fallo) throw fallo;
        return {
            data: {
                id: outfitId,
                name: `Outfit ${outfitId}`,
                assets: (ASSETS_DE[outfitId] ?? [1]).map(id => ({
                    id, name: `Asset ${id}`, assetType: { id: 8, name: 'Hat' },
                })),
                bodyColor3s: {}, scale: {}, playerAvatarType: 'R15',
                outfitType: 'Avatar', isEditable: true,
            },
        };
    }, { endpoint: 'avatar.roblox.com/v3/outfits/{id}/details', notFoundCode: 'outfit_not_found' })
        .then(r => r.data);

    roblox.getCatalogDetails = async assetIds => robloxRateLimiter.run('catalogDetails', async () => {
        llamadas.catalogo++;
        llamadas.assetsPedidos.push(...assetIds);
        const fallo = fallaCatalogo(assetIds);
        if (fallo) throw fallo;
        const mapa = new Map();
        for (const id of assetIds) {
            mapa.set(id, {
                available: true, restrictions: [], isLimited: false, offSale: false,
                price: id * 100, lowestPrice: id * 100, lowestResalePrice: null,
                hasResellers: false, creatorType: 'User', creatorTargetId: 1, creatorName: 'X',
            });
        }
        return { data: mapa };
    }, { endpoint: 'catalog.roblox.com/v1/catalog/items/details' }).then(r => r.data);

    const lote = (cuerpo) => pedir(port, '/v1/outfits/batch', { cuerpo, headers: AUTORIZADO });
    const individual = (id, query = '') =>
        pedir(port, `/v1/outfits/${id}${query}`, { metodo: 'GET', headers: AUTORIZADO });

    // ── 1. Paridad con la ruta individual ────────────────────────────────────

    test('un outfit con catalog sale IDENTICO por lote y por la ruta individual', async () => {
        limpiar();
        const porLote = await lote({ outfitIds: [1000], catalog: true });

        limpiar();
        const porRuta = await individual(1000, '?catalog=1');

        assert.strictEqual(porLote.status, 200);
        assert.strictEqual(porRuta.status, 200);
        assert.deepStrictEqual(
            porLote.body.results[0].outfit,
            porRuta.body,
            'el outfit del lote no es identico al de la ruta individual: migrar la cuadricula cambiaria lo que ve el jugador'
        );
    });

    test('los precios llegan pegados a cada asset', async () => {
        limpiar();
        const res = await lote({ outfitIds: [1000], catalog: true });
        const assets = res.body.results[0].outfit.assets;

        assert.strictEqual(assets.length, 2);
        for (const asset of assets) {
            assert.ok(asset.catalog, `el asset ${asset.id} llego sin ficha de catalogo`);
            assert.strictEqual(asset.catalog.price, asset.id * 100);
        }
        assert.strictEqual(res.body.results[0].outfit.catalogResolved, true);
    });

    test('SIN catalog no se pide catalogo ni aparece el campo', async () => {
        limpiar();
        const res = await lote({ outfitIds: [1000] });

        assert.strictEqual(llamadas.catalogo, 0, 'se pidio catalogo sin que nadie lo pidiera');
        const outfit = res.body.results[0].outfit;
        assert.strictEqual(outfit.catalogResolved, undefined);
        assert.strictEqual(outfit.assets[0].catalog, undefined);
    });

    // ── 2. Que ahorre de verdad ──────────────────────────────────────────────

    test('tres outfits que comparten assets se resuelven en UNA tanda de catalogo', async () => {
        limpiar();
        const res = await lote({ outfitIds: [1000, 1001, 1002], catalog: true });

        assert.strictEqual(res.status, 200);
        // Lo que se arregla: por outfit serian tres tandas.
        assert.strictEqual(llamadas.catalogo, 1,
            `se hicieron ${llamadas.catalogo} tandas de catalogo para tres outfits: no se estan uniendo`);
    });

    test('un asset compartido por varios outfits se pide UNA sola vez', async () => {
        limpiar();
        await lote({ outfitIds: [1000, 1001, 1002], catalog: true });

        // Seis referencias a assets entre los tres outfits, tres assets distintos.
        const pedidos = llamadas.assetsPedidos;
        assert.strictEqual(pedidos.length, 3,
            `se pidieron ${pedidos.length} assets (${pedidos.join(',')}): hay repetidos`);
        assert.deepStrictEqual([...pedidos].sort((a, b) => a - b), [1, 2, 3]);
    });

    test('las stats publican cuantos assets distintos se miraron', async () => {
        limpiar();
        const res = await lote({ outfitIds: [1000, 1001, 1002], catalog: true });

        assert.strictEqual(res.body.stats.catalog, true);
        assert.strictEqual(res.body.stats.catalogAssets, 3);
        assert.strictEqual(res.body.stats.catalogUnresolved, 0);
    });

    test('lo ya cacheado no se vuelve a pedir a Roblox', async () => {
        limpiar();
        await lote({ outfitIds: [1000], catalog: true });
        const trasPrimera = llamadas.catalogo;

        // 1001 comparte el asset 2 con 1000 y trae el 3 nuevo.
        llamadas.assetsPedidos = [];
        await lote({ outfitIds: [1001], catalog: true });

        assert.strictEqual(llamadas.catalogo, trasPrimera + 1);
        assert.deepStrictEqual(llamadas.assetsPedidos, [3],
            'se volvio a pedir un asset que ya estaba en cache');
    });

    // ── 3. Aislamiento ───────────────────────────────────────────────────────

    test('un outfit borrado no deja sin precios a los demas', async () => {
        limpiar();
        fallaOutfit = id => (id === 1001 ? axiosError(404) : null);

        const res = await lote({ outfitIds: [1000, 1001, 1002], catalog: true });

        const porId = new Map(res.body.results.map(r => [r.outfitId, r]));
        assert.strictEqual(porId.get(1001).ok, false);
        assert.strictEqual(porId.get(1001).error.code, 'outfit_not_found');

        for (const id of [1000, 1002]) {
            const r = porId.get(id);
            assert.strictEqual(r.ok, true, `el outfit ${id} cayo con el que fallo`);
            assert.strictEqual(r.outfit.catalogResolved, true);
            assert.ok(r.outfit.assets.every(a => a.catalog), `el outfit ${id} perdio precios`);
        }
    });

    test('si el catalogo falla, los outfits siguen llegando sin precios', async () => {
        limpiar();
        fallaCatalogo = () => axiosError(500);

        const res = await lote({ outfitIds: [1000, 1001], catalog: true });

        assert.strictEqual(res.status, 200, 'un fallo de catalogo tumbo la respuesta entera');
        for (const r of res.body.results) {
            assert.strictEqual(r.ok, true, 'el outfit se perdio por un fallo de catalogo');
            assert.ok(r.outfit.name, 'el outfit llego sin nombre');
            // La distincion que importa: no es "no tiene precio", es "no lo
            // pudimos comprobar".
            assert.strictEqual(r.outfit.catalogResolved, false);
            assert.ok(r.outfit.assets.every(a => a.catalog === undefined));
        }
        assert.strictEqual(res.body.stats.catalogUnresolved, 3);
    });

    test('catalogResolved es POR OUTFIT: el que tiene todos sus assets sale true', async () => {
        limpiar();
        // Solo el asset 3 se queda sin resolver. Afecta a 1001, que lo lleva;
        // 1000 (assets 1 y 2) tiene que salir intacto.
        fallaCatalogo = assetIds => (assetIds.includes(3) ? axiosError(500) : null);

        // Primero 1000 SOLO, para dejar sus assets (1 y 2) en cache. Asi, en la
        // segunda tanda, el unico asset que sale a Roblox es el 3 — y al fallar
        // solo puede manchar al outfit que lo lleva.
        //
        // Se usan DOS outfits y no tres a proposito: la suite corre con
        // CACHE_MAX_ENTRIES=5 para poder probar la expulsion LRU, y un conjunto
        // mas grande se expulsaria a si mismo, volviendo a pedir los assets ya
        // resueltos y deshaciendo justo lo que este caso monta.
        await lote({ outfitIds: [1000], catalog: true });
        const res = await lote({ outfitIds: [1000, 1001], catalog: true });

        const porId = new Map(res.body.results.map(r => [r.outfitId, r]));
        assert.strictEqual(porId.get(1000).outfit.catalogResolved, true,
            'un outfit con todos sus assets resueltos quedo marcado como no resuelto por el fallo de OTRO');
        assert.ok(porId.get(1000).outfit.assets.every(a => a.catalog), 'el outfit intacto perdio precios');
        assert.strictEqual(porId.get(1001).outfit.catalogResolved, false);
    });

    // ── 4. Validacion ────────────────────────────────────────────────────────

    test('catalog tiene que ser booleano JSON, no "1" ni "true"', async () => {
        limpiar();
        const res = await lote({ outfitIds: [1000], catalog: 'true' });

        assert.strictEqual(res.status, 400);
        assert.match(res.body.error.message, /catalog debe ser true o false/);
    });

    test('bundles se rechaza en lote, y dice por que y donde pedirlo', async () => {
        limpiar();
        const res = await lote({ outfitIds: [1000], bundles: true });

        assert.strictEqual(res.status, 400,
            'bundles en lote costaria una llamada a Roblox por asset: tiene que rechazarse');
        assert.match(res.body.error.message, /una llamada por asset/);
        assert.match(res.body.error.message, /GET \/v1\/outfits\/:outfitId\?bundles=1/);
    });

    test('bundles: false tampoco cuela, para que nadie crea que se resolvio', async () => {
        limpiar();
        const res = await lote({ outfitIds: [1000], bundles: false });
        assert.strictEqual(res.status, 400);
    });

    const ok = await suite.run();

    db.query = original.query;
    roblox.getUniverseIdForPlace = original.universo;
    roblox.getUniverseOwner = original.dueño;
    roblox.getOutfitDetailsRaw = original.detalles;
    roblox.getCatalogDetails = original.catalogo;
    cache.reset();
    singleFlight.reset();
    ownRateLimit.reset();
    robloxRateLimiter.reset();
    await new Promise(resolve => server.close(resolve));
    return ok;
};
