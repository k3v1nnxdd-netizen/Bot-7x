'use strict';

const http = require('http');
const { createSuite, axiosError } = require('./harness');
const { createApp } = require('../app');
const ownRateLimit = require('../security/rateLimit');
const robloxRateLimiter = require('../roblox/rateLimiter');
const roblox = require('../roblox/client');
const cache = require('../cache/cacheStore');
const config = require('../config');
const logger = require('../observability/logger');
const repo = require('../db/pluginRotationRepo');
const jobRepo = require('../db/pluginJobRepo');
const jobsA = require('../services/pluginSearch/jobs');
const { crearRunner } = require('../services/pluginSearch/runner');
const { crearBaseFalsa } = require('./fakeDb');

// PROPIEDAD Y TRASPASO DE TRABAJOS ENTRE INSTANCIAS.
//
// El fallo real que motivo esto: una busqueda nueva se quedo en 0 de 10 con 0
// candidatos para siempre. La instancia que la creo dijo "otra instancia la
// continua" — y ninguna la continuaba. Dos causas: la primera escritura
// vallada del ejecutor llegaba a Postgres antes que el INSERT (no se esperaba)
// y "cero filas" se leia como "adoptado"; y el runner arrancaba la busqueda
// aunque marcarla en curso hubiera fallado.
//
// LA PROPIEDAD QUE ESTE ARCHIVO GARANTIZA:
//
//   Todo trabajo no terminal tiene EXACTAMENTE UN ejecutor valido, o esta
//   esperando de forma intencional y recuperable (en cola / estacionado por
//   Roblox) con un dueño vivo que late por el. Nunca queda abandonado, y
//   nunca hay dos ejecutores sobre el mismo trabajo o la misma rotacion.
//
// Se prueba con DOS INSTANCIAS en el mismo proceso: A (la que atiende el HTTP)
// y B (levantada aparte con su propio registro y su propio runner, como la
// instancia nueva de un redeploy), compartiendo la misma base de mentira.

const GROUP_ID = 59218460;
const CLAVE_PLUGIN = config.pluginApiKey;
const INSTANCIA_B = 'instancia-B-deploy-nuevo';

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
    const suite = createSuite('pluginHandoff');
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
            heartbeat: config.pluginJobs.heartbeatIntervalMs,
            adopt: config.pluginJobs.adoptAfterMs,
            parkHeartbeat: config.pluginSearch.rateLimitHeartbeatMs,
            margen: config.pluginSearch.rateLimitWaitMarginMs,
            presupuesto: config.pluginSearch.rateLimitWaitBudgetMs,
        },
    };

    // Latidos y adopcion en milisegundos: lo que se prueba es la relacion.
    config.pluginJobs.heartbeatIntervalMs = 40;
    config.pluginJobs.adoptAfterMs = 400;
    config.pluginSearch.rateLimitHeartbeatMs = 40;
    config.pluginSearch.rateLimitWaitMarginMs = 20;
    config.pluginSearch.rateLimitWaitBudgetMs = 15_000;

    const base = crearBaseFalsa();
    base.instalar();

    // ── Instancia B: su propio registro y su propio runner ───────────────────
    const jobsB = jobsA.crearRegistro({ instancia: INSTANCIA_B });
    crearRunner(jobsB);
    const INSTANCIA_A = jobsA.instancia;

    // ── Comunidad: uno de cada cinco encaja; siempre ascendente ──────────────
    const VALIDO = userId => userId % 5 === 0;
    const PRIMEROS_10_VALIDOS = Array.from({ length: 10 }, (_, i) => 1000 + i * 5);

    let mundo = {};
    const medidas = {};

    function poblar({ miembros = 400, latenciaMs = 25 } = {}) {
        mundo = { miembros, latenciaMs, avatar: null };
        Object.assign(medidas, { avatares: 0, instantes: [] });
        cache.reset();
        base.limpiar();
        jobsA.reset();
        jobsB.reset();
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

    roblox.getCurrentAvatar = async userId => {
        const r = await robloxRateLimiter.run('userAvatar', async () => {
            medidas.avatares++;
            medidas.instantes.push(Date.now());
            await dormir(mundo.latenciaMs);
            if (mundo.avatar) return mundo.avatar(userId);
            return { status: 200, headers: {}, data: { assets: [{ id: userId * 10 }], playerAvatarType: 'R15' } };
        }, { endpoint: 'avatar.roblox.com/v1/users/{id}/avatar' });
        return r.data;
    };

    roblox.getCatalogItemDetails = async items => {
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

    const buscarEnA = (extra = {}) => pedir(port, 'POST', '/plugin/outfits/search', {
        amount: 10, groupId: GROUP_ID, minPrice: 300, requireCompletePrice: false, async: true, ...extra,
    });
    const consultarHttp = id => pedir(port, 'GET', `/plugin/outfits/search/${id}`);
    const TERMINAL = new Set(['completed', 'partial', 'failed', 'expired']);

    async function esperarHasta(condicion, { plazoMs = 20_000, lector = consultarHttp, id } = {}) {
        const limite = Date.now() + plazoMs;
        for (;;) {
            const res = await lector(id);
            const body = res.body ?? res;
            if (condicion(body)) return body;
            if (Date.now() > limite) throw new Error(`plazo agotado: ${JSON.stringify(body).slice(0, 400)}`);
            await dormir(15);
        }
    }
    const esperarTerminalHttp = id => esperarHasta(b => TERMINAL.has(b.status), { id });
    const verEnB = async id => jobsB.presentar(await jobsB.obtener(id));
    const esperarTerminalEnB = id => esperarHasta(b => TERMINAL.has(b.status), { id, lector: verEnB });
    const idsDe = body => body.outfits.map(o => o.userId).sort((a, b) => a - b);

    function espiarLogger() {
        const original_ = { warn: logger.warn, info: logger.info };
        const lineas = [];
        logger.warn = (msg, fields) => lineas.push({ nivel: 'warn', msg, fields: fields ?? {} });
        logger.info = (msg, fields) => lineas.push({ nivel: 'info', msg, fields: fields ?? {} });
        return {
            lineas,
            buscar: msg => lineas.find(l => l.msg === msg),
            todas: msg => lineas.filter(l => l.msg === msg),
            restaurar: () => { logger.warn = original_.warn; logger.info = original_.info; },
        };
    }

    // Todo lo que esta vivo en A o en B se deja terminar antes del siguiente
    // caso: un trabajo suelto seguiria llamando al Roblox de mentira del caso
    // siguiente.
    async function drenar(ids) {
        for (const id of ids) {
            await esperarHasta(b => TERMINAL.has(b.status) || b == null, { id, plazoMs: 25_000 }).catch(() => {});
        }
    }

    // ── 1. Una busqueda nueva NUNCA se queda sin ejecutor ───────────────────

    test('crear ESPERA al INSERT: la primera escritura vallada encuentra la fila y nadie "adopta" un trabajo recien creado', async () => {
        poblar();
        const espia = espiarLogger();
        try {
            const { body } = await buscarEnA();
            const fila = base.trabajosPersistidos.get(body.searchId);
            assert.ok(fila, 'el POST respondio antes de que el trabajo existiera en la base');
            assert.strictEqual(fila.instanceId, INSTANCIA_A);

            const fin = await esperarTerminalHttp(body.searchId);
            assert.strictEqual(fin.status, 'completed');
            assert.strictEqual(fin.found, 10);
            assert.strictEqual(fin.ownership.instance, INSTANCIA_A);
            assert.strictEqual(fin.ownership.handoffs, 0);
            assert.strictEqual(espia.buscar('Trabajo de busqueda adoptado por otra instancia: este proceso lo suelta'), undefined,
                'se marco como adoptado un trabajo que nadie mas tenia');
            assert.strictEqual(espia.buscar('Busqueda soltada: el trabajo lo continua otra instancia'), undefined);
        } finally {
            espia.restaurar();
        }
    });

    test('una fila AUSENTE no es una adopcion: el trabajo sigue en memoria y no se suelta', async () => {
        poblar();
        const { body } = await buscarEnA();
        // La base "pierde" la fila (el INSERT no llego, o alguien la borro).
        base.trabajosPersistidos.delete(body.searchId);

        const fin = await esperarTerminalHttp(body.searchId);
        assert.strictEqual(fin.status, 'completed', `termino ${fin.status}: una fila ausente se tomo por adopcion`);
        assert.strictEqual(fin.found, 10);
    });

    test('el repositorio distingue los cuatro motivos de "no es mio"', async () => {
        poblar();
        const mio = { searchId: 's_' + 'aa'.repeat(16), instanceId: INSTANCIA_A, groupId: GROUP_ID, target: 1, status: 'running', params: {} };
        assert.strictEqual((await jobRepo.actualizar(mio)).motivo, jobRepo.NO_ES_MIO.AUSENTE);

        base.trabajosPersistidos.set(mio.searchId, {
            searchId: mio.searchId, groupId: String(GROUP_ID), status: 'running', target: 1, params: {},
            instanceId: INSTANCIA_B, previousInstanceId: INSTANCIA_A, handoffs: 1,
            heartbeatAt: Date.now(), createdAt: Date.now(), outfits: [], progress: null,
        });
        const ajeno = await jobRepo.actualizar(mio);
        assert.strictEqual(ajeno.ok, false);
        assert.strictEqual(ajeno.motivo, jobRepo.NO_ES_MIO.ADOPTADO);
        assert.strictEqual(ajeno.dueño, INSTANCIA_B);

        base.trabajosPersistidos.get(mio.searchId).instanceId = null;
        assert.strictEqual((await jobRepo.actualizar(mio)).motivo, jobRepo.NO_ES_MIO.SOLTADO);

        base.trabajosPersistidos.get(mio.searchId).status = 'completed';
        assert.strictEqual((await jobRepo.actualizar(mio)).motivo, jobRepo.NO_ES_MIO.TERMINAL);
    });

    // ── 2. Deploy: B arranca mientras A trabaja ─────────────────────────────

    test('A trabaja, B arranca como en un deploy: B NO adopta un trabajo vivo; A lo termina', async () => {
        poblar();
        const { body } = await buscarEnA();
        await esperarHasta(b => (b.progress?.found ?? 0) >= 1, { id: body.searchId });

        // B arranca (su recuperacion de arranque), dos veces, mientras A late.
        for (let i = 0; i < 2; i++) {
            const r = await jobsB.recuperarAlArrancar();
            assert.strictEqual(r.adoptados, 0, 'B adopto un trabajo cuyo dueño estaba vivo');
            await dormir(60);
        }

        const fin = await esperarTerminalHttp(body.searchId);
        assert.strictEqual(fin.status, 'completed');
        assert.strictEqual(fin.found, 10);
        assert.strictEqual(fin.ownership.instance, INSTANCIA_A);
        assert.strictEqual(fin.ownership.handoffs, 0);
        assert.strictEqual(jobsB.tamano(), 0, 'B se quedo con una copia del trabajo de A');
    });

    // ── 3. A muere de verdad; B adopta el MISMO searchId y lo termina ───────

    test('A empieza, B aparece, A muere, B adopta y el MISMO searchId termina 10 de 10', async () => {
        poblar();
        const espia = espiarLogger();
        try {
            const { body } = await buscarEnA();
            const id = body.searchId;
            const enCurso = await esperarHasta(b => (b.progress?.found ?? 0) >= 2, { id });
            const encontradosAntes = enCurso.progress.found;
            const llamadasAntes = medidas.avatares;

            // B aparece y NO roba: A esta viva.
            assert.strictEqual((await jobsB.recuperarAlArrancar()).adoptados, 0);

            // A MUERE: deja de latir y su busqueda para en el siguiente
            // checkpoint sin escribir nada mas. La fila conserva al dueño
            // muerto con un latido que envejece.
            jobsA.__simularMuerte();
            base.instanciaMuereCon(id);

            // Mientras el latido no envejezca lo suficiente, B sigue sin adoptar.
            base.trabajosPersistidos.get(id).heartbeatAt = Date.now() - 100; // "hace 100 ms"
            assert.strictEqual((await jobsB.recuperarAlArrancar()).adoptados, 0, 'B adopto con un latido reciente');
            base.instanciaMuereCon(id);

            // Ahora si: huerfano de verdad.
            const r = await jobsB.recuperarAlArrancar();
            assert.strictEqual(r.adoptados, 1, 'B no adopto el trabajo huerfano');

            // Log del traspaso, con todo lo que hace falta para explicarlo.
            const adopcion = espia.buscar('Trabajo de busqueda adoptado');
            assert.ok(adopcion, 'no se registro la adopcion');
            assert.strictEqual(adopcion.fields.searchId, id);
            assert.strictEqual(adopcion.fields.previousInstance, INSTANCIA_A);
            assert.strictEqual(adopcion.fields.newInstance, INSTANCIA_B);
            assert.strictEqual(adopcion.fields.reason, 'heartbeat_stale');
            assert.ok(adopcion.fields.heartbeatAgeMs >= config.pluginJobs.adoptAfterMs);
            assert.strictEqual(adopcion.fields.handoffs, 1);
            const arranque = espia.buscar('Runner arrancado tras adoptar');
            assert.ok(arranque && arranque.fields.searchId === id, 'el runner no arranco tras adoptar');
            assert.strictEqual(arranque.fields.resumedFromCheckpoint, true);

            // El mismo searchId termina, visto desde B y por HTTP (A sirve de la
            // base porque sabe que ya no es suyo).
            const finB = await esperarTerminalEnB(id);
            assert.strictEqual(finB.status, 'completed', `termino ${finB.status} por ${finB.stoppedBy}`);
            assert.strictEqual(finB.found, 10);
            const finHttp = await esperarTerminalHttp(id);
            assert.strictEqual(finHttp.status, 'completed');
            assert.strictEqual(finHttp.searchId, id);
            assert.strictEqual(finHttp.ownership.instance, INSTANCIA_B);
            assert.strictEqual(finHttp.ownership.previousInstance, INSTANCIA_A);
            assert.strictEqual(finHttp.ownership.handoffs, 1);

            // No empezo de cero, no perdio ni duplico a nadie: conserva lo que A
            // encontro y los 10 son exactamente los 10 primeros validos.
            assert.ok(finHttp.stats.candidatesExamined >= encontradosAntes * 5 - 5);
            assert.deepStrictEqual(idsDe(finHttp), PRIMEROS_10_VALIDOS);
            assert.strictEqual(finHttp.stats.rotationCycle, 1);
            // Y B no repitio el trabajo de A: como mucho la ola que A tenia a
            // medias (la que no llego a persistir). Lo que le quedaba a B eran
            // los candidatos hasta el decimo valido (50 en total, 5 por valido)
            // menos los que A ya habia examinado, mas esa ola.
            const pendientesParaB = 50 - encontradosAntes * 5 + config.pluginRotation.segmentSize;
            assert.ok(medidas.avatares - llamadasAntes <= pendientesParaB,
                `B hizo ${medidas.avatares - llamadasAntes} llamadas de avatar (tope ${pendientesParaB}): rehizo el trabajo de A`);
            // Contando A y B juntos (los contadores viajan en el checkpoint), no
            // se examino mas de una ola por encima de lo estrictamente necesario.
            assert.ok(finHttp.stats.candidatesExamined <= 50 + config.pluginRotation.segmentSize,
                `entre A y B se examinaron ${finHttp.stats.candidatesExamined} candidatos para 10 validos`);
            // A nunca marco el trabajo como fallido: lo solto, sin mas.
            const fila = base.trabajosPersistidos.get(id);
            assert.strictEqual(fila.status, 'completed');
            assert.strictEqual(fila.error, null);
        } finally {
            espia.restaurar();
        }
    });

    // ── 4. A estacionada por 429 ─────────────────────────────────────────────

    test('A estacionada por 429 sigue viva: B arranca y NO la roba; A reanuda y termina', async () => {
        poblar();
        let servidos = 0;
        mundo.avatar = userId => {
            if (++servidos === 20) { throw axiosError(429, { 'retry-after': '1' }); }
            return { status: 200, headers: {}, data: { assets: [{ id: userId * 10 }], playerAvatarType: 'R15' } };
        };

        const { body } = await buscarEnA();
        const id = body.searchId;
        const enPausa = await esperarHasta(b => b.progress?.phase === 'rateLimitWait', { id });
        assert.strictEqual(enPausa.phase, 'rateLimitWait');

        // Durante la pausa A late: B, arrancando, no la considera huerfana.
        for (let i = 0; i < 3; i++) {
            assert.strictEqual((await jobsB.recuperarAlArrancar()).adoptados, 0, 'B robo un trabajo estacionado con dueño vivo');
            await dormir(100);
        }
        const fila = base.trabajosPersistidos.get(id);
        assert.ok(Date.now() - fila.heartbeatAt < config.pluginJobs.adoptAfterMs, 'el trabajo estacionado no latia');

        const fin = await esperarTerminalHttp(id);
        assert.strictEqual(fin.status, 'completed');
        assert.strictEqual(fin.found, 10);
        assert.strictEqual(fin.ownership.instance, INSTANCIA_A);
        assert.strictEqual(fin.ownership.handoffs, 0);
    });

    test('A muere DURANTE el cooldown: B adopta, conserva el cooldown, reanuda despues y completa 10 de 10', async () => {
        poblar();
        let servidos = 0;
        mundo.avatar = userId => {
            if (++servidos === 20) { throw axiosError(429, { 'retry-after': '2' }); }
            return { status: 200, headers: {}, data: { assets: [{ id: userId * 10 }], playerAvatarType: 'R15' } };
        };

        const { body } = await buscarEnA();
        const id = body.searchId;
        await esperarHasta(b => b.progress?.phase === 'rateLimitWait', { id });
        const resumeAt = base.trabajosPersistidos.get(id).resumeAt;
        assert.ok(resumeAt > Date.now() + 1_000, 'la pausa deberia durar aun mas de un segundo');

        // A muere en mitad de la pausa. El limitador de B arranca limpio.
        jobsA.__simularMuerte();
        base.instanciaMuereCon(id);
        robloxRateLimiter.reset();
        const llamadasAlMorir = medidas.avatares;
        const momentoDeAdopcion = Date.now();

        assert.strictEqual((await jobsB.recuperarAlArrancar()).adoptados, 1);

        // B respeta el resumeAt del checkpoint: ninguna llamada de avatar
        // antes de que la ruta reabra.
        const fin = await esperarTerminalEnB(id);
        const antesDeTiempo = medidas.instantes.filter(t => t > momentoDeAdopcion && t < resumeAt - 5);
        assert.strictEqual(antesDeTiempo.length, 0, `B mando ${antesDeTiempo.length} avatares antes de resumeAt`);
        assert.ok(medidas.avatares > llamadasAlMorir, 'B no reanudo la busqueda');

        assert.strictEqual(fin.status, 'completed');
        assert.strictEqual(fin.found, 10);
        assert.ok(fin.stats.rateLimitWaits >= 1);
        assert.deepStrictEqual(idsDe(fin), PRIMEROS_10_VALIDOS);
        const fila = base.trabajosPersistidos.get(id);
        assert.strictEqual(fila.instanceId, INSTANCIA_B);
        assert.strictEqual(fila.handoffs, 1);
    });

    // ── 5. Carrera: A pierde la propiedad estando viva ───────────────────────

    test('CARRERA: A deja de poder latir (base inaccesible), B adopta; A lo detecta y se detiene sin marcar fallo', async () => {
        poblar({ latenciaMs: 40 });
        const espia = espiarLogger();
        try {
            const { body } = await buscarEnA();
            const id = body.searchId;
            await esperarHasta(b => (b.progress?.found ?? 0) >= 1, { id });

            // A sigue viva, pero NINGUNA de sus escrituras llega a la base.
            base.latidosQueFallan = 1_000_000;
            await dormir(config.pluginJobs.adoptAfterMs + 80);

            // B adopta: el latido de A esta viejo de verdad.
            assert.strictEqual((await jobsB.recuperarAlArrancar()).adoptados, 1, 'B no adopto tras un latido caducado');
            const llamadasAlAdoptar = medidas.avatares;

            // La base vuelve. La siguiente escritura de A no toca su fila, A
            // pregunta quien es el dueño, ve que es B, y PARA.
            base.latidosQueFallan = 0;
            const soltada = await esperarHasta(
                () => espia.buscar('Busqueda soltada: el trabajo lo continua otra instancia') !== undefined,
                { id, plazoMs: 10_000, lector: async () => ({}) }
            ).then(() => true).catch(() => false);
            assert.ok(soltada, 'A no solto la busqueda al descubrir que B es la dueña');

            const perdida = espia.buscar('Trabajo de busqueda adoptado por otra instancia: este proceso lo suelta');
            assert.ok(perdida, 'A no dejo constancia del traspaso');
            assert.strictEqual(perdida.fields.previousInstance, INSTANCIA_A);
            assert.strictEqual(perdida.fields.newInstance, INSTANCIA_B);

            const fin = await esperarTerminalEnB(id);
            assert.strictEqual(fin.status, 'completed');
            assert.strictEqual(fin.found, 10);
            assert.deepStrictEqual(idsDe(fin), PRIMEROS_10_VALIDOS);
            // A no marco nada como fallido: la fila la termino B.
            const fila = base.trabajosPersistidos.get(id);
            assert.strictEqual(fila.instanceId, INSTANCIA_B);
            assert.strictEqual(fila.error, null);
            assert.strictEqual(fila.status, 'completed');
            // Y nunca hubo dos ejecutores moviendo la rotacion: el lease es
            // uno, y B solo pudo avanzar cuando A lo solto.
            assert.strictEqual(base.rotaciones.get(String(GROUP_ID)).leaseOwner, null);
            assert.ok(medidas.avatares - llamadasAlAdoptar <= 60, 'B rehizo el trabajo de A');
        } finally {
            base.latidosQueFallan = 0;
            espia.restaurar();
        }
    });

    // ── 6. Rolling deploy con dos instancias coexistiendo ───────────────────

    test('ROLLING DEPLOY: A (vieja) con un trabajo activo y otro en cola; B (nueva) coexiste sin robar; A recibe SIGTERM, suelta, B adopta ambos y los termina en orden', async () => {
        poblar({ latenciaMs: 30 });
        const { body: a1 } = await buscarEnA();
        const { body: a2 } = await buscarEnA({ amount: 3 });
        await esperarHasta(b => (b.progress?.found ?? 0) >= 1, { id: a1.searchId });

        // El segundo espera turno del mismo grupo.
        const enCola = await consultarHttp(a2.searchId);
        assert.strictEqual(enCola.body.status, 'queued');
        assert.strictEqual(enCola.body.phase, 'queued');

        // B arranca y coexiste: no roba ni el activo ni el que esta en cola.
        assert.strictEqual((await jobsB.recuperarAlArrancar()).adoptados, 0);

        // SIGTERM en A: suelta sus trabajos vivos con su ultimo checkpoint.
        const soltados = await jobsA.soltarTodos();
        assert.strictEqual(soltados.soltados, 2, `A solto ${soltados.soltados} de 2`);
        for (const id of [a1.searchId, a2.searchId]) {
            const fila = base.trabajosPersistidos.get(id);
            assert.strictEqual(fila.instanceId, null);
            assert.strictEqual(fila.previousInstanceId, INSTANCIA_A);
            assert.strictEqual(fila.phase, 'recovering');
        }
        // El GET (por A, que ya sabe que no son suyos) lo dice: recuperando.
        const visto = await consultarHttp(a1.searchId);
        assert.strictEqual(visto.body.phase, 'recovering');
        assert.strictEqual(visto.body.ownership.instance, null);

        // La pasada de recuperacion de B los adopta AL INSTANTE (soltados).
        const r = await jobsB.recuperarAlArrancar();
        assert.strictEqual(r.adoptados, 2, `B adopto ${r.adoptados} de 2`);

        const fin1 = await esperarTerminalEnB(a1.searchId);
        const fin2 = await esperarTerminalEnB(a2.searchId);
        assert.strictEqual(fin1.status, 'completed');
        assert.strictEqual(fin1.found, 10);
        assert.deepStrictEqual(idsDe(fin1), PRIMEROS_10_VALIDOS);
        assert.strictEqual(fin2.status, 'completed');
        assert.strictEqual(fin2.found, 3);
        // El segundo continuo la rotacion donde la dejo el primero: NADIE
        // repetido entre los dos.
        const solape = fin2.outfits.filter(o => PRIMEROS_10_VALIDOS.includes(o.userId));
        assert.strictEqual(solape.length, 0, `el segundo trabajo repitio ${solape.length} outfits del primero`);
        for (const id of [a1.searchId, a2.searchId]) {
            const fila = base.trabajosPersistidos.get(id);
            assert.strictEqual(fila.instanceId, INSTANCIA_B);
            assert.strictEqual(fila.handoffs, 1);
            assert.strictEqual(fila.adoptionReason ?? 'released', 'released');
        }
        // Y por HTTP (A) se ve el resultado que produjo B.
        const porHttp = await esperarTerminalHttp(a1.searchId);
        assert.strictEqual(porHttp.ownership.instance, INSTANCIA_B);
        assert.strictEqual(porHttp.found, 10);
    });

    // ── 7. Fallo transitorio de Postgres en el latido ───────────────────────

    test('un bache de Postgres en el latido NO entrega el trabajo a otra instancia', async () => {
        poblar({ latenciaMs: 30 });
        const { body } = await buscarEnA();
        const id = body.searchId;
        await esperarHasta(b => (b.progress?.found ?? 0) >= 1, { id });

        // Fallan los siguientes latidos/volcados de A: menos de lo que dura la
        // tolerancia (400 ms a 40 ms por latido son diez fallos seguidos).
        base.latidosQueFallan = 5;
        for (let i = 0; i < 4; i++) {
            assert.strictEqual((await jobsB.recuperarAlArrancar()).adoptados, 0,
                'un bache transitorio de la base le quito el trabajo a A');
            await dormir(60);
        }

        const fin = await esperarTerminalHttp(id);
        assert.strictEqual(fin.status, 'completed');
        assert.strictEqual(fin.found, 10);
        assert.strictEqual(fin.ownership.instance, INSTANCIA_A);
        assert.strictEqual(fin.ownership.handoffs, 0);
    });

    // ── 8. El GET distingue en que esta cada trabajo ────────────────────────

    test('el GET distingue queued, working, rateLimitWait, recovering y orphaned, y el progreso se mueve durante una pausa', async () => {
        poblar();
        let servidos = 0;
        mundo.avatar = userId => {
            if (++servidos === 20) { throw axiosError(429, { 'retry-after': '2' }); }
            return { status: 200, headers: {}, data: { assets: [{ id: userId * 10 }], playerAvatarType: 'R15' } };
        };

        const { body: a1 } = await buscarEnA();
        const { body: a2 } = await buscarEnA({ amount: 2 });

        const trabajando = await esperarHasta(b => b.phase === 'working' && (b.progress?.found ?? 0) >= 1, { id: a1.searchId });
        assert.strictEqual(trabajando.status, 'running');
        assert.strictEqual(trabajando.ownership.servedFrom, 'memory');

        const enCola = await consultarHttp(a2.searchId);
        assert.strictEqual(enCola.body.phase, 'queued');

        const pausa1 = await esperarHasta(b => b.phase === 'rateLimitWait', { id: a1.searchId });
        assert.strictEqual(pausa1.progress.phase, 'rateLimitWait');
        assert.strictEqual(pausa1.progress.rateLimitedRoute, 'userAvatar');
        await dormir(150);
        const pausa2 = await consultarHttp(a1.searchId);
        assert.ok(pausa2.body.progress.cooldownRemainingMs < pausa1.progress.cooldownRemainingMs,
            'el contador de la pausa no se mueve entre dos consultas');
        assert.ok(pausa2.body.ownership.heartbeatAgeMs < config.pluginJobs.adoptAfterMs, 'estacionado y sin latir');

        // Una fila huerfana en la base (dueño muerto, sin adoptar todavia).
        const huerfano = 's_' + 'bb'.repeat(16);
        base.trabajosPersistidos.set(huerfano, {
            searchId: huerfano, groupId: String(GROUP_ID), status: 'running', target: 5, found: 1,
            candidatesExamined: 7, stoppedBy: null, progress: { found: 1, candidatesExamined: 7, phase: 'working' },
            outfits: [], stats: null, error: null, params: { amount: 5, groupId: GROUP_ID },
            phase: 'working', resumeAt: null, rateLimitedRoute: null, checkpoint: null,
            instanceId: 'instancia-muerta', previousInstanceId: null, handoffs: 0,
            createdAt: Date.now() - 60_000, startedAt: Date.now() - 60_000, finishedAt: null,
            heartbeatAt: Date.now() - config.pluginJobs.adoptAfterMs - 1_000, expiresAt: null,
        });
        const vistoHuerfano = await consultarHttp(huerfano);
        assert.strictEqual(vistoHuerfano.body.status, 'running');
        assert.strictEqual(vistoHuerfano.body.phase, 'orphaned');
        assert.strictEqual(vistoHuerfano.body.ownership.servedFrom, 'database');
        assert.ok(vistoHuerfano.body.ownership.heartbeatAgeMs > config.pluginJobs.adoptAfterMs);
        base.trabajosPersistidos.delete(huerfano);

        await drenar([a1.searchId, a2.searchId]);
    });

    const ok = await suite.run();

    roblox.listGroupMembers = original.listGroupMembers;
    roblox.getCurrentAvatar = original.getCurrentAvatar;
    roblox.getCatalogItemDetails = original.getCatalogItemDetails;
    Object.assign(repo, original.repo);
    Object.assign(jobRepo, original.jobRepo);
    config.pluginJobs.heartbeatIntervalMs = original.cfg.heartbeat;
    config.pluginJobs.adoptAfterMs = original.cfg.adopt;
    config.pluginSearch.rateLimitHeartbeatMs = original.cfg.parkHeartbeat;
    config.pluginSearch.rateLimitWaitMarginMs = original.cfg.margen;
    config.pluginSearch.rateLimitWaitBudgetMs = original.cfg.presupuesto;
    cache.reset();
    ownRateLimit.reset();
    robloxRateLimiter.reset();
    jobsA.reset();
    jobsB.reset();
    await new Promise(resolve => server.close(resolve));
    return ok;
};
