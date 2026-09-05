'use strict';

const http = require('http');
const { createSuite, axiosError } = require('./harness');
const { createApp } = require('../app');
const ownRateLimit = require('../security/rateLimit');
const limitador = require('../roblox/rateLimiter');
const roblox = require('../roblox/client');
const cache = require('../cache/cacheStore');
const config = require('../config');
const rotationRepo = require('../db/pluginRotationRepo');
const jobRepo = require('../db/pluginJobRepo');
const avatarRepo = require('../db/avatarIndexRepo');
const crawlRepo = require('../db/indexCrawlRepo');
const memberRepo = require('../db/groupMemberRepo');
const catalogoRepo = require('../db/assetCatalogRepo');
const pool = require('../db/pool');
const jobs = require('../services/pluginSearch/jobs');
const { crearBaseFalsa } = require('./fakeDb');

// SERVIR DESDE EL INDICE.
//
// Con INDEX_SERVE_ENABLED=true, un POST del plugin es una transaccion contra
// Postgres y nada mas. Lo que estos casos vigilan:
//
//   CERO ROBLOX      los clientes estan instrumentados para HACER FALLAR el
//                    test si el POST los llama. No es una comprobacion de
//                    contadores: es una trampa. Si alguien añade un respaldo
//                    "por si acaso", este archivo se pone rojo.
//   FILTROS          minAccessories, rango de precio y requireCompletePrice se
//                    aplican en la consulta, no despues.
//   ROTACION         dos busquedas seguidas no repiten a nadie.
//   CONCURRENCIA     dos simultaneas tampoco, y eso lo garantiza el bloqueo de
//                    filas dentro de la transaccion.
//   503              si Postgres falla, se dice. NUNCA se cae en Roblox.

const GRUPO = 59218460;
const CLAVE = config.pluginApiKey;

function pedir(port, metodo, ruta, cuerpo) {
    ownRateLimit.reset();
    const payload = cuerpo === undefined ? null : JSON.stringify(cuerpo);
    const headers = { 'x-plugin-key': CLAVE };
    if (payload !== null) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(payload);
    }
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: ruta, method: metodo, headers }, res => {
            let d = '';
            res.on('data', c => { d += c; });
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(d); } catch { /* no-JSON */ }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

module.exports = async function run() {
    const suite = createSuite('indexServe');
    const { test, assert } = suite;

    const original = {
        listGroupMembers: roblox.listGroupMembers,
        getCurrentAvatar: roblox.getCurrentAvatar,
        getCatalogItemDetails: roblox.getCatalogItemDetails,
        rotationRepo: { ...rotationRepo },
        jobRepo: { ...jobRepo },
        avatarRepo: { ...avatarRepo },
        crawlRepo: { ...crawlRepo },
        memberRepo: { ...memberRepo },
        catalogoRepo: { ...catalogoRepo },
        pool: { isConfigured: pool.isConfigured, withTransaction: pool.withTransaction },
        serveEnabled: config.indexServe.enabled,
        minAccessories: config.pluginSearch.minAccessories,
    };

    const app = createApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;

    const base = crearBaseFalsa();
    base.instalar();
    config.indexServe.enabled = true;
    config.pluginSearch.minAccessories = 3;

    // ── LA TRAMPA ───────────────────────────────────────────────────────────
    // Cualquier llamada a Roblox desde un POST servido por el indice deja
    // constancia AQUI, y todos los casos lo comprueban. Es la unica forma de
    // demostrar "no llama a Roblox" sin fiarse de un contador que alguien pueda
    // olvidarse de incrementar.
    const llamadasProhibidas = [];
    roblox.listGroupMembers = async () => { llamadasProhibidas.push('listGroupMembers'); return { members: [], nextCursor: null }; };
    roblox.getCurrentAvatar = async () => { llamadasProhibidas.push('getCurrentAvatar'); return { assets: [], playerAvatarType: null }; };
    roblox.getCatalogItemDetails = async () => { llamadasProhibidas.push('getCatalogItemDetails'); return new Map(); };

    const sinRoblox = () => assert.deepStrictEqual(llamadasProhibidas, [],
        `el POST llamo a Roblox: ${llamadasProhibidas.join(', ')}`);

    // ── El indice de prueba ─────────────────────────────────────────────────
    //
    // Mil usuarios indexados a mano: aqui no corre el worker, se prueba QUIEN
    // SIRVE. Uno de cada diez queda por debajo del minimo de accesorios y uno
    // de cada siete tiene precio incompleto.
    async function poblarIndice({ usuarios = 1000, precio = u => 300 + (u % 700) } = {}) {
        cache.reset(); limitador.reset(); jobs.reset(); base.limpiar();
        llamadasProhibidas.length = 0;

        const lista = [];
        for (let i = 0; i < usuarios; i++) lista.push({ userId: 1000 + i, username: `U${1000 + i}` });
        // La pertenencia esta vallada contra el borrado: sin fila de recorrido
        // no se escribe. Es el orden de produccion, donde el crawler solo pagina
        // un grupo que ya tiene recorrido.
        await crawlRepo.asegurar(GRUPO);
        await memberRepo.registrarPagina(GRUPO, lista);

        for (const m of lista) {
            const u = Number(m.userId);
            const accesorios = u % 10 === 0 ? 2 : 4;      // uno de cada diez, por debajo del minimo
            const completo = u % 7 !== 0;
            await avatarRepo.upsertAvatar({
                userId: u, username: m.username, state: avatarRepo.ESTADO.SOLO_AVATAR,
                assetIds: [`${u}1`, `${u}2`], assetTypeIds: [8, 41], accessories: accesorios,
            });
            await avatarRepo.upsertValoraciones([{
                userId: u,
                state: avatarRepo.ESTADO.VALIDO,
                valoracion: {
                    totalPrice: precio(u), priceComplete: completo,
                    pricedItems: 2, unpricedItems: completo ? 0 : 1,
                    limitedItems: 0, offSaleItems: 0, bundledItems: 0,
                },
            }]);
        }
    }

    const buscar = (extra = {}) => pedir(port, 'POST', '/plugin/outfits/search', {
        amount: 10, groupId: GRUPO, minPrice: 300, maxPrice: 100_000_000,
        requireCompletePrice: false, async: true, ...extra,
    });

    // ── 1. Mil usuarios indexados ───────────────────────────────────────────

    test('con 1000 usuarios indexados, pedir 10 devuelve EXACTAMENTE 10 sin tocar Roblox', async () => {
        await poblarIndice({ usuarios: 1000 });

        const { status, body } = await buscar();

        assert.strictEqual(status, 200);
        assert.strictEqual(body.status, 'completed');
        assert.strictEqual(body.requested, 10);
        assert.strictEqual(body.found, 10);
        assert.strictEqual(body.outfits.length, 10);
        assert.strictEqual(body.indexWarming, false);
        assert.strictEqual(body.coverage.members, 1000);
        assert.strictEqual(body.coverage.indexed, 1000);

        // Terminal: sin searchId no hay nada que sondear y el plugin rehabilita
        // el boton en el acto.
        assert.strictEqual(body.searchId, undefined, 'una respuesta terminal no lleva searchId');

        sinRoblox();
    });

    test('CERO llamadas de avatar y CERO de catalogo desde el POST', async () => {
        await poblarIndice({ usuarios: 200 });
        const antesAvatar = limitador.getMetrics().byRoute.userAvatar.calls;
        const antesCatalogo = limitador.getMetrics().byRoute.catalogDetails.calls;

        await buscar();

        assert.strictEqual(limitador.getMetrics().byRoute.userAvatar.calls, antesAvatar);
        assert.strictEqual(limitador.getMetrics().byRoute.catalogDetails.calls, antesCatalogo);
        sinRoblox();
    });

    // ── 2. Los filtros ──────────────────────────────────────────────────────

    test('ni un outfit por debajo del minimo de accesorios', async () => {
        await poblarIndice({ usuarios: 300 });
        const { body } = await buscar({ amount: 50 });

        assert.strictEqual(body.outfits.length, 50);
        for (const outfit of body.outfits) {
            const fila = base.avatares.get(String(outfit.userId));
            assert.ok(fila.accessories >= config.pluginSearch.minAccessories,
                `salio ${outfit.userId} con ${fila.accessories} accesorios`);
        }
        sinRoblox();
    });

    test('bajar el minimo de accesorios cambia quien puede salir, sin reindexar nada', async () => {
        await poblarIndice({ usuarios: 300 });

        // Con el minimo en 3, los de dos accesorios no salen nunca.
        const conTres = await buscar({ amount: 100 });
        const salieronBajos = conTres.body.outfits.filter(o => Number(o.userId) % 10 === 0);
        assert.deepStrictEqual(salieronBajos, []);

        // Con el minimo en 2, esos MISMOS usuarios ya valen: no se toco ni una
        // fila del indice, solo la configuracion.
        config.pluginSearch.minAccessories = 2;
        try {
            const conDos = await buscar({ amount: 300 });
            assert.ok(conDos.body.outfits.some(o => Number(o.userId) % 10 === 0),
                'bajar el minimo no dejo entrar a los que antes no llegaban');
        } finally {
            config.pluginSearch.minAccessories = 3;
        }
        sinRoblox();
    });

    test('ni un outfit fuera del rango de precio', async () => {
        await poblarIndice({ usuarios: 400 });
        const { body } = await buscar({ amount: 40, minPrice: 500, maxPrice: 700 });

        assert.ok(body.outfits.length > 0, 'no salio ninguno en un rango que tiene candidatos');
        for (const outfit of body.outfits) {
            assert.ok(outfit.totalPrice >= 500 && outfit.totalPrice <= 700,
                `salio uno de ${outfit.totalPrice}, fuera de 500-700`);
        }
        sinRoblox();
    });

    test('requireCompletePrice se respeta', async () => {
        await poblarIndice({ usuarios: 400 });

        const sinExigir = await buscar({ amount: 60, requireCompletePrice: false });
        assert.ok(sinExigir.body.outfits.some(o => o.priceComplete === false),
            'sin exigirlo deberian poder salir precios incompletos');

        const exigiendo = await buscar({ amount: 60, requireCompletePrice: true });
        for (const outfit of exigiendo.body.outfits) {
            assert.strictEqual(outfit.priceComplete, true,
                `salio ${outfit.userId} con precio incompleto pese a exigirlo`);
        }
        sinRoblox();
    });

    // ── 3. Rotacion ─────────────────────────────────────────────────────────

    test('dos busquedas CONSECUTIVAS no repiten a nadie antes de dar la vuelta', async () => {
        await poblarIndice({ usuarios: 1000 });

        const una = await buscar({ amount: 10 });
        const dos = await buscar({ amount: 10 });

        const idsUna = una.body.outfits.map(o => o.userId);
        const idsDos = dos.body.outfits.map(o => o.userId);
        const repetidos = idsDos.filter(id => idsUna.includes(id));

        assert.strictEqual(repetidos.length, 0, `se repitieron ${repetidos.length}: ${repetidos.join(',')}`);
        assert.strictEqual(new Set([...idsUna, ...idsDos]).size, 20);
        sinRoblox();
    });

    test('dos busquedas SIMULTANEAS no reciben al mismo usuario', async () => {
        await poblarIndice({ usuarios: 1000 });

        // A la vez, sin esperar la una a la otra: es la carrera real de dos
        // Studios pulsando BUSCAR en el mismo segundo.
        const [a, b] = await Promise.all([buscar({ amount: 10 }), buscar({ amount: 10 })]);

        const idsA = a.body.outfits.map(o => o.userId);
        const idsB = b.body.outfits.map(o => o.userId);
        const comunes = idsB.filter(id => idsA.includes(id));

        assert.strictEqual(a.body.found, 10);
        assert.strictEqual(b.body.found, 10);
        assert.strictEqual(comunes.length, 0,
            `las dos busquedas simultaneas devolvieron ${comunes.length} usuarios iguales`);
        assert.strictEqual(new Set([...idsA, ...idsB]).size, 20);
        sinRoblox();
    });

    // ── 4. Indice a medias ──────────────────────────────────────────────────

    test('con solo 4 elegibles responde partial con indexWarming y la cobertura', async () => {
        await poblarIndice({ usuarios: 40 });
        // Se dejan cuatro elegibles: al resto se le quita la valoracion.
        let dejados = 0;
        for (const fila of base.avatares.values()) {
            if (fila.accessories < 3) continue;
            if (dejados < 4) { dejados++; continue; }
            fila.state = avatarRepo.ESTADO.SOLO_AVATAR;
            fila.totalPrice = null;
        }

        const { status, body } = await buscar({ amount: 10 });

        assert.strictEqual(status, 200);
        assert.strictEqual(body.status, 'partial');
        assert.strictEqual(body.requested, 10);
        assert.strictEqual(body.found, 4);
        assert.strictEqual(body.outfits.length, 4);
        assert.strictEqual(body.indexWarming, true);
        assert.strictEqual(body.coverage.members, 40);
        assert.ok(body.coverage.indexed > 0);
        assert.strictEqual(body.searchId, undefined);

        // Y quedarse corto SUBE la prioridad del grupo: el worker ira alli.
        const recorrido = await crawlRepo.leer(GRUPO);
        assert.ok(recorrido && recorrido.priority >= 6,
            `la demanda no se registro: priority ${recorrido && recorrido.priority}`);
        sinRoblox();
    });

    test('con el indice vacio responde partial con cero, nunca busca en vivo', async () => {
        cache.reset(); base.limpiar(); llamadasProhibidas.length = 0;

        const { status, body } = await buscar();

        assert.strictEqual(status, 200);
        assert.strictEqual(body.status, 'partial');
        assert.strictEqual(body.found, 0);
        assert.deepStrictEqual(body.outfits, []);
        assert.strictEqual(body.indexWarming, true);
        sinRoblox();
    });

    // ── 5. Postgres caido ───────────────────────────────────────────────────

    test('si Postgres falla, 503 index_unavailable y NUNCA un respaldo a Roblox', async () => {
        await poblarIndice({ usuarios: 50 });

        const bueno = pool.withTransaction;
        pool.withTransaction = async () => { throw Object.assign(new Error('conexion perdida'), { code: '08006' }); };
        try {
            const { status, body } = await pedir(port, 'POST', '/plugin/outfits/search', {
                amount: 10, groupId: GRUPO, minPrice: 300, maxPrice: 100_000_000,
                requireCompletePrice: false, async: true,
            });

            assert.strictEqual(status, 503);
            assert.strictEqual(body.error.code, 'index_unavailable');
            sinRoblox();
        } finally {
            pool.withTransaction = bueno;
        }
    });

    // ── 6. El interruptor ───────────────────────────────────────────────────

    test('con INDEX_SERVE_ENABLED=false el POST vuelve al camino de siempre', async () => {
        await poblarIndice({ usuarios: 50 });
        config.indexServe.enabled = false;
        try {
            const { body } = await buscar();
            // Camino asincrono: crea trabajo y devuelve searchId.
            assert.ok(body.searchId, 'sin el indice sirviendo deberia haber searchId');
            assert.ok(['queued', 'running'].includes(body.status));
        } finally {
            config.indexServe.enabled = true;
        }
    });

    const ok = await suite.run();

    roblox.listGroupMembers = original.listGroupMembers;
    roblox.getCurrentAvatar = original.getCurrentAvatar;
    roblox.getCatalogItemDetails = original.getCatalogItemDetails;
    Object.assign(rotationRepo, original.rotationRepo);
    Object.assign(jobRepo, original.jobRepo);
    Object.assign(avatarRepo, original.avatarRepo);
    Object.assign(crawlRepo, original.crawlRepo);
    Object.assign(memberRepo, original.memberRepo);
    Object.assign(catalogoRepo, original.catalogoRepo);
    pool.isConfigured = original.pool.isConfigured;
    pool.withTransaction = original.pool.withTransaction;
    config.indexServe.enabled = original.serveEnabled;
    config.pluginSearch.minAccessories = original.minAccessories;
    cache.reset();
    ownRateLimit.reset();
    limitador.reset();
    jobs.reset();
    await new Promise(resolve => server.close(resolve));
    return ok;
};
