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

// PARK / RESUME. La prueba real que motivo todo esto:
//
//   amount 10 · 4 encontrados · userAvatar devuelve 429 con retry-after 25 s
//   -> "Busqueda finalizada parcialmente · Limite de avatares de Roblox"
//
// Lo que este archivo protege, en orden:
//
//   1. Un cooldown de Roblox NO termina la busqueda: se estaciona, no manda ni
//      una peticion, y reanuda donde estaba hasta juntar los 10.
//   2. Un candidato al que el limite no dejo mirar NO es un candidato invalido:
//      ni se descarta ni se pierde, y el cursor no salta por encima de el.
//   3. Si el proceso muere estacionado, otra instancia adopta el trabajo y lo
//      termina — mismo searchId, mismos outfits, misma rotacion.
//   4. Mientras un trabajo esta estacionado, el grupo sigue reservado para el;
//      otros grupos no se enteran.
//   5. El avatar se gatea POR PETICION y con concurrencia propia: no hay burst.
//
// Los cooldowns se provocan con milisegundos para que probar el comportamiento
// no cueste los 25 segundos reales.

const GROUP_ID = 59218460;
const OTRO_GRUPO = 11223344;
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

module.exports = async function run() {
    const suite = createSuite('pluginPark');
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
            heartbeat: config.pluginSearch.rateLimitHeartbeatMs,
            margen: config.pluginSearch.rateLimitWaitMarginMs,
            presupuesto: config.pluginSearch.rateLimitWaitBudgetMs,
            pausa: config.pluginSearch.rateLimitSingleWaitMs,
        },
    };

    // Pausas y latidos en milisegundos: se prueba el COMPORTAMIENTO.
    config.pluginSearch.rateLimitHeartbeatMs = 40;
    config.pluginSearch.rateLimitWaitMarginMs = 20;
    config.pluginSearch.rateLimitWaitBudgetMs = 15_000;

    const base = crearBaseFalsa();
    base.instalar();

    // ── Comunidad de mentira. Uno de cada cinco encaja: 10 resultados son ~50
    // candidatos, o sea varias olas, que es lo que hace falta para que una
    // pausa a mitad tenga sentido. SIEMPRE ascendente, para que "los 10
    // primeros validos" sea un conjunto exacto.
    const VALIDO = userId => userId % 5 === 0;
    const PRIMEROS_10_VALIDOS = Array.from({ length: 10 }, (_, i) => 1000 + i * 5);

    let mundo = {};
    const medidas = {};

    function poblar({ miembros = 400 } = {}) {
        mundo = { miembros, avatar: null, catalogo: null };
        Object.assign(medidas, {
            avatares: 0, catalogos: 0, avatarEnVuelo: 0, avatarMaxEnVuelo: 0,
            instantesAvatar: [], instantesCatalogo: [],
        });
        cache.reset();
        base.limpiar();
        jobs.reset();
        robloxRateLimiter.reset();
    }

    roblox.listGroupMembers = async (groupId, { cursor = null } = {}) => {
        const pagina = cursor ? Number(String(cursor).slice(1)) : 0;
        const desde = pagina * 100;
        const hasta = Math.min(desde + 100, mundo.miembros);
        const members = [];
        for (let i = desde; i < hasta; i++) members.push({ userId: 1000 + i, username: `U${1000 + i}` });
        return { members, nextCursor: hasta < mundo.miembros ? `p${pagina + 1}` : null };
    };

    // Avatar por defecto: pasa por el limitador REAL para que el slot de ruta,
    // el marcapasos y el cooldown se comporten como en produccion.
    roblox.getCurrentAvatar = async userId => {
        const r = await robloxRateLimiter.run('userAvatar', async () => {
            medidas.avatares++;
            medidas.instantesAvatar.push(Date.now());
            medidas.avatarEnVuelo++;
            medidas.avatarMaxEnVuelo = Math.max(medidas.avatarMaxEnVuelo, medidas.avatarEnVuelo);
            try {
                await dormir(3);
                if (mundo.avatar) return mundo.avatar(userId);
                return { status: 200, headers: {}, data: { assets: [{ id: userId * 10 }], playerAvatarType: 'R15' } };
            } finally {
                medidas.avatarEnVuelo--;
            }
        }, { endpoint: 'avatar.roblox.com/v1/users/{id}/avatar' });
        return r.data;
    };

    roblox.getCatalogItemDetails = async items => {
        medidas.catalogos++;
        medidas.instantesCatalogo.push(Date.now());
        if (mundo.catalogo) await mundo.catalogo(items);
        const mapa = new Map();
        for (const item of items) {
            const userId = Number(item.id) / 10;
            mapa.set(roblox.catalogKey('Asset', item.id), {
                available: true, assetTypeId: 8, isLimited: false, offSale: false,
                price: VALIDO(userId) ? 500 : 10,
            });
        }
        return mapa;
    };

    const buscarAsync = (port_, extra = {}) => pedir(port_, 'POST', '/plugin/outfits/search', {
        amount: 10, groupId: GROUP_ID, minPrice: 300, requireCompletePrice: false, async: true, ...extra,
    });
    const consultar = (port_, id) => pedir(port_, 'GET', `/plugin/outfits/search/${id}`);

    async function esperarHasta(port_, id, condicion, { plazoMs = 20_000 } = {}) {
        const limite = Date.now() + plazoMs;
        for (;;) {
            const res = await consultar(port_, id);
            if (condicion(res.body)) return res.body;
            if (Date.now() > limite) throw new Error(`plazo agotado esperando el trabajo ${id}: ${JSON.stringify(res.body)}`);
            await dormir(15);
        }
    }
    const TERMINAL = new Set(['completed', 'partial', 'failed', 'expired']);
    const esperarTerminal = (port_, id) => esperarHasta(port_, id, b => TERMINAL.has(b.status));

    // Cierra la ruta del avatar en el bucket del limitador, como haria un
    // 'remaining: 0' con retry-after. Devuelve la ventana [desde, hasta].
    function cerrarRuta(ruta, ms) {
        const desde = Date.now();
        robloxRateLimiter.__buckets[ruta].cooldownUntil = desde + ms;
        return { desde, hasta: desde + ms };
    }

    const idsDe = body => body.outfits.map(o => o.userId).sort((a, b) => a - b);

    // ── 1. El caso principal ─────────────────────────────────────────────────

    test('CASO REAL: 4 encontrados, 429 del avatar con retry-after, el job NO termina, reanuda y llega a 10/10', async () => {
        poblar();
        let ventana = null;
        let servidos = 0;

        // Tras el cuarto outfit valido (el 20º avatar), Roblox contesta 429
        // con retry-after. Es un 429 REAL a traves del limitador: entra por el
        // mismo camino que en produccion (cooldown + marcapasos + diferido).
        mundo.avatar = userId => {
            servidos++;
            if (servidos === 20) {
                ventana = { desde: Date.now(), hasta: Date.now() + 3_000 };
                throw axiosError(429, { 'retry-after': '3', 'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60' });
            }
            return { status: 200, headers: {}, data: { assets: [{ id: userId * 10 }], playerAvatarType: 'R15' } };
        };

        const arranque = await buscarAsync(port);
        assert.strictEqual(arranque.status, 202);
        const id = arranque.body.searchId;

        // Se estaciona: el plugin lo ve como 'running' con phase rateLimitWait,
        // la ruta y cuando reanuda.
        const estacionado = await esperarHasta(port, id, b => b.progress?.phase === 'rateLimitWait');
        assert.strictEqual(estacionado.status, 'running', 'el status publico no puede cambiar');
        assert.strictEqual(estacionado.progress.rateLimitedRoute, 'userAvatar');
        assert.ok(estacionado.progress.resumeAt, 'sin resumeAt no hay forma de decir cuanto queda');
        assert.ok(estacionado.progress.retryAfterMs >= 3_000);
        assert.ok(Number.isFinite(estacionado.progress.estimatedRemainingMs) && estacionado.progress.estimatedRemainingMs >= 0,
            `ETA en pausa invalida: ${estacionado.progress.estimatedRemainingMs}`);
        assert.ok(estacionado.progress.found >= 3, `en la pausa deberia llevar ~4, lleva ${estacionado.progress.found}`);

        const fin = await esperarTerminal(port, id);
        const s = fin.stats;

        assert.strictEqual(fin.status, 'completed', `termino ${fin.status} por ${fin.stoppedBy}`);
        assert.strictEqual(fin.found, 10);
        assert.strictEqual(s.stoppedBy, 'completed');
        assert.ok(s.rateLimitWaits >= 1, 'no consta ninguna pausa');
        assert.ok(s.rateLimitWaitedMs >= 2_500, `solo espero ${s.rateLimitWaitedMs} ms`);

        // CERO peticiones al avatar dentro de la ventana que Roblox pidio.
        const dentro = medidas.instantesAvatar.filter(t => t > ventana.desde + 5 && t < ventana.hasta);
        assert.strictEqual(dentro.length, 0, `salieron ${dentro.length} peticiones de avatar durante el cooldown`);

        // Un limite no es un descarte: nadie cayo como avatarError por el 429.
        assert.strictEqual(s.rejectedAvatarError, 0);
        assert.ok(s.avatarRateLimited >= 1);
        assert.ok(s.avatarDeferred >= 1, 'el candidato del 429 deberia haber quedado pendiente');
        assert.strictEqual(s.avatarDeferred, s.deferredResumed, 'lo diferido no se retomo entero');

        // Y NINGUN candidato se perdio: los 10 son exactamente los 10 primeros
        // validos de la comunidad, en la misma rotacion.
        assert.deepStrictEqual(idsDe(fin), PRIMEROS_10_VALIDOS);
        assert.strictEqual(s.rotationCycle, 1);
        assert.strictEqual(s.rotationWraps, 0);

        // El trabajo de trabajo no incluye la pausa.
        assert.ok(s.workingMs < s.durationMs - 2_000, `workingMs ${s.workingMs} no descuenta la pausa de ${s.rateLimitWaitedMs}`);
    });

    test('dos cooldowns del avatar en la misma busqueda: 4/10 -> pausa -> 7/10 -> pausa -> 10/10', async () => {
        poblar();
        let servidos = 0;
        const ventanas = [];

        mundo.avatar = userId => {
            servidos++;
            if (servidos === 20 || servidos === 35) {
                ventanas.push(cerrarRuta('userAvatar', 250));
                throw axiosError(429, { 'retry-after': '1' });
            }
            return { status: 200, headers: {}, data: { assets: [{ id: userId * 10 }], playerAvatarType: 'R15' } };
        };

        const { body: { searchId } } = await buscarAsync(port);
        const fin = await esperarTerminal(port, searchId);

        assert.strictEqual(fin.status, 'completed');
        assert.strictEqual(fin.found, 10);
        assert.ok(fin.stats.rateLimitWaits >= 2, `solo ${fin.stats.rateLimitWaits} pausas`);
        assert.deepStrictEqual(idsDe(fin), PRIMEROS_10_VALIDOS);
        for (const v of ventanas) {
            const dentro = medidas.instantesAvatar.filter(t => t > v.desde + 5 && t < v.hasta);
            assert.strictEqual(dentro.length, 0, 'peticion de avatar durante un cooldown');
        }
    });

    test('cooldown del CATALOGO: 4/10 -> pausa -> 10/10, sin lotes durante la ventana', async () => {
        poblar();
        let lotes = 0;
        let ventana = null;

        mundo.catalogo = async () => {
            lotes++;
            if (lotes === 2) ventana = cerrarRuta('catalogDetails', 300);
        };

        const { body: { searchId } } = await buscarAsync(port);
        const fin = await esperarTerminal(port, searchId);

        assert.strictEqual(fin.status, 'completed');
        assert.strictEqual(fin.found, 10);
        assert.strictEqual(fin.stats.stoppedByRobloxRateLimit, false);
        assert.ok(fin.stats.rateLimitWaits >= 1);
        const dentro = medidas.instantesCatalogo.filter(t => t > ventana.desde + 5 && t < ventana.hasta);
        assert.strictEqual(dentro.length, 0, `salieron ${dentro.length} lotes de catalogo durante el cooldown`);
        assert.deepStrictEqual(idsDe(fin), PRIMEROS_10_VALIDOS);
    });

    // ── 2. Candidatos, cursor y rotacion ─────────────────────────────────────

    test('el cursor NO salta: tras la pausa la rotacion queda exactamente donde toca', async () => {
        poblar();
        let servidos = 0;
        mundo.avatar = userId => {
            if (++servidos === 15) { cerrarRuta('userAvatar', 200); throw axiosError(429, { 'retry-after': '1' }); }
            return { status: 200, headers: {}, data: { assets: [{ id: userId * 10 }], playerAvatarType: 'R15' } };
        };

        const { body: { searchId } } = await buscarAsync(port);
        const fin = await esperarTerminal(port, searchId);
        assert.strictEqual(fin.found, 10);

        // Lo persistido NUNCA va por delante de lo mirado: si la busqueda
        // termino con candidatos pendientes (entregados sin veredicto porque
        // Roblox cerro la ruta), el avance guardado se queda en el ultimo
        // tramo procesado entero, para que la siguiente busqueda los vuelva a
        // entregar en vez de saltarselos. Repetir un puñado es barato; que un
        // limite se lleve por delante a alguien, no.
        const fila = base.rotaciones.get(String(GROUP_ID));
        assert.ok(fila.intraPageOffset <= fin.stats.rotationEnd.offset - 1,
            `la rotacion guardo ${fila.intraPageOffset}, por delante de la posicion viva ${fin.stats.rotationEnd.offset}`);
        assert.ok(fila.intraPageOffset >= 20, `la rotacion retrocedio hasta ${fila.intraPageOffset}`);
        assert.strictEqual(fila.cycle, 1);
        assert.strictEqual(fila.leaseOwner, null, 'el lease quedo cogido al terminar');

        // Y la siguiente busqueda arranca EXACTAMENTE ahi: como mucho repite
        // el tramo que quedo pendiente, nunca se salta a nadie. (La fila del
        // doble es una referencia viva que la segunda busqueda va a mover: se
        // copia el offset ANTES.)
        const guardado = fila.intraPageOffset;
        const { body: { searchId: segundo } } = await buscarAsync(port, { amount: 3 });
        const fin2 = await esperarTerminal(port, segundo);
        assert.strictEqual(fin2.stats.rotationStart.offset, guardado);
        assert.strictEqual(fin2.stats.rotationCycle, 1);
        // Ningun outfit de la segunda puede ser ANTERIOR al offset guardado:
        // eso significaria que la rotacion retrocedio mas de lo debido.
        for (const id of fin2.outfits.map(o => o.userId)) {
            assert.ok(id >= 1000 + guardado, `la segunda busqueda devolvio ${id}, anterior al offset guardado ${guardado}`);
        }
    });

    test('un candidato diferido queda PENDIENTE en el checkpoint, no se pierde', async () => {
        poblar();
        let servidos = 0;
        mundo.avatar = userId => {
            if (++servidos === 12) { cerrarRuta('userAvatar', 400); throw axiosError(429, { 'retry-after': '1' }); }
            return { status: 200, headers: {}, data: { assets: [{ id: userId * 10 }], playerAvatarType: 'R15' } };
        };

        const { body: { searchId } } = await buscarAsync(port);
        await esperarHasta(port, searchId, b => b.progress?.phase === 'rateLimitWait');

        // El checkpoint persistido durante la pausa lleva a los pendientes.
        const fila = base.trabajosPersistidos.get(searchId);
        assert.ok(fila.checkpoint, 'no se persistio checkpoint al estacionar');
        assert.ok(fila.checkpoint.pendientes.length >= 1, 'el candidato diferido no esta en el checkpoint');
        assert.strictEqual(fila.phase, 'rateLimitWait');
        assert.strictEqual(fila.rateLimitedRoute, 'userAvatar');
        assert.ok(fila.resumeAt > Date.now() - 1000);

        const fin = await esperarTerminal(port, searchId);
        assert.deepStrictEqual(idsDe(fin), PRIMEROS_10_VALIDOS);
    });

    // ── 3. Restart durante el cooldown ───────────────────────────────────────

    test('RESTART durante el cooldown: otra instancia adopta el job y lo termina, mismo searchId', async () => {
        poblar();
        let servidos = 0;
        mundo.avatar = userId => {
            if (++servidos === 20) { cerrarRuta('userAvatar', 1_200); throw axiosError(429, { 'retry-after': '2' }); }
            return { status: 200, headers: {}, data: { assets: [{ id: userId * 10 }], playerAvatarType: 'R15' } };
        };

        const { body: { searchId } } = await buscarAsync(port);
        const enPausa = await esperarHasta(port, searchId, b => b.progress?.phase === 'rateLimitWait');
        const encontradosAntes = enPausa.progress.found;
        assert.ok(encontradosAntes >= 3);

        // ── La instancia muere ───────────────────────────────────────────────
        // Su fila queda con un dueño que ya no existe y un latido viejo. El
        // proceso viejo, si sigue vivo (aqui lo esta), ve en su siguiente
        // latido que la fila ya no es suya y SUELTA la busqueda.
        base.instanciaMuereCon(searchId);
        robloxRateLimiter.reset(); // el limitador de la instancia nueva arranca limpio
        await dormir(150);

        // ── La instancia nueva arranca y recupera ────────────────────────────
        const recuperacion = await jobs.recuperarAlArrancar();
        assert.strictEqual(recuperacion.adoptados, 1, 'no se adopto el trabajo estacionado');
        assert.strictEqual(base.operaciones.adopt, 1);

        const fin = await esperarTerminal(port, searchId);
        assert.strictEqual(fin.status, 'completed', `termino ${fin.status} por ${fin.stoppedBy}`);
        assert.strictEqual(fin.found, 10);

        // No empezo de cero: conserva lo encontrado antes de morir y sigue la
        // misma rotacion, asi que los 10 son exactamente los 10 primeros.
        assert.deepStrictEqual(idsDe(fin), PRIMEROS_10_VALIDOS);
        assert.strictEqual(fin.stats.rotationCycle, 1);
        assert.ok(fin.stats.rateLimitWaits >= 1, 'la instancia nueva deberia haber respetado el resumeAt');

        // La instancia nueva NO mando avatares durante lo que quedaba de
        // cooldown: el resumeAt del checkpoint se reaplico a su limitador.
        const fila = base.trabajosPersistidos.get(searchId);
        assert.strictEqual(fila.status, 'completed');
        assert.strictEqual(fila.phase, 'working');
    });

    test('un job estacionado con latido VIVO no se adopta: no es un huerfano', async () => {
        poblar();
        let servidos = 0;
        mundo.avatar = userId => {
            if (++servidos === 20) { cerrarRuta('userAvatar', 500); throw axiosError(429, { 'retry-after': '1' }); }
            return { status: 200, headers: {}, data: { assets: [{ id: userId * 10 }], playerAvatarType: 'R15' } };
        };

        const { body: { searchId } } = await buscarAsync(port);
        await esperarHasta(port, searchId, b => b.progress?.phase === 'rateLimitWait');

        // Late cada 40 ms: para el recolector esta vivo.
        const recuperacion = await jobs.recuperarAlArrancar();
        assert.strictEqual(recuperacion.adoptados, 0, 'se adopto un trabajo que estaba latiendo');

        const fin = await esperarTerminal(port, searchId);
        assert.strictEqual(fin.found, 10);
    });

    // ── 4. El grupo sigue reservado ──────────────────────────────────────────

    test('mientras A esta estacionado, B del MISMO grupo sigue en cola y C de OTRO grupo trabaja', async () => {
        poblar();
        // El runner deja la cache en 5 entradas; aqui C tiene que poder servirse
        // de ella para trabajar con la ruta del avatar CERRADA por A.
        const topeCache = config.cache.maxEntries;
        config.cache.maxEntries = 5_000;

        // C se calienta ANTES: sus avatares quedan en cache. Es lo que permite
        // demostrar la independencia de grupos aunque la ruta del avatar este
        // cerrada — la cuota de Roblox es por ruta, no por grupo, asi que un C
        // que necesitara avatares nuevos se estacionaria tambien (y eso seria
        // correcto). Lo que NO puede pasar es que C se quede en COLA por el
        // grupo de A.
        const { body: { searchId: calentar } } = await buscarAsync(port, { groupId: OTRO_GRUPO, amount: 2 });
        await esperarTerminal(port, calentar);
        base.rotaciones.delete(String(OTRO_GRUPO));

        let servidos = 0;
        mundo.avatar = userId => {
            if (++servidos === 20) { cerrarRuta('userAvatar', 2_500); throw axiosError(429, { 'retry-after': '3' }); }
            return { status: 200, headers: {}, data: { assets: [{ id: userId * 10 }], playerAvatarType: 'R15' } };
        };

        const { body: { searchId: a } } = await buscarAsync(port);
        let b = null;

        try {
            await esperarHasta(port, a, cuerpo => cuerpo.progress?.phase === 'rateLimitWait');

            // B, mismo grupo: en cola, con el lease de A vigente y renovandose.
            ({ body: { searchId: b } } = await buscarAsync(port, { amount: 2 }));
            await dormir(120);
            const estadoB = await consultar(port, b);
            assert.strictEqual(estadoB.body.status, 'queued', `B deberia estar en cola y esta ${estadoB.body.status}`);
            const fila = base.rotaciones.get(String(GROUP_ID));
            assert.ok(fila.leaseOwner, 'el lease de A no esta cogido durante su pausa');
            assert.ok(fila.leaseExpiresAt > Date.now() + 1_000, 'el lease de A no se esta renovando en la pausa');
            assert.ok(base.operaciones.renew >= 1, 'no hubo ninguna renovacion de lease durante la pausa');

            // C, otro grupo: NO hace cola por el grupo de A, y termina —
            // servido de cache — mientras A sigue estacionado.
            const pedidosAntesDeC = medidas.avatares;
            const { body: { searchId: c } } = await buscarAsync(port, { groupId: OTRO_GRUPO, amount: 2 });
            const finC = await esperarTerminal(port, c);
            assert.strictEqual(finC.status, 'completed');
            assert.strictEqual(finC.found, 2);
            assert.strictEqual(medidas.avatares, pedidosAntesDeC, 'C mando avatares con la ruta cerrada');
            const estadoA = await consultar(port, a);
            assert.strictEqual(estadoA.body.status, 'running');
            assert.strictEqual(estadoA.body.progress?.phase, 'rateLimitWait',
                'A deberia seguir estacionado cuando C termina: C espero a A pese a ser de otro grupo');

            // Al terminar A, B arranca donde A lo dejo, con la misma rotacion,
            // sin haber movido el cursor por encima de A.
            const finA = await esperarTerminal(port, a);
            const finB = await esperarTerminal(port, b);
            assert.strictEqual(finA.found, 10);
            assert.strictEqual(finB.status, 'completed');
            assert.strictEqual(finB.stats.rotationCycle, 1);
            const solape = finB.outfits.filter(o => PRIMEROS_10_VALIDOS.includes(o.userId));
            assert.ok(solape.length <= 1, 'B movio el cursor por encima de A');
        } finally {
            config.cache.maxEntries = topeCache;
            // Pase lo que pase, no se deja ningun trabajo vivo para el siguiente
            // caso: un job huerfano de aqui seguiria llamando al doble de
            // Roblox del caso siguiente y le desordenaria los contadores.
            await esperarTerminal(port, a).catch(() => {});
            if (b) await esperarTerminal(port, b).catch(() => {});
        }
    });

    // ── 5. Timeout absoluto ──────────────────────────────────────────────────

    test('el techo de reloj de pared SI termina en partial, con el motivo de la ruta', async () => {
        poblar();
        const presupuesto = config.pluginSearch.rateLimitWaitBudgetMs;
        config.pluginSearch.rateLimitWaitBudgetMs = 100; // no cabe ninguna pausa real
        let servidos = 0;
        mundo.avatar = userId => {
            if (++servidos === 20) { cerrarRuta('userAvatar', 5_000); throw axiosError(429, { 'retry-after': '5' }); }
            return { status: 200, headers: {}, data: { assets: [{ id: userId * 10 }], playerAvatarType: 'R15' } };
        };

        try {
            const { body: { searchId } } = await buscarAsync(port);
            const fin = await esperarTerminal(port, searchId);

            assert.strictEqual(fin.status, 'partial', `termino ${fin.status} por ${fin.stoppedBy}`);
            assert.strictEqual(fin.stats.stoppedBy, 'avatarRateLimit');
            assert.strictEqual(fin.stats.rateLimitedRoute, 'userAvatar');
            assert.ok(fin.found >= 3 && fin.found < 10, `found=${fin.found}, esperado entre 3 y 9`);
            // Y aun asi el candidato del 429 no se descarto ni se salto: la
            // rotacion no guardo el avance por encima de los pendientes.
            assert.strictEqual(fin.stats.rejectedAvatarError, 0);
            const fila = base.rotaciones.get(String(GROUP_ID));
            assert.ok(fila.intraPageOffset < 20, `la rotacion guardo offset ${fila.intraPageOffset} con pendientes sin mirar`);
        } finally {
            config.pluginSearch.rateLimitWaitBudgetMs = presupuesto;
            robloxRateLimiter.reset();
        }
    });

    // ── 6. Cache y scheduler ─────────────────────────────────────────────────

    test('un acierto de cache no pide permiso ni manda peticion: completa con la ruta CERRADA', async () => {
        poblar();
        // El runner deja la cache en 5 entradas para poder probar la expulsion
        // LRU en otro archivo; aqui hace falta que quepan 50 avatares.
        const topeCache = config.cache.maxEntries;
        config.cache.maxEntries = 5_000;
        const presupuesto = config.pluginSearch.rateLimitWaitBudgetMs;

        try {
            // Primera pasada: calienta la cache de avatares de los primeros 50.
            const { body: { searchId: primero } } = await buscarAsync(port);
            const fin1 = await esperarTerminal(port, primero);
            assert.strictEqual(fin1.found, 10);
            const pedidosAntes = medidas.avatares;

            // Se rebobina la rotacion (misma gente otra vez) y se CIERRA la
            // ruta del avatar durante un buen rato, sin presupuesto para
            // esperarla: lo unico que puede completar esto es la cache.
            base.rotaciones.clear();
            jobs.reset();
            cerrarRuta('userAvatar', 30_000);
            config.pluginSearch.rateLimitWaitBudgetMs = 0;

            const { body: { searchId: segundo } } = await buscarAsync(port);
            const fin2 = await esperarTerminal(port, segundo);

            assert.strictEqual(fin2.status, 'completed', `con la ruta cerrada deberia completar de cache y fue ${fin2.status}`);
            assert.strictEqual(fin2.found, 10);
            assert.strictEqual(medidas.avatares, pedidosAntes, 'salieron peticiones de avatar con todo en cache');
            assert.strictEqual(fin2.stats.avatarRequests, 0);
            assert.ok(fin2.stats.avatarCacheHits >= 50, `solo ${fin2.stats.avatarCacheHits} aciertos de cache`);
        } finally {
            config.cache.maxEntries = topeCache;
            config.pluginSearch.rateLimitWaitBudgetMs = presupuesto;
            robloxRateLimiter.reset();
        }
    });

    test('el scheduler de ruta evita el burst: nunca mas de N avatares en vuelo, y aprende de las cabeceras', async () => {
        poblar();
        // Roblox publica una cuota por cabeceras y la va gastando.
        let quedan = 40;
        mundo.avatar = userId => {
            quedan = Math.max(0, quedan - 1);
            return {
                status: 200,
                headers: { 'x-ratelimit-limit': '40', 'x-ratelimit-remaining': String(quedan), 'x-ratelimit-reset': '10' },
                data: { assets: [{ id: userId * 10 }], playerAvatarType: 'R15' },
            };
        };

        const { body: { searchId } } = await buscarAsync(port, { amount: 6 });
        const fin = await esperarTerminal(port, searchId);
        assert.strictEqual(fin.found, 6);

        assert.ok(medidas.avatarMaxEnVuelo <= config.upstream.routeConcurrency.userAvatar,
            `hubo ${medidas.avatarMaxEnVuelo} avatares en vuelo con tope ${config.upstream.routeConcurrency.userAvatar}`);
        // Con la cuota por debajo de la mitad, el marcapasos se activo SIN que
        // hiciera falta ningun 429.
        const estado = robloxRateLimiter.getThrottleState('userAvatar');
        assert.ok(estado.spacingMs > 0, 'el marcapasos no aprendio de las cabeceras');
        assert.strictEqual(estado.quota.limit, 40);
        assert.strictEqual(fin.stats.avatarRateLimited, 0, 'hubo 429 pese a las cabeceras');
    });

    const ok = await suite.run();

    roblox.listGroupMembers = original.listGroupMembers;
    roblox.getCurrentAvatar = original.getCurrentAvatar;
    roblox.getCatalogItemDetails = original.getCatalogItemDetails;
    Object.assign(repo, original.repo);
    Object.assign(jobRepo, original.jobRepo);
    config.pluginSearch.rateLimitHeartbeatMs = original.cfg.heartbeat;
    config.pluginSearch.rateLimitWaitMarginMs = original.cfg.margen;
    config.pluginSearch.rateLimitWaitBudgetMs = original.cfg.presupuesto;
    config.pluginSearch.rateLimitSingleWaitMs = original.cfg.pausa;
    cache.reset();
    ownRateLimit.reset();
    robloxRateLimiter.reset();
    jobs.reset();
    await new Promise(resolve => server.close(resolve));
    return ok;
};
