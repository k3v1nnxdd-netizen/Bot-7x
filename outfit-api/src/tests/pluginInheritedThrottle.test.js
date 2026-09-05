'use strict';

const http = require('http');
const { createSuite, axiosError } = require('./harness');
const { createApp } = require('../app');
const ownRateLimit = require('../security/rateLimit');
const limitador = require('../roblox/rateLimiter');
const roblox = require('../roblox/client');
const cache = require('../cache/cacheStore');
const config = require('../config');
const repo = require('../db/pluginRotationRepo');
const jobRepo = require('../db/pluginJobRepo');
const jobs = require('../services/pluginSearch/jobs');
const { crearBaseFalsa } = require('./fakeDb');

// UN FRENO HEREDADO NO ES UN LIMITE PROPIO.
//
// El limitador de Roblox es del PROCESO, no de la busqueda: sus cooldowns, su
// breaker y su marcapasos sobreviven a la busqueda que los provoco. Una
// busqueda nueva puede por tanto empezar con la ruta del avatar ya cerrada.
//
// Eso terminaba la busqueda: la pausa no cabia en el reloj de pared (que se
// dimensiono sin saber nada de un cooldown ajeno) y el resultado era
// "2 de 10 · avatarRateLimit" habiendo hecho CERO peticiones de avatar. Un
// freno heredado convertido en un parcial.
//
// Ahora: se espera (el trabajo cambia de fase, conserva encontrados,
// pendientes, cursor y searchId, y no manda ni una peticion), se reanuda solo,
// y termina lo pedido. El presupuesto de espera dejo de recortarse contra el
// reloj de pared en modo asincrono, que era justo lo que hacia que un cooldown
// ajeno — ya corriendo cuando la busqueda empezo — no cupiera nunca.
//
// El segundo fallo que se prueba aqui vive en la rotacion: una busqueda que
// terminaba con candidatos pendientes NO guardaba avance NINGUNO, asi que la
// siguiente volvia a examinar desde cero a todos los que ya tenian veredicto.

const GROUP_ID = 59218460;
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

const dormir = ms => new Promise(r => setTimeout(r, ms));

// Tipos reales. Se dan como los manda Roblox (`assetType.id` anidado) y se
// aplanan con EL MISMO normalizador que corre en produccion.
const T = { Hat: 8, Hair: 41, Face: 42, Neck: 43, Front: 45, Back: 46, Waist: 47, Shirt: 11, Pants: 12, Torso: 27, Head: 17, Emote: 61 };

module.exports = async function run() {
    const suite = createSuite('pluginInheritedThrottle');
    const { test, assert } = suite;

    // La comprobacion de que produccion y las pruebas comparten la MISMA
    // funcion se hace ANTES de tocar nada del cliente.
    const realGetCurrentAvatar = roblox.getCurrentAvatar;
    const realListGroupMembers = roblox.listGroupMembers;
    const realGetCatalogItemDetails = roblox.getCatalogItemDetails;

    const app = createApp();
    const server = await new Promise(resolve => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = server.address().port;

    const original = {
        repo: { ...repo },
        jobRepo: { ...jobRepo },
        cfg: {
            minAccessories: config.pluginSearch.minAccessories,
            heartbeat: config.pluginJobs.heartbeatIntervalMs,
            parkHeartbeat: config.pluginSearch.rateLimitHeartbeatMs,
            margen: config.pluginSearch.rateLimitWaitMarginMs,
            presupuesto: config.pluginSearch.rateLimitWaitBudgetMs,
            cache: config.cache.maxEntries,
        },
    };

    config.pluginSearch.minAccessories = 4;
    config.pluginJobs.heartbeatIntervalMs = 40;
    config.pluginSearch.rateLimitHeartbeatMs = 40;
    config.pluginSearch.rateLimitWaitMarginMs = 20;
    config.pluginSearch.rateLimitWaitBudgetMs = 60_000;
    config.cache.maxEntries = 10_000;

    const base = crearBaseFalsa();
    base.instalar();

    // ── La comunidad ────────────────────────────────────────────────────────
    const MIEMBROS = 900;
    const clase = u => {
        if (u % 37 === 0) return 'borrado';
        if (u % 30 === 8) return 'valido';
        if (u % 10 < 5) return 'pocosAccesorios';
        return 'barato';
    };
    const VALIDOS = [];
    for (let i = 0; i < MIEMBROS; i++) if (clase(1000 + i) === 'valido') VALIDOS.push(1000 + i);
    const usuarioDeAsset = id => Math.floor(Number(id) / 100);

    // Payload CRUDO de Roblox. El aplanado lo hace el cliente real.
    function avatarCrudo(u) {
        const a = (k, tipo) => ({ id: u * 100 + k, name: `A${k}`, assetType: { id: tipo, name: `T${tipo}` } });
        switch (clase(u)) {
            case 'pocosAccesorios':
                return { assets: [a(0, T.Hat), a(1, T.Hair), a(2, T.Back), a(3, T.Shirt), a(4, T.Torso), a(5, T.Head), a(6, T.Emote)], playerAvatarType: 'R15' };
            case 'valido':
                return { assets: [a(0, T.Hat), a(1, T.Hair), a(2, T.Back), a(3, T.Waist), a(4, T.Shirt), a(5, T.Torso)], playerAvatarType: 'R15' };
            default:
                return { assets: [a(0, T.Hat), a(1, T.Hair), a(2, T.Face), a(3, T.Neck), a(4, T.Front), a(5, T.Pants)], playerAvatarType: 'R15' };
        }
    }

    const medidas = {};
    function poblar({ limpiarBase = true } = {}) {
        Object.assign(medidas, {
            avatares: 0,               // peticiones de avatar que SALIERON
            pedidos: [],               // a quien se le pidio el avatar, en orden
            duranteCooldown: 0,        // ...con la ruta cerrada: tiene que ser 0
            forzar429En: new Set(),    // numeros de peticion que responden 429
            retryAfter: '1',
        });
        cache.reset();
        limitador.reset();
        jobs.reset();
        if (limpiarBase) base.limpiar();
    }

    roblox.listGroupMembers = async (groupId, { cursor = null } = {}) => {
        const pagina = cursor ? Number(String(cursor).slice(1)) : 0;
        const desde = pagina * 100;
        const hasta = Math.min(desde + 100, MIEMBROS);
        const members = [];
        for (let i = desde; i < hasta; i++) members.push({ userId: 1000 + i, username: `U${1000 + i}` });
        return { members, nextCursor: hasta < MIEMBROS ? `p${pagina + 1}` : null };
    };

    // El doble del avatar pasa por el limitador real y aplana con el
    // normalizador real: lo unico fabricado es la respuesta de Roblox.
    roblox.getCurrentAvatar = async userId => {
        const r = await limitador.run('userAvatar', async () => {
            // Se mide EN EL ENVIO: si el limitador dejo salir algo con la ruta
            // cerrada, se ve aqui y en ningun otro sitio.
            if (limitador.getThrottleState('userAvatar').throttled) medidas.duranteCooldown++;
            medidas.avatares++;
            medidas.pedidos.push(userId);
            await dormir(3);
            if (medidas.forzar429En.has(medidas.avatares)) {
                throw axiosError(429, { 'retry-after': medidas.retryAfter, 'x-ratelimit-remaining': '0' });
            }
            if (clase(userId) === 'borrado') throw axiosError(404);
            return { status: 200, headers: {}, data: avatarCrudo(userId) };
        }, { endpoint: 'avatar.roblox.com/v1/users/{id}/avatar', notFoundCode: 'user_not_found' });
        return roblox.normalizeAvatarAssets(r.data);
    };

    roblox.getCatalogItemDetails = async items => {
        await limitador.run('catalogDetails', async () => ({ status: 200, headers: {}, data: {} }),
            { endpoint: 'catalog.roblox.com/v1/catalog/items/details' });
        const mapa = new Map();
        for (const item of items) {
            mapa.set(roblox.catalogKey('Asset', item.id), {
                available: true, assetTypeId: 8, isLimited: false, offSale: false,
                price: clase(usuarioDeAsset(item.id)) === 'valido' ? 100 : 10,
            });
        }
        return mapa;
    };

    const TERMINAL = new Set(['completed', 'partial', 'failed', 'expired']);
    const buscar = (extra = {}) => pedir(port, 'POST', '/plugin/outfits/search', {
        amount: 10, groupId: GROUP_ID, minPrice: 300, maxPrice: 100_000_000,
        requireCompletePrice: false, async: true, ...extra,
    });

    async function seguir(id, plazoMs = 60_000) {
        const limite = Date.now() + plazoMs;
        const fases = new Set();
        let maxFound = 0;
        for (;;) {
            const { body: b } = await pedir(port, 'GET', `/plugin/outfits/search/${id}`);
            if (b.phase) fases.add(b.phase);
            assert.ok(b.found >= maxFound, `found bajo de ${maxFound} a ${b.found}`);
            maxFound = b.found;
            if (TERMINAL.has(b.status)) return { fin: b, fases: [...fases] };
            if (Date.now() > limite) throw new Error(`plazo agotado en ${b.status}/${b.phase} found ${b.found}`);
            await dormir(12);
        }
    }

    // ── 1. La ruta ya esta limitada ANTES de empezar ────────────────────────

    test('la ruta del avatar YA esta limitada al iniciar: el trabajo espera, no termina', async () => {
        poblar();
        // Exactamente lo que deja una busqueda anterior que se comio un 429.
        limitador.__buckets.userAvatar.cooldownUntil = Date.now() + 700;

        const { body: creado } = await buscar();
        const searchId = creado.searchId;
        assert.ok(searchId, 'no se creo el trabajo');

        const { fin, fases } = await seguir(searchId);

        // Espero, no morí.
        assert.ok(fases.includes('rateLimitWait'), `nunca paso por la espera: fases ${fases}`);
        assert.strictEqual(fin.searchId, searchId, 'el searchId cambio por el camino');
        assert.strictEqual(fin.status, 'completed', `termino ${fin.status} por ${fin.stoppedBy}`);
        assert.strictEqual(fin.found, 10);
        assert.strictEqual(fin.stoppedBy, 'completed');
        assert.strictEqual(fin.stats.stoppedByRobloxRateLimit, false,
            'un cooldown heredado se conto como limite propio');
        assert.ok(fin.stats.rateLimitWaits >= 1, 'no consta la espera');
    });

    test('CERO peticiones mientras la ruta esta en cooldown, tambien con el freno heredado', async () => {
        poblar();
        limitador.__buckets.userAvatar.cooldownUntil = Date.now() + 700;

        const { body: creado } = await buscar();
        const { fin } = await seguir(creado.searchId);

        assert.strictEqual(medidas.duranteCooldown, 0,
            `salieron ${medidas.duranteCooldown} peticiones con la ruta cerrada`);
        assert.strictEqual(fin.status, 'completed');
        assert.strictEqual(fin.found, 10);
    });

    test('reanuda sola y termina 10 de 10 aunque el freno heredado se sume a otro 429 propio', async () => {
        poblar();
        limitador.__buckets.userAvatar.cooldownUntil = Date.now() + 500;
        medidas.forzar429En = new Set([45, 120]);
        medidas.retryAfter = '1';

        const { body: creado } = await buscar();
        const { fin, fases } = await seguir(creado.searchId);

        assert.strictEqual(fin.status, 'completed', `termino ${fin.status} por ${fin.stoppedBy}`);
        assert.strictEqual(fin.found, 10);
        assert.deepStrictEqual(fin.outfits.map(o => o.userId), VALIDOS.slice(0, 10));
        assert.ok(fases.includes('rateLimitWait'));
        assert.ok(fin.stats.rateLimitWaits >= 2, `solo ${fin.stats.rateLimitWaits} esperas`);
        assert.strictEqual(medidas.duranteCooldown, 0);
        assert.strictEqual(fin.stats.stoppedByRobloxRateLimit, false);
    });

    test('el MISMO freno heredado: en sincrono no cabe y en ASINCRONO se espera y termina 10 de 10', async () => {
        // La prueba A/B del arreglo. El cooldown heredado es identico en los
        // dos; lo unico que cambia es si hay un socket esperando al otro lado.
        //
        // SINCRONO: hay un plazo real (el del socket) y la pausa no cabe. La
        // busqueda no gasta ni una llamada y nombra la ruta cerrada, que es lo
        // que hay que ir a mirar; `avatarRequests: 0` dice que se la encontro
        // cerrada al llegar en vez de haberla agotado ella.
        //
        // ASINCRONO: nadie sostiene un socket. El mismo freno se espera, el
        // trabajo conserva lo suyo y termina lo pedido. ANTES NO: el
        // presupuesto de espera se recortaba contra el reloj de pared y el
        // freno heredado terminaba tambien la busqueda asincrona.
        poblar();
        const techoOriginal = config.pluginSearch.timeBudgetSyncCeilingMs;
        config.pluginSearch.timeBudgetSyncCeilingMs = 120;
        limitador.__buckets.userAvatar.cooldownUntil = Date.now() + 700;

        let sincrono;
        try {
            sincrono = (await buscar({ async: false })).body;
        } finally {
            config.pluginSearch.timeBudgetSyncCeilingMs = techoOriginal;
        }

        assert.strictEqual(medidas.avatares, 0, 'el sincrono gasto llamadas contra una ruta cerrada');
        assert.strictEqual(sincrono.stats.avatarRequests, 0,
            'sin peticiones propias, el contador tiene que decirlo');
        assert.strictEqual(sincrono.found, 0);

        // Y ahora el MISMO freno, en asincrono.
        poblar();
        limitador.__buckets.userAvatar.cooldownUntil = Date.now() + 700;
        const { body: creado } = await buscar();
        const { fin, fases } = await seguir(creado.searchId);

        assert.ok(fases.includes('rateLimitWait'), 'el asincrono no espero: murio con el freno heredado');
        assert.strictEqual(fin.status, 'completed', `el asincrono termino ${fin.status} por ${fin.stoppedBy}`);
        assert.strictEqual(fin.found, 10);
        assert.ok(fin.stats.avatarRequests > 0);
        assert.strictEqual(medidas.duranteCooldown, 0);
    });

    // ── 2. Rotacion: prefijo procesado y pendientes ─────────────────────────

    test('una busqueda frenada CON pendientes conserva el prefijo procesado y no lo repite en la siguiente', async () => {
        poblar();
        // Presupuesto de espera minimo + un Retry-After enorme: la primera
        // pausa no cabe y la busqueda para de verdad, con pendientes en la
        // mano. Es la unica forma honesta de terminar por limite.
        config.pluginSearch.rateLimitWaitBudgetMs = 150;
        medidas.forzar429En = new Set([55]);
        medidas.retryAfter = '600';

        const { body: c1 } = await buscar();
        const r1 = await seguir(c1.searchId, 30_000);
        const procesadosB1 = [...medidas.pedidos];

        assert.strictEqual(r1.fin.status, 'partial', `la primera termino ${r1.fin.status}`);
        assert.strictEqual(r1.fin.stoppedBy, 'avatarRateLimit',
            'con peticiones propias hechas, el limite del avatar SI es el motivo');
        assert.ok(procesadosB1.length >= 40, `solo se procesaron ${procesadosB1.length}`);

        // Los pendientes: entregados por la rotacion y sin veredicto.
        const trabajo = await jobs.obtener(c1.searchId);
        const pendientesB1 = (trabajo.checkpoint?.pendientes ?? []).map(m => Number(m.userId));
        assert.ok(pendientesB1.length > 0, 'el escenario no dejo pendientes: no prueba nada');

        // Segunda busqueda, sin limites y con la rotacion continuando.
        config.pluginSearch.rateLimitWaitBudgetMs = 60_000;
        const pedidosB1 = new Set(procesadosB1);
        medidas.pedidos = [];
        medidas.forzar429En = new Set();
        limitador.reset();
        cache.reset();

        const { body: c2 } = await buscar();
        const r2 = await seguir(c2.searchId, 60_000);
        const procesadosB2 = new Set(medidas.pedidos);

        assert.strictEqual(r2.fin.status, 'completed', `la segunda termino ${r2.fin.status} por ${r2.fin.stoppedBy}`);
        assert.strictEqual(r2.fin.found, 10);

        // EL PREFIJO: todo lo procesado ANTES del primer pendiente esta
        // guardado y no se vuelve a mirar. Antes se repetia entero.
        const primerPendiente = Math.min(...pendientesB1);
        const prefijo = procesadosB1.filter(u => u < primerPendiente);
        assert.ok(prefijo.length >= 20, `el prefijo procesado era de solo ${prefijo.length}: el caso no prueba nada`);
        const repetidos = prefijo.filter(u => procesadosB2.has(u));
        assert.strictEqual(repetidos.length, 0,
            `la segunda busqueda repitio ${repetidos.length} de los ${prefijo.length} ya procesados`);

        // Y NADIE SE PIERDE: los pendientes de la primera se vuelven a entregar.
        const perdidos = pendientesB1.filter(u => !procesadosB2.has(u));
        assert.deepStrictEqual(perdidos, [], `se perdieron pendientes: ${perdidos.join(',')}`);

        // Sin duplicados dentro de la propia busqueda.
        assert.strictEqual(procesadosB2.size, medidas.pedidos.length, 'se pidio dos veces el mismo avatar');
        assert.ok(pedidosB1.size > 0);
    });

    test('dos busquedas seguidas SIN limites no se pisan: la segunda continua por donde iba la comunidad', async () => {
        poblar();
        const { body: c1 } = await buscar();
        const r1 = await seguir(c1.searchId);
        const b1 = new Set(medidas.pedidos);

        medidas.pedidos = [];
        cache.reset();
        const { body: c2 } = await buscar();
        const r2 = await seguir(c2.searchId);
        const b2 = medidas.pedidos;

        assert.strictEqual(r1.fin.status, 'completed');
        assert.strictEqual(r2.fin.status, 'completed');
        // El unico solape admitido es el ultimo entregado: la rotacion guarda
        // de forma INCLUSIVA a proposito, para no saltarse a nadie si el
        // proceso muere justo despues de procesarlo.
        const repetidos = b2.filter(u => b1.has(u));
        assert.ok(repetidos.length <= 1, `se repitieron ${repetidos.length} usuarios entre dos busquedas sanas`);
        assert.notDeepStrictEqual(r2.fin.outfits.map(o => o.userId), r1.fin.outfits.map(o => o.userId),
            'la segunda busqueda devolvio exactamente los mismos outfits');
    });

    // ── 3. Produccion y pruebas, la misma funcion ───────────────────────────

    test('produccion y pruebas usan la MISMA funcion real del cliente para el avatar', async () => {
        // 1. Existe de verdad y es la que exporta el cliente.
        assert.strictEqual(typeof realGetCurrentAvatar, 'function',
            'roblox.getCurrentAvatar no existe en el cliente real');
        assert.strictEqual(typeof realListGroupMembers, 'function');
        assert.strictEqual(typeof realGetCatalogItemDetails, 'function');

        // 2. Pide el avatar COMPLETO por la ruta del avatar, y bajo la llave
        //    del limitador que esta busqueda respeta.
        const fuente = realGetCurrentAvatar.toString();
        assert.ok(fuente.includes('avatar.roblox.com/v1/users/'),
            'la funcion real no consulta la ruta del avatar de Roblox');
        assert.ok(fuente.includes("rateLimiter.run('userAvatar'"),
            'la funcion real no pasa por la ruta userAvatar del limitador');

        // 3. El aplanado que usa produccion es el que usan estas pruebas, y
        //    saca el TIPO de cada asset de donde Roblox lo manda: anidado.
        assert.strictEqual(typeof roblox.normalizeAvatarAssets, 'function');
        const aplanado = roblox.normalizeAvatarAssets({
            assets: [{ id: 5, name: 'Gorro', assetType: { id: T.Hat, name: 'Hat' } }, { id: null }],
            playerAvatarType: 'R15',
        });
        assert.deepStrictEqual(aplanado, {
            assets: [{ id: 5, name: 'Gorro', assetTypeId: T.Hat, assetTypeName: 'Hat' }],
            playerAvatarType: 'R15',
        });

        // 4. Y la ola de avatares llama EXACTAMENTE a esa propiedad del
        //    cliente: si alguien la renombrara, esto se entera.
        const previo = roblox.getCurrentAvatar;
        let llamadas = 0;
        roblox.getCurrentAvatar = async userId => { llamadas++; return previo(userId); };
        try {
            poblar();
            const { body: creado } = await buscar({ amount: 1 });
            await seguir(creado.searchId);
            assert.ok(llamadas > 0, 'la busqueda no llamo a roblox.getCurrentAvatar');
        } finally {
            roblox.getCurrentAvatar = previo;
        }
    });

    const ok = await suite.run();

    roblox.getCurrentAvatar = realGetCurrentAvatar;
    roblox.listGroupMembers = realListGroupMembers;
    roblox.getCatalogItemDetails = realGetCatalogItemDetails;
    Object.assign(repo, original.repo);
    Object.assign(jobRepo, original.jobRepo);
    config.pluginSearch.minAccessories = original.cfg.minAccessories;
    config.pluginJobs.heartbeatIntervalMs = original.cfg.heartbeat;
    config.pluginSearch.rateLimitHeartbeatMs = original.cfg.parkHeartbeat;
    config.pluginSearch.rateLimitWaitMarginMs = original.cfg.margen;
    config.pluginSearch.rateLimitWaitBudgetMs = original.cfg.presupuesto;
    config.cache.maxEntries = original.cfg.cache;
    cache.reset();
    ownRateLimit.reset();
    limitador.reset();
    jobs.reset();
    await new Promise(resolve => server.close(resolve));
    return ok;
};
