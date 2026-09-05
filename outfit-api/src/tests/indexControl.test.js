'use strict';

const http = require('http');
const { createSuite } = require('./harness');
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
const eventos = require('../observability/indexEvents');
const { crearBaseFalsa } = require('./fakeDb');

// ADMINISTRAR COMUNIDADES DEL INDICE: cancelar, reanudar y eliminar.
//
// Cuatro acciones que se parecen lo suficiente como para confundirse, y las
// consecuencias de confundirlas no son simetricas. Cancelar y reanudar son
// reversibles; eliminar no lo es, y borrar de mas se lleva por delante trabajo
// que costo horas de cuota de Roblox. Este archivo existe para fijar por
// escrito donde esta cada frontera:
//
//   CANCELAR    el worker deja de elegir esa comunidad. NO se borra nada, ni
//               siquiera el cursor. Vive en la tabla, asi que sobrevive a un
//               redeploy de Railway.
//   REANUDAR    vuelve a la cola POR DONDE IBA.
//   ELIMINAR    borra su progreso propio. `roblox_user_avatar` y
//               `roblox_asset_catalog` son globales y NO se tocan.
//   SONDEAR     el panel lee y solo lee: cero Roblox, y sin mover la rotacion
//               de entrega ni una fila.

const GRUPO_A = 111111;
const GRUPO_B = 222222;
const CLAVE = config.pluginApiKey;

function pedir(port, metodo, ruta, cuerpo) {
    // El limitador por IP es de 25 en la suite y todo sale de 127.0.0.1: sin
    // este reset, un archivo que sondea unas cuantas veces agota el cubo y
    // rompe con 429 a otro archivo que no ha hecho nada.
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
    const suite = createSuite('indexControl');
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
    //
    // Ninguna ruta de este panel puede acercarse a Roblox. La cuota real es de
    // tres peticiones por segundo para el proceso entero, y un panel abierto
    // sondea cada cinco segundos mientras alguien tiene Studio delante: si
    // gastara de ahi, competiria con el worker por el unico recurso escaso que
    // hay, y justo cuando alguien esta mirando por que el worker no avanza.
    //
    // Es una trampa y no un contador a proposito. Un contador hay que acordarse
    // de incrementarlo; esto se dispara solo el dia que alguien añada una
    // llamada "por si acaso".
    const llamadasProhibidas = [];
    const trampa = nombre => async () => { llamadasProhibidas.push(nombre); throw new Error('prohibido'); };
    roblox.listGroupMembers = trampa('listGroupMembers');
    roblox.getCurrentAvatar = trampa('getCurrentAvatar');
    roblox.getCurrentAvatarV2 = trampa('getCurrentAvatarV2');
    roblox.getCatalogItemDetails = trampa('getCatalogItemDetails');
    roblox.getBundlesForAsset = trampa('getBundlesForAsset');

    const sinRoblox = () => assert.deepStrictEqual(llamadasProhibidas, [],
        `se llamo a Roblox: ${llamadasProhibidas.join(', ')}`);

    // ── EL INDICE DE PRUEBA ─────────────────────────────────────────────────
    //
    // Dos comunidades que COMPARTEN diez usuarios. El solape es la parte
    // importante del montaje: es lo que convierte "no borres datos globales"
    // de una buena intencion en algo que se puede comprobar.
    //
    //   A: usuarios 1000..1019
    //   B: usuarios 1010..1029   -> 1010..1019 estan en las dos
    const usuariosDe = (desde, hasta) => {
        const lista = [];
        for (let i = desde; i <= hasta; i++) lista.push({ userId: i, username: `U${i}` });
        return lista;
    };

    async function poblar() {
        base.limpiar();
        eventos.reset();
        limitador.reset();
        cache.reset();
        llamadasProhibidas.length = 0;

        // El recorrido PRIMERO: la pertenencia esta vallada contra el borrado
        // y no se escribe si la comunidad no figura en el indice. Es el mismo
        // orden que en produccion, donde el crawler solo pagina un grupo que
        // ya tiene fila de recorrido.
        await crawlRepo.asegurar(GRUPO_A);
        await crawlRepo.asegurar(GRUPO_B);

        await memberRepo.registrarPagina(GRUPO_A, usuariosDe(1000, 1019));
        await memberRepo.registrarPagina(GRUPO_B, usuariosDe(1010, 1029));

        for (let i = 1000; i <= 1029; i++) {
            await avatarRepo.upsertAvatar({
                userId: i, username: `U${i}`, state: 'valid',
                assetIds: [9001, 9002, 9003, 9004], assetTypeIds: [8, 41, 46, 47],
                accessories: 4, playerAvatarType: 'R15',
            });
            // El estado va FUERA y la valoracion ANIDADA: es la forma que
            // exige el repositorio real, que ademas valida el estado contra su
            // conjunto cerrado. Aplanarlo deja el avatar sin `state` y por
            // tanto fuera de toda busqueda, en silencio.
            await avatarRepo.upsertValoraciones([{
                userId: i, state: 'valid',
                valoracion: {
                    totalPrice: 500, priceComplete: true, pricedItems: 4,
                    unpricedItems: 0, limitedItems: 0, offSaleItems: 0, bundledItems: 0,
                },
            }], { pricingVersion: 1 });
        }

        await catalogoRepo.guardar(new Map([
            [9001, { available: true, assetTypeId: 8, isLimited: false, offSale: false, price: 125 }],
            [9002, { available: true, assetTypeId: 41, isLimited: false, offSale: false, price: 125 }],
        ]), { faltantes: [] });

    }

    // Un recorrido a medias, con cursor y una vuelta declarada limpia. Es el
    // estado sobre el que se prueba que cancelar conserva el progreso y a la
    // vez retira la autorizacion para marcar bajas.
    async function aMitadDeVuelta(groupId, { instancia = 'w-test' } = {}) {
        base.otroWorkerToma(groupId, instancia, { duracionMs: 60_000 });
        await crawlRepo.guardarCursor(groupId, instancia, {
            cursor: 'pagina-7', intraPageOffset: 12, cycle: 3,
            membersSeen: 400, usersIndexed: 250,
            cycleStartedAt: Date.now() - 60_000, lapClean: true,
            leaseMs: 60_000,
        });
        return crawlRepo.leer(groupId);
    }

    // ════════════════════════════════════════════════════════════════════════
    // CANCELAR
    // ════════════════════════════════════════════════════════════════════════

    test('cancelar una comunidad no afecta a ninguna otra', async () => {
        await poblar();
        await crawlRepo.registrarDemanda(GRUPO_B, { faltan: 5 });

        const r = await pedir(port, 'POST', `/plugin/index/groups/${GRUPO_A}/cancel`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.paused, true);

        const a = await crawlRepo.leer(GRUPO_A);
        const b = await crawlRepo.leer(GRUPO_B);
        assert.ok(a.pausedAt !== null, 'A tenia que quedar cancelada');
        assert.strictEqual(a.enabled, false);
        assert.strictEqual(b.pausedAt, null, 'B no se toco');
        assert.strictEqual(b.enabled, true);
        assert.ok(b.priority > 0, 'B conserva su demanda');
        sinRoblox();
    });

    test('el worker no elige una comunidad cancelada', async () => {
        await poblar();
        await crawlRepo.registrarDemanda(GRUPO_A, { faltan: 9 });
        await pedir(port, 'POST', `/plugin/index/groups/${GRUPO_A}/cancel`);

        // Se pide trabajo muchas veces: si A fuera elegible saldria, porque es
        // la unica con demanda registrada.
        for (let i = 0; i < 5; i++) {
            const elegida = await crawlRepo.tomar('w-1', { leaseMs: 1000, revisitarCadaMs: null });
            if (elegida) {
                assert.notStrictEqual(elegida.groupId, String(GRUPO_A),
                    'el worker cogio una comunidad cancelada');
                await crawlRepo.soltar(elegida.groupId, 'w-1');
            }
        }
        sinRoblox();
    });

    test('la prioridad pendiente NO reactiva una comunidad cancelada', async () => {
        await poblar();
        await pedir(port, 'POST', `/plugin/index/groups/${GRUPO_A}/cancel`);
        const antes = await crawlRepo.leer(GRUPO_A);

        // Diez busquedas que se quedan cortas: en una comunidad normal esto la
        // pondria la primera de la cola.
        for (let i = 0; i < 10; i++) {
            const subio = await crawlRepo.registrarDemanda(GRUPO_A, { faltan: 50 });
            assert.strictEqual(subio, false, 'la demanda no debe prosperar sobre una cancelada');
        }

        const despues = await crawlRepo.leer(GRUPO_A);
        assert.strictEqual(despues.priority, antes.priority, 'la prioridad no puede haber subido');
        assert.strictEqual(despues.enabled, false, 'sigue apagada');
        assert.ok(despues.pausedAt !== null, 'sigue cancelada');

        const elegida = await crawlRepo.tomar('w-1', { leaseMs: 1000 });
        if (elegida) assert.notStrictEqual(elegida.groupId, String(GRUPO_A));
        sinRoblox();
    });

    test('la cancelacion sobrevive a un redeploy', async () => {
        await poblar();
        await pedir(port, 'POST', `/plugin/index/groups/${GRUPO_A}/cancel`);

        // Un redeploy es un proceso nuevo: nada de lo que hubiera en memoria
        // sigue ahi. Lo que sobrevive es la fila, y por eso la pausa vive en
        // la fila. Se comprueba leyendo la tabla y pidiendo trabajo con una
        // instancia que no existia antes.
        eventos.reset();
        const traselReinicio = await crawlRepo.leer(GRUPO_A);
        assert.ok(traselReinicio.pausedAt !== null, 'la pausa tiene que estar en la tabla');
        assert.strictEqual(traselReinicio.enabled, false);

        const elegida = await crawlRepo.tomar('worker-de-otro-despliegue', { leaseMs: 1000 });
        if (elegida) assert.notStrictEqual(elegida.groupId, String(GRUPO_A));
        sinRoblox();
    });

    test('cancelar a mitad de vuelta no marca bajas ni finge que la vuelta acabo', async () => {
        await poblar();
        const antes = await aMitadDeVuelta(GRUPO_A);
        assert.strictEqual(antes.lapClean, true, 'el montaje empieza con la vuelta limpia');

        await pedir(port, 'POST', `/plugin/index/groups/${GRUPO_A}/cancel`);

        const despues = await crawlRepo.leer(GRUPO_A);
        assert.strictEqual(despues.lapClean, false, 'una vuelta interrumpida no es limpia');
        assert.strictEqual(despues.lastFullPassAt, null, 'no se puede fingir una vuelta completa');
        // El lease se CONSERVA, y es deliberado: guardarCursor esta vallado
        // por lease_owner, asi que soltarlo aqui haria que el ciclo en marcha
        // escribiera cero filas y perdiera su cursor, su ciclo y sus contadores.
        // No hace falta soltarlo para que deje de elegirse: tomar filtra por
        // enabled, que la cancelacion ya puso en false.
        assert.strictEqual(despues.leaseOwner, 'w-test', 'el lease se conserva: el ciclo en marcha tiene que poder guardar');
        assert.strictEqual(despues.enabled, false, 'y aun asi deja de ser elegible');

        // Y NADIE queda marcado como baja.
        const conBaja = [...base.miembros.values()].filter(m => m.groupId === String(GRUPO_A) && m.leftAt);
        assert.strictEqual(conBaja.length, 0, 'cancelar no puede dar de baja a nadie');
        sinRoblox();
    });

    test('el ciclo que ya estaba en marcha no puede declarar limpia la vuelta', async () => {
        await poblar();
        await aMitadDeVuelta(GRUPO_A, { instancia: 'w-en-marcha' });
        await pedir(port, 'POST', `/plugin/index/groups/${GRUPO_A}/cancel`);

        // El worker seguia dentro de su ciclo cuando llego la cancelacion y
        // ahora guarda su avance. El cursor SI se conserva; su veredicto sobre
        // la vuelta, no. Sin esto, al reanudar se darian de baja miembros que
        // nadie llego a recorrer.
        base.otroWorkerToma(GRUPO_A, 'w-en-marcha', { duracionMs: 60_000 });
        await crawlRepo.guardarCursor(GRUPO_A, 'w-en-marcha', {
            cursor: 'pagina-8', intraPageOffset: 0, cycle: 3,
            membersSeen: 100, usersIndexed: 50, lapClean: true, leaseMs: 60_000,
        });

        const fila = await crawlRepo.leer(GRUPO_A);
        assert.strictEqual(fila.lapClean, false, 'un ciclo tardio no puede reabrir la autorizacion de bajas');
        assert.strictEqual(fila.cursor, 'pagina-8', 'el avance del cursor SI se conserva');
        sinRoblox();
    });

    // ════════════════════════════════════════════════════════════════════════
    // REANUDAR
    // ════════════════════════════════════════════════════════════════════════

    test('reanudar conserva el progreso y continua por donde iba', async () => {
        await poblar();
        const antes = await aMitadDeVuelta(GRUPO_A);
        await crawlRepo.soltar(GRUPO_A, 'w-test');
        await pedir(port, 'POST', `/plugin/index/groups/${GRUPO_A}/cancel`);

        const r = await pedir(port, 'POST', `/plugin/index/groups/${GRUPO_A}/resume`);
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.paused, false);
        assert.strictEqual(r.body.resumedFrom.hasCursor, true);

        const despues = await crawlRepo.leer(GRUPO_A);
        assert.strictEqual(despues.pausedAt, null);
        assert.strictEqual(despues.enabled, true);
        assert.strictEqual(despues.cursor, antes.cursor, 'el cursor no se toca');
        assert.strictEqual(despues.cycle, antes.cycle, 'el ciclo no se reinicia');
        assert.strictEqual(despues.membersSeen, antes.membersSeen);
        assert.strictEqual(despues.usersIndexed, antes.usersIndexed);
        assert.strictEqual(despues.lapClean, false, 'la vuelta rota sigue rota tras reanudar');

        // Y los miembros y avatares siguen enteros.
        const miembrosA = [...base.miembros.values()].filter(m => m.groupId === String(GRUPO_A));
        assert.strictEqual(miembrosA.length, 20);
        assert.strictEqual(base.avatares.size, 30);
        sinRoblox();
    });

    test('una comunidad reanudada vuelve a ser elegible para el worker', async () => {
        await poblar();
        await pedir(port, 'POST', `/plugin/index/groups/${GRUPO_A}/cancel`);
        await pedir(port, 'POST', `/plugin/index/groups/${GRUPO_A}/resume`);
        await crawlRepo.registrarDemanda(GRUPO_A, { faltan: 9 });

        const fila = await crawlRepo.leer(GRUPO_A);
        assert.ok(fila.priority > 0, 'reanudada, la demanda vuelve a contar');

        let vista = false;
        for (let i = 0; i < 5 && !vista; i++) {
            const elegida = await crawlRepo.tomar(`w-${i}`, { leaseMs: 50 });
            if (elegida && elegida.groupId === String(GRUPO_A)) vista = true;
            if (elegida) await crawlRepo.soltar(elegida.groupId, `w-${i}`);
        }
        assert.ok(vista, 'una comunidad reanudada tiene que poder elegirse');
        sinRoblox();
    });

    // ════════════════════════════════════════════════════════════════════════
    // BUSCAR EN UNA COMUNIDAD CANCELADA
    // ════════════════════════════════════════════════════════════════════════

    test('buscar con datos existentes NO reactiva la comunidad', async () => {
        await poblar();
        await pedir(port, 'POST', `/plugin/index/groups/${GRUPO_A}/cancel`);

        const r = await pedir(port, 'POST', '/plugin/outfits/search', {
            amount: 5, groupId: GRUPO_A, minPrice: 0, maxPrice: 100000,
        });
        assert.strictEqual(r.status, 200);
        assert.ok(r.body.outfits.length > 0, 'el indice existente sigue sirviendo');

        const fila = await crawlRepo.leer(GRUPO_A);
        assert.ok(fila.pausedAt !== null, 'buscar NO puede reactivar una comunidad cancelada');
        assert.strictEqual(fila.enabled, false);
        assert.strictEqual(fila.priority, 0, 'ni siquiera por la puerta de atras de la prioridad');
        sinRoblox();
    });

    test('reanudar y buscar SI la reactiva, y conserva su progreso', async () => {
        await poblar();
        const antes = await aMitadDeVuelta(GRUPO_A);
        await crawlRepo.soltar(GRUPO_A, 'w-test');
        await pedir(port, 'POST', `/plugin/index/groups/${GRUPO_A}/cancel`);

        // El plugin hace exactamente esto cuando eligen "Reanudar y buscar":
        // primero la reanuda de forma explicita, y solo despues busca.
        await pedir(port, 'POST', `/plugin/index/groups/${GRUPO_A}/resume`);
        const r = await pedir(port, 'POST', '/plugin/outfits/search', {
            amount: 5, groupId: GRUPO_A, minPrice: 0, maxPrice: 100000,
        });
        assert.strictEqual(r.status, 200);

        const fila = await crawlRepo.leer(GRUPO_A);
        assert.strictEqual(fila.pausedAt, null, 'quedo reactivada');
        assert.strictEqual(fila.enabled, true);
        assert.strictEqual(fila.cursor, antes.cursor, 'sin empezar de cero');
        sinRoblox();
    });

    // ════════════════════════════════════════════════════════════════════════
    // ELIMINAR
    // ════════════════════════════════════════════════════════════════════════

    test('eliminar exige repetir el groupId', async () => {
        await poblar();
        const sinConfirmar = await pedir(port, 'DELETE', `/plugin/index/groups/${GRUPO_A}`);
        assert.strictEqual(sinConfirmar.status, 400);
        assert.strictEqual(sinConfirmar.body.error.code, 'confirmation_required');

        const malConfirmado = await pedir(port, 'DELETE', `/plugin/index/groups/${GRUPO_A}`, { confirm: '999' });
        assert.strictEqual(malConfirmado.status, 400);

        assert.ok(await crawlRepo.leer(GRUPO_A), 'no se puede haber borrado nada');
        sinRoblox();
    });

    test('eliminar borra el progreso propio de esa comunidad', async () => {
        await poblar();
        await aMitadDeVuelta(GRUPO_A);
        await crawlRepo.soltar(GRUPO_A, 'w-test');

        const r = await pedir(port, 'DELETE', `/plugin/index/groups/${GRUPO_A}`, { confirm: String(GRUPO_A) });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.deleted.existia, true);
        assert.strictEqual(r.body.deleted.miembrosBorrados, 20);

        assert.strictEqual(await crawlRepo.leer(GRUPO_A), null, 'el recorrido se va');
        const miembrosA = [...base.miembros.values()].filter(m => m.groupId === String(GRUPO_A));
        assert.strictEqual(miembrosA.length, 0, 'su pertenencia se va');
        sinRoblox();
    });

    test('eliminar una comunidad no afecta a las demas', async () => {
        await poblar();
        await crawlRepo.registrarDemanda(GRUPO_B, { faltan: 4 });
        const antesB = await crawlRepo.leer(GRUPO_B);

        await pedir(port, 'DELETE', `/plugin/index/groups/${GRUPO_A}`, { confirm: String(GRUPO_A) });

        const despuesB = await crawlRepo.leer(GRUPO_B);
        assert.ok(despuesB, 'B sigue existiendo');
        assert.strictEqual(despuesB.priority, antesB.priority);
        const miembrosB = [...base.miembros.values()].filter(m => m.groupId === String(GRUPO_B));
        assert.strictEqual(miembrosB.length, 20, 'B conserva sus veinte miembros');
        sinRoblox();
    });

    test('eliminar NO borra roblox_user_avatar, que es global y compartido', async () => {
        await poblar();
        const avataresAntes = base.avatares.size;
        assert.strictEqual(avataresAntes, 30);

        const r = await pedir(port, 'DELETE', `/plugin/index/groups/${GRUPO_A}`, { confirm: String(GRUPO_A) });

        assert.strictEqual(base.avatares.size, 30,
            'ni un avatar puede desaparecer: cada uno costo una llamada contra una cuota de 3/s');
        assert.strictEqual(r.body.keptGlobal.robloxUserAvatar, true);

        // Los diez compartidos siguen sirviendo a B, que es la prueba de que
        // borrar en cascada habria destruido trabajo ajeno.
        for (let i = 1010; i <= 1019; i++) {
            assert.ok(base.avatares.has(String(i)), `el avatar compartido ${i} tenia que seguir`);
        }
        // Y se informa de cuantos quedaron sin comunidad, sin borrarlos: los
        // exclusivos de A son 1000..1009.
        assert.strictEqual(r.body.keptGlobal.orphanAvatars, 10);
        sinRoblox();
    });

    test('eliminar NO borra roblox_asset_catalog, que es global', async () => {
        await poblar();
        const fichasAntes = (await catalogoRepo.contar()).fichas;
        assert.ok(fichasAntes > 0, 'el montaje tiene catalogo');

        const r = await pedir(port, 'DELETE', `/plugin/index/groups/${GRUPO_A}`, { confirm: String(GRUPO_A) });

        assert.strictEqual((await catalogoRepo.contar()).fichas, fichasAntes,
            'un asset lo llevan miles de usuarios: no es de ninguna comunidad');
        assert.strictEqual(r.body.keptGlobal.robloxAssetCatalog, true);
        sinRoblox();
    });

    test('un trabajo vivo de esa comunidad se retira antes de borrar', async () => {
        await poblar();
        await jobRepo.crear({
            searchId: 's-vivo', groupId: GRUPO_A, status: 'running',
            target: 10, params: null, instanceId: 'i-1',
        });
        await jobRepo.crear({
            searchId: 's-de-otra', groupId: GRUPO_B, status: 'running',
            target: 10, params: null, instanceId: 'i-1',
        });
        base.otroWorkerToma(GRUPO_A, 'w-ocupado', { duracionMs: 60_000 });

        const r = await pedir(port, 'DELETE', `/plugin/index/groups/${GRUPO_A}`, { confirm: String(GRUPO_A) });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.body.deleted.trabajosRetirados, 1, 'solo el de esa comunidad');

        assert.strictEqual(base.trabajosPersistidos.get('s-vivo').status, 'expired');
        assert.strictEqual(base.trabajosPersistidos.get('s-de-otra').status, 'running',
            'el trabajo de otra comunidad sigue vivo');

        // El worker que la tenia cogida intenta guardar despues del borrado:
        // no encuentra fila, no escribe y NO la resucita.
        const guardado = await crawlRepo.guardarCursor(GRUPO_A, 'w-ocupado', {
            cursor: 'zombi', cycle: 9, leaseMs: 60_000,
        });
        assert.strictEqual(guardado, false, 'no puede escribir sobre lo que ya no existe');
        assert.strictEqual(await crawlRepo.leer(GRUPO_A), null, 'y no la resucita');
        sinRoblox();
    });

    test('la comunidad eliminada desaparece de la lista del panel', async () => {
        await poblar();
        const antes = await pedir(port, 'GET', '/plugin/index/groups');
        assert.ok(antes.body.groups.some(g => g.groupId === String(GRUPO_A)));

        await pedir(port, 'DELETE', `/plugin/index/groups/${GRUPO_A}`, { confirm: String(GRUPO_A) });

        const despues = await pedir(port, 'GET', '/plugin/index/groups');
        assert.ok(!despues.body.groups.some(g => g.groupId === String(GRUPO_A)),
            'una comunidad borrada no puede seguir en la lista');
        assert.ok(despues.body.groups.some(g => g.groupId === String(GRUPO_B)));
        sinRoblox();
    });

    test('volver a usar ese groupId lo trata como comunidad nueva', async () => {
        await poblar();
        await aMitadDeVuelta(GRUPO_A);
        await crawlRepo.soltar(GRUPO_A, 'w-test');
        await pedir(port, 'DELETE', `/plugin/index/groups/${GRUPO_A}`, { confirm: String(GRUPO_A) });

        // Alguien vuelve a buscar en ella: entra limpia, sin rastro del
        // recorrido anterior.
        await crawlRepo.registrarDemanda(GRUPO_A, { faltan: 3 });
        const nueva = await crawlRepo.leer(GRUPO_A);

        assert.ok(nueva, 'vuelve a existir');
        assert.strictEqual(nueva.cursor, null, 'sin el cursor viejo');
        assert.strictEqual(nueva.cycle, 1, 'desde el primer ciclo');
        assert.strictEqual(nueva.membersSeen, 0);
        assert.strictEqual(nueva.usersIndexed, 0);
        assert.strictEqual(nueva.pausedAt, null, 'sin heredar la pausa de la anterior');
        assert.strictEqual(nueva.enabled, true, 'y elegible');
        sinRoblox();
    });

    test('eliminar una comunidad que no existe da 404 y no borra nada', async () => {
        await poblar();
        const r = await pedir(port, 'DELETE', '/plugin/index/groups/987654', { confirm: '987654' });
        assert.strictEqual(r.status, 404);
        assert.strictEqual(r.body.error.code, 'group_not_indexed');
        assert.ok(await crawlRepo.leer(GRUPO_A));
        assert.ok(await crawlRepo.leer(GRUPO_B));
        sinRoblox();
    });

    // ════════════════════════════════════════════════════════════════════════
    // EL PANEL: SOLO LEE
    // ════════════════════════════════════════════════════════════════════════

    test('los endpoints de estado hacen CERO llamadas a Roblox', async () => {
        await poblar();
        for (let i = 0; i < 6; i++) {
            const estado = await pedir(port, 'GET', '/plugin/index/status');
            assert.strictEqual(estado.status, 200);
            assert.strictEqual(estado.body.robloxCalls, 0);
            const grupos = await pedir(port, 'GET', '/plugin/index/groups');
            assert.strictEqual(grupos.status, 200);
            assert.strictEqual(grupos.body.robloxCalls, 0);
        }
        sinRoblox();
    });

    test('sondear NO modifica last_delivered_at de nadie', async () => {
        await poblar();
        const foto = new Map(
            [...base.miembros.entries()].map(([k, m]) => [k, m.lastDeliveredAt])
        );

        for (let i = 0; i < 5; i++) {
            await pedir(port, 'GET', '/plugin/index/status');
            await pedir(port, 'GET', '/plugin/index/groups');
        }

        for (const [k, m] of base.miembros.entries()) {
            assert.strictEqual(m.lastDeliveredAt, foto.get(k),
                `sondear movio la entrega de ${k}`);
        }
        sinRoblox();
    });

    test('sondear NO rota los resultados: la busqueda siguiente continua igual', async () => {
        await poblar();

        const primera = await pedir(port, 'POST', '/plugin/outfits/search', {
            amount: 5, groupId: GRUPO_A, minPrice: 0, maxPrice: 100000,
        });
        const entregados = new Set(primera.body.outfits.map(o => String(o.userId)));
        assert.strictEqual(entregados.size, 5);

        // Veinte sondeos entre una busqueda y la siguiente. Si el panel rotara
        // algo, la segunda busqueda saltaria gente o repetiria.
        for (let i = 0; i < 20; i++) {
            await pedir(port, 'GET', '/plugin/index/groups');
        }

        const segunda = await pedir(port, 'POST', '/plugin/outfits/search', {
            amount: 5, groupId: GRUPO_A, minPrice: 0, maxPrice: 100000,
        });
        const segundos = segunda.body.outfits.map(o => String(o.userId));
        assert.strictEqual(segundos.length, 5);
        for (const id of segundos) {
            assert.ok(!entregados.has(id), `el usuario ${id} se repitio tras sondear`);
        }
        sinRoblox();
    });

    test('el panel ve las canceladas, con su estado y sus contadores', async () => {
        await poblar();
        await pedir(port, 'POST', `/plugin/index/groups/${GRUPO_A}/cancel`, { reason: 'de prueba' });

        const r = await pedir(port, 'GET', '/plugin/index/groups');
        const a = r.body.groups.find(g => g.groupId === String(GRUPO_A));
        const b = r.body.groups.find(g => g.groupId === String(GRUPO_B));

        assert.ok(a, 'una cancelada TIENE que salir: es la unica sobre la que se puede reanudar');
        assert.strictEqual(a.status, 'cancelled');
        assert.strictEqual(a.paused, true);
        assert.strictEqual(a.pausedReason, 'de prueba');
        // El nombre viaja aunque venga vacio: si la ruta deja de proyectarlo,
        // el panel enseña "Comunidad 111111" para siempre y nada lo delata.
        assert.ok("groupName" in a, "la ruta tiene que proyectar groupName");
        assert.strictEqual(a.knownMembers, 20);
        assert.strictEqual(a.indexed, 20);
        assert.strictEqual(a.eligible, 20);
        assert.notStrictEqual(b.status, 'cancelled');
        sinRoblox();
    });

    test('las acciones dejan constancia en el historial de actividad', async () => {
        await poblar();
        await pedir(port, 'POST', `/plugin/index/groups/${GRUPO_A}/cancel`);
        await pedir(port, 'POST', `/plugin/index/groups/${GRUPO_A}/resume`);

        const r = await pedir(port, 'GET', '/plugin/index/status');
        const tipos = r.body.events.map(e => e.tipo);
        assert.ok(tipos.includes('group_paused'), 'la cancelacion tiene que quedar anotada');
        assert.ok(tipos.includes('group_resumed'), 'y la reanudacion tambien');
        sinRoblox();
    });

    test('sin x-plugin-key el panel no contesta nada', async () => {
        await poblar();
        const r = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port, path: '/plugin/index/groups', method: 'GET',
            }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
            req.on('error', reject);
            req.end();
        });
        assert.strictEqual(r.status, 401);
        sinRoblox();
    });

    const ok = await suite.run();

    // ── Limpieza ────────────────────────────────────────────────────────────
    //
    // Los 29 archivos corren en el MISMO proceso y en orden alfabetico. Todo lo
    // que se parchee aqui y no se devuelva rompe a los que vienen despues, con
    // fallos que no tienen nada que ver con ellos.
    server.close();
    ownRateLimit.reset();
    jobs.reset();
    eventos.reset();
    base.limpiar();
    base.desinstalar?.();
    cache.reset();
    limitador.reset();

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
    config.indexServe.enabled = original.serveEnabled;
    config.pluginSearch.minAccessories = original.minAccessories;

    return ok;
};
