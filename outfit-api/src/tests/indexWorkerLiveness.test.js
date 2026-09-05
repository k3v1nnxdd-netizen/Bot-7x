'use strict';

const http = require('http');
const { createSuite, axiosError, networkError, timeoutError } = require('./harness');
const { createApp } = require('../app');
const config = require('../config');
const roblox = require('../roblox/client');
const cache = require('../cache/cacheStore');
const limitador = require('../roblox/rateLimiter');
const ownRateLimit = require('../security/rateLimit');
const colaDeGrupos = require('../services/pluginSearch/groupQueue');
const rotationRepo = require('../db/pluginRotationRepo');
const jobRepo = require('../db/pluginJobRepo');
const avatarRepo = require('../db/avatarIndexRepo');
const crawlRepo = require('../db/indexCrawlRepo');
const memberRepo = require('../db/groupMemberRepo');
const catalogoRepo = require('../db/assetCatalogRepo');
const pool = require('../db/pool');
const jobs = require('../services/pluginSearch/jobs');
const { crearWorker, ETAPA } = require('../services/indexWorker/worker');
const { crearBaseFalsa } = require('./fakeDb');

// LIVENESS DEL WORKER.
//
// El fallo que esto vigila, visto en produccion: el indice se quedo clavado en
// treinta usuarios durante quince minutos. Sin excepcion, sin error y con el
// proceso vivo — el worker simplemente no tenia trabajo elegible, porque un
// grupo A MEDIO INDEXAR y sin demanda dejaba de mirarse hasta la siguiente
// vuelta completa, siete dias despues.
//
// Lo que se prueba aqui:
//
//   NADA LO DUERME       ni un 429 de una hora, ni un timeout, ni el breaker,
//                        ni un fallo de red, ni una excepcion de un usuario o
//                        de un lote de catalogo.
//   ETAPAS INDEPENDIENTES el crawler sigue descubriendo miembros con el avatar
//                        frenado; los precios avanzan aunque el avatar espere.
//   UN USUARIO NO TUMBA  su excepcion se anota y el ciclo sigue con el siguiente.
//   VUELVE SOLO          cuando el cooldown termina, sin que nadie lo toque.

const GRUPO = 59218460;
const T = { Hat: 8, Hair: 41, Back: 46, Waist: 47 };

module.exports = async function run() {
    const suite = createSuite('indexWorkerLiveness');
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
        pool: { isConfigured: pool.isConfigured, withTransaction: pool.withTransaction },
        cfg: { ...config.indexWorker },
        serveEnabled: config.indexServe.enabled,
        minAccessories: config.pluginSearch.minAccessories,
        cache: config.cache.maxEntries,
    };

    config.indexWorker.crawlPagesPerCycle = 1;
    config.indexWorker.avatarsPerCycle = 10;
    config.indexWorker.pricingBatchUsers = 40;
    config.indexWorker.leaseMs = 5_000;
    config.indexWorker.avatarTtlMs = 600_000;
    config.indexWorker.priceTtlMs = 300_000;
    config.indexWorker.catalogTtlMs = 300_000;
    config.indexWorker.fullPassEveryMs = 3_600_000;
    // Revisita inmediata: en produccion son 30 s; aqui interesa el mecanismo,
    // no la espera.
    config.indexWorker.revisitEveryMs = 0;
    config.indexWorker.stallCycles = 2;
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

    const app = createApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;

    const mundo = {
        miembros: 0, avatares: 0, paginas: 0,
        avatarFalla: null,          // (userId, n) -> Error | null
        catalogoFalla: null,
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
            const fallo = mundo.avatarFalla?.(Number(userId), mundo.avatares);
            if (fallo) throw fallo;
            const a = (k, tipo) => ({ id: 100 + k, name: `A${k}`, assetType: { id: tipo, name: `T${tipo}` } });
            return {
                status: 200, headers: {},
                data: { assets: [a(0, T.Hat), a(1, T.Hair), a(2, T.Back), a(3, T.Waist)], playerAvatarType: 'R15' },
            };
        }, { endpoint: 'avatar.roblox.com/v2/avatar/users/{id}/avatar', notFoundCode: 'user_not_found' });
        return roblox.normalizeAvatarAssets(r.data);
    };

    roblox.getCatalogItemDetails = async items => {
        await limitador.run('catalogDetails', async () => {
            const fallo = mundo.catalogoFalla?.();
            if (fallo) throw fallo;
            return { status: 200, headers: {}, data: {} };
        }, { endpoint: 'catalog.roblox.com/v1/catalog/items/details' });
        const mapa = new Map();
        for (const item of items) {
            mapa.set(roblox.catalogKey('Asset', item.id), {
                available: true, assetTypeId: 8, isLimited: false, offSale: false, price: 200,
            });
        }
        return mapa;
    };

    roblox.getBundlesForAsset = async () => [];

    function poblar({ miembros = 300 } = {}) {
        Object.assign(mundo, { miembros, avatares: 0, paginas: 0, avatarFalla: null, catalogoFalla: null });
        cache.reset();
        limitador.reset();
        colaDeGrupos.reset();
        jobs.reset();
        base.limpiar();
    }

    // Congela la ruta del avatar durante una hora, como haria Roblox.
    const congelarAvatar = (ms = 60 * 60_000) => {
        limitador.__buckets.userAvatarV2.cooldownUntil = Date.now() + ms;
    };
    const descongelar = () => { limitador.__buckets.userAvatarV2.cooldownUntil = 0; };

    const nuevoWorker = nombre => crearWorker({ instancia: nombre });

    function pedir(cuerpo) {
        ownRateLimit.reset();
        const payload = JSON.stringify(cuerpo);
        return new Promise((res, rej) => {
            const q = http.request({
                host: '127.0.0.1', port, path: '/plugin/outfits/search', method: 'POST',
                headers: {
                    'x-plugin-key': config.pluginApiKey, 'content-type': 'application/json',
                    'content-length': Buffer.byteLength(payload),
                },
            }, r => { let d = ''; r.on('data', c => { d += c; }); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(d) })); });
            q.on('error', rej); q.write(payload); q.end();
        });
    }

    // ── 1. EL FALLO ORIGINAL: seguir avanzando sin demanda ──────────────────

    test('un grupo a medio indexar SIGUE avanzando aunque nadie lo pida', async () => {
        // Es el fallo de produccion en una linea: la demanda se consume y el
        // grupo, con cientos de usuarios sin mirar, dejaba de elegirse.
        poblar({ miembros: 300 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 1 });

        const worker = nuevoWorker('w-sin-demanda');
        await worker.ciclo();
        const trasElPrimero = base.avatares.size;
        assert.ok(trasElPrimero > 0);

        // La demanda ya esta consumida: sin revisita, aqui se acababa todo.
        assert.strictEqual((await crawlRepo.leer(GRUPO)).priority, 0);

        for (let i = 0; i < 5; i++) await worker.ciclo();

        assert.ok(base.avatares.size > trasElPrimero,
            `el indice se quedo clavado en ${trasElPrimero} usuarios sin demanda`);
        assert.ok(worker.metricas.cycles >= 3,
            `solo se ejecutaron ${worker.metricas.cycles} ciclos con trabajo pendiente`);
    });

    // ── 1b. EL DENOMINADOR: miembros conocidos ──────────────────────────────

    test('VARIAS VUELTAS: el denominador NO se duplica por revisitar paginas', async () => {
        // El fallo que esto vigila: en produccion el "de Y miembros conocidos"
        // salto de 23.500 a 3.340 y luego a 85.200 para la MISMA comunidad. Un
        // denominador de usuarios distintos no puede hacer eso.
        poblar({ miembros: 250 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });
        const worker = nuevoWorker('w-denominador');

        const denominadores = [];
        const numeradores = [];

        // Cinco vueltas enteras a una comunidad de 250 (tres paginas cada una).
        for (let i = 0; i < 18; i++) {
            await worker.ciclo();
            const foto = await avatarRepo.cobertura(GRUPO, {
                ttlAvatarMs: config.indexWorker.avatarTtlMs,
                ttlPrecioMs: config.indexWorker.priceTtlMs,
                minAccessories: config.pluginSearch.minAccessories,
            });
            denominadores.push(foto.members);
            numeradores.push(foto.indexed);
        }

        // El crawler dio varias vueltas: lo confirma el contador acumulado.
        assert.ok(worker.metricas.memberRowsSeen > 250,
            `el crawler no llego a repasar paginas: ${worker.metricas.memberRowsSeen} filas vistas`);

        // EL DENOMINADOR: nunca pasa de los miembros que existen, por muchas
        // vueltas que se den. Sin COUNT DISTINCT esto se dispararia.
        const maximo = Math.max(...denominadores);
        assert.strictEqual(maximo, 250,
            `el denominador llego a ${maximo} en una comunidad de 250`);

        // Y nunca RETROCEDE: nadie se ha ido del grupo.
        for (let i = 1; i < denominadores.length; i++) {
            assert.ok(denominadores[i] >= denominadores[i - 1],
                `el denominador bajo de ${denominadores[i - 1]} a ${denominadores[i]}`);
        }

        // El numerador SI sube: es lo que se esta indexando.
        assert.ok(numeradores[numeradores.length - 1] > numeradores[0],
            'el numerador no avanzo en varias vueltas');
        assert.ok(numeradores[numeradores.length - 1] <= maximo,
            'se indexaron mas usuarios de los que hay');
    });

    test('vuelta al 95% pero INTERRUMPIDA: cero bajas', async () => {
        // Lo que esto vigila: un porcentaje alto NO es evidencia. Una vuelta que
        // vio el 95% de la comunidad y se corto por un error sigue teniendo un
        // 5% sin mirar, y marcar ahi convierte usuarios ACTIVOS en bajas.
        poblar({ miembros: 400 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });
        const worker = nuevoWorker('w-95-interrumpida');

        for (let i = 0; i < 5; i++) await worker.ciclo();      // vuelta limpia
        assert.strictEqual((await memberRepo.contar(GRUPO)).miembros, 400);

        await new Promise(r => setTimeout(r, 10));

        // Vuelta nueva: tres paginas buenas (300 de 400 = 75%), la cuarta falla
        // y la quinta cierra la paginacion. Se habra visto el 95% y aun asi la
        // vuelta esta interrumpida.
        const bueno = roblox.listGroupMembers;
        let n = 0;
        roblox.listGroupMembers = async (g, { cursor = null } = {}) => {
            n++;
            if (n === 4) throw networkError();                 // LA INTERRUPCION
            const pagina = cursor ? Number(String(cursor).slice(1)) : 0;
            const desde = pagina * 100;
            const hasta = Math.min(desde + 100, 380);          // 380 de 400: 95%
            const members = [];
            for (let i = desde; i < hasta; i++) members.push({ userId: 1000 + i, username: `U${1000 + i}` });
            return { members, nextCursor: hasta < 380 ? `p${pagina + 1}` : null };
        };

        try {
            for (let i = 0; i < 8; i++) await worker.ciclo();
        } finally {
            roblox.listGroupMembers = bueno;
        }

        const tras = await memberRepo.contar(GRUPO);
        assert.strictEqual(tras.bajas, 0,
            `una vuelta interrumpida al 95% marco ${tras.bajas} bajas`);
        assert.strictEqual(tras.miembros, 400, 'se perdieron miembros activos');
    });

    test('vuelta al 100% con final normal: las bajas reales SI se marcan', async () => {
        poblar({ miembros: 300 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });
        const worker = nuevoWorker('w-100-limpia');

        for (let i = 0; i < 4; i++) await worker.ciclo();
        assert.strictEqual((await memberRepo.contar(GRUPO)).miembros, 300);

        // Se van treinta de verdad. Dos vueltas limpias enteras: aqui una vuelta
        // dura milisegundos y la marca de agua puede caer en el mismo que la
        // ultima pagina; en produccion una vuelta tarda minutos.
        await new Promise(r => setTimeout(r, 10));
        mundo.miembros = 270;
        for (let i = 0; i < 8; i++) await worker.ciclo();

        const tras = await memberRepo.contar(GRUPO);
        assert.strictEqual(tras.miembros, 270, `quedaron ${tras.miembros} activos y deberian ser 270`);
        assert.strictEqual(tras.bajas, 30);

        // Y no sigue bajando: se marcaron una vez.
        for (let i = 0; i < 6; i++) await worker.ciclo();
        assert.strictEqual((await memberRepo.contar(GRUPO)).miembros, 270);
    });

    test('CURSOR INVALIDO cerca del final: cero bajas y la vuelta vuelve a empezar', async () => {
        poblar({ miembros: 400 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });
        const worker = nuevoWorker('w-cursor-invalido');

        for (let i = 0; i < 5; i++) await worker.ciclo();
        assert.strictEqual((await memberRepo.contar(GRUPO)).miembros, 400);

        await new Promise(r => setTimeout(r, 10));

        // Vuelta nueva: las tres primeras paginas van bien y la CUARTA —la
        // ultima— falla porque el cursor ya no vale.
        const bueno = roblox.listGroupMembers;
        let n = 0;
        roblox.listGroupMembers = async (g, { cursor = null } = {}) => {
            n++;
            if (n === 4) throw axiosError(400, {}, { errors: [{ message: 'InvalidCursor' }] });
            const pagina = cursor ? Number(String(cursor).slice(1)) : 0;
            const desde = pagina * 100;
            const hasta = Math.min(desde + 100, 400);
            const members = [];
            for (let i = desde; i < hasta; i++) members.push({ userId: 1000 + i, username: `U${1000 + i}` });
            return { members, nextCursor: hasta < 400 ? `p${pagina + 1}` : null };
        };

        try {
            for (let i = 0; i < 8; i++) await worker.ciclo();
        } finally {
            roblox.listGroupMembers = bueno;
        }

        const tras = await memberRepo.contar(GRUPO);
        assert.strictEqual(tras.bajas, 0,
            `un cursor invalido marco ${tras.bajas} bajas`);
        assert.strictEqual(tras.miembros, 400);
    });

    test('VARIAS VUELTAS COMPLETAS: coverage.members estable y sin duplicados', async () => {
        poblar({ miembros: 250 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });
        const worker = nuevoWorker('w-vueltas-estables');

        const denominadores = [];
        for (let vuelta = 0; vuelta < 5; vuelta++) {
            for (let i = 0; i < 3; i++) await worker.ciclo();   // 250 = 3 paginas
            const foto = await avatarRepo.cobertura(GRUPO, {
                ttlAvatarMs: config.indexWorker.avatarTtlMs,
                ttlPrecioMs: config.indexWorker.priceTtlMs,
                minAccessories: config.pluginSearch.minAccessories,
            });
            denominadores.push(foto.knownMembers);
        }

        // Cinco vueltas enteras y el denominador no se mueve ni un usuario.
        assert.deepStrictEqual(denominadores, [250, 250, 250, 250, 250],
            `el denominador fluctuo: ${denominadores.join(', ')}`);
        assert.strictEqual((await memberRepo.contar(GRUPO)).bajas, 0,
            'se marcaron bajas sin que nadie se fuera');
        // Y el crawler dio vueltas de verdad: las filas vistas superan a los miembros.
        assert.ok(worker.metricas.memberRowsSeen > 250 * 3,
            `solo ${worker.metricas.memberRowsSeen} filas vistas: no hubo varias vueltas`);
    });

    // ── 2. Cooldown de una hora en el avatar ────────────────────────────────

    test('COOLDOWN DE UNA HORA: el crawler sigue descubriendo miembros', async () => {
        poblar({ miembros: 1000 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });
        congelarAvatar();

        const worker = nuevoWorker('w-congelado');
        const avataresAntes = mundo.avatares;

        for (let i = 0; i < 6; i++) await worker.ciclo();

        assert.strictEqual(mundo.avatares, avataresAntes,
            'salieron peticiones de avatar con la ruta congelada');
        assert.ok(base.miembros.size >= 500,
            `el crawler solo descubrio ${base.miembros.size} miembros con el avatar frenado`);
        // FILAS vistas (con vueltas), que es lo que mide el crawler.
        assert.ok(worker.metricas.memberRowsSeen >= 500);
        // Y el denominador honesto: usuarios distintos, nunca mas de los que hay.
        assert.ok(worker.metricas.membersDiscovered <= 1000,
            `el denominador llego a ${worker.metricas.membersDiscovered} en una comunidad de 1000`);
        assert.ok(worker.metricas.cooldowns > 0, 'no consta el cooldown');
        assert.strictEqual(worker.metricas.cycleTimeouts, 0);
        descongelar();
    });

    test('COOLDOWN DE UNA HORA: el POST sigue respondiendo y el worker sigue vivo', async () => {
        poblar({ miembros: 400 });
        config.indexServe.enabled = true;
        congelarAvatar();
        try {
            const worker = nuevoWorker('w-post-vivo');
            await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });
            for (let i = 0; i < 3; i++) await worker.ciclo();

            const { status, body } = await pedir({
                amount: 10, groupId: GRUPO, minPrice: 100, maxPrice: 100_000_000,
                requireCompletePrice: false, async: true,
            });

            assert.strictEqual(status, 200, 'el POST dejo de responder con el avatar frenado');
            assert.ok(['completed', 'partial'].includes(body.status));

            // El worker sigue vivo: emite latido y no esta bloqueado.
            worker.emitirLatido();
            assert.strictEqual(worker.vida.etapa, ETAPA.OCIOSO);
            assert.ok(worker.metricas.cycles >= 3);
        } finally {
            config.indexServe.enabled = false;
            descongelar();
        }
    });

    test('el pricing avanza aunque el avatar este congelado', async () => {
        poblar({ miembros: 200 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });

        // Primero se indexan avatares con la ruta libre.
        const worker = nuevoWorker('w-precios');
        await worker.ciclo();
        assert.ok(base.avatares.size > 0);

        // Se les quita la valoracion y se congela SOLO el avatar.
        for (const fila of base.avatares.values()) { fila.pricedAt = null; fila.state = 'avatar_only'; }
        base.catalogo.clear();
        congelarAvatar();
        const valoradosAntes = worker.metricas.usersPriced;

        await worker.ciclo();

        assert.ok(worker.metricas.usersPriced > valoradosAntes,
            'el pricing se paro porque el avatar estaba frenado, teniendo el catalogo libre');
        descongelar();
    });

    // ── 3. Errores temporales ───────────────────────────────────────────────

    test('un ERROR DE RED en una llamada de avatar no aborta el grupo', async () => {
        poblar({ miembros: 50 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });
        // El tercer avatar del ciclo revienta con un fallo de red. El limitador
        // lo REINTENTA y lo absorbe, que es justo lo que debe pasar con un
        // fallo transitorio; lo que se comprueba aqui es que el ciclo no se
        // corta y que el resto de usuarios se procesa igual.
        let n = 0;
        mundo.avatarFalla = () => (++n === 3 ? networkError() : null);

        const worker = nuevoWorker('w-red');
        const r = await worker.ciclo();

        assert.strictEqual(r.avataresEscritos, 10,
            `un fallo de red corto el ciclo: solo ${r.avataresEscritos} escritos de 10`);
        // Y el siguiente ciclo sigue con los que faltan.
        mundo.avatarFalla = null;
        const antes = base.avatares.size;
        await worker.ciclo();
        assert.ok(base.avatares.size > antes, 'el ciclo siguiente no avanzo tras el error');
    });

    test('un TIMEOUT y una EXCEPCION cualquiera tampoco lo tumban', async () => {
        poblar({ miembros: 50 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });
        let n = 0;
        mundo.avatarFalla = () => {
            n++;
            if (n === 2) return timeoutError();
            if (n === 4) return new Error('algo raro dentro de un usuario');
            return null;
        };

        const worker = nuevoWorker('w-timeout');
        const r = await worker.ciclo();

        assert.ok(r.avataresEscritos >= 7, `solo se escribieron ${r.avataresEscritos}`);
        assert.strictEqual(worker.metricas.cycleTimeouts, 0);
        mundo.avatarFalla = null;
    });

    test('una excepcion del CATALOGO no impide que el crawler y el avatar avancen', async () => {
        poblar({ miembros: 200 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });
        mundo.catalogoFalla = () => new Error('catalogo roto');

        const worker = nuevoWorker('w-catalogo-roto');
        const r = await worker.ciclo();

        assert.ok(r.miembrosVistos > 0, 'el crawler no avanzo');
        assert.ok(r.avataresEscritos > 0, 'el avatar no avanzo');
        // Y nadie quedo marcado como sin precio por un fallo temporal.
        const marcados = [...base.avatares.values()].filter(f => f.state === 'unpriceable');
        assert.deepStrictEqual(marcados, [], 'un fallo de catalogo dejo veredictos permanentes');
        mundo.catalogoFalla = null;
    });

    test('un fallo del CRAWLER no impide indexar a los ya descubiertos', async () => {
        poblar({ miembros: 200 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });
        const worker = nuevoWorker('w-crawler-roto');
        await worker.ciclo();                       // descubre la primera pagina
        const descubiertos = base.miembros.size;
        assert.ok(descubiertos > 0);

        // Ahora la pagina de miembros falla siempre.
        const bueno = roblox.listGroupMembers;
        roblox.listGroupMembers = async () => { throw networkError(); };
        try {
            const avataresAntes = base.avatares.size;
            const r = await worker.ciclo();
            assert.ok(r.errores > 0, 'no consta el fallo del crawler');
            assert.ok(base.avatares.size > avataresAntes,
                'un fallo del crawler impidio indexar a los ya descubiertos');
        } finally {
            roblox.listGroupMembers = bueno;
        }
    });

    // ── 4. Recuperacion automatica ──────────────────────────────────────────

    test('cuando el cooldown TERMINA, el worker reanuda solo y sube avatarsIndexed', async () => {
        poblar({ miembros: 300 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });
        congelarAvatar();

        const worker = nuevoWorker('w-reanuda');
        for (let i = 0; i < 3; i++) await worker.ciclo();
        const durante = worker.metricas.avatarsIndexed;
        assert.strictEqual(durante, 0, 'se indexaron avatares con la ruta congelada');

        // El cooldown pasa. Nadie toca el worker.
        descongelar();
        await worker.ciclo();

        assert.ok(worker.metricas.avatarsIndexed > durante,
            'el worker no reanudo solo al terminar el cooldown');
        assert.ok(base.avatares.size > 0);
    });

    test('REINICIO durante el cooldown: recupera el cursor y continua', async () => {
        poblar({ miembros: 300 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });

        const antes = nuevoWorker('w-antes-del-reinicio');
        await antes.ciclo();
        await antes.ciclo();
        const cursorGuardado = (await crawlRepo.leer(GRUPO)).cursor;
        assert.strictEqual(cursorGuardado, 'p2');

        // Muere el proceso con el avatar congelado.
        congelarAvatar();
        const despues = nuevoWorker('w-tras-el-reinicio');
        assert.strictEqual(despues.metricas.cycles, 0);

        const r = await despues.ciclo();
        assert.strictEqual(r.cursorAntes, cursorGuardado,
            `el worker nuevo arranco en ${r.cursorAntes} en vez de en ${cursorGuardado}`);
        assert.ok(r.miembrosVistos > 0, 'el crawler no avanzo tras el reinicio');

        // Y al descongelar, sigue indexando desde donde iba.
        descongelar();
        await despues.ciclo();
        assert.ok(despues.metricas.avatarsIndexed > 0);
    });

    // ── 5. Atasco y latido ──────────────────────────────────────────────────

    test('sin progreso y SIN cooldown se avisa con worker_stalled, y el worker sigue', async () => {
        poblar({ miembros: 0 });          // comunidad vacia: no hay nada que hacer
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });

        const worker = nuevoWorker('w-atascado');
        for (let i = 0; i < 4; i++) await worker.ciclo();

        assert.ok(worker.metricas.stalls > 0, 'no se aviso del atasco');
        assert.ok(worker.vida.ciclosSinProgreso >= 2);
        // Y sigue corriendo ciclos: avisar no es morirse.
        assert.ok(worker.metricas.cycles >= 4);
    });

    test('con cooldown activo NO se avisa de atasco: esperar no es estar atascado', async () => {
        poblar({ miembros: 60 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });
        const worker = nuevoWorker('w-esperando');
        // Se recorre la comunidad entera primero para que no quede nada nuevo.
        for (let i = 0; i < 3; i++) await worker.ciclo();
        const avisosAntes = worker.metricas.stalls;

        congelarAvatar();
        for (let i = 0; i < 4; i++) await worker.ciclo();

        assert.strictEqual(worker.metricas.stalls, avisosAntes,
            'se aviso de atasco mientras se esperaba un cooldown legitimo');
        descongelar();
    });

    test('el latido dice que sigue vivo, en que etapa y cuanto lleva sin progresar', async () => {
        poblar({ miembros: 100 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });
        const worker = nuevoWorker('w-latido');
        await worker.ciclo();

        const v = worker.vida;
        assert.strictEqual(v.etapa, ETAPA.OCIOSO);
        assert.strictEqual(v.groupId, String(GRUPO));
        assert.ok(v.ultimoProgresoAt > 0);
        assert.strictEqual(v.ciclosSinProgreso, 0);
        // Emitirlo no puede lanzar: es un log, no una operacion.
        worker.emitirLatido();
    });

    // ── 6. El vigilante ─────────────────────────────────────────────────────

    test('un ciclo colgado se da por perdido y el siguiente corre igual', async () => {
        poblar({ miembros: 50 });
        await crawlRepo.registrarDemanda(GRUPO, { faltan: 10 });

        const worker = nuevoWorker('w-vigilante');
        const previo = config.indexWorker.cycleTimeoutMs;
        const previoLease = config.indexWorker.leaseMs;
        config.indexWorker.cycleTimeoutMs = 30;
        // Un ciclo colgado sigue reteniendo el lease del grupo: es a proposito,
        // porque si ese await volviera tarde seguiria escribiendo. Lo que lo
        // desbloquea es la CADUCIDAD del lease, que aqui se acorta para no
        // esperar un minuto.
        config.indexWorker.leaseMs = 40;

        // Una pagina de miembros que no vuelve NUNCA: sin vigilante, el worker
        // se quedaria con la bandera de "corriendo" puesta para siempre.
        const bueno = roblox.listGroupMembers;
        roblox.listGroupMembers = () => new Promise(() => {});
        try {
            await worker.cicloVigilado();
            assert.strictEqual(worker.metricas.cycleTimeouts, 1, 'el vigilante no salto');
        } finally {
            roblox.listGroupMembers = bueno;
            config.indexWorker.cycleTimeoutMs = previo;
        }

        // En cuanto caduca el lease del ciclo colgado, el worker vuelve a
        // trabajar solo: nadie lo reinicia y el proceso no se ha muerto.
        await new Promise(r => setTimeout(r, 70));
        const r = await worker.cicloVigilado();
        config.indexWorker.leaseMs = previoLease;
        assert.ok(r && r.hecho !== false, 'el worker no se recupero tras el ciclo colgado');
        assert.ok(worker.metricas.cycles >= 1);
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
    config.indexServe.enabled = original.serveEnabled;
    config.pluginSearch.minAccessories = original.minAccessories;
    config.cache.maxEntries = original.cache;
    config.upstream.routeMinSpacingMs.userAvatarV2 = sueloV2;
    cache.reset();
    limitador.reset();
    ownRateLimit.reset();
    colaDeGrupos.reset();
    jobs.reset();
    await new Promise(resolve => server.close(resolve));
    return ok;
};
