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
const catalogoRepo = require('../db/assetCatalogRepo');
const pool = require('../db/pool');
const { crearWorker } = require('../services/indexWorker/worker');
const { crearBaseFalsa } = require('./fakeDb');

// EL WORKER DEL INDICE: crawler, avatares y precios.
//
// Tres etapas separadas porque cuestan cosas distintas. El crawler pagina
// miembros, que es barato. Los avatares gastan una llamada por usuario, que es
// lo escaso. Los precios agrupan a MUCHOS usuarios en pocos lotes, que es donde
// esta el ahorro grande.
//
// Las reglas que estos casos vigilan, y por que cada una existe:
//
//   UN LIMITE NO ES UN DATO   Roblox frenandonos no dice nada del avatar de
//                             nadie. No degrada, no marca, no borra.
//   UN ERROR TEMPORAL TAMPOCO 'unpriceable' significa "Roblox contesto y no hay
//                             precio", jamas "no pudimos preguntar".
//   EL MINIMO SE APLICA AL    guardarlo como estado obligaria a reindexar la
//   CONSULTAR                 comunidad por cambiar una variable de entorno.
//   EL CATALOGO SOBREVIVE     un redeploy no puede costar miles de assets ya
//                             conocidos.

const GRUPO = 59218460;
const OTRO_GRUPO = 77000111;
const T = { Hat: 8, Hair: 41, Back: 46, Waist: 47, Shirt: 11, Torso: 27 };

module.exports = async function run() {
    const suite = createSuite('indexWorker');
    const { test, assert } = suite;

    const original = {
        listGroupMembers: roblox.listGroupMembers,
        getCurrentAvatar: roblox.getCurrentAvatar,
        getCurrentAvatarV2: roblox.getCurrentAvatarV2,
        getCatalogItemDetails: roblox.getCatalogItemDetails,
        getBundlesForAsset: roblox.getBundlesForAsset,
        rotationRepo: { ...rotationRepo },
        jobRepo: { ...jobRepo },
        avatarRepo: { ...avatarRepo },
        crawlRepo: { ...crawlRepo },
        memberRepo: { ...memberRepo },
        catalogoRepo: { ...catalogoRepo },
        // `instalar()` del doble parchea TAMBIEN el pool. Sin restaurarlo, los
        // archivos que corren despues creen que hay Postgres, la rotacion pasa
        // a modo lease y se quedan esperando un turno que nadie va a soltar.
        pool: { isConfigured: pool.isConfigured, withTransaction: pool.withTransaction },
        cfg: { ...config.indexWorker },
        minAccessories: config.pluginSearch.minAccessories,
        cache: config.cache.maxEntries,
    };

    config.indexWorker.avatarsPerCycle = 25;
    config.indexWorker.pricingBatchUsers = 60;
    config.indexWorker.crawlPagesPerCycle = 1;
    config.indexWorker.leaseMs = 5_000;
    config.indexWorker.avatarTtlMs = 60_000;
    config.indexWorker.priceTtlMs = 30_000;
    config.indexWorker.catalogTtlMs = 30_000;
    config.indexWorker.fullPassEveryMs = 3_600_000;
    config.indexWorker.pricingVersion = 1;
    config.pluginSearch.minAccessories = 3;
    config.cache.maxEntries = 20_000;

    // EL SUELO DE RITMO DE v2, ACORTADO AQUI. En produccion son 334 ms (3 por
    // segundo, el ritmo medido en Railway); en estos casos se prueba la LOGICA
    // del worker, y esperar un tercio de segundo por avatar convertiria el
    // archivo en varios minutos de sleep. El valor real se comprueba en
    // indexWorkerV2.test.js, que es donde toca.
    const sueloV2 = config.upstream.routeMinSpacingMs.userAvatarV2;
    config.upstream.routeMinSpacingMs.userAvatarV2 = 1;

    const base = crearBaseFalsa();
    base.instalar();

    // ── El mundo ────────────────────────────────────────────────────────────
    //
    // Los avatares COMPARTEN assets a proposito: es lo que hace que el catalogo
    // se reutilice, y sin eso el ahorro de la etapa de precios no se veria.
    const mundo = {
        miembros: 0, avatares: 0, lotes: 0, paginas: 0, assetsPedidos: [],
        avatar429Desde: null, catalogo429Desde: null, avatarErrorEn: new Set(),
        borrados: new Set(), vacios: new Set(), pocosAccesorios: new Set(),
    };

    // Cuatro assets por avatar, sacados de un repertorio pequeño: los gorros se
    // repiten entre usuarios igual que en una comunidad de verdad.
    const avatarCrudo = u => {
        const tipos = mundo.pocosAccesorios.has(u)
            ? [T.Shirt, T.Torso]                       // ninguno es accesorio
            : [T.Hat, T.Hair, T.Back, T.Waist];
        return {
            assets: tipos.map((tipo, i) => ({
                id: 100 + ((u + i * 7) % 20),          // 20 assets distintos en total
                name: `A${i}`,
                assetType: { id: tipo, name: `T${tipo}` },
            })),
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

    // EL WORKER LLAMA A v2. v1 esta en seis por hora en Railway y ya no se usa
    // desde aqui; el doble tiene que ser el de la ruta que de verdad se pide.
    roblox.getCurrentAvatarV2 = async userId => {
        const r = await limitador.run('userAvatarV2', async () => {
            mundo.avatares++;
            if (mundo.avatar429Desde !== null && mundo.avatares >= mundo.avatar429Desde) {
                throw axiosError(429, { 'retry-after': '30' });
            }
            if (mundo.avatarErrorEn.has(Number(userId))) throw axiosError(500);
            if (mundo.borrados.has(Number(userId))) throw axiosError(404);
            if (mundo.vacios.has(Number(userId))) {
                return { status: 200, headers: {}, data: { assets: [], playerAvatarType: 'R15' } };
            }
            return { status: 200, headers: {}, data: avatarCrudo(Number(userId)) };
        }, { endpoint: 'avatar.roblox.com/v2/avatar/users/{id}/avatar', notFoundCode: 'user_not_found' });
        return roblox.normalizeAvatarAssets(r.data);
    };

    roblox.getCatalogItemDetails = async items => {
        await limitador.run('catalogDetails', async () => {
            mundo.lotes++;
            if (mundo.catalogo429Desde !== null && mundo.lotes >= mundo.catalogo429Desde) {
                throw axiosError(429, { 'retry-after': '30' });
            }
            return { status: 200, headers: {}, data: {} };
        }, { endpoint: 'catalog.roblox.com/v1/catalog/items/details' });

        const mapa = new Map();
        for (const item of items) {
            mundo.assetsPedidos.push(String(item.id));
            mapa.set(roblox.catalogKey('Asset', item.id), {
                available: true, assetTypeId: 8, isLimited: false, offSale: false,
                price: 150, lowestPrice: null, lowestResalePrice: null,
            });
        }
        return mapa;
    };

    roblox.getBundlesForAsset = async () => [];

    function poblar({ miembros = 12 } = {}) {
        Object.assign(mundo, {
            miembros, avatares: 0, lotes: 0, paginas: 0, assetsPedidos: [],
            avatar429Desde: null, catalogo429Desde: null, avatarErrorEn: new Set(),
            borrados: new Set(), vacios: new Set(), pocosAccesorios: new Set(),
        });
        cache.reset();
        limitador.reset();
        colaDeGrupos.reset();
        base.limpiar();
    }

    const nuevoWorker = nombre => crearWorker({ instancia: nombre });
    const ciclos = async (worker, veces, grupo = GRUPO) => {
        for (let i = 0; i < veces; i++) {
            await crawlRepo.registrarDemanda(grupo, { faltan: 5 });
            await worker.ciclo();
        }
    };

    // ── 1. Las tres etapas ──────────────────────────────────────────────────

    test('un ciclo descubre miembros, indexa avatares y valora precios', async () => {
        poblar({ miembros: 12 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });

        const worker = nuevoWorker('w-uno');
        const r = await worker.ciclo();

        assert.strictEqual(r.hecho, true, `no hizo nada: ${r.motivo}`);
        assert.strictEqual(r.miembrosVistos, 12, 'el crawler no descubrio la pagina entera');
        assert.strictEqual(base.miembros.size, 12);
        assert.strictEqual(r.avataresEscritos, 12);
        assert.ok(r.usuariosValorados > 0, 'no se valoro a nadie');

        const uno = await avatarRepo.leer(1000);
        assert.strictEqual(uno.state, 'valid');
        assert.strictEqual(uno.accessories, 4);
        assert.ok(uno.totalPrice > 0);
        assert.ok(uno.pricedAt > 0);

        // Ni un estado que codifique el veredicto de accesorios.
        for (const fila of base.avatares.values()) {
            assert.notStrictEqual(fila.state, 'too_few_accessories');
        }
    });

    test('las llamadas de CATALOGO son una fraccion de las de AVATAR', async () => {
        poblar({ miembros: 100 });
        const worker = nuevoWorker('w-ahorro');
        await ciclos(worker, 6);

        const m = worker.metricas;
        assert.ok(m.avatarsRequested >= 100, `solo ${m.avatarsRequested} avatares`);
        assert.ok(m.catalogBatches > 0, 'no se despacho ni un lote');
        assert.ok(m.catalogBatches < m.avatarsRequested / 10,
            `${m.catalogBatches} lotes para ${m.avatarsRequested} avatares: no se agrupa`);
        assert.ok(m.catalogAssetsUnique < m.catalogAssetsSeen / 3,
            `${m.catalogAssetsUnique} unicos de ${m.catalogAssetsSeen} vistos: no se deduplica`);
        assert.ok(m.usersPriced >= 100);
    });

    // ── 2. El minimo de accesorios ──────────────────────────────────────────

    test('quien no llega al minimo: se guarda su avatar, NO se le gasta catalogo', async () => {
        poblar({ miembros: 20 });
        for (let i = 0; i < 20; i += 2) mundo.pocosAccesorios.add(1000 + i);

        const worker = nuevoWorker('w-minimo');
        await ciclos(worker, 3);

        const bajo = await avatarRepo.leer(1000);
        assert.ok(bajo, 'no se guardo el avatar del que tiene pocos accesorios');
        assert.strictEqual(bajo.accessories, 0, 'camisa y torso no son accesorios');
        assert.ok(bajo.assetIds.length > 0, 'no se guardaron sus assets');
        assert.ok(bajo.avatarFetchedAt > 0, 'no se guardo la fecha');
        assert.strictEqual(bajo.state, 'avatar_only', 'no puede quedar como servible');
        assert.strictEqual(bajo.pricedAt, null, 'se le gasto catalogo pese a no llegar al minimo');
        assert.ok(worker.metricas.belowMinAccessories > 0, 'no consta en las metricas');

        // Y el de al lado, que si llega, esta valorado.
        const alto = await avatarRepo.leer(1001);
        assert.strictEqual(alto.state, 'valid');
        assert.ok(alto.totalPrice > 0);
    });

    // ── 3. Cursor, reinicio y bajas ─────────────────────────────────────────

    test('CURSOR: el segundo ciclo continua en la pagina siguiente', async () => {
        poblar({ miembros: 250 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });
        const worker = nuevoWorker('w-cursor');

        const uno = await worker.ciclo();
        assert.strictEqual(uno.cursorAntes, null);
        assert.strictEqual(uno.cursorDespues, 'p1');

        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });
        const dos = await worker.ciclo();
        assert.strictEqual(dos.cursorAntes, 'p1');
        assert.strictEqual(dos.cursorDespues, 'p2');
    });

    test('REINICIO: un worker nuevo continua desde el cursor persistido', async () => {
        poblar({ miembros: 250 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });

        const antes = nuevoWorker('w-antes');
        await antes.ciclo();
        const guardado = await crawlRepo.leer(GRUPO);
        assert.strictEqual(guardado.cursor, 'p1');
        assert.strictEqual(guardado.leaseOwner, null, 'el lease quedo cogido');

        const despues = nuevoWorker('w-despues');
        assert.strictEqual(despues.metricas.cycles, 0);
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });
        const r = await despues.ciclo();
        assert.strictEqual(r.cursorAntes, 'p1', 'el worker nuevo volvio a empezar');
    });

    test('BAJAS: quien deja el grupo se marca al cerrar una vuelta, nunca a mitad', async () => {
        poblar({ miembros: 250 });
        const worker = nuevoWorker('w-bajas');

        await ciclos(worker, 3);      // vuelta completa: tres paginas
        assert.strictEqual(base.miembros.size, 250);
        for (const fila of base.miembros.values()) assert.strictEqual(fila.leftAt, null);

        // Una vuelta real tarda segundos; aqui entera son milisegundos, y la
        // marca de agua de la vuelta nueva podria caer en el MISMO milisegundo
        // que la ultima vez que se vio a alguien. Se separa a mano para que la
        // prueba mida la logica y no la resolucion del reloj.
        await new Promise(r => setTimeout(r, 10));

        // Quien esta indexado ANTES de que nadie se vaya. Con 25 avatares por
        // ciclo no da tiempo a mirar a los 250, asi que se comprueba sobre los
        // que de verdad tienen fila.
        const indexadosAntes = [...base.avatares.keys()];
        assert.ok(indexadosAntes.length > 0);

        // Cincuenta se van. A mitad de la vuelta siguiente NO puede haber
        // bajas: "no le he visto" ahi solo significa "aun no le toca".
        mundo.miembros = 200;
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });
        await worker.ciclo();
        const aMitad = [...base.miembros.values()].filter(f => f.leftAt !== null).length;
        assert.strictEqual(aMitad, 0, 'se marcaron bajas a mitad de recorrido');

        await ciclos(worker, 3);
        const bajas = [...base.miembros.values()].filter(f => f.leftAt !== null);
        assert.strictEqual(bajas.length, 50, `se marcaron ${bajas.length} bajas de 50`);
        for (const fila of bajas) assert.ok(Number(fila.userId) >= 1200);
        assert.strictEqual(worker.metricas.leavers, 50);

        // Y NO se borro NADA del indice: marcar una baja no tira el trabajo de
        // haber resuelto su avatar, que sigue siendo valido si vuelve.
        for (const id of indexadosAntes) {
            assert.ok(base.avatares.has(id), `se borro el indice de ${id} al marcar bajas`);
        }
        // La fila de pertenencia tambien sigue: marcada, no borrada.
        const unaBaja = bajas[0];
        assert.ok(base.miembros.has(`${GRUPO}|${unaBaja.userId}`), 'se borro la fila de pertenencia');
    });

    // ── 4. Lease y dos workers ──────────────────────────────────────────────

    test('LEASE: dos workers no recorren el mismo grupo a la vez', async () => {
        poblar({ miembros: 250 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });
        base.otroWorkerToma(GRUPO, 'w-remoto', { duracionMs: 60_000 });

        const mio = nuevoWorker('w-mio');
        const r = await mio.ciclo();

        assert.strictEqual(r.hecho, false);
        assert.strictEqual(r.motivo, 'sin_trabajo');
        assert.strictEqual(mundo.paginas, 0, 'gasto una llamada en un grupo ajeno');
    });

    test('DOS WORKERS: cada uno coge un grupo distinto', async () => {
        poblar({ miembros: 250 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });
        await crawlRepo.registrarDemanda(OTRO_GRUPO, { faltan: 5 });

        const uno = await crawlRepo.tomar('w-a', { leaseMs: 5_000 });
        const dos = await crawlRepo.tomar('w-b', { leaseMs: 5_000 });
        assert.ok(uno && dos, 'alguno se quedo sin grupo');
        assert.notStrictEqual(uno.groupId, dos.groupId);
        assert.strictEqual(await crawlRepo.tomar('w-c', { leaseMs: 5_000 }), null,
            'un tercero entro en un grupo con dueño');
        await crawlRepo.soltar(uno.groupId, 'w-a');
        await crawlRepo.soltar(dos.groupId, 'w-b');
    });

    test('LEASE PERDIDO: sin el lease no se escribe el cursor', async () => {
        poblar({ miembros: 250 });
        await crawlRepo.asegurar(GRUPO);
        base.otroWorkerToma(GRUPO, 'w-legitimo', { duracionMs: 60_000 });

        const movido = await crawlRepo.guardarCursor(GRUPO, 'w-intruso', {
            cursor: 'p9', intraPageOffset: 0, cycle: 1, membersSeen: 100, usersIndexed: 10, leaseMs: 5_000,
        });
        assert.strictEqual(movido, false);
        assert.strictEqual((await crawlRepo.leer(GRUPO)).cursor, null);
    });

    // ── 5. Limites y errores ────────────────────────────────────────────────

    test('429 del avatar: corta, NO escribe y NO toca la fila del que procesaba', async () => {
        poblar({ miembros: 20 });
        const worker = nuevoWorker('w-429');
        await ciclos(worker, 2);
        const antes = JSON.parse(JSON.stringify([...base.avatares.values()]));
        assert.ok(antes.length > 0);

        // Todo da 429, y el primero esta vencido para que le toque a el.
        limitador.reset(); cache.reset();
        base.envejecerAvatar(antes[0].userId, { avatarMs: 120_000 });
        mundo.avatar429Desde = mundo.avatares + 1;
        await ciclos(worker, 3);

        assert.strictEqual(base.avatares.size, antes.length, 'el 429 cambio cuantas filas hay');
        for (const previa of antes) {
            const ahora = base.avatares.get(previa.userId);
            assert.strictEqual(ahora.state, previa.state, `cambio el estado de ${previa.userId}`);
            assert.strictEqual(ahora.totalPrice, previa.totalPrice, `cambio el precio de ${previa.userId}`);
            assert.strictEqual(ahora.accessories, previa.accessories);
            assert.strictEqual(ahora.consecutiveErrors, 0, 'un 429 se anoto como error del usuario');
        }
        assert.ok(worker.metricas.cooldowns > 0);
    });

    test('429 del CATALOGO: nadie queda como unpriceable', async () => {
        poblar({ miembros: 30 });
        const worker = nuevoWorker('w-cat429');
        await ciclos(worker, 2);

        // Se fuerza trabajo de precio nuevo y que el catalogo falle.
        for (const fila of base.avatares.values()) { fila.pricedAt = null; fila.state = 'avatar_only'; }
        base.catalogo.clear();
        limitador.reset();
        mundo.catalogo429Desde = mundo.lotes + 1;
        await ciclos(worker, 2);

        const marcados = [...base.avatares.values()].filter(f => f.state === 'unpriceable');
        assert.deepStrictEqual(marcados, [],
            `${marcados.length} usuarios quedaron como unpriceable por un 429 del catalogo`);
    });

    test('un ERROR TEMPORAL del avatar no se convierte en un veredicto permanente', async () => {
        poblar({ miembros: 10 });
        mundo.avatarErrorEn = new Set([1003]);

        const worker = nuevoWorker('w-temporal');
        await ciclos(worker, 2);

        assert.strictEqual(await avatarRepo.leer(1003), null,
            'un error temporal escribio una fila');
        assert.ok(worker.metricas.errors > 0);

        // Cuando Roblox se recupera, entra como cualquiera.
        mundo.avatarErrorEn = new Set();
        cache.reset();
        await ciclos(worker, 2);
        const recuperado = await avatarRepo.leer(1003);
        assert.ok(recuperado, 'no se reintento al usuario que habia fallado');
        assert.strictEqual(recuperado.state, 'valid');
    });

    test('con la ruta del avatar frenada no sale ni una peticion de avatar', async () => {
        poblar({ miembros: 12 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });
        limitador.__buckets.userAvatarV2.cooldownUntil = Date.now() + 30_000;

        const worker = nuevoWorker('w-frenado');
        const antes = mundo.avatares;
        await worker.ciclo();

        assert.strictEqual(mundo.avatares, antes, 'salieron avatares con la ruta cerrada');
        assert.ok(worker.metricas.cooldowns > 0);
        limitador.reset();
    });

    // ── 6. Ceder el paso ────────────────────────────────────────────────────

    test('una busqueda APARCADA ya no bloquea al worker: la cuota esta libre', async () => {
        // El fallo que esto corrige: bastaba con que existiera una busqueda
        // viva para parar el worker entero, incluso si esa busqueda estaba
        // esperando un cooldown y no gastaba ni una peticion.
        poblar({ miembros: 20 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 5 });

        const soltar = await colaDeGrupos.tomarTurno(GRUPO);   // turno, nada en vuelo
        try {
            const worker = nuevoWorker('w-no-bloqueado');
            const r = await worker.ciclo();
            assert.strictEqual(r.hecho, true, 'el worker se paro por una busqueda que no gasta cuota');
            assert.ok(r.avataresEscritos > 0, 'no indexo a nadie teniendo la cuota libre');
        } finally {
            soltar();
        }
    });

    // ── 7. Catalogo persistente ─────────────────────────────────────────────

    test('CATALOGO PERSISTENTE: un reinicio NO vuelve a pedir assets ya conocidos', async () => {
        poblar({ miembros: 60 });
        const worker = nuevoWorker('w-catalogo');
        await ciclos(worker, 4);

        assert.ok(base.catalogo.size > 0, 'no se persistio ninguna ficha');
        assert.ok(mundo.assetsPedidos.length > 0);

        // REINICIO: se pierde la cache de memoria y el worker. La tabla no.
        cache.reset();
        limitador.reset();
        mundo.assetsPedidos = [];
        for (const fila of base.avatares.values()) { fila.pricedAt = null; fila.state = 'avatar_only'; }

        const nuevo = nuevoWorker('w-tras-reinicio');
        await ciclos(nuevo, 4);

        assert.strictEqual(mundo.assetsPedidos.length, 0,
            `se volvieron a pedir ${mundo.assetsPedidos.length} assets que ya estaban en Postgres`);
        assert.ok(nuevo.metricas.catalogCacheHitsPostgres > 0, 'no consta ni un acierto de catalogo');
        assert.ok(nuevo.metricas.usersPriced > 0, 'no se valoro a nadie con las fichas guardadas');
        assert.strictEqual(nuevo.metricas.catalogAssetsRequested, 0);
    });

    test('un 429 del catalogo no borra ni una ficha guardada', async () => {
        poblar({ miembros: 40 });
        const worker = nuevoWorker('w-fichas');
        await ciclos(worker, 3);
        const antes = new Map([...base.catalogo.entries()].map(([k, v]) => [k, v.price]));
        assert.ok(antes.size > 0);

        limitador.reset();
        mundo.catalogo429Desde = mundo.lotes + 1;
        for (const fila of base.avatares.values()) { fila.pricedAt = null; fila.state = 'avatar_only'; }
        await ciclos(worker, 2);

        assert.strictEqual(base.catalogo.size, antes.size, 'el 429 cambio cuantas fichas hay');
        for (const [id, precio] of antes) {
            assert.strictEqual(base.catalogo.get(id).price, precio, `cambio el precio de la ficha ${id}`);
        }
    });

    // ── 8. TTL, prioridad y duplicados ──────────────────────────────────────

    test('TTL: vencer NO borra, solo adelanta en la cola', async () => {
        poblar({ miembros: 12 });
        const worker = nuevoWorker('w-ttl');
        await ciclos(worker, 2);
        assert.strictEqual(base.avatares.size, 12);

        base.envejecerAvatar(1000, { avatarMs: 120_000 });
        base.envejecerAvatar(1001, { avatarMs: 120_000 });

        const cola = await avatarRepo.pendientesDeAvatar(GRUPO, {
            limite: 5, ttlAvatarMs: config.indexWorker.avatarTtlMs,
        });

        assert.strictEqual(base.avatares.size, 12, 'el TTL borro filas');
        assert.ok(await avatarRepo.leer(1000), 'la fila vencida desaparecio');
        assert.deepStrictEqual(cola.map(c => c.userId), ['1000', '1001']);
    });

    test('PRIORIDAD: cobertura primero, y la demanda manda entre grupos', async () => {
        poblar({ miembros: 20 });
        const worker = nuevoWorker('w-prioridad');
        await ciclos(worker, 2);

        // Uno vencido y uno sin indexar: va primero el que no se ha mirado nunca.
        base.envejecerAvatar(1000, { avatarMs: 120_000 });
        base.avatares.delete('1005');

        const cola = await avatarRepo.pendientesDeAvatar(GRUPO, {
            limite: 5, ttlAvatarMs: config.indexWorker.avatarTtlMs,
        });
        assert.strictEqual(cola[0].userId, '1005', 'no se prioriza ampliar cobertura');
        assert.strictEqual(cola[0].nuevo, true);

        // Entre grupos manda la demanda.
        await crawlRepo.asegurar(OTRO_GRUPO);
        const otro = base.recorridos.get(String(OTRO_GRUPO));
        otro.lastRunAt = Date.now(); otro.lastFullPassAt = Date.now();
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 9 });
        const r = await worker.ciclo();
        assert.strictEqual(r.groupId, String(GRUPO));
    });

    test('DUPLICADOS: un usuario en dos grupos ocupa UNA fila de indice', async () => {
        poblar({ miembros: 10 });
        await memberRepo.registrarPagina(GRUPO, [{ userId: 5000, username: 'X' }]);
        await memberRepo.registrarPagina(OTRO_GRUPO, [{ userId: 5000, username: 'X' }]);
        await avatarRepo.upsertAvatar({
            userId: 5000, state: avatarRepo.ESTADO.SOLO_AVATAR,
            assetIds: ['1'], assetTypeIds: [8], accessories: 1,
        });
        await avatarRepo.upsertAvatar({
            userId: 5000, state: avatarRepo.ESTADO.SOLO_AVATAR,
            assetIds: ['1'], assetTypeIds: [8], accessories: 1,
        });

        assert.strictEqual([...base.avatares.keys()].filter(k => k === '5000').length, 1);
        assert.strictEqual((await memberRepo.contar(GRUPO)).miembros, 1);
        assert.strictEqual((await memberRepo.contar(OTRO_GRUPO)).miembros, 1);
    });

    test('una valoracion nula cambia el estado pero NO borra un precio bueno', async () => {
        poblar({ miembros: 5 });
        await avatarRepo.upsertAvatar({
            userId: 7001, state: avatarRepo.ESTADO.SOLO_AVATAR,
            assetIds: ['1'], assetTypeIds: [8], accessories: 4,
        });
        await avatarRepo.upsertValoraciones([{
            userId: 7001, state: avatarRepo.ESTADO.VALIDO,
            valoracion: { totalPrice: 4242, priceComplete: true, pricedItems: 1, unpricedItems: 0, limitedItems: 0, offSaleItems: 0, bundledItems: 0 },
        }]);
        await avatarRepo.upsertValoraciones([{
            userId: 7001, state: avatarRepo.ESTADO.SIN_PRECIO, valoracion: null,
        }]);

        const fila = await avatarRepo.leer(7001);
        assert.strictEqual(fila.state, 'unpriceable');
        assert.strictEqual(fila.totalPrice, 4242, 'se tiro un precio bueno');
    });

    test('un upsert de avatar NO pisa la valoracion ya guardada', async () => {
        poblar({ miembros: 5 });
        await avatarRepo.upsertAvatar({
            userId: 7002, state: avatarRepo.ESTADO.SOLO_AVATAR,
            assetIds: ['1'], assetTypeIds: [8], accessories: 4,
        });
        await avatarRepo.upsertValoraciones([{
            userId: 7002, state: avatarRepo.ESTADO.VALIDO,
            valoracion: { totalPrice: 999, priceComplete: true, pricedItems: 1, unpricedItems: 0, limitedItems: 0, offSaleItems: 0, bundledItems: 0 },
        }]);

        // Se cambia de ropa: se reescribe el avatar.
        await avatarRepo.upsertAvatar({
            userId: 7002, state: avatarRepo.ESTADO.SOLO_AVATAR,
            assetIds: ['1', '2'], assetTypeIds: [8, 41], accessories: 5,
        });

        const fila = await avatarRepo.leer(7002);
        assert.strictEqual(fila.assetIds.length, 2, 'no se actualizo el avatar');
        assert.strictEqual(fila.totalPrice, 999, 'escribir el avatar tiro el precio');
    });

    test('apagado por configuracion, el worker no arranca', async () => {
        const previo = config.indexWorker.enabled;
        config.indexWorker.enabled = false;
        try {
            assert.strictEqual(nuevoWorker('w-apagado').arrancar(), false);
        } finally {
            config.indexWorker.enabled = previo;
        }
    });

    const ok = await suite.run();

    roblox.listGroupMembers = original.listGroupMembers;
    roblox.getCurrentAvatar = original.getCurrentAvatar;
    roblox.getCurrentAvatarV2 = original.getCurrentAvatarV2;
    roblox.getCatalogItemDetails = original.getCatalogItemDetails;
    roblox.getBundlesForAsset = original.getBundlesForAsset;
    Object.assign(rotationRepo, original.rotationRepo);
    Object.assign(jobRepo, original.jobRepo);
    Object.assign(avatarRepo, original.avatarRepo);
    Object.assign(crawlRepo, original.crawlRepo);
    Object.assign(memberRepo, original.memberRepo);
    Object.assign(catalogoRepo, original.catalogoRepo);
    pool.isConfigured = original.pool.isConfigured;
    pool.withTransaction = original.pool.withTransaction;
    Object.assign(config.indexWorker, original.cfg);
    config.pluginSearch.minAccessories = original.minAccessories;
    config.cache.maxEntries = original.cache;
    config.upstream.routeMinSpacingMs.userAvatarV2 = sueloV2;
    cache.reset();
    limitador.reset();
    colaDeGrupos.reset();
    return ok;
};
