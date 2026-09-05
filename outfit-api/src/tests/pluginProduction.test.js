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
const jobs = require('../services/pluginSearch/jobs');
const { crearBaseFalsa } = require('./fakeDb');
const { crearStats } = require('../services/pluginSearch/stats');
const { __juzgar: juzgar } = require('../services/pluginSearch/avatarWave');
const { countAccessories, isAccessory } = require('../catalog/assetTypes');

// LA PRUEBA DE PRODUCCION. Reproduce el escenario que hoy termina en 2 de 10:
//
//   amount 10 · grupo con MUCHOS usuarios que no sirven (la mayoria con tres
//   accesorios o menos, otros baratos, algunos borrados o vacios) · ~3% de
//   outfits validos · presion REAL de rate limit en el avatar durante la
//   busqueda, con 429 que traen Retry-After y 429 que no traen nada.
//
// Y comprueba, sobre esa misma busqueda, TODO lo que tiene que cumplirse:
//
//   - termina completed con 10 de 10
//   - no hay usuarios duplicados ni candidatos perdidos por el limite
//   - CERO peticiones al avatar mientras la ruta esta cerrada
//   - un 429 no se convierte en avatarError
//   - los avatares con tres accesorios o menos NO gastan catalogo
//   - atraviesa mas de un cooldown y sigue buscando usuarios nuevos
//   - no termina por ningun limite arbitrario de candidatos
//
// Todo con cooldowns de milisegundos para no tardar los 25 s reales.

const GROUP_ID = 59218460;
const CLAVE_PLUGIN = config.pluginApiKey;

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

// ── Tipos de asset de Roblox, por nombre, para montar avatares realistas ─────
const T = {
    Hat: 8, Hair: 41, Face: 42, Neck: 43, Shoulder: 44, Front: 45, Back: 46, Waist: 47,
    Shirt: 11, Pants: 12, TShirt: 2, Head: 17, FaceDecal: 18, Gear: 19,
    Torso: 27, RightArm: 28, LeftArm: 29, LeftLeg: 30, RightLeg: 31,
    Idle: 51, Emote: 61, Mood: 78, DynamicHead: 79, JacketLayered: 67,
};

module.exports = async function run() {
    const suite = createSuite('pluginProduction');
    const { test, assert } = suite;

    // ── Unidad: la regla de los accesorios ───────────────────────────────────

    test('countAccessories cuenta SOLO accesorios reales, distintos', () => {
        const avatar = [
            { id: 1, assetTypeId: T.Hat }, { id: 2, assetTypeId: T.Hair }, { id: 3, assetTypeId: T.Back },
            { id: 3, assetTypeId: T.Back },                   // repetido: cuenta una vez
            { id: 4, assetTypeId: T.Shirt }, { id: 5, assetTypeId: T.Pants }, { id: 6, assetTypeId: T.TShirt },
            { id: 7, assetTypeId: T.Head }, { id: 8, assetTypeId: T.FaceDecal }, { id: 9, assetTypeId: T.Torso },
            { id: 10, assetTypeId: T.LeftArm }, { id: 11, assetTypeId: T.Idle }, { id: 12, assetTypeId: T.Emote },
            { id: 13, assetTypeId: T.Mood }, { id: 14, assetTypeId: T.DynamicHead }, { id: 15, assetTypeId: T.Gear },
            { id: 16, assetTypeId: null }, { id: 17 },       // tipo desconocido: no se adivina
        ];
        assert.strictEqual(countAccessories(avatar), 3);
        assert.strictEqual(countAccessories([...avatar, { id: 18, assetTypeId: T.JacketLayered }]), 4);
        for (const tipo of [T.Shirt, T.Pants, T.TShirt, T.Head, T.FaceDecal, T.Torso, T.Idle, T.Emote, T.Mood, T.DynamicHead, T.Gear]) {
            assert.strictEqual(isAccessory(tipo), false, `el tipo ${tipo} no es un accesorio`);
        }
    });

    test('tres accesorios o menos -> tooFewAccessories, con la respuesta del avatar en la mano', () => {
        const original = config.pluginSearch.minAccessories;
        config.pluginSearch.minAccessories = 4;
        try {
            const stats = crearStats();
            const miembro = { userId: 1, username: 'u' };
            const tres = juzgar(miembro, { assets: [
                { id: 1, assetTypeId: T.Hat }, { id: 2, assetTypeId: T.Hair }, { id: 3, assetTypeId: T.Back },
                { id: 4, assetTypeId: T.Torso }, { id: 5, assetTypeId: T.Shirt }, { id: 6, assetTypeId: T.Emote },
            ] }, stats);
            assert.strictEqual(tres.ok, false);
            assert.strictEqual(tres.motivo, 'tooFewAccessories');
            assert.strictEqual(tres.assetIds, undefined, 'un descartado no puede llevar assets al catalogo');

            const cuatro = juzgar(miembro, { assets: [
                { id: 1, assetTypeId: T.Hat }, { id: 2, assetTypeId: T.Hair }, { id: 3, assetTypeId: T.Back },
                { id: 4, assetTypeId: T.Waist }, { id: 5, assetTypeId: T.Torso },
            ] }, stats);
            assert.strictEqual(cuatro.ok, true);
            assert.strictEqual(cuatro.accessories, 4);
            assert.strictEqual(cuatro.assetIds.length, 5, 'los assets no accesorio SI se valoran, solo no cuentan para la regla');

            // 0 apaga la regla (es como corre el resto de la suite).
            config.pluginSearch.minAccessories = 0;
            assert.strictEqual(juzgar(miembro, { assets: [{ id: 1, assetTypeId: T.Hat }] }, stats).ok, true);
        } finally {
            config.pluginSearch.minAccessories = original;
        }
    });

    // ── El escenario de produccion ───────────────────────────────────────────

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
            heartbeat: config.pluginSearch.rateLimitHeartbeatMs,
            margen: config.pluginSearch.rateLimitWaitMarginMs,
            presupuesto: config.pluginSearch.rateLimitWaitBudgetMs,
            cache: config.cache.maxEntries,
        },
    };

    config.pluginSearch.minAccessories = 4;
    config.pluginSearch.rateLimitHeartbeatMs = 40;
    config.pluginSearch.rateLimitWaitMarginMs = 20;
    config.pluginSearch.rateLimitWaitBudgetMs = 60_000;
    config.cache.maxEntries = 10_000;

    const base = crearBaseFalsa();
    base.instalar();

    // ── La comunidad: como la real, la mayoria no sirve ──────────────────────
    //
    //   userId % 37 == 0            borrado (404)
    //   userId % 41 == 0            avatar vacio
    //   userId % 30 == 8            VALIDO: 4 accesorios a 100 R$ = 400 >= 300   (~3%)
    //   userId % 10 <  5            tres accesorios o menos: NO puede ir al catalogo
    //   resto                       4-5 accesorios a 10 R$: cae por minPrice
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
    // Los assets de un usuario son userId*100 + k: de un assetId se saca el usuario.
    const usuarioDeAsset = assetId => Math.floor(Number(assetId) / 100);

    function avatarDe(userId) {
        const a = (k, tipo) => ({ id: userId * 100 + k, name: `A${k}`, assetTypeId: tipo, assetTypeName: null });
        switch (clase(userId)) {
            case 'vacio': return { assets: [], playerAvatarType: 'R15' };
            case 'pocosAccesorios': return { assets: [
                a(0, T.Hat), a(1, T.Hair), a(2, T.Back),        // 3 accesorios
                a(3, T.Shirt), a(4, T.Pants), a(5, T.Torso), a(6, T.Head), a(7, T.Emote), a(8, T.Mood),
            ], playerAvatarType: 'R15' };
            case 'valido': return { assets: [
                a(0, T.Hat), a(1, T.Hair), a(2, T.Back), a(3, T.Waist),  // 4 accesorios
                a(4, T.Shirt), a(5, T.Torso),
            ], playerAvatarType: 'R15' };
            default: return { assets: [
                a(0, T.Hat), a(1, T.Hair), a(2, T.Face), a(3, T.Neck), a(4, T.Front),  // 5 accesorios baratos
                a(5, T.Pants),
            ], playerAvatarType: 'R15' };
        }
    }

    const medidas = {
        avatares: 0, avatar429s: 0, enVuelo: 0, maxEnVuelo: 0,
        instantes: [], ventanasCerradas: [], catalogoAssets: [], lotes: 0,
    };

    // ── Roblox de mentira: cuota por ventana con cabeceras, y 429 forzados ───
    // La cuota se publica por cabeceras (limit / remaining / reset), como hace
    // Roblox. Ademas se fuerzan dos 429 en momentos fijos para garantizar que
    // la busqueda atraviesa los DOS caminos: uno CON Retry-After y otro SIN
    // ninguna cabecera de espera.
    const CUOTA = 40, VENTANA_MS = 1000;
    let ventana = { inicio: Date.now(), usadas: 0 };

    function cerrarVentana(ms, conCabecera) {
        const desde = Date.now();
        medidas.ventanasCerradas.push({ desde, hasta: desde + ms, conCabecera });
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
            const ahora = Date.now();
            medidas.avatares++;
            medidas.instantes.push(ahora);
            medidas.enVuelo++;
            medidas.maxEnVuelo = Math.max(medidas.maxEnVuelo, medidas.enVuelo);
            try {
                await dormir(3);
                if (ahora - ventana.inicio >= VENTANA_MS) ventana = { inicio: ahora, usadas: 0 };
                ventana.usadas++;
                const quedan = Math.max(0, CUOTA - ventana.usadas);
                const resetS = Math.max(1, Math.ceil((ventana.inicio + VENTANA_MS - ahora) / 1000));

                // 429 forzados: CON Retry-After (peticiones 30 y 150) y SIN
                // ninguna cabecera (peticion 90), para atravesar los dos caminos.
                if (medidas.avatares === 30 || medidas.avatares === 150) {
                    medidas.avatar429s++;
                    cerrarVentana(1_000, true);
                    throw axiosError(429, { 'retry-after': '1', 'x-ratelimit-limit': String(CUOTA), 'x-ratelimit-remaining': '0' });
                }
                if (medidas.avatares === 90) {
                    medidas.avatar429s++;
                    // Sin cabecera, el limitador espera su escalon conservador;
                    // esa es la ventana en la que no puede salir nada.
                    cerrarVentana(config.upstream.rateLimitFallbackBaseMs, false);
                    throw axiosError(429, {});
                }
                if (ventana.usadas > CUOTA) {
                    medidas.avatar429s++;
                    cerrarVentana(resetS * 1000, true);
                    throw axiosError(429, { 'retry-after': String(resetS), 'x-ratelimit-limit': String(CUOTA), 'x-ratelimit-remaining': '0' });
                }
                if (clase(userId) === 'borrado') throw axiosError(404);

                return {
                    status: 200,
                    headers: {
                        'x-ratelimit-limit': String(CUOTA),
                        'x-ratelimit-remaining': String(quedan),
                        'x-ratelimit-reset': String(resetS),
                    },
                    data: avatarDe(userId),
                };
            } finally {
                medidas.enVuelo--;
            }
        }, { endpoint: 'avatar.roblox.com/v1/users/{id}/avatar', notFoundCode: 'user_not_found' });
        return r.data;
    };

    // El catalogo tambien pasa por el limitador REAL, como en produccion: asi
    // `catalogRouteCalls` (lo que cuenta el limitador) se puede cotejar con los
    // lotes que el Roblox de mentira recibio.
    roblox.getCatalogItemDetails = async items => {
        await robloxRateLimiter.run('catalogDetails', async () => {
            medidas.lotes++;
            return { status: 200, headers: {}, data: {} };
        }, { endpoint: 'catalog.roblox.com/v1/catalog/items/details' });
        const mapa = new Map();
        for (const item of items) {
            medidas.catalogoAssets.push(String(item.id));
            const userId = usuarioDeAsset(item.id);
            mapa.set(roblox.catalogKey('Asset', item.id), {
                available: true, assetTypeId: 8, isLimited: false, offSale: false,
                price: clase(userId) === 'valido' ? 100 : 10,
            });
        }
        return mapa;
    };

    const consultar = id => pedir(port, 'GET', `/plugin/outfits/search/${id}`);
    async function esperarTerminal(id, { plazoMs = 60_000 } = {}) {
        const limite = Date.now() + plazoMs;
        for (;;) {
            const res = await consultar(id);
            if (['completed', 'partial', 'failed', 'expired'].includes(res.body.status)) return res.body;
            if (Date.now() > limite) throw new Error(`plazo agotado: ${JSON.stringify(res.body).slice(0, 300)}`);
            await dormir(15);
        }
    }

    test('PRODUCCION: 10 pedidos, comunidad mayoritariamente inservible, presion de 429 -> 10 de 10 sin bombardear', async () => {
        cache.reset();
        base.limpiar();
        jobs.reset();
        robloxRateLimiter.reset();

        const arranque = await pedir(port, 'POST', '/plugin/outfits/search', {
            amount: 10, groupId: GROUP_ID, minPrice: 300, maxPrice: 100_000_000,
            requireCompletePrice: false, async: true,
        });
        assert.strictEqual(arranque.status, 202);
        const fin = await esperarTerminal(arranque.body.searchId);
        const s = fin.stats;

        // ── El resultado ─────────────────────────────────────────────────────
        assert.strictEqual(fin.status, 'completed', `termino ${fin.status} por ${fin.stoppedBy}: ${JSON.stringify(s)}`);
        assert.strictEqual(fin.found, 10);
        assert.strictEqual(s.stoppedBy, 'completed');

        // Sin duplicados, y sin candidatos perdidos: son EXACTAMENTE los diez
        // primeros validos de la comunidad, en orden de rotacion.
        const ids = fin.outfits.map(o => o.userId);
        assert.strictEqual(new Set(ids).size, ids.length, 'hay usuarios duplicados');
        assert.deepStrictEqual([...ids].sort((a, b) => a - b), VALIDOS, 'se perdio o se salto algun candidato');
        for (const outfit of fin.outfits) assert.ok(outfit.totalPrice >= 300);

        // ── Presion de rate limit atravesada, no sufrida ──────────────────────
        assert.ok(medidas.avatar429s >= 3, `hubo solo ${medidas.avatar429s} 429: no hubo presion real`);
        assert.ok(medidas.ventanasCerradas.some(v => v.conCabecera) && medidas.ventanasCerradas.some(v => !v.conCabecera),
            'la busqueda no atraveso los dos tipos de 429 (con y sin cabecera)');
        // Mas de un cooldown ESTACIONADO. (Un cooldown que vence mientras
        // terminan las peticiones en vuelo no necesita pausa: eso es correcto,
        // y por eso se exige >= 2 y no == numero de 429.)
        assert.ok(s.rateLimitWaits >= 2, `estaciono solo ${s.rateLimitWaits} veces con ${medidas.avatar429s} cooldowns`);
        assert.ok(s.avatarRateLimited >= 3);
        assert.strictEqual(s.avatarDeferred, s.deferredResumed, 'lo diferido no se retomo entero');

        // CERO peticiones al avatar dentro de cada ventana que Roblox cerro.
        for (const v of medidas.ventanasCerradas) {
            const dentro = medidas.instantes.filter(t => t > v.desde + 5 && t < v.hasta);
            assert.strictEqual(dentro.length, 0,
                `${dentro.length} peticiones de avatar durante un cooldown ${v.conCabecera ? 'con' : 'SIN'} cabecera`);
        }

        // Un 429 no es un error del candidato: avatarError son SOLO los borrados.
        const borradosExaminados = medidas.instantes.length > 0
            ? s.rejectedAvatarError
            : 0;
        assert.ok(borradosExaminados <= Math.ceil(s.candidatesExamined / 37) + 1,
            `rejectedAvatarError=${s.rejectedAvatarError}: hay 429 contados como error de avatar`);

        // ── Los que no sirven se saltan BARATO ───────────────────────────────
        assert.ok(s.rejectedTooFewAccessories > 0, 'no consta ningun descarte por pocos accesorios');
        assert.ok(s.rejectedMinPrice > 0);
        assert.ok(s.rejectedEmptyAvatar > 0);

        // NINGUN asset de un usuario con tres accesorios o menos llego al catalogo.
        const usuariosEnCatalogo = new Set(medidas.catalogoAssets.map(usuarioDeAsset));
        const filtrados = [...usuariosEnCatalogo].filter(u => clase(u) === 'pocosAccesorios');
        assert.strictEqual(filtrados.length, 0, `${filtrados.length} usuarios con pocos accesorios gastaron catalogo`);
        // Y el catalogo solo vio a los que merecian precio.
        for (const u of usuariosEnCatalogo) assert.ok(['valido', 'barato'].includes(clase(u)), `catalogo para ${clase(u)}`);

        // ── Sin limites arbitrarios ni rafagas ───────────────────────────────
        assert.ok(s.candidatesExamined < s.hardCandidateLimit / 2, 'la busqueda se acerco al techo duro');
        assert.ok(s.candidatesExamined >= 200, `solo examino ${s.candidatesExamined}: no siguio buscando usuarios nuevos`);
        assert.ok(s.memberPagesFetched >= 3, 'no paso de las primeras paginas');
        assert.ok(medidas.maxEnVuelo <= config.upstream.routeConcurrency.userAvatar,
            `${medidas.maxEnVuelo} avatares en vuelo a la vez`);
        assert.strictEqual(s.rotationCycle, 1);

        // ── Observabilidad: todo lo que hace falta para leer la busqueda ─────
        for (const campo of ['candidatesExamined', 'rejectedTooFewAccessories', 'avatarRequests', 'avatarCacheHits',
            'catalogBatches', 'catalogAssetsReused', 'rateLimitWaits', 'rateLimitWaitedMs', 'workingMs',
            'durationMs', 'stoppedBy', 'avatarShed', 'avatarDeferred', 'deferredResumed']) {
            assert.ok(campo in s, `a stats le falta ${campo}`);
        }
        // Cuantas llamadas de avatar salieron DE VERDAD: lo cuenta el limitador,
        // y por eso incluye los reintentos que el propio limitador hace tras
        // esperar un Retry-After corto (la busqueda no los ve). Tiene que ser
        // EXACTO respecto a lo que recibio el Roblox de mentira.
        assert.strictEqual(s.avatarRouteCalls, medidas.avatares,
            `stats.avatarRouteCalls=${s.avatarRouteCalls} pero salieron ${medidas.avatares} de verdad`);
        assert.ok(s.avatarRequests <= medidas.avatares && s.avatarRequests >= medidas.avatares - medidas.avatar429s,
            `stats.avatarRequests=${s.avatarRequests} no cuadra con ${medidas.avatares} salidas y ${medidas.avatar429s} 429`);
        assert.strictEqual(s.catalogRouteCalls, medidas.lotes,
            `stats.catalogRouteCalls=${s.catalogRouteCalls} pero hubo ${medidas.lotes} lotes`);
        assert.ok(s.workingMs < s.durationMs, 'el tiempo de trabajo no descuenta las pausas');
        assert.ok(s.rateLimitWaitedMs > 0);
    });

    test('la MISMA busqueda repetida se sirve de cache: cero peticiones de avatar nuevas', async () => {
        // Segunda pasada sobre la misma comunidad, rebobinando la rotacion.
        base.rotaciones.clear();
        jobs.reset();
        robloxRateLimiter.reset();
        const antes = medidas.avatares;

        const arranque = await pedir(port, 'POST', '/plugin/outfits/search', {
            amount: 10, groupId: GROUP_ID, minPrice: 300, requireCompletePrice: false, async: true,
        });
        const fin = await esperarTerminal(arranque.body.searchId);

        assert.strictEqual(fin.status, 'completed');
        assert.strictEqual(fin.found, 10);
        assert.strictEqual(fin.stats.avatarRequests, 0, 'con todo en cache no puede salir ninguna peticion');
        assert.strictEqual(medidas.avatares, antes);
        assert.ok(fin.stats.avatarCacheHits >= 200);
        assert.ok(fin.stats.rejectedTooFewAccessories > 0, 'la regla tambien aplica a lo servido de cache');
    });

    const ok = await suite.run();

    roblox.listGroupMembers = original.listGroupMembers;
    roblox.getCurrentAvatar = original.getCurrentAvatar;
    roblox.getCatalogItemDetails = original.getCatalogItemDetails;
    Object.assign(repo, original.repo);
    Object.assign(jobRepo, original.jobRepo);
    config.pluginSearch.minAccessories = original.cfg.minAccessories;
    config.pluginSearch.rateLimitHeartbeatMs = original.cfg.heartbeat;
    config.pluginSearch.rateLimitWaitMarginMs = original.cfg.margen;
    config.pluginSearch.rateLimitWaitBudgetMs = original.cfg.presupuesto;
    config.cache.maxEntries = original.cfg.cache;
    cache.reset();
    ownRateLimit.reset();
    robloxRateLimiter.reset();
    jobs.reset();
    await new Promise(resolve => server.close(resolve));
    return ok;
};
