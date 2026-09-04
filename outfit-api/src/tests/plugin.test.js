'use strict';

const http = require('http');
const { createSuite, axiosError, networkError } = require('./harness');
const { createApp } = require('../app');
const ownRateLimit = require('../security/rateLimit');
const roblox = require('../roblox/client');
const cache = require('../cache/cacheStore');
const config = require('../config');

// Tests de POST /plugin/outfits/search por HTTP real, SIN red: las tres
// llamadas a Roblox que compone la busqueda (miembros del grupo, avatar de
// cada usuario, fichas de catalogo por lote) se sustituyen por dobles.
//
// Lo que este archivo protege, por orden de importancia:
//   1. Que el filtro de precio decide de verdad quien entra y quien no.
//   2. Que un usuario que falla se DESCARTA y la busqueda sigue, en vez de
//      tumbar la peticion entera. Es el requisito que hace utilizable esto
//      sobre una comunidad real, donde siempre hay cuentas baneadas.
//   3. Que la busqueda TERMINA: topes de candidatos y de paginas, sin bucles.
//   4. Que no salen usuarios repetidos aunque Roblox repita miembros.
//   5. Los bordes de validacion (1, 500, 0, 501, tipos) y la forma de la
//      respuesta, que es contrato con el plugin.

function buscar(port, body, { raw, contentType = 'application/json', pluginKey = CLAVE_PLUGIN } = {}) {
    // El limitador del runner esta bajado a 25/min para que otro archivo pueda
    // provocar un 429 a proposito; sin este reset, los casos de aqui lo
    // heredarian.
    ownRateLimit.reset();

    const payload = raw !== undefined
        ? raw
        : body !== undefined ? JSON.stringify(body) : null;

    const headers = {};
    if (contentType) headers['content-type'] = contentType;
    // null = no mandar la cabecera, para los casos de 401.
    if (pluginKey !== null) headers['x-plugin-key'] = pluginKey;
    if (payload !== null) headers['content-length'] = Buffer.byteLength(payload);

    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port, path: '/plugin/outfits/search', method: 'POST', headers,
        }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(data); } catch { /* respuesta no-JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: data });
            });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

// El groupId viaja ahora como NUMERO estricto: el contrato del plugin no
// admite "59218460" como cadena, y hay un caso que lo comprueba.
const GROUP_ID = 59218460;
const CLAVE_PLUGIN = config.pluginApiKey;

module.exports = async function run() {
    const suite = createSuite('plugin');
    const { test, assert } = suite;

    const app = createApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;

    // ── Dobles de Roblox ─────────────────────────────────────────────────────
    //
    // Un mundo de mentira completo y configurable: N miembros, cada uno con un
    // avatar de un solo asset cuyo precio es su propio id. Asi el precio de un
    // usuario es predecible desde el test y el filtro se puede comprobar al
    // robusto en vez de "a ver que sale".
    const original = {
        listGroupMembers: roblox.listGroupMembers,
        getCurrentAvatar: roblox.getCurrentAvatar,
        getCatalogItemDetails: roblox.getCatalogItemDetails,
    };

    // Estado del mundo, reescrito por cada caso.
    let mundo = {};
    const llamadas = { members: 0, avatars: 0, catalog: 0 };

    function poblar({ miembros = 10, precioDe = userId => userId, avatarRoto = () => false,
        catalogoRoto = false, paginas = null } = {}) {
        mundo = { miembros, precioDe, avatarRoto, catalogoRoto, paginas };
        llamadas.members = 0;
        llamadas.avatars = 0;
        llamadas.catalog = 0;
        cache.reset(); // la cache es global: sin esto un caso veria los datos del anterior
    }

    // Paginacion real de mentira: 100 por pagina y cursor "p1", "p2"... para
    // poder comprobar el tope de paginas sin depender de Roblox.
    const dobles = {};

    dobles.listGroupMembers = async (groupId, { cursor = null } = {}) => {
        llamadas.members++;
        if (mundo.paginas) return mundo.paginas(cursor);

        const pagina = cursor ? Number(String(cursor).slice(1)) : 0;
        const desde = pagina * 100;
        const hasta = Math.min(desde + 100, mundo.miembros);
        const members = [];
        for (let i = desde; i < hasta; i++) {
            members.push({ userId: 1000 + i, username: `User${1000 + i}` });
        }
        return { members, nextCursor: hasta < mundo.miembros ? `p${pagina + 1}` : null };
    };

    dobles.getCurrentAvatar = async userId => {
        llamadas.avatars++;
        if (mundo.avatarRoto(userId)) throw axiosError(404);
        // Un asset por usuario, con id derivado del suyo: assetId = userId * 10.
        return { assets: [{ id: userId * 10, name: `Asset${userId}`, assetTypeId: 8, assetTypeName: 'Hat' }],
            playerAvatarType: 'R15' };
    };

    dobles.getCatalogItemDetails = async items => {
        llamadas.catalog++;
        if (mundo.catalogoRoto) throw networkError();
        const mapa = new Map();
        for (const item of items) {
            const userId = Number(item.id) / 10;
            mapa.set(roblox.catalogKey('Asset', item.id), {
                available: true, name: `Asset${item.id}`, itemType: 'Asset', assetTypeId: 8,
                restrictions: [], isLimited: false, offSale: false,
                price: mundo.precioDe(userId), lowestPrice: null, lowestResalePrice: null,
                hasResellers: false, collectibleItemId: null,
                creatorType: 'User', creatorTargetId: 1, creatorName: 'Roblox',
            });
        }
        return mapa;
    };

    // Se instalan una vez; los casos que necesiten otro comportamiento
    // reasignan y vuelven al doble base al terminar, NUNCA a original.*.
    roblox.listGroupMembers = dobles.listGroupMembers;
    roblox.getCurrentAvatar = dobles.getCurrentAvatar;
    roblox.getCatalogItemDetails = dobles.getCatalogItemDetails;

    const cuerpo = (extra = {}) => ({ amount: 10, groupId: GROUP_ID, ...extra });

    // ── Busqueda real ────────────────────────────────────────────────────────

    test('devuelve miembros reales del grupo con su precio calculado', async () => {
        poblar({ miembros: 10, precioDe: () => 250 });
        const res = await buscar(port, cuerpo({ amount: 5 }));

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.requested, 5);
        assert.strictEqual(res.body.found, 5);
        assert.strictEqual(res.body.outfits.length, 5);

        for (const outfit of res.body.outfits) {
            assert.deepStrictEqual(Object.keys(outfit).sort(), ['totalPrice', 'userId', 'username']);
            assert.strictEqual(outfit.totalPrice, 250);
            assert.ok(outfit.userId >= 1000 && outfit.userId < 1010, `userId inesperado: ${outfit.userId}`);
            assert.strictEqual(outfit.username, `User${outfit.userId}`);
        }
    });

    test('el precio total es la SUMA de los assets del avatar', async () => {
        poblar({ miembros: 3 });
        // Avatar de tres piezas: 100 + 250 + 1000.
        roblox.getCurrentAvatar = async () => ({
            assets: [{ id: 11 }, { id: 22 }, { id: 33 }], playerAvatarType: 'R15',
        });
        const precios = { 11: 100, 22: 250, 33: 1000 };
        roblox.getCatalogItemDetails = async items => {
            const mapa = new Map();
            for (const item of items) {
                mapa.set(roblox.catalogKey('Asset', item.id), {
                    available: true, restrictions: [], isLimited: false, offSale: false,
                    price: precios[item.id], lowestPrice: null, lowestResalePrice: null,
                });
            }
            return mapa;
        };

        const res = await buscar(port, cuerpo({ amount: 1 }));
        assert.strictEqual(res.body.outfits[0].totalPrice, 1350);

        roblox.getCurrentAvatar = dobles.getCurrentAvatar;
        roblox.getCatalogItemDetails = dobles.getCatalogItemDetails;
    });

    test('un asset sin ficha de catalogo DESCARTA al candidato, no suma 0', async () => {
        poblar({ miembros: 1 });
        roblox.getCurrentAvatar = async () => ({ assets: [{ id: 11 }, { id: 22 }], playerAvatarType: 'R15' });
        roblox.getCatalogItemDetails = async () => {
            // Roblox devuelve SOLO el primero: el segundo esta borrado o moderado.
            const mapa = new Map();
            mapa.set(roblox.catalogKey('Asset', 11), {
                available: true, restrictions: [], isLimited: false, price: 500,
            });
            return mapa;
        };

        // Contar el ausente como 0 daria totalPrice 500 y colaria este avatar
        // en un rango donde no encaja. Preferimos no devolverlo.
        const res = await buscar(port, cuerpo({ amount: 1 }));
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.found, 0);

        roblox.getCurrentAvatar = dobles.getCurrentAvatar;
        roblox.getCatalogItemDetails = dobles.getCatalogItemDetails;
    });

    test('un asset con precio null (limited / fuera de venta) DESCARTA al candidato', async () => {
        poblar({ miembros: 1 });
        roblox.getCurrentAvatar = async () => ({ assets: [{ id: 11 }, { id: 22 }], playerAvatarType: 'R15' });
        roblox.getCatalogItemDetails = async items => {
            const mapa = new Map();
            for (const item of items) {
                mapa.set(roblox.catalogKey('Asset', item.id), {
                    available: true, restrictions: [], isLimited: Number(item.id) === 22,
                    // El limited llega con price null: su valor vive en la
                    // reventa, y leerlo es la fase siguiente.
                    price: Number(item.id) === 22 ? null : 300,
                    lowestPrice: Number(item.id) === 22 ? 15000 : null,
                });
            }
            return mapa;
        };

        const res = await buscar(port, cuerpo({ amount: 1 }));
        assert.strictEqual(res.body.found, 0);

        roblox.getCurrentAvatar = dobles.getCurrentAvatar;
        roblox.getCatalogItemDetails = dobles.getCatalogItemDetails;
    });

    test('un precio REAL de 0 sigue siendo valido: gratis no es lo mismo que desconocido', async () => {
        poblar({ miembros: 3, precioDe: () => 0 });
        const res = await buscar(port, cuerpo({ amount: 3, minPrice: 0, maxPrice: 0 }));
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.found, 3);
        for (const outfit of res.body.outfits) assert.strictEqual(outfit.totalPrice, 0);
    });

    test('un avatar mixto de piezas gratis y de pago suma solo lo que cuesta', async () => {
        poblar({ miembros: 1 });
        roblox.getCurrentAvatar = async () => ({
            assets: [{ id: 11 }, { id: 22 }, { id: 33 }], playerAvatarType: 'R15',
        });
        const precios = { 11: 0, 22: 0, 33: 450 };
        roblox.getCatalogItemDetails = async items => {
            const mapa = new Map();
            for (const item of items) {
                mapa.set(roblox.catalogKey('Asset', item.id), {
                    available: true, restrictions: [], isLimited: false, price: precios[item.id],
                });
            }
            return mapa;
        };

        const res = await buscar(port, cuerpo({ amount: 1 }));
        assert.strictEqual(res.body.found, 1);
        assert.strictEqual(res.body.outfits[0].totalPrice, 450);

        roblox.getCurrentAvatar = dobles.getCurrentAvatar;
        roblox.getCatalogItemDetails = dobles.getCatalogItemDetails;
    });

    // ── Filtro de precio ─────────────────────────────────────────────────────

    test('minPrice y maxPrice dejan fuera a quien no encaja', async () => {
        // Precios 0, 100, 200 ... 900 (uno por miembro).
        poblar({ miembros: 10, precioDe: userId => (userId - 1000) * 100 });

        const res = await buscar(port, cuerpo({ amount: 10, minPrice: 200, maxPrice: 500 }));

        // Solo 200, 300, 400 y 500 caben en el rango.
        assert.strictEqual(res.body.found, 4);
        for (const outfit of res.body.outfits) {
            assert.ok(outfit.totalPrice >= 200 && outfit.totalPrice <= 500,
                `precio fuera de rango: ${outfit.totalPrice}`);
        }
    });

    test('los limites del rango son INCLUSIVOS por los dos lados', async () => {
        poblar({ miembros: 10, precioDe: userId => (userId - 1000) * 100 });
        const res = await buscar(port, cuerpo({ amount: 10, minPrice: 300, maxPrice: 300 }));
        assert.strictEqual(res.body.found, 1);
        assert.strictEqual(res.body.outfits[0].totalPrice, 300);
    });

    test('sin minPrice ni maxPrice no se filtra por precio', async () => {
        poblar({ miembros: 6, precioDe: userId => (userId - 1000) * 1000 });
        const res = await buscar(port, cuerpo({ amount: 6 }));
        assert.strictEqual(res.body.found, 6);
    });

    test('un rango que no encaja con nadie da found:0 y 200, no un error', async () => {
        poblar({ miembros: 10, precioDe: () => 50 });
        const res = await buscar(port, cuerpo({ amount: 10, minPrice: 9000, maxPrice: 10000 }));
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.found, 0);
        assert.deepStrictEqual(res.body.outfits, []);
    });

    // ── Resistencia: lo que falla se descarta y la busqueda sigue ────────────

    test('un usuario cuyo avatar no se puede leer se descarta, no rompe la busqueda', async () => {
        // Los pares fallan: quedan 5 de 10 utiles.
        poblar({ miembros: 10, precioDe: () => 100, avatarRoto: userId => userId % 2 === 0 });

        const res = await buscar(port, cuerpo({ amount: 10 }));
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.found, 5);
        for (const outfit of res.body.outfits) {
            assert.strictEqual(outfit.userId % 2, 1, 'se colo un usuario que debia fallar');
        }
    });

    test('si TODOS los avatares fallan, la respuesta sigue siendo 200 con found:0', async () => {
        poblar({ miembros: 10, avatarRoto: () => true });
        const res = await buscar(port, cuerpo({ amount: 10 }));
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.found, 0);
    });

    test('si no se puede poner precio a un avatar, ese usuario se descarta', async () => {
        // El catalogo entero falla: un precio 0 seria mentira, no gratis.
        poblar({ miembros: 5, catalogoRoto: true });
        const res = await buscar(port, cuerpo({ amount: 5, minPrice: 0 }));
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.found, 0);
    });

    test('un avatar vacio se descarta', async () => {
        poblar({ miembros: 5 });
        roblox.getCurrentAvatar = async () => ({ assets: [], playerAvatarType: 'R15' });
        const res = await buscar(port, cuerpo({ amount: 5 }));
        assert.strictEqual(res.body.found, 0);
        roblox.getCurrentAvatar = dobles.getCurrentAvatar;
    });

    test('un grupo que Roblox no conoce -> 404 group_not_found', async () => {
        poblar({ miembros: 0 });
        roblox.listGroupMembers = async () => { throw new (require('../roblox/errors').NotFoundError)('group_not_found', 'no existe'); };
        const res = await buscar(port, cuerpo());
        assert.strictEqual(res.status, 404);
        assert.strictEqual(res.body.error.code, 'group_not_found');
        roblox.listGroupMembers = dobles.listGroupMembers;
    });

    // ── Terminacion: nada de bucles infinitos ────────────────────────────────

    test('un grupo mas pequeño que amount devuelve lo que hay, sin colgarse', async () => {
        poblar({ miembros: 3, precioDe: () => 100 });
        const res = await buscar(port, cuerpo({ amount: 500 }));
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.requested, 500);
        assert.strictEqual(res.body.found, 3);
    });

    test('no se piden mas paginas de miembros que el tope configurado', async () => {
        // Grupo "infinito": siempre devuelve cursor. Sin tope, esto no acaba.
        poblar({
            miembros: 0,
            precioDe: () => 100,
            paginas: cursor => {
                const pagina = cursor ? Number(String(cursor).slice(1)) : 0;
                const members = [];
                for (let i = 0; i < 100; i++) members.push({ userId: pagina * 100 + i + 1, username: `U${i}` });
                return { members, nextCursor: `p${pagina + 1}` }; // NUNCA null
            },
        });

        const res = await buscar(port, cuerpo({ amount: 500, minPrice: 9_000_000 }));
        assert.strictEqual(res.status, 200);
        assert.ok(llamadas.members <= config.pluginSearch.maxMemberPages,
            `se pidieron ${llamadas.members} paginas, el tope es ${config.pluginSearch.maxMemberPages}`);
    });

    test('no se examinan mas candidatos que el cupo, aunque no se llegue a amount', async () => {
        // 5000 miembros y un rango imposible: sin tope se mirarian los 5000.
        poblar({ miembros: 5000, precioDe: () => 10 });
        const res = await buscar(port, cuerpo({ amount: 500, minPrice: 100000, maxPrice: 200000 }));

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.found, 0);
        assert.ok(llamadas.avatars <= config.pluginSearch.maxCandidates,
            `se examinaron ${llamadas.avatars} candidatos, el cupo es ${config.pluginSearch.maxCandidates}`);
    });

    test('pedir pocos outfits no examina el grupo entero', async () => {
        poblar({ miembros: 5000, precioDe: () => 100 });
        await buscar(port, cuerpo({ amount: 1 }));
        // minCandidates (60) + el margen de una tanda: muy lejos de 5000.
        assert.ok(llamadas.avatars <= config.pluginSearch.minCandidates + config.pluginSearch.concurrency,
            `se examinaron ${llamadas.avatars} candidatos para pedir 1`);
    });

    test('para en cuanto tiene suficientes: no examina a todo el grupo', async () => {
        poblar({ miembros: 1000, precioDe: () => 100 });
        const res = await buscar(port, cuerpo({ amount: 10 }));
        assert.strictEqual(res.body.found, 10);
        assert.ok(llamadas.avatars < 100, `examino ${llamadas.avatars} candidatos para encontrar 10`);
    });

    // ── Sin duplicados ───────────────────────────────────────────────────────

    test('nunca repite un userId, aunque Roblox devuelva miembros duplicados', async () => {
        poblar({
            miembros: 0,
            precioDe: () => 100,
            paginas: cursor => {
                // Las dos paginas traen EXACTAMENTE la misma gente.
                const members = [1, 2, 3, 4, 5].map(i => ({ userId: i, username: `U${i}` }));
                return { members, nextCursor: cursor ? null : 'p1' };
            },
        });

        const res = await buscar(port, cuerpo({ amount: 10 }));
        const ids = res.body.outfits.map(o => o.userId);
        assert.strictEqual(new Set(ids).size, ids.length, `hay duplicados: ${ids.join(',')}`);
        assert.strictEqual(res.body.found, 5);
    });

    // ── Muestreo ─────────────────────────────────────────────────────────────

    test('el orden de los resultados varia entre busquedas (se baraja)', async () => {
        const firmas = new Set();
        for (let intento = 0; intento < 8; intento++) {
            poblar({ miembros: 200, precioDe: () => 100 });
            const res = await buscar(port, cuerpo({ amount: 20 }));
            firmas.add(res.body.outfits.map(o => o.userId).join(','));
        }
        // Con 200 miembros y 20 resultados, ocho busquedas identicas serian
        // practicamente imposibles si de verdad se baraja.
        assert.ok(firmas.size > 1, 'las 8 busquedas devolvieron exactamente los mismos usuarios en el mismo orden');
    });

    // ── La cache se reutiliza ────────────────────────────────────────────────

    test('la segunda busqueda no vuelve a pedir el avatar ni el precio ya cacheados', async () => {
        // UN solo candidato a proposito. El runner de tests baja
        // CACHE_MAX_ENTRIES a 5 para poder ejercitar la expulsion LRU en
        // cache.test.js, asi que un caso con 20 usuarios se expulsaria a si
        // mismo y no probaria nada. Con uno, las tres claves que toca la
        // busqueda (pagina de miembros, avatar, ficha del asset) caben de sobra.
        poblar({ miembros: 1, precioDe: () => 100 });

        const primera = await buscar(port, cuerpo({ amount: 1 }));
        assert.strictEqual(primera.body.found, 1);
        assert.strictEqual(llamadas.avatars, 1, 'la primera busqueda deberia pedir el avatar una vez');
        assert.strictEqual(llamadas.catalog, 1, 'la primera busqueda deberia pedir el catalogo una vez');

        llamadas.avatars = 0;
        llamadas.catalog = 0;

        const segunda = await buscar(port, cuerpo({ amount: 1 }));
        assert.strictEqual(segunda.body.found, 1);
        assert.strictEqual(segunda.body.outfits[0].totalPrice, 100);

        // Ni una llamada mas: avatar y ficha de catalogo salen de la cache que
        // ya comparte con /v1/outfits y /v1/catalog/batch.
        assert.strictEqual(llamadas.avatars, 0, 'la segunda busqueda volvio a pedir el avatar');
        assert.strictEqual(llamadas.catalog, 0, 'la segunda busqueda volvio a pedir el catalogo');
    });

    // ── Validacion: amount ───────────────────────────────────────────────────

    async function esperar400(descripcion, peticion) {
        const res = await peticion();
        assert.strictEqual(res.status, 400, `${descripcion}: se esperaba 400 y llego ${res.status}`);
        assert.strictEqual(res.body.error.code, 'invalid_request');
        assert.ok(typeof res.body.error.message === 'string' && res.body.error.message.length > 0);
        return res;
    }

    test('amount = 1 (minimo) -> 200 y requested = 1', async () => {
        poblar({ miembros: 5, precioDe: () => 100 });
        const res = await buscar(port, cuerpo({ amount: 1 }));
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.requested, 1);
        assert.strictEqual(res.body.found, 1);
    });

    test('amount = 100 -> 200 y requested = 100', async () => {
        poblar({ miembros: 120, precioDe: () => 100 });
        const res = await buscar(port, cuerpo({ amount: 100 }));
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.requested, 100);
        assert.strictEqual(res.body.found, 100);
    });

    test('amount = 500 (maximo) -> 200 y requested = 500', async () => {
        poblar({ miembros: 600, precioDe: () => 100 });
        const res = await buscar(port, cuerpo({ amount: 500 }));
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.requested, 500);
    });

    test('amount = 0 -> 400 (por debajo del minimo)', async () => {
        await esperar400('amount=0', () => buscar(port, cuerpo({ amount: 0 })));
    });

    test('amount = 501 -> 400 (por encima del maximo)', async () => {
        await esperar400('amount=501', () => buscar(port, cuerpo({ amount: 501 })));
    });

    test('amount = "abc" -> 400 (no es un numero)', async () => {
        await esperar400('amount="abc"', () => buscar(port, cuerpo({ amount: 'abc' })));
    });

    test('amount ausente -> 400', async () => {
        await esperar400('sin amount', () => buscar(port, { groupId: GROUP_ID }));
    });

    test('amount = "100" (numero como texto) -> 400', async () => {
        await esperar400('amount="100"', () => buscar(port, cuerpo({ amount: '100' })));
    });

    test('amount = 1.5 (decimal) -> 400', async () => {
        await esperar400('amount=1.5', () => buscar(port, cuerpo({ amount: 1.5 })));
    });

    // ── Validacion: groupId ──────────────────────────────────────────────────

    test('groupId ausente -> 400', async () => {
        await esperar400('sin groupId', () => buscar(port, { amount: 10 }));
    });

    test('groupId = 0 -> 400 (no es positivo)', async () => {
        await esperar400('groupId=0', () => buscar(port, cuerpo({ groupId: 0 })));
    });

    test('groupId negativo -> 400', async () => {
        await esperar400('groupId=-5', () => buscar(port, cuerpo({ groupId: -5 })));
    });

    test('groupId = "abc" -> 400', async () => {
        await esperar400('groupId="abc"', () => buscar(port, cuerpo({ groupId: 'abc' })));
    });

    // El contrato del plugin es ESTRICTO y se aparta a proposito del resto de
    // la API, donde un id de Roblox se acepta como numero o como cadena. Aqui
    // una cadena es señal de que el plugin no convirtio el texto de su caja.
    test('groupId como cadena "59218460" -> 400 (el contrato exige numero)', async () => {
        await esperar400('groupId string', () => buscar(port, cuerpo({ groupId: '59218460' })));
    });

    test('groupId decimal -> 400', async () => {
        await esperar400('groupId=1.5', () => buscar(port, cuerpo({ groupId: 1.5 })));
    });

    test('groupId por encima del entero seguro de JS -> 400', async () => {
        await esperar400('groupId enorme', () => buscar(port, cuerpo({ groupId: Number.MAX_SAFE_INTEGER + 2 })));
    });

    // ── Validacion: precios ──────────────────────────────────────────────────

    test('minPrice negativo -> 400', async () => {
        await esperar400('minPrice=-1', () => buscar(port, cuerpo({ minPrice: -1 })));
    });

    test('maxPrice menor que minPrice -> 400', async () => {
        await esperar400('max<min', () => buscar(port, cuerpo({ minPrice: 500, maxPrice: 100 })));
    });

    test('minPrice = 0 es valido (no se confunde con ausente)', async () => {
        poblar({ miembros: 5, precioDe: () => 0 });
        const res = await buscar(port, cuerpo({ amount: 5, minPrice: 0, maxPrice: 0 }));
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.found, 5);
    });

    test('minPrice decimal -> 400', async () => {
        await esperar400('minPrice=10.5', () => buscar(port, cuerpo({ minPrice: 10.5 })));
    });

    test('maxPrice como texto -> 400', async () => {
        await esperar400('maxPrice="3000"', () => buscar(port, cuerpo({ maxPrice: '3000' })));
    });

    // ── Cuerpo y cableado ────────────────────────────────────────────────────

    test('sin cuerpo ni content-type -> 400, no 500', async () => {
        await esperar400('sin cuerpo', () => buscar(port, undefined, { contentType: null }));
    });

    test('JSON malformado -> 400, no 500', async () => {
        await esperar400('json roto', () => buscar(port, undefined, { raw: '{"amount":' }));
    });

    test('la ruta no exige x-api-key, x-admin-key ni token de licencia', async () => {
        poblar({ miembros: 5, precioDe: () => 100 });
        const res = await buscar(port, cuerpo({ amount: 1 }));
        assert.strictEqual(res.status, 200);
    });

    // ── stats de diagnostico ─────────────────────────────────────────────────
    //
    // El valor de stats esta en que los numeros CUADREN: si un candidato se
    // cuenta dos veces, o en la casilla equivocada, mandan a arreglar lo que no
    // esta roto. Por eso casi todos estos casos comprueban dos cosas a la vez:
    // que la casilla correcta subio, y que la invariante sigue en pie.

    const CLAVES_STATS = [
        'candidatesExamined', 'accepted', 'rejectedAvatarError', 'rejectedEmptyAvatar',
        'rejectedCatalogError', 'rejectedUnknownPrice', 'rejectedMinPrice', 'rejectedMaxPrice',
    ];

    // candidatesExamined tiene que ser exactamente la suma del resto.
    function comprobarInvariante(stats, contexto) {
        const suma = stats.accepted + stats.rejectedAvatarError + stats.rejectedEmptyAvatar
            + stats.rejectedCatalogError + stats.rejectedUnknownPrice
            + stats.rejectedMinPrice + stats.rejectedMaxPrice;
        assert.strictEqual(stats.candidatesExamined, suma,
            `${contexto}: candidatesExamined=${stats.candidatesExamined} pero las casillas suman ${suma} ` +
            `(${JSON.stringify(stats)})`);
    }

    test('stats viene en la respuesta con las ocho claves y nada mas', async () => {
        poblar({ miembros: 10, precioDe: () => 100 });
        const res = await buscar(port, cuerpo({ amount: 5 }));

        assert.ok(res.body.stats, 'no vino el objeto stats');
        assert.deepStrictEqual(Object.keys(res.body.stats).sort(), [...CLAVES_STATS].sort());
        for (const clave of CLAVES_STATS) {
            assert.strictEqual(typeof res.body.stats[clave], 'number', `${clave} no es un numero`);
            assert.ok(Number.isInteger(res.body.stats[clave]), `${clave} no es entero`);
            assert.ok(res.body.stats[clave] >= 0, `${clave} es negativo`);
        }
    });

    test('stats es ADITIVO: el contrato anterior no se movio', async () => {
        poblar({ miembros: 10, precioDe: () => 100 });
        const res = await buscar(port, cuerpo({ amount: 3 }));

        // Las cuatro claves de siempre, con los mismos tipos y significados.
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.requested, 3);
        assert.strictEqual(res.body.found, 3);
        assert.ok(Array.isArray(res.body.outfits));
        assert.deepStrictEqual(Object.keys(res.body.outfits[0]).sort(),
            ['totalPrice', 'userId', 'username']);
        // Y stats como quinta clave, sin tocar las anteriores.
        assert.deepStrictEqual(Object.keys(res.body).sort(),
            ['found', 'outfits', 'requested', 'stats', 'success']);
    });

    test('accepted coincide con found cuando la busqueda no se llena', async () => {
        poblar({ miembros: 6, precioDe: () => 100 });
        const res = await buscar(port, cuerpo({ amount: 50 }));
        assert.strictEqual(res.body.found, 6);
        assert.strictEqual(res.body.stats.accepted, 6);
        assert.strictEqual(res.body.stats.candidatesExamined, 6);
        comprobarInvariante(res.body.stats, 'todos aceptados');
    });

    test('rejectedAvatarError cuenta a los que no se pudieron consultar', async () => {
        // Los pares fallan: 5 de 10.
        poblar({ miembros: 10, precioDe: () => 100, avatarRoto: userId => userId % 2 === 0 });
        const res = await buscar(port, cuerpo({ amount: 10 }));

        assert.strictEqual(res.body.stats.rejectedAvatarError, 5);
        assert.strictEqual(res.body.stats.accepted, 5);
        assert.strictEqual(res.body.stats.rejectedUnknownPrice, 0, 'un fallo de avatar se conto como precio');
        comprobarInvariante(res.body.stats, 'mitad con avatar roto');
    });

    test('rejectedEmptyAvatar se distingue de un error de avatar', async () => {
        poblar({ miembros: 4, precioDe: () => 100 });
        roblox.getCurrentAvatar = async () => ({ assets: [], playerAvatarType: 'R15' });

        const res = await buscar(port, cuerpo({ amount: 4 }));
        assert.strictEqual(res.body.stats.rejectedEmptyAvatar, 4);
        assert.strictEqual(res.body.stats.rejectedAvatarError, 0, 'un avatar vacio se conto como error');
        comprobarInvariante(res.body.stats, 'avatares vacios');

        roblox.getCurrentAvatar = dobles.getCurrentAvatar;
    });

    test('rejectedCatalogError cuenta cuando Roblox no responde al catalogo', async () => {
        poblar({ miembros: 5, catalogoRoto: true });
        const res = await buscar(port, cuerpo({ amount: 5 }));

        assert.strictEqual(res.body.stats.rejectedCatalogError, 5);
        assert.strictEqual(res.body.stats.rejectedUnknownPrice, 0,
            'un fallo de Roblox se conto como precio desconocido');
        assert.strictEqual(res.body.stats.accepted, 0);
        comprobarInvariante(res.body.stats, 'catalogo caido');
    });

    test('rejectedUnknownPrice cuenta a quien lleva algo sin precio fiable', async () => {
        // Es el caso que de verdad se quiere diagnosticar: Roblox responde bien,
        // pero el asset no tiene precio utilizable (limited / fuera de venta).
        poblar({ miembros: 5 });
        roblox.getCatalogItemDetails = async items => {
            const mapa = new Map();
            for (const item of items) {
                mapa.set(roblox.catalogKey('Asset', item.id), {
                    available: true, restrictions: ['Limited'], isLimited: true,
                    price: null, lowestPrice: 15000,
                });
            }
            return mapa;
        };

        const res = await buscar(port, cuerpo({ amount: 5, minPrice: 0 }));
        assert.strictEqual(res.body.found, 0);
        assert.strictEqual(res.body.stats.rejectedUnknownPrice, 5);
        assert.strictEqual(res.body.stats.rejectedCatalogError, 0,
            'un precio nulo se conto como fallo de Roblox');
        assert.strictEqual(res.body.stats.rejectedMinPrice, 0,
            'un precio nulo se conto como fuera de rango');
        comprobarInvariante(res.body.stats, 'todo limiteds');

        roblox.getCatalogItemDetails = dobles.getCatalogItemDetails;
    });

    test('rejectedMinPrice y rejectedMaxPrice cuentan cada lado por separado', async () => {
        // Precios 0, 100, 200 ... 900.
        poblar({ miembros: 10, precioDe: userId => (userId - 1000) * 100 });
        const res = await buscar(port, cuerpo({ amount: 10, minPrice: 300, maxPrice: 600 }));

        // Por debajo: 0, 100, 200 -> 3.  Dentro: 300..600 -> 4.  Por encima: 700, 800, 900 -> 3.
        assert.strictEqual(res.body.stats.rejectedMinPrice, 3);
        assert.strictEqual(res.body.stats.rejectedMaxPrice, 3);
        assert.strictEqual(res.body.stats.accepted, 4);
        assert.strictEqual(res.body.found, 4);
        comprobarInvariante(res.body.stats, 'rango por los dos lados');
    });

    test('cada candidato se cuenta UNA sola vez, con causas mezcladas', async () => {
        // Mundo variado a proposito: unos fallan el avatar, otros no tienen
        // precio, otros se salen del rango y otros entran. Es el caso que
        // pillaria un candidato contado dos veces.
        poblar({
            miembros: 12,
            avatarRoto: userId => userId % 4 === 0,          // 3 de 12
            precioDe: userId => (userId - 1000) * 100,
        });
        roblox.getCatalogItemDetails = async items => {
            const mapa = new Map();
            for (const item of items) {
                const userId = Number(item.id) / 10;
                const sinPrecio = userId % 4 === 1;          // otro grupo distinto
                mapa.set(roblox.catalogKey('Asset', item.id), {
                    available: true, restrictions: [], isLimited: sinPrecio,
                    price: sinPrecio ? null : (userId - 1000) * 100,
                });
            }
            return mapa;
        };

        const res = await buscar(port, cuerpo({ amount: 12, minPrice: 300, maxPrice: 800 }));
        const stats = res.body.stats;

        comprobarInvariante(stats, 'causas mezcladas');
        assert.strictEqual(stats.candidatesExamined, 12, 'no se examinaron los 12 del grupo');
        assert.strictEqual(stats.rejectedAvatarError, 3);
        assert.strictEqual(stats.accepted, res.body.found);

        roblox.getCatalogItemDetails = dobles.getCatalogItemDetails;
    });

    test('la invariante aguanta cuando la busqueda se llena antes de tiempo', async () => {
        // Se para en cuanto tiene 3, a mitad de una tanda de 4.
        poblar({ miembros: 200, precioDe: () => 100 });
        const res = await buscar(port, cuerpo({ amount: 3 }));

        assert.strictEqual(res.body.found, 3);
        comprobarInvariante(res.body.stats, 'parada temprana');
        // accepted puede pasarse de amount por lo que quede de la ultima tanda,
        // pero nunca por mas que el tamaño de una tanda.
        assert.ok(res.body.stats.accepted >= res.body.found, 'accepted por debajo de found');
        assert.ok(res.body.stats.accepted <= res.body.found + config.pluginSearch.concurrency,
            `accepted (${res.body.stats.accepted}) se paso de la ultima tanda`);
    });

    test('un grupo vacio da stats a cero, no un error', async () => {
        poblar({ miembros: 0 });
        const res = await buscar(port, cuerpo({ amount: 10 }));

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.found, 0);
        assert.strictEqual(res.body.stats.candidatesExamined, 0);
        comprobarInvariante(res.body.stats, 'grupo vacio');
    });

    test('stats no lleva credenciales ni datos de usuario', async () => {
        poblar({ miembros: 5, precioDe: () => 100 });
        const res = await buscar(port, cuerpo({ amount: 2 }));

        const serializado = JSON.stringify(res.body.stats);
        assert.ok(!serializado.includes(CLAVE_PLUGIN), 'la credencial se filtro en stats');
        assert.ok(!serializado.includes(config.apiKey), 'la key del juego se filtro en stats');
        assert.ok(!serializado.includes(config.adminApiKey), 'la key de admin se filtro en stats');
        // Solo enteros: ni ids, ni nombres, ni nada que venga de Roblox.
        for (const valor of Object.values(res.body.stats)) {
            assert.strictEqual(typeof valor, 'number');
        }
    });

    // ── Credencial exclusiva del plugin ──────────────────────────────────────
    //
    // Lo que se protege aqui no es solo "hay 401 si falta la clave", sino el
    // AISLAMIENTO entre los tres secretos: que la del plugin no abra nada mas,
    // y que nada mas abra la del plugin. Es lo que permite revocarle el acceso
    // al plugin sin tocarle el juego a ningun cliente con licencia.

    test('sin x-plugin-key -> 401 y NI UNA llamada a Roblox', async () => {
        poblar({ miembros: 10, precioDe: () => 100 });
        const res = await buscar(port, cuerpo(), { pluginKey: null });

        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.error.code, 'unauthorized');
        // El rechazo va delante del parser de cuerpo y de la busqueda: una
        // peticion sin credencial no puede costar ni una llamada saliente.
        assert.strictEqual(llamadas.members, 0);
        assert.strictEqual(llamadas.avatars, 0);
    });

    test('x-plugin-key incorrecta -> 401', async () => {
        poblar({ miembros: 10, precioDe: () => 100 });
        const res = await buscar(port, cuerpo(), { pluginKey: 'clave-que-no-es' });
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.error.code, 'unauthorized');
        assert.strictEqual(llamadas.avatars, 0);
    });

    test('el 401 es IDENTICO falte la clave o sea incorrecta', async () => {
        // Distinguirlas solo ayudaria a quien esta probando claves.
        const sin = await buscar(port, cuerpo(), { pluginKey: null });
        const mala = await buscar(port, cuerpo(), { pluginKey: 'x'.repeat(40) });
        assert.deepStrictEqual(sin.body, mala.body);
        assert.strictEqual(sin.status, mala.status);
    });

    test('la clave del JUEGO no abre /plugin', async () => {
        const res = await buscar(port, cuerpo(), { pluginKey: config.apiKey });
        assert.strictEqual(res.status, 401);
    });

    test('la clave de ADMIN no abre /plugin', async () => {
        const res = await buscar(port, cuerpo(), { pluginKey: config.adminApiKey });
        assert.strictEqual(res.status, 401);
    });

    test('mandar la clave del plugin en x-api-key o x-admin-key no sirve', async () => {
        ownRateLimit.reset();
        const res = await new Promise((resolve, reject) => {
            const payload = JSON.stringify(cuerpo());
            const req = http.request({
                host: '127.0.0.1', port, path: '/plugin/outfits/search', method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(payload),
                    'x-api-key': CLAVE_PLUGIN,
                    'x-admin-key': CLAVE_PLUGIN,
                },
            }, r => {
                let data = '';
                r.on('data', c => { data += c; });
                r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.write(payload);
            req.end();
        });
        assert.strictEqual(res.status, 401, 'la clave del plugin se acepto en la cabecera equivocada');
    });

    test('la clave del plugin NO se acepta por query string', async () => {
        // Un secreto en la URL acaba en el log de acceso de cualquier proxy, y
        // el requestLogger de este servicio si registra la URL.
        ownRateLimit.reset();
        const res = await new Promise((resolve, reject) => {
            const payload = JSON.stringify(cuerpo());
            const req = http.request({
                host: '127.0.0.1', port,
                path: `/plugin/outfits/search?x-plugin-key=${encodeURIComponent(CLAVE_PLUGIN)}`,
                method: 'POST',
                headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
            }, r => {
                let data = '';
                r.on('data', c => { data += c; });
                r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.write(payload);
            req.end();
        });
        assert.strictEqual(res.status, 401);
    });

    test('la clave del plugin no abre /admin/groups ni /v1/metrics', async () => {
        function pedir(path, headers) {
            ownRateLimit.reset();
            return new Promise((resolve, reject) => {
                const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, r => {
                    let data = '';
                    r.on('data', c => { data += c; });
                    r.on('end', () => resolve({ status: r.statusCode, raw: data }));
                });
                req.on('error', reject);
                req.end();
            });
        }

        const admin = await pedir('/admin/groups', { 'x-admin-key': CLAVE_PLUGIN });
        assert.strictEqual(admin.status, 401, 'la clave del plugin abrio /admin/groups');

        const metrics = await pedir('/v1/metrics', { 'x-api-key': CLAVE_PLUGIN });
        assert.strictEqual(metrics.status, 401, 'la clave del plugin abrio /v1/metrics');
    });

    test('/health sigue sin pedir ninguna credencial', async () => {
        ownRateLimit.reset();
        const res = await new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, path: '/health', method: 'GET' }, r => {
                let data = '';
                r.on('data', c => { data += c; });
                r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.end();
        });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.status, 'ok');
    });

    test('la clave del plugin NO aparece en ninguna respuesta', async () => {
        poblar({ miembros: 3, precioDe: () => 100 });
        const ok = await buscar(port, cuerpo({ amount: 1 }));
        const no = await buscar(port, cuerpo(), { pluginKey: null });
        assert.ok(!ok.raw.includes(CLAVE_PLUGIN), 'la clave se filtro en una respuesta 200');
        assert.ok(!no.raw.includes(CLAVE_PLUGIN), 'la clave se filtro en el 401');
    });

    test('otra ruta bajo /plugin, CON credencial, sigue siendo 404 route_not_found', async () => {
        ownRateLimit.reset();
        const res = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port, path: '/plugin/loquesea', method: 'GET',
                headers: { 'x-plugin-key': CLAVE_PLUGIN },
            }, r => {
                let data = '';
                r.on('data', c => { data += c; });
                r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.end();
        });
        assert.strictEqual(res.status, 404);
        assert.strictEqual(res.body.error.code, 'route_not_found');
    });

    test('otra ruta bajo /plugin SIN credencial responde 401, no 404', async () => {
        // La credencial se comprueba antes de enrutar, igual que en /admin: un
        // 404 aqui le confirmaria a quien tantea que rutas existen y cuales no.
        ownRateLimit.reset();
        const res = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port, path: '/plugin/loquesea', method: 'GET',
            }, r => {
                let data = '';
                r.on('data', c => { data += c; });
                r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.end();
        });
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.error.code, 'unauthorized');
    });

    const ok = await suite.run();

    roblox.listGroupMembers = original.listGroupMembers;
    roblox.getCurrentAvatar = original.getCurrentAvatar;
    roblox.getCatalogItemDetails = original.getCatalogItemDetails;
    cache.reset();
    ownRateLimit.reset();
    await new Promise(resolve => server.close(resolve));
    return ok;
};
