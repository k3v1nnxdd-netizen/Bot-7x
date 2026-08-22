'use strict';

const http = require('http');
const crypto = require('crypto');
const { createSuite, captureStdout } = require('./harness');
const { createApp } = require('../app');
const config = require('../config');
const ownRateLimit = require('../security/rateLimit');
const db = require('../db/pool');
const roblox = require('../roblox/client');
const cache = require('../cache/cacheStore');
const licenseToken = require('../security/licenseToken');
const { UpstreamError } = require('../roblox/errors');

// Tests de POST /v1/catalog/batch por HTTP real, sin base de datos y sin
// Roblox. Lo que se protege aqui:
//
//   1. LA DOBLE PUERTA. La x-api-key viaja dentro del .rbxl que se vende, asi
//      que por si sola NO puede abrir la inteligencia de catalogo. Hace falta
//      ademas el token de licencia, verificado con la MISMA cadena de
//      /v1/license/verify — incluida la propiedad real del juego.
//   2. EL NUMERO DE LLAMADAS A ROBLOX. Es la razon de existir del endpoint: un
//      outfit frio son ~5 llamadas y uno caliente CERO. Si alguien rompe la
//      cache o lanza la busqueda inversa a todos los assets, esto lo caza.
//   3. QUE ROBLOX SOLO TENGA QUE COMPROBAR PROPIEDAD. `ownershipChecks` colapsa
//      N assets en 1 bundle; si eso se rompe, el juego hace seis llamadas de
//      ownership donde deberia hacer una.

const GROUP_ID = '35216530';
const OTRO_GRUPO = '77112233';
const PLACE_ID = '1234567890';
const UNIVERSE_ID = '5432109876';

// Ids reales, verificados en vivo contra Roblox al diseñar esto.
const KORBLOX_BUNDLE = '192';
const KORBLOX_PIERNA = '139607718';
const HEADLESS_BUNDLE = '201';
const HEADLESS_CABEZA = '15093053680';
const DH_BUNDLE = '968';
const DH_CABEZA = '11308945948';   // assetType 79
const DH_MOOD = '11308935548';     // assetType 78
const SOMBRERO = '607702162';      // assetType 8: NO es bundle-backed

function request(port, path, { headers = {}, body, raw, sinReset = false } = {}) {
    if (!sinReset) ownRateLimit.reset();
    const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch { /* no-JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
            });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

module.exports = async function run() {
    const suite = createSuite('catalogBatch');
    const { test, assert } = suite;

    const OUTFIT = config.apiKey;
    const ADMIN = config.adminApiKey;
    const juego = { 'content-type': 'application/json', 'x-api-key': OUTFIT };

    const TOKEN = licenseToken.generateToken();
    const HASH = crypto.createHash('sha256').update(TOKEN, 'utf8').digest('hex');

    // ── Dobles ───────────────────────────────────────────────────────────────
    const queryOriginal = db.query;
    const originales = {
        getCatalogItemDetails: roblox.getCatalogItemDetails,
        getBundlesForAsset: roblox.getBundlesForAsset,
        getBundleDetails: roblox.getBundleDetails,
        getUniverseIdForPlace: roblox.getUniverseIdForPlace,
        getUniverseOwner: roblox.getUniverseOwner,
    };

    let licenciaFila = null;
    db.query = async () => ({ rows: licenciaFila ? [licenciaFila] : [], rowCount: licenciaFila ? 1 : 0 });

    const filaActiva = (overrides = {}) => ({
        group_id: GROUP_ID, active: true, license_token_hash: HASH, ...overrides,
    });

    // Registro de TODAS las llamadas salientes: es lo que permite afirmar
    // cuantas se hacen, que es medio sentido de este endpoint.
    let llamadas = [];

    // Catalogo de mentira. `fichas` mapea assetId/bundleId -> datos; lo que no
    // este se comporta como Roblox: simplemente no vuelve en la respuesta.
    const CATALOGO = {
        [DH_CABEZA]: { name: 'Check It - Head', assetType: 79, isOffSale: true },
        [DH_MOOD]: { name: 'Check It - Mood', assetType: 78, isOffSale: true },
        [KORBLOX_PIERNA]: { name: 'Korblox Deathspeaker Right Leg', assetType: 31, isOffSale: true },
        [HEADLESS_CABEZA]: { name: 'Headless Head', assetType: 17, isOffSale: true },
        [SOMBRERO]: {
            name: 'Roblox Baseball Cap', assetType: 8, price: 350, isOffSale: false,
            itemRestrictions: ['Limited'], lowestResalePrice: 1100, hasResellers: true,
        },
    };

    const INVERSA = {
        [DH_CABEZA]: [{ id: 968, name: 'Check It', bundleType: 'DynamicHead' }],
        [DH_MOOD]: [{ id: 968, name: 'Check It', bundleType: 'DynamicHead' }],
        [KORBLOX_PIERNA]: [{ id: 192, name: 'Korblox Deathspeaker', bundleType: 'BodyParts' }],
        // Headless NO resuelve por busqueda inversa: comprobado en vivo. Es
        // justo el hueco que cubre el registro curado.
        [HEADLESS_CABEZA]: [],
    };

    const BUNDLES = {
        [KORBLOX_BUNDLE]: {
            name: 'Korblox Deathspeaker', bundleType: 'BodyParts', price: 17000, forSale: true,
            assetIds: ['139607570', '139607625', '139607673', KORBLOX_PIERNA, '139607770', '139610147'],
        },
        [HEADLESS_BUNDLE]: {
            name: 'Headless Horseman', bundleType: 'BodyParts', price: 31000, forSale: false,
            assetIds: ['134082453', '134082473', '134082507', '134082533', '134082557', HEADLESS_CABEZA],
        },
        [DH_BUNDLE]: {
            name: 'Check It', bundleType: 'DynamicHead', price: 0, forSale: true,
            assetIds: [DH_CABEZA, DH_MOOD, '11308949065'],
        },
    };

    // `fallos` permite hacer caer una ola concreta para probar parciales.
    function montarRoblox({ fallos = {} } = {}) {
        cache.reset();
        llamadas = [];

        roblox.getCatalogItemDetails = async items => {
            llamadas.push({ api: 'items/details', items: items.map(i => `${i.itemType}:${i.id}`) });
            if (fallos.itemsDetails) throw fallos.itemsDetails;

            const salida = new Map();
            for (const { itemType, id } of items) {
                if (itemType === 'Asset') {
                    const ficha = CATALOGO[String(id)];
                    if (!ficha) continue; // ausente = Roblox no tiene ficha
                    const restrictions = ficha.itemRestrictions ?? [];
                    salida.set(roblox.catalogKey('Asset', id), {
                        available: true, name: ficha.name, itemType: 'Asset',
                        assetTypeId: ficha.assetType, bundleTypeId: null,
                        restrictions,
                        isLimited: restrictions.includes('Limited'),
                        offSale: ficha.isOffSale ?? null,
                        price: ficha.price ?? null,
                        lowestPrice: ficha.lowestPrice ?? null,
                        lowestResalePrice: ficha.lowestResalePrice ?? null,
                        hasResellers: ficha.hasResellers ?? null,
                        collectibleItemId: null,
                        creatorType: 'User', creatorTargetId: 1, creatorName: 'Roblox',
                    });
                } else {
                    const b = BUNDLES[String(id)];
                    if (!b) continue;
                    salida.set(roblox.catalogKey('Bundle', id), {
                        available: true, name: b.name, itemType: 'Bundle',
                        assetTypeId: null, bundleTypeId: 1,
                        restrictions: [], isLimited: false,
                        offSale: !b.forSale, price: b.price,
                        lowestPrice: null, lowestResalePrice: null, hasResellers: null,
                        collectibleItemId: null,
                        creatorType: 'User', creatorTargetId: 1, creatorName: 'Roblox',
                    });
                }
            }
            return salida;
        };

        roblox.getBundlesForAsset = async assetId => {
            llamadas.push({ api: 'assets/bundles', assetId: String(assetId) });
            if (fallos.reverse) throw fallos.reverse;
            return INVERSA[String(assetId)] ?? [];
        };

        roblox.getBundleDetails = async bundleIds => {
            llamadas.push({ api: 'bundles/details', bundleIds: bundleIds.map(String) });
            if (fallos.bundleDetails) throw fallos.bundleDetails;

            const salida = new Map();
            for (const id of bundleIds) {
                const b = BUNDLES[String(id)];
                if (!b) continue;
                salida.set(String(id), {
                    available: true, name: b.name, bundleType: b.bundleType,
                    assetIds: b.assetIds, price: b.price, forSale: b.forSale, noPriceText: null,
                    collectibleItemId: null, lowestPrice: null, lowestResalePrice: null,
                    hasResellers: null, saleStatus: null,
                    creatorType: 'User', creatorTargetId: '1', creatorName: 'Roblox',
                });
            }
            return salida;
        };

        // Propiedad del juego: por defecto el juego ES del grupo con licencia.
        roblox.getUniverseIdForPlace = async () => {
            llamadas.push({ api: 'place->universe' });
            return UNIVERSE_ID;
        };
        roblox.getUniverseOwner = async universeId => {
            llamadas.push({ api: 'universe->owner' });
            return {
                universeId, rootPlaceId: PLACE_ID, name: 'Juego',
                creatorType: 'Group', creatorId: GROUP_ID, creatorName: 'x',
            };
        };
    }

    // El token NO va en el cuerpo: viaja por la cabecera x-license-token, igual
    // que en /v1/license/verify. Un Secret de Roblox no se puede serializar con
    // JSONEncode, y aqui aplica exactamente la misma limitacion.
    const cuerpo = (extra = {}) => ({
        gameId: UNIVERSE_ID,
        placeId: PLACE_ID,
        assetIds: [DH_CABEZA, DH_MOOD, SOMBRERO],
        ...extra,
    });

    // `token: null` = no se manda la cabecera.
    const pedir = (port, body, { headers = juego, token = TOKEN } = {}) =>
        request(port, '/v1/catalog/batch', {
            headers: token === null ? headers : { ...headers, 'x-license-token': token },
            body,
        });
    const deCatalogo = () => llamadas.filter(l => l.api !== 'place->universe' && l.api !== 'universe->owner');

    // El runner fija CACHE_MAX_ENTRIES=5 para que cache.test.js pueda provocar
    // expulsiones. Aqui haria justo lo contrario de lo que se quiere medir: un
    // outfit ocupa mas de cinco entradas, asi que "la segunda vez sale de
    // cache" fallaria por falta de sitio y no por un fallo real. Se amplia
    // durante este archivo y se restaura al salir.
    const topeCachePrevio = config.cache.maxEntries;
    config.cache.maxEntries = 500;

    const app = createApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;

    // ═══ La doble puerta ═════════════════════════════════════════════════════

    test('sin x-api-key -> 401 y ni una llamada', async () => {
        licenciaFila = filaActiva(); montarRoblox();
        const res = await pedir(port, cuerpo(), { headers: { 'content-type': 'application/json' } });

        assert.strictEqual(res.status, 401);
        assert.strictEqual(llamadas.length, 0);
    });

    test('la ADMIN_API_KEY no abre el catalogo', async () => {
        licenciaFila = filaActiva(); montarRoblox();
        const res = await pedir(port, cuerpo(), { headers: { 'content-type': 'application/json', 'x-admin-key': ADMIN } });

        assert.strictEqual(res.status, 401);
        assert.strictEqual(llamadas.length, 0);
    });

    test('con x-api-key pero SIN token de licencia -> 400, no se resuelve nada', async () => {
        // La clave del juego viaja dentro del .rbxl: por si sola no puede abrir
        // la inteligencia de catalogo. Es el motivo de existir de esta ruta.
        licenciaFila = filaActiva(); montarRoblox();
        const res = await pedir(port, cuerpo(), { token: null });

        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error.code, 'invalid_request');
        assert.strictEqual(deCatalogo().length, 0, 'ni una llamada de catalogo sin licencia');
    });

    test('token invalido -> 403 token_invalido y CERO trabajo de catalogo', async () => {
        licenciaFila = null; montarRoblox();
        const res = await pedir(port, cuerpo(), { token: licenseToken.generateToken() });

        assert.strictEqual(res.status, 403);
        assert.deepStrictEqual(res.body, { ok: false, motivo: 'token_invalido' });
        assert.strictEqual(deCatalogo().length, 0);
    });

    test('licencia desactivada -> 403 licencia_inactiva', async () => {
        licenciaFila = filaActiva({ active: false }); montarRoblox();
        const res = await pedir(port, cuerpo());

        assert.strictEqual(res.status, 403);
        assert.deepStrictEqual(res.body, { ok: false, motivo: 'licencia_inactiva' });
        assert.strictEqual(deCatalogo().length, 0);
    });

    test('juego de OTRO grupo -> 403 grupo_no_coincide (misma cadena que verify)', async () => {
        licenciaFila = filaActiva(); montarRoblox();
        roblox.getUniverseOwner = async universeId => ({
            universeId, rootPlaceId: PLACE_ID, name: 'Juego ajeno',
            creatorType: 'Group', creatorId: OTRO_GRUPO, creatorName: 'x',
        });

        const res = await pedir(port, cuerpo());

        assert.strictEqual(res.status, 403);
        assert.deepStrictEqual(res.body, { ok: false, motivo: 'grupo_no_coincide' });
        assert.strictEqual(deCatalogo().length, 0, 'un juego sin licencia no llega a costar catalogo');
    });

    test('un creatorId falsificado tampoco abre el catalogo', async () => {
        licenciaFila = filaActiva(); montarRoblox();
        roblox.getUniverseOwner = async universeId => ({
            universeId, rootPlaceId: PLACE_ID, name: 'Juego ajeno',
            creatorType: 'Group', creatorId: OTRO_GRUPO, creatorName: 'x',
        });

        const res = await pedir(port, cuerpo({ creatorId: GROUP_ID, creatorType: 'Group' }));
        assert.strictEqual(res.status, 403);
        assert.strictEqual(res.body.motivo, 'grupo_no_coincide');
    });

    test('la propiedad del juego sale de cache: no se repregunta a Roblox en cada outfit', async () => {
        licenciaFila = filaActiva(); montarRoblox();

        await pedir(port, cuerpo());
        const primeraPropiedad = llamadas.filter(l => l.api === 'place->universe').length;

        await pedir(port, cuerpo({ assetIds: [SOMBRERO] }));
        const totalPropiedad = llamadas.filter(l => l.api === 'place->universe').length;

        assert.strictEqual(primeraPropiedad, 1);
        assert.strictEqual(totalPropiedad, 1, 'abrir un segundo outfit no vuelve a resolver la propiedad');
    });

    // ═══ Contrato y validacion ═══════════════════════════════════════════════

    test('los ids salen como STRING aunque lleguen como numero', async () => {
        licenciaFila = filaActiva(); montarRoblox();
        const res = await pedir(port, cuerpo({ assetIds: [Number(SOMBRERO)], bundleIds: [Number(KORBLOX_BUNDLE)] }));

        assert.strictEqual(res.status, 200);
        assert.strictEqual(typeof res.body.assets[0].assetId, 'string');
        assert.strictEqual(res.body.assets[0].assetId, SOMBRERO);
        assert.strictEqual(typeof res.body.bundles[0].bundleId, 'string');
        assert.ok(res.body.bundles[0].assetIds.every(id => typeof id === 'string'));
        assert.ok(res.body.ownershipChecks.every(c => typeof c.id === 'string'));
    });

    test('limites: 64 assets, 32 bundles, 80 total', async () => {
        licenciaFila = filaActiva(); montarRoblox();
        const ids = n => Array.from({ length: n }, (_, i) => String(1000000 + i));

        const casos = [
            { body: cuerpo({ assetIds: ids(65) }), motivo: '65 assets' },
            { body: cuerpo({ assetIds: [], bundleIds: ids(33) }), motivo: '33 bundles' },
            { body: cuerpo({ assetIds: ids(60), bundleIds: ids(25) }), motivo: '85 en total' },
            { body: cuerpo({ assetIds: [] }), motivo: 'sin ningun id' },
            { body: cuerpo({ assetIds: ['abc'] }), motivo: 'id no numerico' },
            { body: cuerpo({ assetIds: ['0'] }), motivo: 'id cero' },
            { body: cuerpo({ assetIds: ['007'] }), motivo: 'ceros a la izquierda' },
            { body: cuerpo({ assetIds: SOMBRERO }), motivo: 'assetIds que no es lista' },
            { body: cuerpo({ resolveBundles: 'si' }), motivo: 'resolveBundles que no es booleano' },
        ];

        for (const { body, motivo } of casos) {
            montarRoblox();
            const res = await pedir(port, body);
            assert.strictEqual(res.status, 400, `deberia rechazar: ${motivo}`);
            assert.strictEqual(res.body.error.code, 'invalid_request');
            assert.strictEqual(deCatalogo().length, 0, `sin tocar Roblox (${motivo})`);
        }
    });

    test('64 assets exactos SI se aceptan', async () => {
        licenciaFila = filaActiva(); montarRoblox();
        const res = await pedir(port, cuerpo({ assetIds: Array.from({ length: 64 }, (_, i) => String(1000000 + i)) }));
        assert.strictEqual(res.status, 200, 'el limite es inclusivo');
    });

    test('cuerpo enorme -> 413', async () => {
        licenciaFila = filaActiva(); montarRoblox();
        const res = await request(port, '/v1/catalog/batch', {
            headers: { ...juego, 'x-license-token': TOKEN }, raw: JSON.stringify(cuerpo({ relleno: 'x'.repeat(9000) })),
        });
        assert.strictEqual(res.status, 413);
    });

    // ═══ Inteligencia de catalogo ════════════════════════════════════════════

    test('un outfit frio: UN lote mixto, inversa solo donde toca', async () => {
        licenciaFila = filaActiva(); montarRoblox();
        const res = await pedir(port, cuerpo({ assetIds: [DH_CABEZA, DH_MOOD, SOMBRERO] }));

        assert.strictEqual(res.status, 200);

        // Lotes que piden ASSETS. Hay un segundo items/details, pero es solo
        // para los bundles DESCUBIERTOS por la inversa (bundles/details no trae
        // itemRestrictions), y ese no lleva ni un asset.
        const lotesDeAssets = deCatalogo().filter(l => l.api === 'items/details' && l.items.some(i => i.startsWith('Asset:')));
        assert.strictEqual(lotesDeAssets.length, 1, 'los tres assets se piden en UNA sola llamada');
        assert.strictEqual(lotesDeAssets[0].items.length, 3);

        // El sombrero (tipo 8) NO puede venir en un bundle: preguntarlo seria
        // gastar la unica llamada sin lote que hay.
        const inversas = deCatalogo().filter(l => l.api === 'assets/bundles').map(l => l.assetId);
        assert.deepStrictEqual(inversas.sort(), [DH_CABEZA, DH_MOOD].sort(),
            'solo se hace busqueda inversa a los tipos que pueden venir en bundle');
    });

    test('un outfit CALIENTE no gasta ni una llamada a Roblox', async () => {
        licenciaFila = filaActiva(); montarRoblox();

        await pedir(port, cuerpo());
        const primera = deCatalogo().length;
        assert.ok(primera > 0, 'la primera vez si cuesta');

        llamadas = [];
        const res = await pedir(port, cuerpo());

        assert.strictEqual(res.status, 200);
        assert.strictEqual(deCatalogo().length, 0, 'la segunda sale entera de cache');
        assert.strictEqual(res.body.assets.length, 3, 'y devuelve exactamente lo mismo');
    });

    test('la cache es POR ITEM: otro outfit que comparte pieza reaprovecha', async () => {
        licenciaFila = filaActiva(); montarRoblox();

        await pedir(port, cuerpo({ assetIds: [DH_CABEZA, DH_MOOD] }));
        llamadas = [];

        // Otro outfit distinto que comparte la cabeza: solo lo nuevo cuesta.
        await pedir(port, cuerpo({ assetIds: [DH_CABEZA, SOMBRERO] }));

        const lotesDeAssets = deCatalogo().filter(l => l.api === 'items/details' && l.items.some(i => i.startsWith('Asset:')));
        assert.strictEqual(lotesDeAssets.length, 1);
        assert.deepStrictEqual(lotesDeAssets[0].items, [`Asset:${SOMBRERO}`], 'solo se pide la pieza que faltaba');
    });

    test('Dynamic Head y su Mood apuntan al MISMO bundle', async () => {
        licenciaFila = filaActiva(); montarRoblox();
        const res = await pedir(port, cuerpo({ assetIds: [DH_CABEZA, DH_MOOD] }));

        const cabeza = res.body.assets.find(a => a.assetId === DH_CABEZA);
        const mood = res.body.assets.find(a => a.assetId === DH_MOOD);

        assert.strictEqual(cabeza.assetType.id, 79);
        assert.strictEqual(cabeza.assetType.name, 'DynamicHead');
        assert.strictEqual(cabeza.special, 'dynamicHead');
        assert.strictEqual(mood.assetType.name, 'MoodAnimation');
        assert.strictEqual(mood.special, 'moodAnimation', 'el Mood es su propia cosa, no "dynamicHead"');

        assert.deepStrictEqual(cabeza.ownedVia, { kind: 'Bundle', id: DH_BUNDLE });
        assert.deepStrictEqual(mood.ownedVia, { kind: 'Bundle', id: DH_BUNDLE },
            'los dos se poseen comprobando el mismo bundle');
    });

    test('Korblox se reconoce y se comprueba por bundle', async () => {
        licenciaFila = filaActiva(); montarRoblox();
        const res = await pedir(port, cuerpo({ assetIds: [KORBLOX_PIERNA] }));

        const pierna = res.body.assets[0];
        assert.strictEqual(pierna.special, 'korblox');
        assert.deepStrictEqual(pierna.ownedVia, { kind: 'Bundle', id: KORBLOX_BUNDLE });

        const bundle = res.body.bundles.find(b => b.bundleId === KORBLOX_BUNDLE);
        assert.strictEqual(bundle.special, 'korblox');
        assert.strictEqual(bundle.bundleType, 'BodyParts');
        assert.strictEqual(bundle.price, 17000);
        assert.strictEqual(bundle.forSale, true);
        assert.ok(bundle.assetIds.includes(KORBLOX_PIERNA), 'trae la composicion del pack');
    });

    test('Headless se resuelve por el registro curado aunque la inversa devuelva vacio', async () => {
        // Comprobado en vivo: la busqueda inversa NO resuelve el bundle de
        // Headless. Sin el registro curado, el objeto de 31.000 Robux quedaria
        // como un asset suelto y el juego comprobaria la propiedad equivocada.
        licenciaFila = filaActiva(); montarRoblox();
        const res = await pedir(port, cuerpo({ assetIds: [HEADLESS_CABEZA] }));

        const cabeza = res.body.assets[0];
        assert.deepStrictEqual(cabeza.bundleIds, [HEADLESS_BUNDLE]);
        assert.strictEqual(cabeza.special, 'headless');
        assert.deepStrictEqual(cabeza.ownedVia, { kind: 'Bundle', id: HEADLESS_BUNDLE });
        assert.strictEqual(res.body.bundles.find(b => b.bundleId === HEADLESS_BUNDLE).forSale, false);
    });

    test('ownershipChecks colapsa varios assets del mismo pack en UNA comprobacion', async () => {
        licenciaFila = filaActiva(); montarRoblox();
        const res = await pedir(port, cuerpo({ assetIds: [DH_CABEZA, DH_MOOD, SOMBRERO, KORBLOX_PIERNA] }));

        const checks = res.body.ownershipChecks;
        const porClave = new Set(checks.map(c => `${c.kind}:${c.id}`));
        assert.strictEqual(porClave.size, checks.length, 'sin duplicados');

        const dh = checks.find(c => c.id === DH_BUNDLE);
        assert.strictEqual(dh.kind, 'Bundle');
        assert.deepStrictEqual(dh.covers.sort(), [DH_CABEZA, DH_MOOD].sort(),
            'una sola comprobacion cubre la cabeza y el mood');

        const gorra = checks.find(c => c.id === SOMBRERO);
        assert.strictEqual(gorra.kind, 'Asset', 'lo que no viene de bundle se comprueba como asset');
        assert.deepStrictEqual(gorra.covers, [SOMBRERO]);

        // 4 assets -> 3 comprobaciones. Sin esto el juego haria 4.
        assert.strictEqual(checks.length, 3);
    });

    test('un bundle pedido cubre a sus assets aunque no haya busqueda inversa', async () => {
        licenciaFila = filaActiva(); montarRoblox();
        const res = await pedir(port, cuerpo({
            assetIds: [KORBLOX_PIERNA], bundleIds: [KORBLOX_BUNDLE], resolveBundles: false,
        }));

        assert.strictEqual(deCatalogo().filter(l => l.api === 'assets/bundles').length, 0,
            'resolveBundles:false apaga la busqueda inversa');
        const pierna = res.body.assets[0];
        assert.deepStrictEqual(pierna.ownedVia, { kind: 'Bundle', id: KORBLOX_BUNDLE },
            'la composicion del bundle pedido ya dice que esa pierna es suya');
    });

    test('los datos de reventa vienen incluidos, sin llamadas extra', async () => {
        licenciaFila = filaActiva(); montarRoblox();
        const res = await pedir(port, cuerpo({ assetIds: [SOMBRERO] }));

        const gorra = res.body.assets[0];
        assert.strictEqual(gorra.limited, true);
        assert.strictEqual(gorra.price, 350);
        assert.strictEqual(gorra.offSale, false);
        assert.strictEqual(gorra.resale.lowestResalePrice, 1100);
        assert.strictEqual(gorra.resale.hasResellers, true);
        assert.strictEqual(deCatalogo().filter(l => l.api === 'items/details').length, 1,
            'la reventa venia en la misma respuesta: cero llamadas de mas');
    });

    test('un asset que Roblox ya no reconoce sale found:false con todas las claves', async () => {
        licenciaFila = filaActiva(); montarRoblox();
        const res = await pedir(port, cuerpo({ assetIds: ['999999999999'] }));

        const fantasma = res.body.assets[0];
        assert.strictEqual(fantasma.found, false);
        for (const campo of ['name', 'price', 'offSale', 'limited', 'restrictions', 'creator']) {
            assert.ok(campo in fantasma, `falta la clave ${campo}`);
            assert.strictEqual(fantasma[campo], null, `${campo} deberia ser null, no false`);
        }
        assert.deepStrictEqual(fantasma.ownedVia, { kind: 'Asset', id: '999999999999' });
    });

    test('el tope de busquedas inversas se respeta y se avisa', async () => {
        licenciaFila = filaActiva(); montarRoblox();

        // 10 partes del cuerpo: todas son candidatas, pero el tope es 8.
        const cuerpos = Array.from({ length: 10 }, (_, i) => String(2000000 + i));
        for (const id of cuerpos) CATALOGO[id] = { name: 'Parte', assetType: 27, isOffSale: true };

        const res = await pedir(port, cuerpo({ assetIds: cuerpos }));

        const inversas = deCatalogo().filter(l => l.api === 'assets/bundles');
        assert.strictEqual(inversas.length, config.catalogBatch.maxReverseLookups);
        assert.strictEqual(res.body.unresolved.reverseTruncated, 2, 'y se dice cuantas se quedaron fuera');

        for (const id of cuerpos) delete CATALOGO[id];
    });

    // ═══ Fallos: parciales y 503 ═════════════════════════════════════════════

    test('si falla la busqueda inversa, el resto del outfit se entrega igual', async () => {
        licenciaFila = filaActiva();
        montarRoblox({ fallos: { reverse: new UpstreamError('caido', new Error('x')) } });

        let res;
        await captureStdout(async () => { res = await pedir(port, cuerpo({ assetIds: [DH_CABEZA, SOMBRERO] })); });

        assert.strictEqual(res.status, 200, 'la ficha de catalogo no depende de la inversa');
        assert.strictEqual(res.body.assets.length, 2);
        const cabeza = res.body.assets.find(a => a.assetId === DH_CABEZA);
        assert.deepStrictEqual(cabeza.bundleIds, [], 'sin bundle conocido');
        assert.deepStrictEqual(cabeza.ownedVia, { kind: 'Asset', id: DH_CABEZA },
            'se comprueba el asset, que es lo unico que se sabe con certeza');
    });

    test('fallo del lote con parte en cache -> 200 partial + unresolved', async () => {
        licenciaFila = filaActiva(); montarRoblox();

        // Primero se calienta el sombrero.
        await pedir(port, cuerpo({ assetIds: [SOMBRERO] }));

        // Ahora Roblox falla, pero el sombrero ya esta en cache.
        roblox.getCatalogItemDetails = async items => {
            llamadas.push({ api: 'items/details', items: items.map(i => `${i.itemType}:${i.id}`) });
            throw new UpstreamError('caido', new Error('x'));
        };

        let res;
        await captureStdout(async () => { res = await pedir(port, cuerpo({ assetIds: [SOMBRERO, DH_CABEZA] })); });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.partial, true);
        assert.deepStrictEqual(res.body.assets.map(a => a.assetId), [SOMBRERO], 'se entrega lo que hay');
        assert.deepStrictEqual(res.body.unresolved.assetIds, [DH_CABEZA], 'y se dice exactamente que falto');
    });

    test('fallo total y nada en cache -> 503, NUNCA un 200 vacio', async () => {
        // Un 200 con la lista vacia le diria al juego "estos items no existen",
        // que es falso: dejaria al jugador viendo un armario roto por un bache
        // de Roblox.
        licenciaFila = filaActiva();
        montarRoblox({ fallos: { itemsDetails: new UpstreamError('caido', new Error('x')) } });

        let res;
        await captureStdout(async () => { res = await pedir(port, cuerpo({ assetIds: [DH_CABEZA] })); });

        assert.strictEqual(res.status, 503);
        assert.strictEqual(res.body.error.code, 'upstream_unavailable');
        assert.ok(Number(res.headers['retry-after']) >= 1);
    });

    // ═══ Que no rompe nada de lo que ya habia ════════════════════════════════

    test('el token de licencia NO aparece en la respuesta ni en el log', async () => {
        const logger = require('../observability/logger');
        const infoOriginal = logger.info;
        const registrado = [];
        logger.info = (mensaje, datos) => registrado.push({ mensaje, datos });

        licenciaFila = filaActiva(); montarRoblox();
        let res;
        try { res = await pedir(port, cuerpo()); } finally { logger.info = infoOriginal; }

        assert.ok(!res.raw.includes(TOKEN));
        assert.ok(!res.raw.includes(HASH));
        const linea = registrado.find(l => l.mensaje === 'Catalogo por lotes');
        assert.ok(linea, 'la peticion deja rastro');
        assert.ok(!JSON.stringify(linea).includes(TOKEN), 'EL TOKEN NO PUEDE ACABAR EN EL LOG');
        assert.strictEqual(linea.datos.groupId, GROUP_ID, 'pero si se sabe que grupo pidio');
    });

    test('las rutas de outfits y licencias siguen intactas', async () => {
        licenciaFila = filaActiva(); montarRoblox();

        const metrics = await request(port, '/v1/metrics', { headers: { 'x-api-key': OUTFIT } });
        assert.strictEqual(metrics.status, 404, 'POST /v1/metrics no existe (es GET)');

        const noExiste = await pedir(port, cuerpo(), juego).then(() => request(port, '/v1/catalog/otra', { headers: { ...juego, 'x-license-token': TOKEN }, body: {} }));
        assert.strictEqual(noExiste.status, 404);
        assert.strictEqual(noExiste.body.error.code, 'route_not_found');
    });

    test('/v1/catalog/batch esta detras del limitador por IP', async () => {
        licenciaFila = filaActiva(); montarRoblox();
        ownRateLimit.reset();
        const { maxPerWindow } = ownRateLimit.getMetrics();

        for (let i = 0; i < maxPerWindow; i++) {
            const res = await request(port, '/v1/catalog/batch', { headers: { ...juego, 'x-license-token': TOKEN }, body: cuerpo(), sinReset: true });
            assert.strictEqual(res.status, 200, `la peticion ${i + 1} debia pasar`);
        }
        const res = await request(port, '/v1/catalog/batch', { headers: { ...juego, 'x-license-token': TOKEN }, body: cuerpo(), sinReset: true });
        assert.strictEqual(res.status, 429);
        ownRateLimit.reset();
    });

    const ok = await suite.run();

    db.query = queryOriginal;
    Object.assign(roblox, originales);
    config.cache.maxEntries = topeCachePrevio;
    cache.reset();
    ownRateLimit.reset();
    await new Promise(resolve => server.close(resolve));
    return ok;
};
