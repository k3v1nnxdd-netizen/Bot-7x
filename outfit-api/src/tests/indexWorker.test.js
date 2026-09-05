'use strict';

const { createSuite, axiosError } = require('./harness');
const config = require('../config');
const roblox = require('../roblox/client');
const cache = require('../cache/cacheStore');
const limitador = require('../roblox/rateLimiter');
const colaDeGrupos = require('../services/pluginSearch/groupQueue');
const rotationRepo = require('../db/pluginRotationRepo');
const jobRepo = require('../db/pluginJobRepo');
const avatarRepo = require('../db/avatarIndexRepo');
const crawlRepo = require('../db/indexCrawlRepo');
const memberRepo = require('../db/groupMemberRepo');
const { crearWorker } = require('../services/indexWorker/worker');
const { crearBaseFalsa } = require('./fakeDb');

// EL WORKER DEL INDICE (fase 1: solo escribe, nadie lee todavia).
//
// Lo que estos casos vigilan, y por que cada uno existe:
//
//   REINICIO   el cursor vive en Postgres, asi que morir a mitad de comunidad
//              continua por donde iba. Es la razon de que el cursor no este en
//              memoria.
//   LEASE      dos instancias arrancan a la vez en cada redeploy de Railway. Si
//              las dos recorren el mismo grupo, el cursor avanza a saltos.
//   429        UN LIMITE NO ES UN DATO. Es la regla mas importante del indice:
//              Roblox frenandonos no dice nada sobre el avatar de nadie, y no
//              puede degradar, marcar ni borrar una sola fila.
//   TTL        vencer NO borra: solo adelanta esa fila en la cola de refresco.
//   PRIORIDAD  el worker va donde se busca, no por la whitelist entera.
//   UPSERTS    idempotentes, porque un reintento tras un reinicio repite tramo.

const GRUPO = 59218460;
const OTRO_GRUPO = 77000111;

const T = { Hat: 8, Hair: 41, Back: 46, Waist: 47, Shirt: 11, Torso: 27 };

module.exports = async function run() {
    const suite = createSuite('indexWorker');
    const { test, assert } = suite;

    const original = {
        listGroupMembers: roblox.listGroupMembers,
        getCurrentAvatar: roblox.getCurrentAvatar,
        getCatalogItemDetails: roblox.getCatalogItemDetails,
        // `instalar()` del doble parchea TAMBIEN la rotacion y los trabajos.
        // Sin restaurarlos, los archivos de test que corren despues heredan un
        // Postgres falso instalado y cambian de comportamiento sin tocarse: la
        // rotacion pasa de efimera a persistente y la paginacion se mueve.
        rotationRepo: { ...rotationRepo },
        jobRepo: { ...jobRepo },
        avatarRepo: { ...avatarRepo },
        crawlRepo: { ...crawlRepo },
        memberRepo: { ...memberRepo },
        cfg: { ...config.indexWorker },
        cache: config.cache.maxEntries,
    };

    config.indexWorker.usersPerCycle = 10;
    config.indexWorker.leaseMs = 5_000;
    config.indexWorker.avatarTtlMs = 60_000;
    config.indexWorker.priceTtlMs = 30_000;
    config.indexWorker.fullPassEveryMs = 3_600_000;
    config.indexWorker.pricingVersion = 1;
    config.cache.maxEntries = 10_000;

    const base = crearBaseFalsa();
    base.instalar();

    // ── El mundo ────────────────────────────────────────────────────────────
    const mundo = { miembros: 0, avatares: 0, paginas: 0, avatar429Desde: null, borrados: new Set(), vacios: new Set() };

    // Payload CRUDO de Roblox: el aplanado lo hace el cliente real.
    const avatarCrudo = u => {
        const a = (k, tipo) => ({ id: u * 100 + k, name: `A${k}`, assetType: { id: tipo, name: `T${tipo}` } });
        return {
            assets: [a(0, T.Hat), a(1, T.Hair), a(2, T.Back), a(3, T.Waist), a(4, T.Shirt), a(5, T.Torso)],
            playerAvatarType: 'R15',
        };
    };

    roblox.listGroupMembers = async (groupId, { cursor = null } = {}) => {
        mundo.paginas++;
        const pagina = cursor ? Number(String(cursor).slice(1)) : 0;
        const desde = pagina * 100;
        const hasta = Math.min(desde + 100, mundo.miembros);
        const members = [];
        for (let i = desde; i < hasta; i++) members.push({ userId: 1000 + i, username: `U${1000 + i}` });
        return { members, nextCursor: hasta < mundo.miembros ? `p${pagina + 1}` : null };
    };

    roblox.getCurrentAvatar = async userId => {
        const r = await limitador.run('userAvatar', async () => {
            mundo.avatares++;
            if (mundo.avatar429Desde !== null && mundo.avatares >= mundo.avatar429Desde) {
                throw axiosError(429, { 'retry-after': '30' });
            }
            if (mundo.borrados.has(Number(userId))) throw axiosError(404);
            if (mundo.vacios.has(Number(userId))) return { status: 200, headers: {}, data: { assets: [], playerAvatarType: 'R15' } };
            return { status: 200, headers: {}, data: avatarCrudo(Number(userId)) };
        }, { endpoint: 'avatar.roblox.com/v1/users/{id}/avatar', notFoundCode: 'user_not_found' });
        return roblox.normalizeAvatarAssets(r.data);
    };

    roblox.getCatalogItemDetails = async items => {
        await limitador.run('catalogDetails', async () => ({ status: 200, headers: {}, data: {} }),
            { endpoint: 'catalog.roblox.com/v1/catalog/items/details' });
        const mapa = new Map();
        for (const item of items) {
            mapa.set(roblox.catalogKey('Asset', item.id), {
                available: true, assetTypeId: 8, isLimited: false, offSale: false, price: 50,
            });
        }
        return mapa;
    };

    function poblar({ miembros = 12 } = {}) {
        mundo.miembros = miembros;
        mundo.avatares = 0;
        mundo.paginas = 0;
        mundo.avatar429Desde = null;
        mundo.borrados = new Set();
        mundo.vacios = new Set();
        cache.reset();
        limitador.reset();
        colaDeGrupos.reset();
        base.limpiar();
    }

    const nuevoWorker = nombre => crearWorker({ instancia: nombre });

    // ── 1. Lo basico: llena el indice ───────────────────────────────────────

    test('un ciclo indexa miembros y outfits con el MISMO precio que calcula una busqueda', async () => {
        poblar({ miembros: 12 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });

        const worker = nuevoWorker('w-uno');
        const r = await worker.ciclo();

        assert.strictEqual(r.hecho, true, `no hizo nada: ${r.motivo}`);
        assert.strictEqual(r.groupId, String(GRUPO));
        assert.strictEqual(r.miembrosVistos, 12);
        assert.strictEqual(base.miembros.size, 12, 'no se registro la pertenencia');
        assert.strictEqual(r.escritos, 10, 'deberia escribir usersPerCycle usuarios');
        assert.strictEqual(base.avatares.size, 10);

        // Los HECHOS, no el veredicto: se guarda el numero de accesorios.
        const uno = await avatarRepo.leer(1000);
        assert.strictEqual(uno.state, 'valid');
        assert.strictEqual(uno.accessories, 4, 'gorro, pelo, espalda y cintura son cuatro accesorios');
        assert.strictEqual(uno.assetIds.length, 6);
        assert.strictEqual(uno.totalPrice, 300, 'seis assets a 50 son 300');
        assert.strictEqual(uno.priceComplete, true);
        assert.ok(uno.pricedAt > 0);

        // NO existe el estado 'too_few_accessories': el minimo se aplica al
        // consultar, y por eso puede cambiarse sin reindexar nada.
        for (const fila of base.avatares.values()) {
            assert.notStrictEqual(fila.state, 'too_few_accessories');
        }
    });

    test('la cobertura y la frescura se publican en las metricas del worker', async () => {
        poblar({ miembros: 12 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });
        const worker = nuevoWorker('w-metricas');
        await worker.ciclo();

        const m = worker.metricas;
        assert.strictEqual(m.coverage.members, 12);
        assert.strictEqual(m.coverage.indexed, 10);
        assert.strictEqual(m.coverage.valid, 10);
        assert.strictEqual(m.coverage.fresh, 10);
        assert.ok(m.coverage.coverage > 0.8 && m.coverage.coverage < 0.85);
        assert.strictEqual(m.usersWritten, 10);
        assert.strictEqual(m.errors, 0);
        assert.strictEqual(m.rateLimitHits, 0);
        assert.ok(m.lastCycleMs >= 0 && m.lastCycleAt > 0);
        assert.ok(m.usersPerMinute > 0, 'no se midio la velocidad');
    });

    // ── 2. Cursor y reinicio ────────────────────────────────────────────────

    test('CURSOR: el segundo ciclo continua en la pagina siguiente, no repite la primera', async () => {
        poblar({ miembros: 250 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });
        const worker = nuevoWorker('w-cursor');

        const uno = await worker.ciclo();
        assert.strictEqual(uno.cursorAntes, null);
        assert.strictEqual(uno.cursorDespues, 'p1');
        assert.strictEqual((await crawlRepo.leer(GRUPO)).cursor, 'p1', 'el cursor no se persistio');

        const dos = await worker.ciclo();
        assert.strictEqual(dos.cursorAntes, 'p1');
        assert.strictEqual(dos.cursorDespues, 'p2');
        assert.strictEqual(base.miembros.size, 200, 'la segunda pagina no aporto miembros nuevos');
    });

    test('REINICIO: un worker nuevo continua desde el MISMO cursor que dejo el anterior', async () => {
        poblar({ miembros: 250 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });

        const antes = nuevoWorker('w-antes');
        await antes.ciclo();
        const guardado = await crawlRepo.leer(GRUPO);
        assert.strictEqual(guardado.cursor, 'p1');
        assert.strictEqual(guardado.leaseOwner, null, 'el lease quedo cogido tras el ciclo');

        // El proceso muere: se pierde TODO lo que estaba en memoria. Lo unico
        // que sobrevive es la base, que es justo el punto.
        const despues = nuevoWorker('w-despues');
        assert.strictEqual(despues.metricas.cycles, 0, 'el worker nuevo no arranca limpio');

        const r = await despues.ciclo();
        assert.strictEqual(r.cursorAntes, 'p1', 'el worker nuevo volvio a empezar por el principio');
        assert.strictEqual(r.cursorDespues, 'p2');
    });

    test('el cursor da la vuelta al terminar la comunidad y cuenta el ciclo', async () => {
        poblar({ miembros: 40 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 3 });
        const worker = nuevoWorker('w-vuelta');

        const r = await worker.ciclo();
        assert.strictEqual(r.vueltaCompleta, true, 'con 40 miembros la primera pagina ya es la ultima');
        const fila = await crawlRepo.leer(GRUPO);
        assert.strictEqual(fila.cursor, null, 'no volvio al principio');
        assert.strictEqual(fila.cycle, 2);
        assert.ok(fila.lastFullPassAt > 0);
    });

    // ── 3. Lease y dos workers ──────────────────────────────────────────────

    test('LEASE: dos workers a la vez no recorren el mismo grupo', async () => {
        poblar({ miembros: 250 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });
        // Otra instancia ya lo tiene cogido, con lease vivo.
        base.otroWorkerToma(GRUPO, 'w-remoto', { duracionMs: 60_000 });

        const mio = nuevoWorker('w-mio');
        const r = await mio.ciclo();

        assert.strictEqual(r.hecho, false);
        assert.strictEqual(r.motivo, 'sin_trabajo', 'se metio en un grupo que tenia dueño');
        assert.strictEqual(mundo.paginas, 0, 'gasto una llamada en un grupo ajeno');
        assert.strictEqual((await crawlRepo.leer(GRUPO)).leaseOwner, 'w-remoto');
    });

    test('DOS WORKERS: cada uno coge un grupo distinto y ninguno se queda esperando', async () => {
        poblar({ miembros: 250 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });
        await crawlRepo.registrarDemanda(OTRO_GRUPO, { faltan: 5 });

        const a = nuevoWorker('w-a');
        const b = nuevoWorker('w-b');

        // Se cogen los leases ANTES de dejar que ninguno avance, que es la
        // carrera real de dos instancias arrancando a la vez.
        const primero = await crawlRepo.tomar('w-a', { leaseMs: 5_000 });
        const segundo = await crawlRepo.tomar('w-b', { leaseMs: 5_000 });

        assert.ok(primero && segundo, 'alguno se quedo sin grupo');
        assert.notStrictEqual(primero.groupId, segundo.groupId, 'los dos cogieron el MISMO grupo');
        await crawlRepo.soltar(primero.groupId, 'w-a');
        await crawlRepo.soltar(segundo.groupId, 'w-b');

        // Y trabajando de verdad, cada uno indexa sin pisar al otro.
        const ra = await a.ciclo();
        const rb = await b.ciclo();
        assert.strictEqual(ra.hecho, true);
        assert.strictEqual(rb.hecho, true);
        assert.notStrictEqual(ra.groupId, rb.groupId);
    });

    test('un avance con el lease PERDIDO no mueve el cursor de quien lo tiene ahora', async () => {
        poblar({ miembros: 250 });
        await crawlRepo.asegurar(GRUPO);
        // El lease es de otro: guardar tiene que ser un no-op.
        base.otroWorkerToma(GRUPO, 'w-legitimo', { duracionMs: 60_000 });

        const movido = await crawlRepo.guardarCursor(GRUPO, 'w-intruso', {
            cursor: 'p9', intraPageOffset: 0, cycle: 1, membersSeen: 100, usersIndexed: 10, leaseMs: 5_000,
        });

        assert.strictEqual(movido, false, 'un worker sin lease movio el cursor');
        assert.strictEqual((await crawlRepo.leer(GRUPO)).cursor, null);
    });

    // ── 4. El 429 ───────────────────────────────────────────────────────────

    test('429: corta el ciclo y NO escribe ni una fila nueva', async () => {
        poblar({ miembros: 12 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });
        mundo.avatar429Desde = 1;     // el primer avatar ya devuelve 429

        const worker = nuevoWorker('w-429');
        const r = await worker.ciclo();

        assert.strictEqual(r.limitado, true, 'no detecto el limite');
        assert.strictEqual(r.escritos, 0, 'escribio pese al 429');
        assert.strictEqual(base.avatares.size, 0, 'el indice tiene filas que Roblox nunca confirmo');
        assert.ok(worker.metricas.rateLimitHits > 0, 'no consta el limite en las metricas');
        assert.strictEqual(worker.metricas.errors, 0, 'un 429 se conto como error');

        // La pertenencia SI se guarda: la pagina de miembros salio bien y es
        // otra ruta. Un limite del avatar no invalida lo que dijo la de grupos.
        assert.strictEqual(base.miembros.size, 12);
    });

    test('429: NO degrada, NO marca y NO borra lo que ya estaba indexado', async () => {
        poblar({ miembros: 12 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });

        // Primero se indexa con Roblox contestando.
        const worker = nuevoWorker('w-429-conserva');
        await worker.ciclo();
        assert.strictEqual(base.avatares.size, 10);
        const antes = JSON.parse(JSON.stringify([...base.avatares.values()]));

        // Ahora Roblox cierra la puerta y se vuelve a intentar, varias veces.
        limitador.reset();
        cache.reset();
        base.envejecerAvatar(1000, { avatarMs: 120_000 });   // ademas, vencido
        mundo.avatar429Desde = mundo.avatares + 1;
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });
        for (let i = 0; i < 3; i++) await worker.ciclo();

        const despues = [...base.avatares.values()];
        assert.strictEqual(despues.length, antes.length, 'el 429 cambio cuantas filas hay');
        for (const fila of despues) {
            const previa = antes.find(f => f.userId === fila.userId);
            assert.strictEqual(fila.state, previa.state, `el 429 cambio el estado de ${fila.userId}`);
            assert.strictEqual(fila.totalPrice, previa.totalPrice, `el 429 cambio el precio de ${fila.userId}`);
            assert.strictEqual(fila.accessories, previa.accessories);
            assert.strictEqual(fila.consecutiveErrors, 0, 'un 429 se anoto como error del usuario');
        }
    });

    test('con la ruta ya frenada, el ciclo ni empieza: cero llamadas', async () => {
        poblar({ miembros: 12 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });
        limitador.__buckets.userAvatar.cooldownUntil = Date.now() + 30_000;

        const worker = nuevoWorker('w-frenado');
        const r = await worker.ciclo();

        assert.strictEqual(r.hecho, false);
        assert.strictEqual(r.motivo, 'roblox_limitado');
        assert.strictEqual(mundo.paginas, 0, 'pidio una pagina con la ruta cerrada');
        assert.strictEqual(mundo.avatares, 0);
        assert.ok(worker.metricas.rateLimitedMs > 0, 'no anoto cuanto habia que esperar');
        limitador.reset();
    });

    // ── 5. TTL y prioridad ──────────────────────────────────────────────────

    test('TTL: vencer NO borra, solo adelanta esa fila en la cola de refresco', async () => {
        poblar({ miembros: 12 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });
        const worker = nuevoWorker('w-ttl');
        await worker.ciclo();
        assert.strictEqual(base.avatares.size, 10);

        // Dos filas envejecen por encima del TTL del avatar.
        base.envejecerAvatar(1000, { avatarMs: 120_000 });
        base.envejecerAvatar(1001, { avatarMs: 120_000 });

        const cola = await avatarRepo.pendientes(GRUPO, {
            limite: 5,
            ttlAvatarMs: config.indexWorker.avatarTtlMs,
            ttlPrecioMs: config.indexWorker.priceTtlMs,
            pricingVersion: 1,
        });

        // Siguen estando: vencer no las borro.
        assert.strictEqual(base.avatares.size, 10, 'el TTL borro filas');
        assert.ok(await avatarRepo.leer(1000), 'la fila vencida desaparecio');
        // Y los dos que faltan por indexar (1010, 1011) van ANTES que las
        // vencidas: no saber nada es mas urgente que saberlo viejo.
        assert.deepStrictEqual(cola.slice(0, 2).map(c => c.userId), ['1010', '1011']);
        assert.deepStrictEqual(cola.slice(2, 4).map(c => c.userId), ['1000', '1001']);
    });

    test('TTL: una fila vencida se refresca y conserva su identidad, no se duplica', async () => {
        poblar({ miembros: 10 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });
        const worker = nuevoWorker('w-refresco');
        await worker.ciclo();
        assert.strictEqual(base.avatares.size, 10);

        const antes = await avatarRepo.leer(1000);
        base.envejecerAvatar(1000, { avatarMs: 120_000 });
        cache.reset();
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 1 });
        await worker.ciclo();

        assert.strictEqual(base.avatares.size, 10, 'el refresco duplico la fila');
        const despues = await avatarRepo.leer(1000);
        assert.ok(despues.avatarFetchedAt > antes.avatarFetchedAt, 'no se refresco');
        assert.strictEqual(despues.userId, antes.userId);
        assert.strictEqual(despues.totalPrice, antes.totalPrice);
    });

    test('PRIORIDAD: el worker va al grupo con demanda, no al otro', async () => {
        poblar({ miembros: 250 });
        await crawlRepo.asegurar(OTRO_GRUPO);
        // El otro grupo existe pero no lo busca nadie... y ademas ya se recorrio.
        const fila = base.recorridos.get(String(OTRO_GRUPO));
        fila.lastRunAt = Date.now();
        fila.lastFullPassAt = Date.now();

        await crawlRepo.registrarDemanda(GRUPO, { faltan: 9 });

        const worker = nuevoWorker('w-prioridad');
        const r = await worker.ciclo();

        assert.strictEqual(r.groupId, String(GRUPO), 'no fue al grupo que se estaba buscando');
    });

    test('PRIORIDAD: sin demanda y ya recorrido, un grupo NO entra en la cola', async () => {
        poblar({ miembros: 250 });
        await crawlRepo.asegurar(GRUPO);
        const fila = base.recorridos.get(String(GRUPO));
        fila.lastRunAt = Date.now();
        fila.lastFullPassAt = Date.now();      // recorrido hace nada

        const worker = nuevoWorker('w-sin-demanda');
        const r = await worker.ciclo();

        assert.strictEqual(r.hecho, false);
        assert.strictEqual(r.motivo, 'sin_trabajo', 'se puso a recorrer un grupo que nadie pidio');
        assert.strictEqual(mundo.paginas, 0);
    });

    test('PRIORIDAD: la demanda se consume con el trabajo, no de golpe', async () => {
        poblar({ miembros: 250 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });
        assert.strictEqual((await crawlRepo.leer(GRUPO)).priority, 5);

        const worker = nuevoWorker('w-consumo');
        await worker.ciclo();

        const despues = await crawlRepo.leer(GRUPO);
        assert.strictEqual(despues.priority, 4, 'la prioridad se fue de golpe o no bajo');
        assert.ok(despues.priority > 0, 'un grupo muy pedido perdio su turno tras un solo ciclo');
    });

    // ── 6. Upserts y duplicados ─────────────────────────────────────────────

    test('UPSERTS: repetir el mismo tramo no duplica ni pierde nada', async () => {
        poblar({ miembros: 10 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });
        const worker = nuevoWorker('w-idempotente');
        await worker.ciclo();

        const primera = JSON.parse(JSON.stringify([...base.avatares.values()]));
        const miembrosAntes = base.miembros.size;

        // Se repite el MISMO trabajo, como haria un reintento tras un reinicio.
        for (let i = 0; i < 3; i++) {
            await memberRepo.registrarPagina(GRUPO, [...Array(10)].map((_, k) => ({ userId: 1000 + k, username: `U${1000 + k}` })));
            for (const fila of primera) {
                await avatarRepo.upsert({
                    userId: fila.userId, username: fila.username, state: fila.state,
                    assetIds: fila.assetIds, assetTypeIds: fila.assetTypeIds,
                    accessories: fila.accessories, playerAvatarType: fila.playerAvatarType,
                    valoracion: {
                        totalPrice: fila.totalPrice, priceComplete: fila.priceComplete,
                        pricedItems: fila.pricedItems, unpricedItems: fila.unpricedItems,
                        limitedItems: fila.limitedItems, offSaleItems: fila.offSaleItems,
                        bundledItems: fila.bundledItems,
                    },
                    pricingVersion: 1,
                });
            }
        }

        assert.strictEqual(base.avatares.size, primera.length, 'el upsert duplico filas');
        assert.strictEqual(base.miembros.size, miembrosAntes, 'la pertenencia se duplico');
        for (const fila of primera) {
            const ahora = await avatarRepo.leer(fila.userId);
            assert.strictEqual(ahora.state, fila.state);
            assert.strictEqual(ahora.totalPrice, fila.totalPrice);
            assert.strictEqual(ahora.accessories, fila.accessories);
        }
    });

    test('DUPLICADOS: un usuario en dos grupos ocupa UNA fila de indice y dos de pertenencia', async () => {
        poblar({ miembros: 10 });

        await memberRepo.registrarPagina(GRUPO, [{ userId: 1000, username: 'U1000' }]);
        await memberRepo.registrarPagina(OTRO_GRUPO, [{ userId: 1000, username: 'U1000' }]);
        await avatarRepo.upsert({
            userId: 1000, username: 'U1000', state: 'valid',
            assetIds: ['1'], assetTypeIds: [8], accessories: 1,
            valoracion: { totalPrice: 100, priceComplete: true, pricedItems: 1, unpricedItems: 0, limitedItems: 0, offSaleItems: 0, bundledItems: 0 },
        });

        assert.strictEqual(base.avatares.size, 1, 'el mismo usuario se indexo dos veces');
        assert.strictEqual(base.miembros.size, 2, 'la pertenencia deberia ser por grupo');
        assert.strictEqual((await memberRepo.contar(GRUPO)).miembros, 1);
        assert.strictEqual((await memberRepo.contar(OTRO_GRUPO)).miembros, 1);
    });

    test('un upsert SIN valoracion conserva el precio anterior en vez de borrarlo', async () => {
        poblar({ miembros: 5 });
        await avatarRepo.upsert({
            userId: 1000, state: 'valid', assetIds: ['1'], assetTypeIds: [8], accessories: 1,
            valoracion: { totalPrice: 777, priceComplete: true, pricedItems: 1, unpricedItems: 0, limitedItems: 0, offSaleItems: 0, bundledItems: 0 },
        });
        // Ahora el catalogo no se pudo resolver: se reescribe el avatar sin precio.
        await avatarRepo.upsert({
            userId: 1000, state: 'unpriceable', assetIds: ['1', '2'], assetTypeIds: [8, 41], accessories: 2,
        });

        const fila = await avatarRepo.leer(1000);
        assert.strictEqual(fila.state, 'unpriceable');
        assert.strictEqual(fila.assetIds.length, 2, 'no se actualizo el avatar');
        assert.strictEqual(fila.totalPrice, 777, 'se tiro un precio bueno por no tener uno nuevo');
    });

    // ── 7. Persistencia y estados ───────────────────────────────────────────

    test('PERSISTENCIA: usuarios borrados y avatares vacios se guardan como HECHOS', async () => {
        poblar({ miembros: 10 });
        mundo.borrados = new Set([1002]);
        mundo.vacios = new Set([1003]);
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });

        const worker = nuevoWorker('w-estados');
        await worker.ciclo();

        assert.strictEqual((await avatarRepo.leer(1002)).state, 'not_found');
        assert.strictEqual((await avatarRepo.leer(1003)).state, 'empty_avatar');
        assert.strictEqual((await avatarRepo.leer(1000)).state, 'valid');
        assert.strictEqual(worker.metricas.notFound, 1);
        assert.strictEqual(worker.metricas.emptyAvatar, 1);
    });

    test('un usuario borrado NO vuelve a la cola en cada ciclo: solo cuando vence su avatar', async () => {
        // El defecto que esto vigila: las filas que NO PUEDEN tener precio
        // (borrado, avatar vacio) tienen la fecha de valoracion a nulo, y la
        // cola las elegia SIEMPRE. El worker se pasaba la vida volviendo a
        // preguntar por los mismos usuarios que ya sabia que no existen: en una
        // comunidad de 450 se medían 549 respuestas 404 para 12 borrados.
        poblar({ miembros: 10 });
        mundo.borrados = new Set([1002, 1005]);
        mundo.vacios = new Set([1003]);
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });

        const worker = nuevoWorker('w-sin-bucle');
        await worker.ciclo();
        assert.strictEqual(base.avatares.size, 10, 'no se indexo la comunidad entera');

        // Nadie pendiente: los borrados y el vacio ya tienen su respuesta.
        const cola = await avatarRepo.pendientes(GRUPO, {
            limite: 10,
            ttlAvatarMs: config.indexWorker.avatarTtlMs,
            ttlPrecioMs: config.indexWorker.priceTtlMs,
            pricingVersion: 1,
        });
        assert.deepStrictEqual(cola.map(c => c.userId), [],
            `quedaron ${cola.length} usuarios en la cola sin nada que refrescar`);

        // Y un ciclo mas no gasta ni una llamada de avatar.
        const antes = mundo.avatares;
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });
        await worker.ciclo();
        assert.strictEqual(mundo.avatares, antes, 'volvio a preguntar por usuarios ya resueltos');

        // Cuando vence el reloj del AVATAR si vuelven: un borrado puede dejar
        // de estarlo y un avatar vacio puede vestirse.
        base.envejecerAvatar(1002, { avatarMs: config.indexWorker.avatarTtlMs + 1_000 });
        const conVencido = await avatarRepo.pendientes(GRUPO, {
            limite: 10,
            ttlAvatarMs: config.indexWorker.avatarTtlMs,
            ttlPrecioMs: config.indexWorker.priceTtlMs,
            pricingVersion: 1,
        });
        assert.deepStrictEqual(conVencido.map(c => c.userId), ['1002']);
    });

    test('PERSISTENCIA: todo el estado del recorrido sobrevive en la base, nada en memoria', async () => {
        poblar({ miembros: 250 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 7 });

        const worker = nuevoWorker('w-persistente');
        await worker.ciclo();
        await worker.ciclo();

        const fila = await crawlRepo.leer(GRUPO);
        assert.strictEqual(fila.cursor, 'p2');
        assert.ok(fila.membersSeen >= 200, `solo consta haber visto ${fila.membersSeen} miembros`);
        assert.ok(fila.usersIndexed >= 10);
        assert.strictEqual(fila.demands, 1);
        assert.strictEqual(fila.leaseOwner, null);
        assert.ok(fila.lastRunAt > 0);
    });

    // ── 8. Ceder el paso ────────────────────────────────────────────────────

    test('el worker CEDE el paso: con una busqueda viva no gasta ni una llamada', async () => {
        poblar({ miembros: 250 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });

        // Una busqueda tiene turno en un grupo: la cuota es suya.
        const soltar = await colaDeGrupos.tomarTurno(GRUPO);
        try {
            const worker = nuevoWorker('w-cede');
            const r = await worker.ciclo();

            assert.strictEqual(r.hecho, false);
            assert.strictEqual(r.motivo, 'cede_a_busqueda');
            assert.strictEqual(mundo.paginas, 0, 'le robo una llamada a una busqueda viva');
            assert.strictEqual(worker.metricas.yieldedToSearch, 1);
        } finally {
            soltar();
        }
    });

    // ── 9. El interruptor de la fase ────────────────────────────────────────

    test('apagado por configuracion, el worker no arranca', async () => {
        const previo = config.indexWorker.enabled;
        config.indexWorker.enabled = false;
        try {
            const worker = nuevoWorker('w-apagado');
            assert.strictEqual(worker.arrancar(), false, 'arranco estando desactivado');
        } finally {
            config.indexWorker.enabled = previo;
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
    Object.assign(config.indexWorker, original.cfg);
    config.cache.maxEntries = original.cache;
    cache.reset();
    limitador.reset();
    colaDeGrupos.reset();
    return ok;
};
