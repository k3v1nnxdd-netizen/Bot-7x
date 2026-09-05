'use strict';

const { createSuite } = require('./harness');
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
const jobs = require('../services/pluginSearch/jobs');
const { crearBaseFalsa } = require('./fakeDb');

// EL SISTEMA ANTIGUO NO ARRANCA CUANDO EL INDICE SIRVE.
//
// El fallo que esto corrige, visto en produccion: con INDEX_SERVE_ENABLED=true
// las busquedas nuevas ya salian de Postgres, pero al arrancar el servidor se
// adoptaban trabajos asincronos que habian quedado del sistema anterior. En los
// logs se veia:
//
//   Trabajo de busqueda adoptado
//   Runner arrancado tras adoptar
//   Busqueda esperando el turno global del grupo
//
// Esos trabajos se ponian a recorrer comunidades llamando a Roblox, y competian
// por la MISMA cuota que necesita el worker del indice — que es justo lo
// escaso. Nadie los estaba esperando: el plugin ya no sondea.
//
// Ahora, con el indice sirviendo, no se adoptan, no se reanudan y no se
// ejecutan. Se RETIRAN: se marcan como expirados, un estado que el plugin ya
// entiende, en vez de borrarlos — un plugin que siguiera sondeando recibe una
// respuesta clara y no un 404 sin explicacion.
//
// Con INDEX_SERVE_ENABLED=false todo sigue exactamente igual que antes, que es
// lo que hace posible la vuelta atras.

const GRUPO = 59218460;

module.exports = async function run() {
    const suite = createSuite('indexLegacyOff');
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
    };

    const base = crearBaseFalsa();
    base.instalar();

    // ── LA TRAMPA ───────────────────────────────────────────────────────────
    // Cualquier llamada a Roblox durante la recuperacion deja constancia aqui.
    // Un trabajo legacy que arrancara de verdad empezaria pidiendo la primera
    // pagina de miembros, asi que esto lo caza sin depender de contadores.
    const llamadas = [];
    roblox.listGroupMembers = async () => { llamadas.push('listGroupMembers'); return { members: [], nextCursor: null }; };
    roblox.getCurrentAvatar = async () => { llamadas.push('getCurrentAvatar'); return { assets: [], playerAvatarType: null }; };
    roblox.getCatalogItemDetails = async () => { llamadas.push('getCatalogItemDetails'); return new Map(); };

    // Un trabajo del sistema antiguo, huerfano y listo para ser adoptado:
    // exactamente lo que queda en la tabla tras un redeploy.
    function sembrarLegacy(searchId, { estado = 'running' } = {}) {
        base.trabajosPersistidos.set(searchId, {
            searchId, groupId: String(GRUPO), status: estado, target: 10, found: 2,
            candidatesExamined: 40, stoppedBy: null,
            progress: { target: 10, found: 2, candidatesExamined: 40 },
            params: {
                amount: 10, groupId: GRUPO, minPrice: 300, maxPrice: 100000000,
                requireCompletePrice: false, async: true,
            },
            checkpoint: { version: 1, outfits: [{ userId: 1 }, { userId: 2 }], pendientes: [], examinados: 40 },
            phase: 'working', resumeAt: null, rateLimitedRoute: null,
            outfits: [], stats: null, error: null,
            createdAt: Date.now() - 600_000, startedAt: Date.now() - 600_000, finishedAt: null,
            // Latido viejisimo: es un huerfano de manual.
            heartbeatAt: Date.now() - config.pluginJobs.adoptAfterMs - 60_000,
            instanceId: 'instancia-muerta', expiresAt: null,
        });
    }

    function limpiar() {
        cache.reset(); limitador.reset(); colaDeGrupos.reset(); jobs.reset(); base.limpiar();
        llamadas.length = 0;
    }

    // Un ejecutor de mentira: si el runner legacy arranca, se nota aqui.
    function ejecutorEspia() {
        const arrancados = [];
        jobs.registrarEjecutor(trabajo => { arrancados.push(trabajo.searchId); return null; });
        return arrancados;
    }

    // ── 1. Con el indice sirviendo ──────────────────────────────────────────

    test('INDEX_SERVE_ENABLED=true: un job legacy pendiente NO se adopta ni arranca', async () => {
        limpiar();
        config.indexServe.enabled = true;
        const arrancados = ejecutorEspia();
        sembrarLegacy('s_' + 'aa'.repeat(16));

        const r = await jobs.recuperarAlArrancar();

        assert.strictEqual(r.adoptados, 0, 'se adopto un trabajo del sistema antiguo');
        assert.deepStrictEqual(arrancados, [], `el runner legacy arranco: ${arrancados.join(',')}`);
        assert.deepStrictEqual(llamadas, [], `el job legacy llamo a Roblox: ${llamadas.join(', ')}`);
        assert.strictEqual(jobs.tamano(), 0, 'el trabajo se cargo en memoria pese a no ejecutarse');
    });

    test('el job legacy queda RETIRADO como expirado, no borrado', async () => {
        limpiar();
        config.indexServe.enabled = true;
        ejecutorEspia();
        const id = 's_' + 'bb'.repeat(16);
        sembrarLegacy(id);

        const r = await jobs.recuperarAlArrancar();

        assert.strictEqual(r.legacyRetirado, 1);
        const fila = base.trabajosPersistidos.get(id);
        assert.ok(fila, 'la fila se borro en vez de marcarse');
        assert.strictEqual(fila.status, 'expired');
        assert.strictEqual(fila.errorCode, 'index_serving',
            'no consta POR QUE se retiro');
        assert.strictEqual(fila.instanceId, null, 'quedo con dueño');
    });

    test('tambien se retiran los que estaban en cola, no solo los que corrian', async () => {
        limpiar();
        config.indexServe.enabled = true;
        ejecutorEspia();
        sembrarLegacy('s_' + 'cc'.repeat(16), { estado: 'queued' });
        sembrarLegacy('s_' + 'dd'.repeat(16), { estado: 'running' });

        const r = await jobs.recuperarAlArrancar();

        assert.strictEqual(r.legacyRetirado, 2);
        assert.deepStrictEqual(llamadas, []);
        for (const fila of base.trabajosPersistidos.values()) {
            assert.strictEqual(fila.status, 'expired');
        }
    });

    test('la retirada es idempotente: al segundo arranque no queda nada que hacer', async () => {
        limpiar();
        config.indexServe.enabled = true;
        ejecutorEspia();
        sembrarLegacy('s_' + 'ee'.repeat(16));

        const primero = await jobs.recuperarAlArrancar();
        assert.strictEqual(primero.legacyRetirado, 1);

        const segundo = await jobs.recuperarAlArrancar();
        assert.strictEqual(segundo.legacyRetirado, 0, 'volvio a retirar algo ya retirado');
        assert.deepStrictEqual(llamadas, []);
    });

    test('el barrido periodico tampoco los resucita', async () => {
        // server.js llama a recuperarAlArrancar en un intervalo, no solo al
        // arrancar: si la puerta fallara ahi, los trabajos volverian a la vida
        // unos segundos despues del despliegue.
        limpiar();
        config.indexServe.enabled = true;
        const arrancados = ejecutorEspia();
        sembrarLegacy('s_' + 'ff'.repeat(16));

        for (let i = 0; i < 5; i++) await jobs.recuperarAlArrancar();

        assert.deepStrictEqual(arrancados, []);
        assert.deepStrictEqual(llamadas, []);
    });

    // ── 2. Con el indice apagado: comportamiento de siempre ─────────────────

    test('INDEX_SERVE_ENABLED=false: el sistema antiguo se adopta y arranca como siempre', async () => {
        limpiar();
        config.indexServe.enabled = false;
        const arrancados = ejecutorEspia();
        const id = 's_' + '11'.repeat(16);
        sembrarLegacy(id);

        const r = await jobs.recuperarAlArrancar();

        assert.strictEqual(r.adoptados, 1, 'no se adopto el trabajo huerfano');
        assert.deepStrictEqual(arrancados, [id], 'el runner no arranco tras adoptar');
        assert.strictEqual(base.trabajosPersistidos.get(id).status, 'running',
            'se retiro un trabajo que deberia haberse reanudado');
    });

    test('INDEX_SERVE_ENABLED=false conserva el checkpoint al reanudar', async () => {
        limpiar();
        config.indexServe.enabled = false;
        ejecutorEspia();
        const id = 's_' + '22'.repeat(16);
        sembrarLegacy(id);

        await jobs.recuperarAlArrancar();

        const trabajo = await jobs.obtener(id);
        assert.ok(trabajo, 'el trabajo adoptado no esta en memoria');
        assert.strictEqual(trabajo.checkpoint.outfits.length, 2,
            'se perdio lo que el trabajo ya habia encontrado');
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
    cache.reset();
    limitador.reset();
    colaDeGrupos.reset();
    jobs.reset();
    return ok;
};
