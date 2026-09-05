'use strict';

const http = require('http');
const { createSuite, axiosError } = require('./harness');
const { createApp } = require('../app');
const ownRateLimit = require('../security/rateLimit');
const robloxRateLimiter = require('../roblox/rateLimiter');
const roblox = require('../roblox/client');
const cache = require('../cache/cacheStore');
const config = require('../config');
const repo = require('../db/pluginRotationRepo');
const jobRepo = require('../db/pluginJobRepo');
const jobsA = require('../services/pluginSearch/jobs');
const { crearRunner } = require('../services/pluginSearch/runner');
const { crearBaseFalsa } = require('./fakeDb');

// ENTREGA PROGRESIVA Y CONTINUIDAD ANTE ROBLOX.
//
// El criterio de aceptacion, literal: si se piden 10 y existen al menos 10
// outfits validos, la busqueda continua aunque Roblox la obligue a esperar, y
// el plugin va recibiendo los outfits encontrados hasta llegar a 10 de 10.
//
// La prueba principal es identica a produccion: target 10, comunidad
// mayoritariamente inservible (tres accesorios o menos, baratos, borrados,
// vacios, ~3% validos), varios 429 de avatar Y de catalogo — uno de ellos con
// un Retry-After que el antiguo techo por pausa habria rechazado —, y el
// trabajo inspeccionado en CADA poll. Lo que tiene que verse:
//
//   running  found 2  outfits 2
//   waiting  found 2  outfits 2      <- Roblox pidio esperar; los 2 siguen ahi
//   running  found 5  outfits 5
//   waiting  found 5  outfits 5
//   ...
//   completed found 10 outfits 10
//
// y NUNCA "partial 2 de 10" porque Roblox pidiera esperar.

const GROUP_ID = 59218460;
const CLAVE_PLUGIN = config.pluginApiKey;
const INSTANCIA_B = 'instancia-B-progresiva';

function pedir(port, metodo, ruta, cuerpo) {
    ownRateLimit.reset();
    const payload = cuerpo === undefined ? null : JSON.stringify(cuerpo);
    const headers = { 'x-plugin-key': CLAVE_PLUGIN };
    if (payload !== null) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = Buffer.byteLength(payload);
    }
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: ruta, method: metodo, headers }, res => {
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

const dormir = ms => new Promise(r => setTimeout(r, ms));

// Tipos de asset reales, para que la regla de accesorios decida como en
// produccion.
const T = { Hat: 8, Hair: 41, Face: 42, Neck: 43, Front: 45, Back: 46, Waist: 47, Shirt: 11, Pants: 12, Torso: 27, Head: 17, Emote: 61, Mood: 78 };

module.exports = async function run() {
    const suite = createSuite('pluginProgressive');
    const { test, assert } = suite;

    const app = createApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;

    const original = {
        listGroupMembers: roblox.listGroupMembers,
        getCurrentAvatar: roblox.getCurrentAvatar,
        getCatalogItemDetails: roblox.getCatalogItemDetails,
        repo: { ...repo },
        jobRepo: { ...jobRepo },
        cfg: {
            minAccessories: config.pluginSearch.minAccessories,
            heartbeat: config.pluginJobs.heartbeatIntervalMs,
            adopt: config.pluginJobs.adoptAfterMs,
            parkHeartbeat: config.pluginSearch.rateLimitHeartbeatMs,
            margen: config.pluginSearch.rateLimitWaitMarginMs,
            presupuesto: config.pluginSearch.rateLimitWaitBudgetMs,
            cache: config.cache.maxEntries,
        },
    };

    config.pluginSearch.minAccessories = 4;
    config.pluginJobs.heartbeatIntervalMs = 40;
    config.pluginJobs.adoptAfterMs = 400;
    config.pluginSearch.rateLimitHeartbeatMs = 40;
    config.pluginSearch.rateLimitWaitMarginMs = 20;
    config.pluginSearch.rateLimitWaitBudgetMs = 60_000;
    config.cache.maxEntries = 10_000;

    const base = crearBaseFalsa();
    base.instalar();
    const jobsB = jobsA.crearRegistro({ instancia: INSTANCIA_B });
    crearRunner(jobsB);

    // ── La comunidad de produccion ───────────────────────────────────────────
    //   % 37 == 0  borrado (404) · % 41 == 0  vacio · % 30 == 8  VALIDO (~3%)
    //   % 10 <  5  tres accesorios o menos (NO puede ir al catalogo)
    //   resto      accesorios de sobra pero baratos (cae por minPrice)
    const MIEMBROS = 900;
    const clase = userId => {
        if (userId % 37 === 0) return 'borrado';
        if (userId % 41 === 0) return 'vacio';
        if (userId % 30 === 8) return 'valido';
        if (userId % 10 < 5) return 'pocosAccesorios';
        return 'barato';
    };
    const VALIDOS = [];
    for (let i = 0; i < MIEMBROS && VALIDOS.length < 10; i++) if (clase(1000 + i) === 'valido') VALIDOS.push(1000 + i);
    const usuarioDeAsset = id => Math.floor(Number(id) / 100);

    function avatarDe(userId) {
        const a = (k, tipo) => ({ id: userId * 100 + k, name: `A${k}`, assetTypeId: tipo, assetTypeName: null });
        switch (clase(userId)) {
            case 'vacio': return { assets: [], playerAvatarType: 'R15' };
            case 'pocosAccesorios': return { assets: [a(0, T.Hat), a(1, T.Hair), a(2, T.Back), a(3, T.Shirt), a(4, T.Torso), a(5, T.Head), a(6, T.Emote), a(7, T.Mood)], playerAvatarType: 'R15' };
            case 'valido': return { assets: [a(0, T.Hat), a(1, T.Hair), a(2, T.Back), a(3, T.Waist), a(4, T.Shirt), a(5, T.Torso)], playerAvatarType: 'R15' };
            default: return { assets: [a(0, T.Hat), a(1, T.Hair), a(2, T.Face), a(3, T.Neck), a(4, T.Front), a(5, T.Pants)], playerAvatarType: 'R15' };
        }
    }

    let mundo = {};
    const medidas = {};
    function poblar() {
        mundo = { avatar429En: new Set(), catalogo429En: new Set(), retryAfterS: '1' };
        Object.assign(medidas, { avatares: 0, lotes: 0, catalogoAssets: [], instantes: [] });
        cache.reset();
        base.limpiar();
        jobsA.reset();
        jobsB.reset();
        robloxRateLimiter.reset();
    }

    roblox.listGroupMembers = async (groupId, { cursor = null } = {}) => {
        const pagina = cursor ? Number(String(cursor).slice(1)) : 0;
        const desde = pagina * 100;
        const hasta = Math.min(desde + 100, MIEMBROS);
        const members = [];
        for (let i = desde; i < hasta; i++) members.push({ userId: 1000 + i, username: `U${1000 + i}` });
        return { members, nextCursor: hasta < MIEMBROS ? `p${pagina + 1}` : null };
    };

    roblox.getCurrentAvatar = async userId => {
        const r = await robloxRateLimiter.run('userAvatar', async () => {
            medidas.avatares++;
            medidas.instantes.push(Date.now());
            await dormir(4);
            if (mundo.avatar429En.has(medidas.avatares)) {
                throw axiosError(429, { 'retry-after': mundo.retryAfterS, 'x-ratelimit-remaining': '0' });
            }
            if (clase(userId) === 'borrado') throw axiosError(404);
            return { status: 200, headers: {}, data: avatarDe(userId) };
        }, { endpoint: 'avatar.roblox.com/v1/users/{id}/avatar', notFoundCode: 'user_not_found' });
        return r.data;
    };

    roblox.getCatalogItemDetails = async items => {
        await robloxRateLimiter.run('catalogDetails', async () => {
            medidas.lotes++;
            if (mundo.catalogo429En.has(medidas.lotes)) {
                throw axiosError(429, { 'retry-after': mundo.retryAfterS, 'x-ratelimit-remaining': '0' });
            }
            return { status: 200, headers: {}, data: {} };
        }, { endpoint: 'catalog.roblox.com/v1/catalog/items/details' });
        const mapa = new Map();
        for (const item of items) {
            medidas.catalogoAssets.push(String(item.id));
            mapa.set(roblox.catalogKey('Asset', item.id), {
                available: true, assetTypeId: 8, isLimited: false, offSale: false,
                price: clase(usuarioDeAsset(item.id)) === 'valido' ? 100 : 10,
            });
        }
        return mapa;
    };

    const TERMINAL = new Set(['completed', 'partial', 'failed', 'expired']);
    const buscar = (extra = {}) => pedir(port, 'POST', '/plugin/outfits/search', {
        amount: 10, groupId: GROUP_ID, minPrice: 300, maxPrice: 100_000_000, requireCompletePrice: false, async: true, ...extra,
    });
    const consultar = id => pedir(port, 'GET', `/plugin/outfits/search/${id}`);

    // Sigue un trabajo hasta que termine, guardando UNA foto por poll y
    // comprobando en cada una las invariantes que el plugin necesita.
    async function seguir(id, { lector = consultar, plazoMs = 60_000 } = {}) {
        const fotos = [];
        const limite = Date.now() + plazoMs;
        let anterior = null;
        for (;;) {
            const res = await lector(id);
            const b = res.body ?? res;
            const ids = (b.outfits ?? []).map(o => o.userId);
            const foto = { status: b.status, phase: b.phase, found: b.found, outfits: ids.length, ids };
            fotos.push(foto);

            // Invariantes, en CADA poll:
            assert.strictEqual(foto.outfits, foto.found, `poll ${fotos.length}: found=${foto.found} pero outfits.length=${foto.outfits}`);
            assert.strictEqual(new Set(ids).size, ids.length, `poll ${fotos.length}: userIds duplicados en la lista`);
            if (anterior) {
                assert.ok(foto.found >= anterior.found, `poll ${fotos.length}: found bajo de ${anterior.found} a ${foto.found}`);
                // Estable: lo entregado antes es prefijo de lo entregado ahora.
                for (let i = 0; i < anterior.ids.length; i++) {
                    assert.strictEqual(ids[i], anterior.ids[i], `poll ${fotos.length}: el outfit ${anterior.ids[i]} desaparecio o cambio de sitio`);
                }
            }
            if (b.progress) {
                assert.strictEqual(b.progress.found, foto.found, 'progress.found no coincide con la lista entregada');
                assert.strictEqual(typeof b.progress.waitingForRoblox, 'boolean');
                assert.ok(Number.isFinite(b.progress.rejectedTooFewAccessories));
            }
            assert.notStrictEqual(b.status, 'partial', `poll ${fotos.length}: partial con ${foto.found}/10 por ${b.stoppedBy}`);

            if (TERMINAL.has(b.status)) return { fin: b, fotos };
            if (Date.now() > limite) throw new Error(`plazo agotado: ${JSON.stringify(foto)}`);
            anterior = foto;
            await dormir(12);
        }
    }

    // Resumen legible de la secuencia: solo los cambios de (status/phase/found).
    function etapas(fotos) {
        const out = [];
        for (const f of fotos) {
            const clave = `${f.status}/${f.phase}/${f.found}`;
            if (out.length === 0 || out[out.length - 1].clave !== clave) out.push({ clave, ...f });
        }
        return out;
    }

    // ── 1. La prueba de produccion, inspeccionada en cada poll ──────────────

    test('PRODUCCION: de 0 a 10 entregando outfits en cada poll, atravesando varios 429 de avatar y catalogo, sin partial', async () => {
        poblar();
        // 429 de avatar en las peticiones 40 y 130, de catalogo en el lote 4.
        // La segunda pausa de avatar pide un Retry-After de 2 s: el antiguo
        // techo por pausa (20 s en produccion frente a 25 s reales) la habria
        // rechazado; aqui se escala igual.
        mundo.avatar429En = new Set([40, 130]);
        mundo.catalogo429En = new Set([4]);
        mundo.retryAfterS = '2';

        const { body: creado } = await buscar();
        assert.ok(['queued', 'running'].includes(creado.status), `el POST respondio ${creado.status}`);

        const { fin, fotos } = await seguir(creado.searchId);
        const secuencia = etapas(fotos);

        // ── El resultado ─────────────────────────────────────────────────────
        assert.strictEqual(fin.status, 'completed', `termino ${fin.status} por ${fin.stoppedBy}`);
        assert.strictEqual(fin.found, 10);
        assert.strictEqual(fin.outfits.length, 10);
        assert.deepStrictEqual(fin.outfits.map(o => o.userId).sort((a, b) => a - b), VALIDOS, 'no son los diez primeros validos');
        assert.strictEqual(fin.stats.stoppedBy, 'completed');

        // ── La secuencia que tiene que verse ─────────────────────────────────
        // Hubo entregas parciales DURANTE running (no solo al final)...
        const parciales = fotos.filter(f => f.status === 'running' && f.found > 0 && f.found < 10);
        assert.ok(parciales.length >= 3, `solo ${parciales.length} polls con outfits parciales en running`);
        // ...con esperas a Roblox en las que los outfits ya entregados siguen ahi...
        const esperas = fotos.filter(f => f.phase === 'rateLimitWait');
        assert.ok(esperas.length >= 2, `solo ${esperas.length} polls en espera: no se vieron varios cooldowns`);
        for (const e of esperas) assert.strictEqual(e.outfits, e.found, 'en espera se perdieron outfits ya entregados');
        assert.ok(esperas.some(e => e.found >= 2), 'ninguna espera conservo outfits ya encontrados');
        // ...y found subio en varios escalones distintos hasta 10.
        const escalones = [...new Set(fotos.map(f => f.found))];
        assert.ok(escalones.length >= 4, `found solo tomo ${escalones.length} valores: ${escalones.join(',')}`);
        assert.strictEqual(escalones[escalones.length - 1], 10);

        // ── Continuidad ante Roblox ──────────────────────────────────────────
        assert.ok(fin.stats.rateLimitWaits >= 2, `estaciono solo ${fin.stats.rateLimitWaits} veces`);
        assert.strictEqual(fin.stats.stoppedByRobloxRateLimit, false);
        assert.strictEqual(fin.stats.avatarDeferred, fin.stats.deferredResumed);
        assert.ok(fin.stats.rejectedTooFewAccessories > 0);
        const usuariosEnCatalogo = new Set(medidas.catalogoAssets.map(usuarioDeAsset));
        assert.strictEqual([...usuariosEnCatalogo].filter(u => clase(u) === 'pocosAccesorios').length, 0,
            'un candidato con tres accesorios o menos gasto catalogo');
        assert.strictEqual(fin.stats.rotationCycle, 1);

        // Para el informe.
        // eslint-disable-next-line no-console
        console.log('       secuencia: ' + secuencia.map(e => `${e.status}${e.phase && e.phase !== 'working' ? '(' + e.phase + ')' : ''} found ${e.found} outfits ${e.outfits}`).join(' -> '));

    });

    test('un 429 no incrementa avatarError: los rechazos de avatar son SOLO los usuarios borrados', async () => {
        poblar();
        mundo.avatar429En = new Set([25, 60, 95]);
        mundo.retryAfterS = '1';
        const { body: creado } = await buscar();
        const { fin } = await seguir(creado.searchId);
        assert.strictEqual(fin.status, 'completed');
        // Cuantos 'borrado' hay entre los examinados, contados desde el primero.
        let borrados = 0;
        let examinadosVistos = 0;
        for (let i = 0; examinadosVistos < fin.stats.candidatesExamined && i < MIEMBROS; i++) {
            examinadosVistos++;
            if (clase(1000 + i) === 'borrado') borrados++;
        }
        assert.ok(Math.abs(fin.stats.rejectedAvatarError - borrados) <= 1,
            `rejectedAvatarError=${fin.stats.rejectedAvatarError} pero solo hubo ~${borrados} borrados: hay 429 contados como error`);
        assert.ok(fin.stats.avatarRateLimited >= 3);
    });

    // ── 2. Reinicio con varios outfits ya encontrados ────────────────────────

    test('REINICIO con varios outfits: el mismo searchId conserva los encontrados y sigue aumentando la lista', async () => {
        poblar();
        mundo.avatar429En = new Set([90]);
        const { body: creado } = await buscar();
        const id = creado.searchId;

        // Se deja avanzar hasta llevar al menos 3 entregados.
        let visto;
        for (let i = 0; i < 2000; i++) {
            visto = (await consultar(id)).body;
            if (visto.found >= 3) break;
            await dormir(12);
        }
        assert.ok(visto.found >= 3, `no llego a 3 antes del reinicio (${visto.found})`);
        const antes = visto.outfits.map(o => o.userId);

        // La copia caliente de ANTES de morir: es la que la busqueda vieja
        // seguiria usando desde sus ganchos.
        const copiaVieja = await jobsA.obtener(id);

        // El proceso muere: deja de latir, la busqueda para, la fila envejece.
        jobsA.__simularMuerte();
        base.instanciaMuereCon(id);
        robloxRateLimiter.reset();
        await dormir(120);

        // El GET, aun antes de la adopcion, sigue entregando lo encontrado.
        const durante = (await consultar(id)).body;
        assert.ok(durante.found >= antes.length, 'el reinicio hizo desaparecer outfits ya entregados');
        assert.deepStrictEqual(durante.outfits.map(o => o.userId).slice(0, antes.length), antes);

        // La instancia (nueva) recupera y continua. La copia vieja del
        // trabajo (la que tenia la busqueda muerta) deja de ser vigente: sus
        // ganchos, aunque siguieran vivos en este proceso, no pueden escribir
        // sobre la nueva. Sin esto un poll veia found 4 y el siguiente 3.
        assert.strictEqual((await jobsA.recuperarAlArrancar()).adoptados, 1);
        const copiaNueva = await jobsA.obtener(id);
        assert.notStrictEqual(copiaNueva, copiaVieja, 'la readopcion reutilizo la copia muerta');
        assert.strictEqual(jobsA.esVigente(copiaNueva), true);
        assert.strictEqual(jobsA.esVigente(copiaVieja), false, 'la copia vieja sigue contando como vigente');
        const { fin, fotos } = await seguir(id);
        assert.strictEqual(fin.status, 'completed');
        assert.strictEqual(fin.found, 10);
        assert.deepStrictEqual(fin.outfits.map(o => o.userId).slice(0, antes.length), antes, 'el reinicio cambio los outfits ya entregados');
        assert.deepStrictEqual(fin.outfits.map(o => o.userId).sort((a, b) => a - b), VALIDOS);
        assert.ok(fotos[0].found >= antes.length, 'tras el reinicio la lista arranco por debajo de lo ya entregado');
    });

    // ── 3. Handoff entre instancias con varios outfits ──────────────────────

    test('HANDOFF A->B con varios outfits: B recibe el mismo acumulado y sigue sin perder ni duplicar', async () => {
        poblar();
        mundo.avatar429En = new Set([110]);
        const { body: creado } = await buscar();
        const id = creado.searchId;

        let visto;
        for (let i = 0; i < 2000; i++) {
            visto = (await consultar(id)).body;
            if (visto.found >= 4) break;
            await dormir(12);
        }
        assert.ok(visto.found >= 4, `no llego a 4 antes del traspaso (${visto.found})`);
        const antes = visto.outfits.map(o => o.userId);

        // B arranca con A viva: no roba.
        assert.strictEqual((await jobsB.recuperarAlArrancar()).adoptados, 0);

        // A muere; B adopta con el acumulado.
        jobsA.__simularMuerte();
        base.instanciaMuereCon(id);
        robloxRateLimiter.reset();
        await dormir(100);
        assert.strictEqual((await jobsB.recuperarAlArrancar()).adoptados, 1);
        const enB = jobsB.presentar(await jobsB.obtener(id));
        assert.strictEqual(enB.ownership.instance, INSTANCIA_B);
        assert.deepStrictEqual(enB.outfits.map(o => o.userId).slice(0, antes.length), antes, 'B no recibio el mismo acumulado');

        // Se sigue por HTTP (A sirve la fila de la base) y desde B: mismo resultado.
        const { fin } = await seguir(id);
        assert.strictEqual(fin.status, 'completed');
        assert.strictEqual(fin.found, 10);
        assert.strictEqual(fin.ownership.instance, INSTANCIA_B);
        assert.strictEqual(fin.ownership.handoffs, 1);
        assert.deepStrictEqual(fin.outfits.map(o => o.userId).slice(0, antes.length), antes);
        assert.deepStrictEqual(fin.outfits.map(o => o.userId).sort((a, b) => a - b), VALIDOS);
        const desdeB = jobsB.presentar(await jobsB.obtener(id));
        assert.deepStrictEqual(desdeB.outfits.map(o => o.userId), fin.outfits.map(o => o.userId));
    });

    // ── 4. Una pausa larga no termina nada ──────────────────────────────────

    test('un Retry-After largo (mayor que el antiguo techo por pausa) cambia la fase y la busqueda continua', async () => {
        poblar();
        mundo.avatar429En = new Set([40]);
        mundo.retryAfterS = '3';
        const { body: creado } = await buscar();
        const { fin, fotos } = await seguir(creado.searchId);

        assert.strictEqual(fin.status, 'completed');
        assert.strictEqual(fin.found, 10);
        const espera = fotos.find(f => f.phase === 'rateLimitWait');
        assert.ok(espera, 'no se vio la fase de espera');
        assert.ok(fin.stats.rateLimitWaitedMs >= 2_500, `espero solo ${fin.stats.rateLimitWaitedMs} ms`);
        assert.ok(fin.stats.workingMs < fin.stats.durationMs - 2_000, 'la espera se conto como trabajo');
    });

    const ok = await suite.run();

    roblox.listGroupMembers = original.listGroupMembers;
    roblox.getCurrentAvatar = original.getCurrentAvatar;
    roblox.getCatalogItemDetails = original.getCatalogItemDetails;
    Object.assign(repo, original.repo);
    Object.assign(jobRepo, original.jobRepo);
    config.pluginSearch.minAccessories = original.cfg.minAccessories;
    config.pluginJobs.heartbeatIntervalMs = original.cfg.heartbeat;
    config.pluginJobs.adoptAfterMs = original.cfg.adopt;
    config.pluginSearch.rateLimitHeartbeatMs = original.cfg.parkHeartbeat;
    config.pluginSearch.rateLimitWaitMarginMs = original.cfg.margen;
    config.pluginSearch.rateLimitWaitBudgetMs = original.cfg.presupuesto;
    config.cache.maxEntries = original.cfg.cache;
    cache.reset();
    ownRateLimit.reset();
    robloxRateLimiter.reset();
    jobsA.reset();
    jobsB.reset();
    await new Promise(resolve => server.close(resolve));
    return ok;
};
