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
const { crearEstimador, ewma } = require('../services/pluginSearch/eta');

// Rotacion persistente, trabajos asincronos y estimacion de tiempo.
//
// Archivo aparte de plugin.test.js a proposito: aquel prueba el MOTOR de la
// busqueda (precio, lotes, backpressure) y este prueba lo que la envuelve —
// por donde va la comunidad, como se sigue una busqueda en curso y cuanto
// queda. Mezclarlos daria un archivo de mil lineas donde no se encuentra nada.
//
// La base de datos se sustituye por un doble EN MEMORIA con la misma semantica
// que las dos tablas de Postgres, incluido el lease. Asi se puede probar la
// rotacion, la concurrencia y la recuperacion sin depender de que haya una base
// levantada — que es justo lo que no queremos en la suite.

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
                resolve({ status: res.statusCode, body: parsed, raw: data });
            });
        });
        req.on('error', reject);
        if (payload !== null) req.write(payload);
        req.end();
    });
}

const buscar = (port, extra = {}) => pedir(port, 'POST', '/plugin/outfits/search', {
    amount: 5, groupId: GROUP_ID, requireCompletePrice: false, ...extra,
});

// El doble de Postgres vive en fakeDb.js y lo comparten este archivo y
// pluginPark.test.js: dos copias del mismo doble acabarian con dos semanticas
// distintas de la misma tabla.
const { crearBaseFalsa } = require('./fakeDb');

module.exports = async function run() {
    const suite = createSuite('pluginRotation');
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
    };

    const base = crearBaseFalsa();
    base.instalar();

    // ── Comunidad de mentira, paginada como Roblox ───────────────────────────
    let mundo = {};
    const llamadas = { members: 0, avatars: 0 };

    function poblar({ miembros = 250, avatarRoto = () => false, precio = () => 100,
        cursorInvalido = null } = {}) {
        mundo = { miembros, avatarRoto, precio, cursorInvalido };
        llamadas.members = 0;
        llamadas.avatars = 0;
        cache.reset();
        base.limpiar();
        jobs.reset();
        robloxRateLimiter.reset();
    }

    // Cursores con forma de cursor real: opacos para quien los use, pero
    // deterministas para poder afirmar sobre ellos desde el test.
    const cursorDePagina = n => `cur_${n}_${'x'.repeat(20)}`;
    const paginaDeCursor = cursor => (cursor === null ? 0 : Number(String(cursor).split('_')[1]));

    roblox.listGroupMembers = async (groupId, { cursor = null, sortOrder = 'Asc' } = {}) => {
        llamadas.members++;

        if (mundo.cursorInvalido && cursor === mundo.cursorInvalido) {
            throw axiosError(400, {}, { errors: [{ message: 'InvalidCursor' }] });
        }

        const pagina = paginaDeCursor(cursor);
        const desde = pagina * 100;
        const hasta = Math.min(desde + 100, mundo.miembros);
        const members = [];
        for (let i = desde; i < hasta; i++) {
            // El sentido del recorrido cambia a quien sale, igual que en Roblox.
            const indice = sortOrder === 'Desc' ? mundo.miembros - 1 - i : i;
            members.push({ userId: 100000 + indice, username: `U${100000 + indice}` });
        }
        return { members, nextCursor: hasta < mundo.miembros ? cursorDePagina(pagina + 1) : null };
    };

    roblox.getCurrentAvatar = async userId => {
        llamadas.avatars++;
        if (mundo.avatarRoto(userId)) throw axiosError(404);
        return { assets: [{ id: userId * 10 }], playerAvatarType: 'R15' };
    };

    roblox.getCatalogItemDetails = async items => {
        const mapa = new Map();
        for (const item of items) {
            mapa.set(roblox.catalogKey('Asset', item.id), {
                available: true, assetTypeId: 8, isLimited: false, offSale: false,
                price: mundo.precio(Number(item.id) / 10),
            });
        }
        return mapa;
    };

    const idsDe = res => res.body.outfits.map(o => o.userId);

    // ── Rotacion secuencial ──────────────────────────────────────────────────

    test('la primera busqueda arranca por el principio de la comunidad', async () => {
        poblar({ miembros: 250 });
        const res = await buscar(port, { amount: 5 });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.found, 5);
        assert.strictEqual(res.body.stats.rotationMode, 'leased');
        assert.strictEqual(res.body.stats.rotationStart.cursor, 'first');
        assert.strictEqual(res.body.stats.rotationStart.offset, 0);
    });

    test('la segunda busqueda REANUDA donde termino la primera', async () => {
        poblar({ miembros: 250 });

        const primera = await buscar(port, { amount: 5 });
        const segunda = await buscar(port, { amount: 5 });

        assert.strictEqual(primera.body.found, 5);
        assert.strictEqual(segunda.body.found, 5);

        // rotationEnd publica la posicion VIVA (exclusiva); lo que se guarda es
        // la inclusiva, un miembro por detras. Reanudar ahi es la definicion de
        // resumeInclusive.
        const esperado = primera.body.stats.rotationEnd.offset - 1;
        assert.strictEqual(segunda.body.stats.rotationStart.offset, esperado,
            'la segunda busqueda no arranco donde termino la primera');

        // Y avanza de verdad: el tramo nuevo no repite al anterior salvo el
        // miembro inclusivo de la frontera. (No se compara la MAGNITUD de los
        // userId: el sentido del recorrido se sortea por grupo, asi que avanzar
        // puede significar ids crecientes o decrecientes.)
        const solape = idsDe(segunda).filter(id => idsDe(primera).includes(id));
        assert.strictEqual(solape.length, 1,
            `la segunda busqueda deberia repetir solo el miembro inclusivo y repitio ${solape.length}`);
        assert.ok(segunda.body.stats.rotationEnd.offset > primera.body.stats.rotationEnd.offset,
            'la rotacion no avanzo entre las dos busquedas');
    });

    test('la reanudacion es INCLUSIVA: repite exactamente al ultimo miembro', async () => {
        poblar({ miembros: 250 });
        assert.strictEqual(config.pluginRotation.resumeInclusive, true,
            'este caso describe el comportamiento con resumeInclusive activado');

        const primera = await buscar(port, { amount: 5 });
        const segunda = await buscar(port, { amount: 5 });

        const ultimoDeLaPrimera = idsDe(primera)[primera.body.found - 1];
        const primeroDeLaSegunda = idsDe(segunda)[0];

        assert.strictEqual(primeroDeLaSegunda, ultimoDeLaPrimera,
            'con resumeInclusive el primer miembro de la segunda deberia ser el ultimo de la primera');
    });

    test('tres busquedas seguidas recorren tramos consecutivos y sin solapes largos', async () => {
        poblar({ miembros: 250 });

        const vistos = [];
        const finales = [];
        for (let i = 0; i < 3; i++) {
            const res = await buscar(port, { amount: 5 });
            vistos.push(idsDe(res));
            finales.push(res.body.stats.rotationEnd.offset);
        }

        // Cada tramo deja la rotacion mas adelante que el anterior.
        assert.ok(finales[1] > finales[0], `la 2a busqueda no avanzo: ${finales[0]} -> ${finales[1]}`);
        assert.ok(finales[2] > finales[1], `la 3a busqueda no avanzo: ${finales[1]} -> ${finales[2]}`);

        // El unico solape admisible es el miembro inclusivo de la frontera.
        const solape01 = vistos[0].filter(id => vistos[1].includes(id));
        const solape12 = vistos[1].filter(id => vistos[2].includes(id));
        assert.ok(solape01.length <= 1, `solape de ${solape01.length} entre la 1a y la 2a busqueda`);
        assert.ok(solape12.length <= 1, `solape de ${solape12.length} entre la 2a y la 3a busqueda`);

        // Y los tres tramos juntos cubren gente distinta: 3 busquedas de 5 con
        // dos fronteras inclusivas son 13 personas distintas.
        const todos = new Set(vistos.flat());
        assert.strictEqual(todos.size, 13, `se esperaban 13 miembros distintos y hubo ${todos.size}`);
    });

    test('al final de la comunidad da la vuelta y sigue por el principio', async () => {
        // Comunidad diminuta: unas pocas busquedas la recorren entera.
        poblar({ miembros: 12 });

        let dioLaVuelta = false;
        for (let i = 0; i < 6 && !dioLaVuelta; i++) {
            const res = await buscar(port, { amount: 3 });
            if (res.body.stats.rotationWraps > 0 || res.body.stats.rotationCycle > 1) dioLaVuelta = true;
        }

        assert.ok(dioLaVuelta, 'la rotacion nunca dio la vuelta en una comunidad de 12 miembros');
        const fila = base.rotaciones.get(String(GROUP_ID));
        assert.ok(fila.cycle >= 2, `el ciclo persistido deberia haber avanzado, va por ${fila.cycle}`);
    });

    test('una vuelta entera sin resultados termina sola, sin bucle', async () => {
        // Nadie encaja: el rango es imposible. La busqueda tiene que dar la
        // vuelta, ver que no hay nadie nuevo y parar.
        poblar({ miembros: 30, precio: () => 10 });
        const res = await buscar(port, { amount: 50, minPrice: 900000, maxPrice: 1000000 });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.found, 0);
        assert.ok(['candidatesExhausted', 'candidateCap'].includes(res.body.stats.stoppedBy),
            `se esperaba parada por agotamiento y fue ${res.body.stats.stoppedBy}`);
        // Con 30 miembros no puede haber examinado cientos: la deduplicacion
        // dentro de la busqueda tiene que haber cortado.
        assert.ok(res.body.stats.candidatesExamined <= 31,
            `examino ${res.body.stats.candidatesExamined} candidatos en una comunidad de 30`);
    });

    test('nunca repite un userId dentro de la misma busqueda, aunque de la vuelta', async () => {
        poblar({ miembros: 8 });
        const res = await buscar(port, { amount: 50 });

        const ids = idsDe(res);
        assert.strictEqual(new Set(ids).size, ids.length, `hay duplicados: ${ids.join(',')}`);
        assert.ok(res.body.found <= 8, 'devolvio mas outfits que miembros tiene la comunidad');
    });

    // ── Paginacion dentro de UNA busqueda ────────────────────────────────────
    //
    // La rotacion no solo recuerda por donde va entre busquedas: dentro de una
    // sola tiene que poder pasar de la pagina 1 a la 2, a la 3 y a las que
    // hagan falta. El sintoma que se vio en produccion fue `memberPagesFetched:
    // 1`: la busqueda se quedaba en los primeros 100 miembros porque el
    // presupuesto se agotaba antes de necesitar la segunda pagina.

    test('una busqueda sola cruza varias paginas y la rotacion queda en la pagina y el offset exactos', async () => {
        // Uno de cada 60 encaja: para juntar 5 hay que llegar a la tercera pagina.
        poblar({ miembros: 500, precio: userId => (userId % 60 === 0 ? 500 : 10) });
        const res = await buscar(port, { amount: 5, minPrice: 400 });

        assert.strictEqual(res.body.found, 5);
        assert.ok(res.body.stats.memberPagesFetched >= 3,
            `solo pidio ${res.body.stats.memberPagesFetched} paginas`);

        const fila = base.rotaciones.get(String(GROUP_ID));
        assert.ok(fila, 'no se persistio la rotacion');
        assert.ok(fila.cursor !== null, 'la rotacion se quedo guardada en la primera pagina');
        assert.strictEqual(fila.cycle, 1, 'no deberia haber dado la vuelta a la comunidad');

        // La posicion viva que publica stats es EXCLUSIVA (el siguiente a
        // mirar); lo que se guarda es la INCLUSIVA, un miembro por detras. Esa
        // diferencia de uno es toda la definicion de resumeInclusive.
        assert.strictEqual(fila.intraPageOffset, res.body.stats.rotationEnd.offset - 1);

        // Y el ultimo miembro guardado es el ultimo que la rotacion ENTREGO, no
        // el ultimo que resulto valido: la rotacion marca por donde va el
        // recorrido de la comunidad, no cuantos outfits salieron de el. El
        // sentido del recorrido se sortea por grupo, asi que valen los dos.
        const examinados = res.body.stats.candidatesExamined;
        const ascendente = 100000 + examinados - 1;
        const descendente = 100000 + 500 - examinados;
        assert.ok([ascendente, descendente].map(String).includes(String(fila.lastUserId)),
            `lastUserId=${fila.lastUserId} no cuadra con ${examinados} candidatos entregados`);

        // Y la siguiente busqueda arranca EXACTAMENTE ahi, en su pagina.
        // La fila del doble es la MISMA referencia que muta la busqueda
        // siguiente: sin copiarla aqui, lo que se compara despues ya no es lo
        // que dejo la primera.
        const guardado = { ...fila };
        const segunda = await buscar(port, { amount: 1, minPrice: 400 });
        assert.strictEqual(segunda.body.stats.rotationStart.offset, guardado.intraPageOffset);
        assert.strictEqual(segunda.body.stats.rotationStart.cursor,
            String(guardado.cursor).slice(0, 12));
        assert.strictEqual(segunda.body.stats.rotationCycle, 1);
    });

    test('cruzar paginas dentro de una busqueda no repite a nadie', async () => {
        // El wrap-around y el salto de pagina son los dos sitios donde un
        // miembro podria colarse dos veces; `visitedUserIds` los cubre los dos.
        poblar({ miembros: 350, precio: () => 100 });
        const res = await buscar(port, { amount: 120 });

        const ids = idsDe(res);
        assert.strictEqual(new Set(ids).size, ids.length, 'hay userIds repetidos');
        assert.ok(res.body.stats.memberPagesFetched >= 2,
            'el caso no llego a cruzar de pagina, no prueba nada');
    });

    test('esperar turno NO consume el presupuesto de tiempo de la busqueda', async () => {
        // El reloj arrancaba al aceptar la peticion, no al empezar a buscar. Con
        // presupuestos cortos eso dejaba a la SEGUNDA busqueda de una comunidad
        // sin tiempo antes de haber mirado a nadie: hacia cola, entraba con el
        // presupuesto ya gastado y devolvia `timeBudget` con found:0.
        poblar({ miembros: 250 });

        const presupuestoOriginal = config.pluginSearch.timeBudgetMs;
        const listarOriginal = roblox.listGroupMembers;
        config.pluginSearch.timeBudgetMs = 400;

        // La busqueda de delante tarda MAS que ese presupuesto en soltar el grupo.
        let primeraLlamada = true;
        roblox.listGroupMembers = async (...args) => {
            if (primeraLlamada) {
                primeraLlamada = false;
                await new Promise(resolve => setTimeout(resolve, 600));
            }
            return listarOriginal(...args);
        };

        try {
            const [a, b] = await Promise.all([
                buscar(port, { amount: 5 }),
                buscar(port, { amount: 5 }),
            ]);

            assert.strictEqual(a.body.found, 5);
            assert.strictEqual(b.body.found, 5,
                'la segunda busqueda se quedo sin presupuesto haciendo cola');
            assert.notStrictEqual(b.body.stats.stoppedBy, 'timeBudget');
        } finally {
            config.pluginSearch.timeBudgetMs = presupuestoOriginal;
            roblox.listGroupMembers = listarOriginal;
        }
    });

    // ── amount = outfits validos, no intentos ────────────────────────────────

    test('los candidatos invalidos se sustituyen: 10 pedidos, 10 conseguidos', async () => {
        // Dos de cada tres avatares fallan. Con la semantica antigua (amount =
        // intentos) esto habria devuelto ~3; ahora tiene que llegar a 10.
        poblar({ miembros: 250, avatarRoto: userId => userId % 3 !== 0 });

        const res = await buscar(port, { amount: 10 });

        assert.strictEqual(res.body.found, 10, 'no completo los 10 outfits pedidos');
        assert.ok(res.body.stats.candidatesExamined >= 30,
            `examino solo ${res.body.stats.candidatesExamined} candidatos para 10 resultados`);
        assert.ok(res.body.stats.rejectedAvatarError >= 20);
        assert.strictEqual(res.body.stats.stoppedBy, 'completed');
    });

    test('un precio fuera de rango tampoco gasta plaza', async () => {
        // Solo uno de cada cuatro entra en el rango.
        poblar({ miembros: 250, precio: userId => (userId % 4 === 0 ? 500 : 50) });
        const res = await buscar(port, { amount: 8, minPrice: 400, maxPrice: 600 });

        assert.strictEqual(res.body.found, 8);
        assert.ok(res.body.stats.rejectedMinPrice >= 8);
        for (const outfit of res.body.outfits) {
            assert.ok(outfit.totalPrice >= 400 && outfit.totalPrice <= 600);
        }
    });

    test('si la comunidad no da para tanto, devuelve parcial sin error', async () => {
        poblar({ miembros: 7 });
        const res = await buscar(port, { amount: 10 });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.requested, 10);
        assert.strictEqual(res.body.found, 7);
        assert.strictEqual(res.body.stats.stoppedBy, 'candidatesExhausted');
    });

    // ── Presupuestos ─────────────────────────────────────────────────────────

    test('el TECHO DURO sigue cortando aunque falten resultados', async () => {
        // Con el techo real (100 x 150 = 15.000) una comunidad de 5000 se agota
        // primero, que es lo que se quiere. Aqui se baja a proposito para
        // comprobar que la proteccion anti-bucle existe y funciona.
        const original = config.pluginSearch.hardCandidateLimit;
        config.pluginSearch.hardCandidateLimit = 200;
        poblar({ miembros: 5000, precio: () => 10 });

        try {
            const res = await buscar(port, { amount: 100, minPrice: 999999 });

            assert.strictEqual(res.body.found, 0);
            assert.strictEqual(res.body.stats.stoppedBy, 'candidateCap');
            assert.ok(res.body.stats.candidatesExamined <= 200 + config.pluginRotation.segmentSize);
        } finally {
            config.pluginSearch.hardCandidateLimit = original;
        }
    });

    test('el presupuesto de tiempo corta limpiamente', async () => {
        const original = config.pluginSearch.timeBudgetMs;
        config.pluginSearch.timeBudgetMs = 0;
        poblar({ miembros: 500 });

        try {
            const res = await buscar(port, { amount: 100 });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.stats.stoppedBy, 'timeBudget');
            assert.strictEqual(llamadas.avatars, 0, 'gasto avatares con el tiempo ya agotado');
        } finally {
            config.pluginSearch.timeBudgetMs = original;
        }
    });

    test('un 429 del catalogo para la busqueda y conserva lo encontrado', async () => {
        poblar({ miembros: 500 });
        const catalogoBase = roblox.getCatalogItemDetails;
        let lotes = 0;

        roblox.getCatalogItemDetails = async items => {
            lotes++;
            if (lotes > 1) {
                return robloxRateLimiter.run('catalogDetails', async () => {
                    throw axiosError(429, { 'retry-after': '30' });
                }, { endpoint: 'catalog.roblox.com/v1/catalog/items/details' });
            }
            return catalogoBase(items);
        };

        try {
            const res = await buscar(port, { amount: 200 });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.stats.stoppedByCatalogRateLimit, true);
            assert.ok(res.body.found > 0, 'se perdieron los outfits encontrados antes del 429');
        } finally {
            roblox.getCatalogItemDetails = catalogoBase;
            robloxRateLimiter.reset();
        }
    });

    // ── Persistencia, recuperacion y concurrencia ────────────────────────────

    test('el progreso persiste entre busquedas y sobrevive a un reinicio', async () => {
        poblar({ miembros: 250 });
        await buscar(port, { amount: 5 });

        const fila = base.rotaciones.get(String(GROUP_ID));
        assert.ok(fila, 'no se persistio la rotacion del grupo');
        assert.ok(fila.lastUserId !== null, 'no se guardo el ultimo miembro procesado');
        assert.strictEqual(fila.leaseOwner, null, 'el lease quedo cogido al terminar');

        // Un reinicio de Railway: los trabajos en memoria se pierden, la fila no.
        jobs.reset();
        const guardado = { ...fila };

        const despues = await buscar(port, { amount: 5 });
        assert.strictEqual(despues.body.stats.rotationStart.offset, guardado.intraPageOffset,
            'tras el reinicio la busqueda no continuo por donde iba');
    });

    test('un cursor invalido reinicia el ciclo en vez de romper la busqueda', async () => {
        poblar({ miembros: 250 });

        // Se deja la rotacion apuntando a un cursor que Roblox ya no acepta.
        base.rotaciones.set(String(GROUP_ID), {
            groupId: String(GROUP_ID), sortOrder: 'Asc',
            cursor: cursorDePagina(1), intraPageOffset: 10,
            lastUserId: '100050', cycle: 3, cursorResets: 0,
            leaseOwner: null, leaseExpiresAt: null,
        });
        mundo.cursorInvalido = cursorDePagina(1);

        const res = await buscar(port, { amount: 5 });

        assert.strictEqual(res.status, 200, 'un cursor caducado tumbo la busqueda');
        assert.strictEqual(res.body.found, 5);
        assert.strictEqual(res.body.stats.rotationCursorResets, 1);
        assert.strictEqual(res.body.stats.rotationEnd.cursor, 'first',
            'tras el reinicio deberia estar recorriendo la primera pagina');
    });

    test('un grupo inexistente sigue siendo 404, no un reinicio de cursor', async () => {
        poblar({ miembros: 0 });
        const listarBase = roblox.listGroupMembers;
        roblox.listGroupMembers = async () => {
            throw new (require('../roblox/errors').NotFoundError)('group_not_found', 'no existe');
        };

        try {
            const res = await buscar(port, { amount: 5 });
            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.body.error.code, 'group_not_found');
        } finally {
            roblox.listGroupMembers = listarBase;
        }
    });

    // ── Cola por comunidad ───────────────────────────────────────────────────
    //
    // Una sola busqueda recorre un grupo a la vez. Lo que se prueba aqui no es
    // que "no choquen", sino que la segunda ESPERA y continua donde acabo la
    // primera — que es lo unico que hace que la rotacion signifique algo.

    test('la segunda busqueda del mismo grupo queda en cola, no recorre en paralelo', async () => {
        poblar({ miembros: 250 });
        const { abrirRotacion } = require('../services/pluginSearch/rotation');
        const { crearStats } = require('../services/pluginSearch/stats');
        const cola = require('../services/pluginSearch/groupQueue');

        const a = await abrirRotacion(GROUP_ID, crearStats());
        assert.strictEqual(a.modo, 'leased');
        assert.strictEqual(cola.estaOcupado(GROUP_ID), true);

        // B pide turno y se queda esperando: su promesa NO resuelve mientras A
        // no cierre. Se comprueba sin sondear, dandole al bucle de eventos la
        // oportunidad de resolverla si fuera a hacerlo.
        let posicionAvisada = null;
        let bLista = false;
        const promesaB = abrirRotacion(GROUP_ID, crearStats(), {
            onEncolado: posicion => { posicionAvisada = posicion; },
        }).then(rotacion => { bLista = true; return rotacion; });

        await new Promise(resolve => setImmediate(resolve));
        assert.strictEqual(bLista, false, 'la segunda rotacion arranco sin esperar turno');
        assert.strictEqual(posicionAvisada, 1, 'no se aviso de la posicion en cola');

        // Al cerrar A, B arranca sola. Sin temporizadores ni sondeo.
        await a.cerrar();
        const b = await promesaB;

        assert.strictEqual(bLista, true, 'la segunda rotacion no arranco al liberarse el turno');
        assert.strictEqual(b.modo, 'leased', 'la segunda tambien deberia recorrer con lease');
        await b.cerrar();

        const fila = base.rotaciones.get(String(GROUP_ID));
        assert.strictEqual(fila.leaseOwner, null, 'quedo un lease sin soltar');
    });

    test('la segunda arranca EXACTAMENTE donde termino la primera', async () => {
        poblar({ miembros: 250 });
        const { abrirRotacion } = require('../services/pluginSearch/rotation');
        const { crearStats } = require('../services/pluginSearch/stats');

        const a = await abrirRotacion(GROUP_ID, crearStats());
        const primeros = await a.siguienteSegmento(6);
        const finDeA = a.posicion.offset;
        await a.cerrar();

        const b = await abrirRotacion(GROUP_ID, crearStats());
        assert.strictEqual(b.inicio.offset, finDeA - 1,
            'la segunda no reanudo en la posicion inclusiva de la primera');

        const siguientes = await b.siguienteSegmento(6);
        await b.cerrar();

        // El ultimo de A es el primero de B (reanudacion inclusiva) y de ahi en
        // adelante todo es nuevo.
        assert.strictEqual(siguientes[0].userId, primeros[primeros.length - 1].userId);
        const idsA = new Set(primeros.map(m => m.userId));
        const repetidos = siguientes.filter(m => idsA.has(m.userId));
        assert.strictEqual(repetidos.length, 1, 'la segunda repitio mas que el miembro inclusivo');
    });

    test('la rotacion NO retrocede aunque las busquedas se solapen en el tiempo', async () => {
        poblar({ miembros: 250 });

        const posiciones = [];
        for (let i = 0; i < 4; i++) {
            const res = await buscar(port, { amount: 4 });
            posiciones.push(res.body.stats.rotationEnd.offset);
        }

        for (let i = 1; i < posiciones.length; i++) {
            assert.ok(posiciones[i] > posiciones[i - 1],
                `la rotacion retrocedio: ${posiciones[i - 1]} -> ${posiciones[i]}`);
        }
    });

    test('grupos distintos NO se bloquean entre si', async () => {
        poblar({ miembros: 250 });
        const { abrirRotacion } = require('../services/pluginSearch/rotation');
        const { crearStats } = require('../services/pluginSearch/stats');
        const cola = require('../services/pluginSearch/groupQueue');

        // A ocupa el grupo 1. El grupo 2 tiene que poder arrancar al instante.
        const a = await abrirRotacion(GROUP_ID, crearStats());
        assert.strictEqual(cola.estaOcupado(GROUP_ID), true);

        const b = await abrirRotacion(OTRO_GRUPO, crearStats());
        assert.strictEqual(b.modo, 'leased', 'un grupo distinto no deberia esperar a nadie');
        assert.strictEqual(cola.estaOcupado(OTRO_GRUPO), true);

        await Promise.all([a.cerrar(), b.cerrar()]);
        assert.strictEqual(cola.estaOcupado(GROUP_ID), false);
        assert.strictEqual(cola.estaOcupado(OTRO_GRUPO), false);
    });

    test('si la busqueda de delante falla, el turno se libera igual', async () => {
        poblar({ miembros: 250 });
        const { abrirRotacion } = require('../services/pluginSearch/rotation');
        const { crearStats } = require('../services/pluginSearch/stats');
        const cola = require('../services/pluginSearch/groupQueue');

        const a = await abrirRotacion(GROUP_ID, crearStats());

        const promesaB = abrirRotacion(GROUP_ID, crearStats());
        await new Promise(resolve => setImmediate(resolve));

        // A revienta a mitad. El cierre va en un finally, asi que el turno se
        // suelta igual: si no, la cola quedaria parada para siempre.
        try {
            throw new Error('fallo simulado a mitad de la busqueda');
        } catch {
            await a.cerrar();
        }

        const b = await promesaB;
        assert.strictEqual(b.modo, 'leased', 'el turno no se libero tras el fallo de la anterior');
        await b.cerrar();
        assert.strictEqual(cola.estaOcupado(GROUP_ID), false);
    });

    test('la cola tiene tope: por encima se rechaza en el acto', async () => {
        poblar({ miembros: 250 });
        const cola = require('../services/pluginSearch/groupQueue');
        const tope = config.pluginQueue.maxWaiting;

        const soltar = await cola.tomarTurno(GROUP_ID);
        const esperando = [];
        for (let i = 0; i < tope; i++) {
            // Se capturan los rechazos: al final se sueltan todos y los que
            // sigan esperando reciben el rechazo del reset.
            esperando.push(cola.tomarTurno(GROUP_ID).catch(() => null));
        }

        await assert.rejects(
            () => cola.tomarTurno(GROUP_ID),
            err => err.code === 'queue_full',
            'por encima del tope la cola deberia rechazar en el acto'
        );

        cola.reset();
        soltar();
        await Promise.all(esperando);
    });

    test('la espera en cola tiene plazo y se rinde con un motivo claro', async () => {
        poblar({ miembros: 250 });
        const cola = require('../services/pluginSearch/groupQueue');
        const plazoOriginal = config.pluginQueue.waitTimeoutMs;
        config.pluginQueue.waitTimeoutMs = 40;

        try {
            const soltar = await cola.tomarTurno(GROUP_ID);
            await assert.rejects(
                () => cola.tomarTurno(GROUP_ID),
                err => err.code === 'queue_timeout',
                'la espera deberia rendirse con queue_timeout'
            );
            soltar();
        } finally {
            config.pluginQueue.waitTimeoutMs = plazoOriginal;
            cola.reset();
        }
    });

    test('la cola es FIFO: nadie adelanta a quien lleva mas tiempo esperando', async () => {
        poblar({ miembros: 250 });
        const cola = require('../services/pluginSearch/groupQueue');

        const soltar = await cola.tomarTurno(GROUP_ID);
        const orden = [];

        const esperas = [1, 2, 3].map(n =>
            cola.tomarTurno(GROUP_ID).then(soltarN => { orden.push(n); return soltarN; }));

        // Se van soltando en cadena; el orden de llegada tiene que respetarse.
        soltar();
        for (const espera of esperas) (await espera)();
        await Promise.all(esperas);

        assert.deepStrictEqual(orden, [1, 2, 3], `la cola no respeto el orden de llegada: ${orden}`);
        assert.strictEqual(cola.estaOcupado(GROUP_ID), false);
    });

    test('dos busquedas simultaneas por HTTP se serializan y las dos terminan', async () => {
        poblar({ miembros: 250 });

        const [a, b] = await Promise.all([
            buscar(port, { amount: 5 }),
            buscar(port, { amount: 5 }),
        ]);

        assert.strictEqual(a.status, 200);
        assert.strictEqual(b.status, 200);
        assert.strictEqual(a.body.found, 5);
        assert.strictEqual(b.body.found, 5);

        // Las dos con lease: una espero a la otra en vez de recorrer en paralelo.
        assert.strictEqual(a.body.stats.rotationMode, 'leased');
        assert.strictEqual(b.body.stats.rotationMode, 'leased');

        const fila = base.rotaciones.get(String(GROUP_ID));
        assert.strictEqual(fila.leaseOwner, null, 'quedo un lease sin soltar');
        assert.ok(fila.intraPageOffset > 0);
    });

    test('dos busquedas simultaneas no devuelven a la misma gente', async () => {
        poblar({ miembros: 250 });

        const [a, b] = await Promise.all([
            buscar(port, { amount: 5 }),
            buscar(port, { amount: 5 }),
        ]);

        const idsA = new Set(idsDe(a));
        const comunes = idsDe(b).filter(id => idsA.has(id));

        // Se serializan, asi que la segunda reanuda tras la primera y solo puede
        // repetir el miembro inclusivo de la frontera.
        assert.ok(comunes.length <= 1,
            `las dos busquedas devolvieron ${comunes.length} usuarios iguales`);
    });

    test('grupos distintos avanzan de forma independiente', async () => {
        poblar({ miembros: 250 });

        await buscar(port, { amount: 5 });                       // avanza GROUP_ID
        const otro = await pedir(port, 'POST', '/plugin/outfits/search', {
            amount: 5, groupId: OTRO_GRUPO, requireCompletePrice: false,
        });

        assert.strictEqual(otro.body.stats.rotationStart.cursor, 'first',
            'un grupo nuevo deberia empezar por el principio, no heredar el avance de otro');
        assert.strictEqual(base.rotaciones.size, 2);
        assert.ok(base.rotaciones.get(String(GROUP_ID)).intraPageOffset > 0);
    });

    test('sin base de datos la busqueda sigue funcionando, en modo efimero', async () => {
        poblar({ miembros: 250 });
        base.disponible = false;

        try {
            const res = await buscar(port, { amount: 5 });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.found, 5);
            assert.strictEqual(res.body.stats.rotationMode, 'ephemeral');
            assert.strictEqual(base.rotaciones.size, 0, 'escribio rotacion sin base disponible');
        } finally {
            base.disponible = true;
        }
    });

    // ── Trabajos asincronos ──────────────────────────────────────────────────

    test('el modo asincrono devuelve un searchId al instante', async () => {
        poblar({ miembros: 250 });
        const res = await buscar(port, { amount: 5, async: true });

        assert.strictEqual(res.status, 202);
        assert.strictEqual(res.body.success, true);
        assert.ok(/^s_[0-9a-f]{32}$/.test(res.body.searchId), `searchId con formato raro: ${res.body.searchId}`);
        assert.ok(['queued', 'running'].includes(res.body.status));
        assert.strictEqual(res.body.pollAfterMs, config.pluginJobs.pollIntervalMs);
        assert.deepStrictEqual(res.body.outfits, [], 'un trabajo recien creado no puede traer resultados');
    });

    test('el GET sigue el trabajo hasta que termina y entonces trae los outfits', async () => {
        poblar({ miembros: 250 });
        const arranque = await buscar(port, { amount: 5, async: true });
        const url = `/plugin/outfits/search/${arranque.body.searchId}`;

        let estado = null;
        for (let intento = 0; intento < 60; intento++) {
            estado = await pedir(port, 'GET', url);
            assert.strictEqual(estado.status, 200);
            if (['completed', 'partial', 'failed'].includes(estado.body.status)) break;
            await new Promise(resolve => setTimeout(resolve, 20));
        }

        assert.strictEqual(estado.body.status, 'completed');
        assert.strictEqual(estado.body.found, 5);
        assert.strictEqual(estado.body.outfits.length, 5);
        assert.strictEqual(estado.body.pollAfterMs, null, 'un trabajo terminado no deberia pedir mas polling');
        assert.ok(estado.body.stats, 'el trabajo terminado deberia traer sus stats');
    });

    test('un searchId desconocido responde 404, no un error raro', async () => {
        poblar({ miembros: 10 });
        const res = await pedir(port, 'GET', `/plugin/outfits/search/s_${'0'.repeat(32)}`);
        assert.strictEqual(res.status, 404);
        assert.strictEqual(res.body.error.code, 'search_not_found');
    });

    test('un searchId con formato invalido responde 400', async () => {
        const res = await pedir(port, 'GET', '/plugin/outfits/search/no-es-un-id');
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error.code, 'invalid_request');
    });

    test('el GET exige la credencial del plugin igual que el POST', async () => {
        poblar({ miembros: 250 });
        const arranque = await buscar(port, { amount: 3, async: true });

        ownRateLimit.reset();
        const res = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1', port,
                path: `/plugin/outfits/search/${arranque.body.searchId}`, method: 'GET',
            }, r => {
                let data = '';
                r.on('data', c => { data += c; });
                r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(data) }));
            });
            req.on('error', reject);
            req.end();
        });

        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.body.error.code, 'unauthorized');
    });

    test('el modo sincrono sigue devolviendo el contrato de siempre', async () => {
        poblar({ miembros: 250 });
        const res = await buscar(port, { amount: 4 });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.requested, 4);
        assert.strictEqual(res.body.found, 4);
        assert.strictEqual(res.body.outfits.length, 4);
        assert.ok(res.body.searchId, 'el sincrono tambien deberia identificar la busqueda');
        assert.ok(res.body.progress, 'el sincrono tambien deberia traer el progreso final');
    });

    test('async con un valor que no es booleano -> 400', async () => {
        const res = await pedir(port, 'POST', '/plugin/outfits/search', {
            amount: 5, groupId: GROUP_ID, async: 'si',
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(res.body.error.code, 'invalid_request');
    });

    // ── Coordinacion GLOBAL entre instancias ─────────────────────────────────
    //
    // La regla es absoluta: un groupId lo recorre UNA busqueda en todo el
    // sistema, no una por proceso. Estos casos simulan que otra replica tiene el
    // grupo cogido (una fila de lease con dueño ajeno, que es exactamente lo que
    // ve nuestra instancia) y comprueban que aqui se espera — nunca se recorre
    // por libre.
    //
    // LO MAS IMPORTANTE DE TODO EL ARCHIVO es el ultimo caso: con Postgres
    // disponible NO EXISTE ningun camino que lleve a modo efimero por
    // contencion. Ese fallback seria justo la corrupcion que todo esto evita.

    const { abrirRotacion } = require('../services/pluginSearch/rotation');
    const { crearStats } = require('../services/pluginSearch/stats');
    const notificador = require('../db/rotationNotifier');
    const colaLocal = require('../services/pluginSearch/groupQueue');

    // Espera a que una promesa NO se haya resuelto todavia, dandole al bucle de
    // eventos oportunidades reales de resolverla si fuera a hacerlo.
    async function siguePendiente(marca) {
        for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
        return marca.hecho === false;
    }

    test('si otra instancia tiene el grupo, esta espera: NO entra en efimero', async () => {
        poblar({ miembros: 250 });
        base.otraInstanciaToma(GROUP_ID);

        const marca = { hecho: false };
        let posicionAvisada = null;
        const promesa = abrirRotacion(GROUP_ID, crearStats(), {
            onEncolado: posicion => { posicionAvisada = posicion; },
        }).then(r => { marca.hecho = true; return r; });

        assert.ok(await siguePendiente(marca),
            'arranco a recorrer con el grupo cogido por otra instancia');
        assert.strictEqual(posicionAvisada, 1, 'no se aviso de la posicion en la cola global');

        // La otra replica termina y suelta.
        base.otraInstanciaSuelta(GROUP_ID);
        notificador.__despertar(GROUP_ID);

        const rotacion = await promesa;
        assert.strictEqual(rotacion.modo, 'leased',
            'tras esperar deberia recorrer con lease, jamas en efimero');
        await rotacion.cerrar();
    });

    test('al liberarse, continua desde el cursor que dejo la otra instancia', async () => {
        poblar({ miembros: 250 });
        base.otraInstanciaToma(GROUP_ID);

        const marca = { hecho: false };
        const promesa = abrirRotacion(GROUP_ID, crearStats())
            .then(r => { marca.hecho = true; return r; });
        assert.ok(await siguePendiente(marca));

        // La otra replica avanza el cursor y suelta.
        base.otraInstanciaSuelta(GROUP_ID, {
            cursor: null, intraPageOffset: 37, lastUserId: '100036', cycle: 2,
        });
        notificador.__despertar(GROUP_ID);

        const rotacion = await promesa;
        assert.strictEqual(rotacion.inicio.offset, 37,
            'no continuo desde el cursor persistido por la otra instancia');
        assert.strictEqual(rotacion.cycle, 2, 'no heredo el ciclo de la otra instancia');
        await rotacion.cerrar();
    });

    test('si la instancia dueña muere, el lease vence y otra continua', async () => {
        poblar({ miembros: 250 });
        // Lease cortisimo y NADIE lo suelta: es una replica que murio sin avisar.
        // No habra NOTIFY nunca; despertar depende solo de la caducidad.
        base.otraInstanciaToma(GROUP_ID, { duracionMs: 60 });

        const rotacion = await abrirRotacion(GROUP_ID, crearStats());
        assert.strictEqual(rotacion.modo, 'leased',
            'tras vencer el lease del muerto deberia poder recorrer con lease');
        await rotacion.cerrar();
    });

    test('el aviso despierta sin tener que esperar a la caducidad del lease', async () => {
        poblar({ miembros: 250 });
        // Lease larguisimo: si el despertar dependiera de la caducidad, esto
        // tardaria un minuto. Con el aviso, es inmediato.
        base.otraInstanciaToma(GROUP_ID, { duracionMs: 60_000 });

        const empezado = Date.now();
        const promesa = abrirRotacion(GROUP_ID, crearStats());

        await new Promise(resolve => setImmediate(resolve));
        base.otraInstanciaSuelta(GROUP_ID);
        notificador.__despertar(GROUP_ID);

        const rotacion = await promesa;
        const tardo = Date.now() - empezado;

        assert.strictEqual(rotacion.modo, 'leased');
        assert.ok(tardo < 1000, `tardo ${tardo} ms: parece que espero a la caducidad en vez del aviso`);
        await rotacion.cerrar();
    });

    test('la espera global tiene plazo y termina en error, NUNCA en efimero', async () => {
        poblar({ miembros: 250 });
        const plazoOriginal = config.pluginQueue.waitTimeoutMs;
        config.pluginQueue.waitTimeoutMs = 120;

        try {
            // La otra instancia no suelta jamas dentro del plazo.
            base.otraInstanciaToma(GROUP_ID, { duracionMs: 60_000 });

            await assert.rejects(
                () => abrirRotacion(GROUP_ID, crearStats()),
                err => err.code === 'queue_timeout',
                'con el grupo ocupado y el plazo agotado debe fallar, no recorrer por libre'
            );
        } finally {
            config.pluginQueue.waitTimeoutMs = plazoOriginal;
            colaLocal.reset();
        }
    });

    test('el timeout de cola llega al plugin como error, sin resultados inventados', async () => {
        poblar({ miembros: 250 });
        const plazoOriginal = config.pluginQueue.waitTimeoutMs;
        config.pluginQueue.waitTimeoutMs = 120;

        try {
            base.otraInstanciaToma(GROUP_ID, { duracionMs: 60_000 });
            const res = await buscar(port, { amount: 5 });

            assert.strictEqual(res.status, 503);
            assert.strictEqual(res.body.error.code, 'queue_timeout');
            assert.strictEqual(base.rotaciones.get(String(GROUP_ID)).leaseOwner, 'instancia-remota',
                'se toco el lease de la otra instancia');
        } finally {
            config.pluginQueue.waitTimeoutMs = plazoOriginal;
            colaLocal.reset();
        }
    });

    test('tres busquedas en espera conservan el orden de llegada', async () => {
        poblar({ miembros: 250 });
        base.otraInstanciaToma(GROUP_ID);

        const orden = [];
        const promesas = [1, 2, 3].map(n =>
            abrirRotacion(GROUP_ID, crearStats()).then(async rotacion => {
                orden.push(n);
                await rotacion.cerrar();
                return n;
            }));

        await new Promise(resolve => setImmediate(resolve));
        assert.deepStrictEqual(orden, [], 'alguna arranco con el grupo ocupado');

        base.otraInstanciaSuelta(GROUP_ID);
        notificador.__despertar(GROUP_ID);
        await Promise.all(promesas);

        assert.deepStrictEqual(orden, [1, 2, 3], `no se respeto el orden de llegada: ${orden}`);
    });

    test('queuePosition cuenta tambien las busquedas de otras instancias', async () => {
        poblar({ miembros: 250 });

        // Dos trabajos 'queued' del mismo grupo escritos por OTRAS replicas.
        for (const sufijo of ['aa', 'bb']) {
            const id = `s_${sufijo.repeat(16)}`;
            base.trabajosPersistidos.set(id, {
                searchId: id, groupId: String(GROUP_ID), status: 'queued', target: 5,
                found: 0, candidatesExamined: 0, stoppedBy: null, progress: null,
                outfits: [], stats: null, error: null,
                createdAt: Date.now() - 1000, startedAt: null, finishedAt: null,
                heartbeatAt: Date.now(), expiresAt: null,
            });
        }

        base.otraInstanciaToma(GROUP_ID);

        let posicionAvisada = null;
        const marca = { hecho: false };
        const promesa = abrirRotacion(GROUP_ID, crearStats(), {
            onEncolado: posicion => { posicionAvisada = posicion; },
        }).then(r => { marca.hecho = true; return r; });

        assert.ok(await siguePendiente(marca));
        assert.strictEqual(posicionAvisada, 3,
            'la posicion deberia contar los dos trabajos en cola de otras instancias');

        base.otraInstanciaSuelta(GROUP_ID);
        notificador.__despertar(GROUP_ID);
        await (await promesa).cerrar();
    });

    test('un grupo ocupado por otra instancia no frena a los demas grupos', async () => {
        poblar({ miembros: 250 });
        base.otraInstanciaToma(GROUP_ID, { duracionMs: 60_000 });

        // El grupo bloqueado tiene una busqueda esperando...
        const marca = { hecho: false };
        const bloqueada = abrirRotacion(GROUP_ID, crearStats())
            .then(r => { marca.hecho = true; return r; })
            .catch(() => null);

        // ...y OTRO grupo arranca al instante, sin esperar a nadie.
        const otra = await abrirRotacion(OTRO_GRUPO, crearStats());
        assert.strictEqual(otra.modo, 'leased');
        assert.ok(await siguePendiente(marca), 'la del grupo ocupado no deberia haber arrancado');
        await otra.cerrar();

        base.otraInstanciaSuelta(GROUP_ID);
        notificador.__despertar(GROUP_ID);
        const desbloqueada = await bloqueada;
        if (desbloqueada) await desbloqueada.cerrar();
    });

    test('CON Postgres disponible no existe NINGUN camino de contencion hacia efimero', async () => {
        poblar({ miembros: 250 });
        const plazoOriginal = config.pluginQueue.waitTimeoutMs;
        config.pluginQueue.waitTimeoutMs = 100;

        // Bateria de escenarios de contencion. En todos, el resultado admisible
        // es solo uno de dos: se consigue el lease, o se falla diciendolo.
        // Recorrer sin lease no esta entre las opciones.
        const escenarios = [
            ['lease ajeno que no se suelta', () => base.otraInstanciaToma(GROUP_ID, { duracionMs: 60_000 })],
            ['lease ajeno que vence solo', () => base.otraInstanciaToma(GROUP_ID, { duracionMs: 40 })],
            ['lease ajeno recien renovado', () => base.otraInstanciaToma(GROUP_ID, { duracionMs: 30_000 })],
        ];

        try {
            for (const [nombre, montar] of escenarios) {
                base.limpiar();
                colaLocal.reset();
                montar();

                let modo = null;
                let codigo = null;
                try {
                    const rotacion = await abrirRotacion(GROUP_ID, crearStats());
                    modo = rotacion.modo;
                    await rotacion.cerrar();
                } catch (err) {
                    codigo = err.code;
                }

                assert.notStrictEqual(modo, 'ephemeral',
                    `el escenario "${nombre}" acabo recorriendo en efimero`);
                assert.ok(modo === 'leased' || codigo === 'queue_timeout',
                    `el escenario "${nombre}" acabo en un estado inesperado: modo=${modo} codigo=${codigo}`);
            }
        } finally {
            config.pluginQueue.waitTimeoutMs = plazoOriginal;
            colaLocal.reset();
        }
    });

    test('efimero SOLO existe cuando no hay DATABASE_URL', async () => {
        poblar({ miembros: 250 });

        // Con base: nunca efimero, ni con el grupo libre.
        const conBase = await abrirRotacion(GROUP_ID, crearStats());
        assert.strictEqual(conBase.modo, 'leased');
        await conBase.cerrar();

        // Sin base: efimero, que es el modo de desarrollo local.
        base.disponible = false;
        try {
            const sinBase = await abrirRotacion(GROUP_ID, crearStats());
            assert.strictEqual(sinBase.modo, 'ephemeral');
            await sinBase.cerrar();
        } finally {
            base.disponible = true;
        }
    });

    // ── Durabilidad de los trabajos ──────────────────────────────────────────
    //
    // Un searchId que solo vive en memoria se pierde en cada redeploy y no
    // existe para las demas replicas. Lo que se prueba aqui es que el trabajo
    // sobrevive al proceso, que ningun huerfano se queda 'running' para siempre
    // y que lo vencido se borra.

    test('un trabajo terminado se recupera despues de un reinicio', async () => {
        poblar({ miembros: 250 });
        const arranque = await buscar(port, { amount: 4, async: true });
        const searchId = arranque.body.searchId;

        // Se espera a que termine con el proceso todavia vivo.
        for (let i = 0; i < 60; i++) {
            const estado = await pedir(port, 'GET', `/plugin/outfits/search/${searchId}`);
            if (['completed', 'partial'].includes(estado.body.status)) break;
            await new Promise(r => setTimeout(r, 20));
        }

        // REINICIO: la memoria se va, la tabla no.
        jobs.reset();
        assert.ok(base.trabajosPersistidos.has(searchId), 'el trabajo no se persistio');

        const despues = await pedir(port, 'GET', `/plugin/outfits/search/${searchId}`);
        assert.strictEqual(despues.status, 200, 'el trabajo no sobrevivio al reinicio');
        assert.strictEqual(despues.body.status, 'completed');
        assert.strictEqual(despues.body.found, 4);
        assert.strictEqual(despues.body.outfits.length, 4, 'los resultados no sobrevivieron');
        assert.ok(despues.body.stats, 'las stats no sobrevivieron');
    });

    test('un GET desde otra instancia lee el trabajo persistido', async () => {
        poblar({ miembros: 250 });
        const searchId = `s_${'ab'.repeat(16)}`;

        // Fila escrita por OTRO proceso: esta instancia no la tiene en memoria.
        base.trabajosPersistidos.set(searchId, {
            searchId, groupId: String(GROUP_ID), status: 'running', target: 10,
            found: 3, candidatesExamined: 12, stoppedBy: null,
            progress: { target: 10, found: 3, candidatesExamined: 12, elapsedMs: 1200,
                completionRatio: 0.3, estimatedRemainingMs: 4000, etaConfidence: 'ok' },
            outfits: [], stats: null, error: null,
            createdAt: Date.now(), startedAt: Date.now(), finishedAt: null,
            heartbeatAt: Date.now(), expiresAt: null,
        });

        const res = await pedir(port, 'GET', `/plugin/outfits/search/${searchId}`);
        assert.strictEqual(res.status, 200, 'no se pudo leer un trabajo de otra instancia');
        assert.strictEqual(res.body.status, 'running');
        assert.strictEqual(res.body.progress.found, 3);
        assert.strictEqual(res.body.progress.estimatedRemainingMs, 4000);
        assert.strictEqual(res.body.pollAfterMs, config.pluginJobs.pollIntervalMs);
    });

    test('un trabajo huerfano acaba marcado como expirado, nunca eterno', async () => {
        poblar({ miembros: 250 });
        const searchId = `s_${'cd'.repeat(16)}`;

        // Trabajo 'running' cuyo proceso murio: su latido es viejisimo.
        base.trabajosPersistidos.set(searchId, {
            searchId, groupId: String(GROUP_ID), status: 'running', target: 10,
            found: 2, candidatesExamined: 8, stoppedBy: null, progress: null,
            outfits: [], stats: null, error: null,
            createdAt: Date.now() - 600_000, startedAt: Date.now() - 600_000, finishedAt: null,
            heartbeatAt: Date.now() - config.pluginJobs.heartbeatTimeoutMs - 10_000,
            expiresAt: null,
        });

        const recuperacion = await jobs.recuperarAlArrancar();
        assert.strictEqual(recuperacion.expirados, 1, 'el huerfano no se marco como expirado');

        const res = await pedir(port, 'GET', `/plugin/outfits/search/${searchId}`);
        assert.strictEqual(res.body.status, 'expired');
        assert.strictEqual(res.body.stoppedBy, 'expired');
    });

    test('un trabajo vivo que solo va lento NO se marca expirado', async () => {
        poblar({ miembros: 250 });
        const searchId = `s_${'ef'.repeat(16)}`;

        base.trabajosPersistidos.set(searchId, {
            searchId, groupId: String(GROUP_ID), status: 'running', target: 100,
            found: 5, candidatesExamined: 40, stoppedBy: null, progress: null,
            outfits: [], stats: null, error: null,
            createdAt: Date.now() - 30_000, startedAt: Date.now() - 30_000, finishedAt: null,
            heartbeatAt: Date.now() - 1_000, // late hace un segundo
            expiresAt: null,
        });

        await jobs.recuperarAlArrancar();
        const fila = base.trabajosPersistidos.get(searchId);
        assert.strictEqual(fila.status, 'running', 'se mato un trabajo que seguia latiendo');
    });

    test('la recoleccion borra los trabajos vencidos y respeta los vigentes', async () => {
        poblar({ miembros: 250 });

        base.trabajosPersistidos.set('s_' + '11'.repeat(16), {
            searchId: 's_' + '11'.repeat(16), groupId: String(GROUP_ID), status: 'completed',
            target: 5, found: 5, candidatesExamined: 5, stoppedBy: 'completed', progress: null,
            outfits: [], stats: null, error: null, createdAt: 0, startedAt: 0,
            finishedAt: Date.now() - 1000, heartbeatAt: Date.now() - 1000,
            expiresAt: Date.now() - 1, // ya vencido
        });
        base.trabajosPersistidos.set('s_' + '22'.repeat(16), {
            searchId: 's_' + '22'.repeat(16), groupId: String(GROUP_ID), status: 'partial',
            target: 5, found: 2, candidatesExamined: 9, stoppedBy: 'timeBudget', progress: null,
            outfits: [], stats: null, error: null, createdAt: 0, startedAt: 0,
            finishedAt: Date.now(), heartbeatAt: Date.now(),
            expiresAt: Date.now() + 60_000, // todavia vigente
        });

        const recuperacion = await jobs.recuperarAlArrancar();
        assert.strictEqual(recuperacion.borrados, 1);
        assert.strictEqual(base.trabajosPersistidos.has('s_' + '11'.repeat(16)), false);
        assert.strictEqual(base.trabajosPersistidos.has('s_' + '22'.repeat(16)), true,
            'se borro un trabajo que aun estaba dentro de su plazo');
    });

    test('el estado en cola se distingue del progreso de busqueda', async () => {
        poblar({ miembros: 250 });
        const cola = require('../services/pluginSearch/groupQueue');

        // Se ocupa el grupo a mano para que la busqueda tenga que esperar turno.
        const soltar = await cola.tomarTurno(GROUP_ID);

        const arranque = await buscar(port, { amount: 5, async: true });
        assert.strictEqual(arranque.status, 202);

        await new Promise(r => setTimeout(r, 30));
        const enCola = await pedir(port, 'GET', `/plugin/outfits/search/${arranque.body.searchId}`);

        assert.strictEqual(enCola.body.status, 'queued');
        assert.strictEqual(enCola.body.queuePosition, 1, 'no se informo de la posicion en cola');
        assert.strictEqual(enCola.body.progress, null,
            'esperando turno no hay progreso que enseñar: seria una barra parada fingiendo trabajo');

        soltar();

        // Al liberarse, arranca y pasa a running/terminado con progreso real.
        let final = null;
        for (let i = 0; i < 60; i++) {
            final = await pedir(port, 'GET', `/plugin/outfits/search/${arranque.body.searchId}`);
            if (['completed', 'partial', 'failed'].includes(final.body.status)) break;
            await new Promise(r => setTimeout(r, 20));
        }
        assert.strictEqual(final.body.status, 'completed');
        assert.strictEqual(final.body.queuePosition, null);
        assert.ok(final.body.progress, 'al terminar deberia haber progreso');
    });

    test('el searchId es impredecible y no enumerable', async () => {
        poblar({ miembros: 250 });

        const ids = new Set();
        for (let i = 0; i < 12; i++) {
            const res = await buscar(port, { amount: 1, async: true });
            ids.add(res.body.searchId);
        }

        assert.strictEqual(ids.size, 12, 'se repitio algun searchId');

        for (const id of ids) {
            // 128 bits de aleatoriedad criptografica: 32 hexadecimales.
            assert.ok(/^s_[0-9a-f]{32}$/.test(id), `formato inesperado: ${id}`);
        }

        // Ni consecutivos ni con prefijo comun: dos ids no comparten ni los
        // primeros caracteres, que es lo que delataria un contador o un tiempo.
        const lista = [...ids].map(id => id.slice(2));
        for (let i = 1; i < lista.length; i++) {
            assert.notStrictEqual(lista[i].slice(0, 8), lista[i - 1].slice(0, 8),
                'dos searchId comparten prefijo: parecen derivados de un contador');
        }
    });

    test('sin base de datos los trabajos siguen funcionando en memoria', async () => {
        poblar({ miembros: 250 });
        base.disponible = false;

        try {
            const arranque = await buscar(port, { amount: 3, async: true });
            assert.strictEqual(arranque.status, 202);

            let estado = null;
            for (let i = 0; i < 60; i++) {
                estado = await pedir(port, 'GET', `/plugin/outfits/search/${arranque.body.searchId}`);
                if (['completed', 'partial'].includes(estado.body.status)) break;
                await new Promise(r => setTimeout(r, 20));
            }

            assert.strictEqual(estado.body.status, 'completed');
            assert.strictEqual(estado.body.outfits.length, 3);
            assert.strictEqual(base.trabajosPersistidos.size, 0, 'escribio trabajos sin base disponible');
        } finally {
            base.disponible = true;
        }
    });

    // ── Progreso y ETA ───────────────────────────────────────────────────────

    test('el progreso final describe la busqueda con numeros reales', async () => {
        poblar({ miembros: 250, avatarRoto: userId => userId % 2 === 0 });
        const res = await buscar(port, { amount: 6 });
        const p = res.body.progress;

        assert.strictEqual(p.target, 6);
        assert.strictEqual(p.found, 6);
        assert.strictEqual(p.completionRatio, 1);
        assert.ok(p.candidatesExamined >= 12, 'con la mitad de avatares rotos deberia haber mirado el doble');
        assert.ok(p.elapsedMs >= 0);
        assert.strictEqual(p.estimatedRemainingMs, 0, 'una busqueda completa no tiene tiempo restante');
        assert.strictEqual(p.etaConfidence, 'done');
    });

    test('sin muestra suficiente NO se inventa una ETA', async () => {
        const estimador = crearEstimador({ target: 10, previas: null });
        const p = estimador.progreso({ examinados: 2, encontrados: 1 });

        assert.strictEqual(p.estimatedRemainingMs, null);
        assert.strictEqual(p.etaConfidence, 'calculating');
    });

    test('con muestra suficiente la ETA sale de la tasa de aceptacion real', async () => {
        // Reloj controlado: 100 ms por candidato, aceptacion del 25%.
        let ahora = 0;
        const estimador = crearEstimador({ target: 10, previas: null, ahora: () => ahora });

        for (let i = 1; i <= 20; i++) {
            ahora += 100;
            estimador.observar({ examinados: i, encontrados: Math.floor(i / 4) });
        }

        const p = estimador.progreso({ examinados: 20, encontrados: 5 });

        assert.strictEqual(p.etaConfidence, 'ok');
        assert.ok(p.acceptanceRate > 0.15 && p.acceptanceRate < 0.35,
            `tasa de aceptacion fuera de lo esperado: ${p.acceptanceRate}`);
        // Faltan 5 a una tasa de ~0.25 => ~20 candidatos => ~2000 ms.
        assert.ok(p.estimatedRemainingMs > 1000 && p.estimatedRemainingMs < 4000,
            `ETA fuera de lo razonable: ${p.estimatedRemainingMs}`);
    });

    test('el historial del grupo permite estimar desde el primer segundo', async () => {
        const previas = {
            acceptanceRate: 0.25, candidateLatencyMs: 100,
            candidatesPerResult: 4, searchDurationMs: 4000, searchesCompleted: 12,
        };
        const estimador = crearEstimador({ target: 10, previas });
        const p = estimador.progreso({ examinados: 1, encontrados: 0 });

        assert.ok(Number.isFinite(p.estimatedRemainingMs), 'con historial deberia haber estimacion');
        assert.strictEqual(p.etaConfidence, 'low', 'apoyada en el historial, la confianza deberia ser baja');
    });

    test('la ETA nunca es negativa, NaN ni infinita', async () => {
        const casos = [
            { target: 10, previas: null, examinados: 0, encontrados: 0 },
            { target: 10, previas: null, examinados: 50, encontrados: 0 },
            { target: 10, previas: null, examinados: 50, encontrados: 50 },
            { target: 1, previas: { acceptanceRate: 0, candidateLatencyMs: 0, searchesCompleted: 3 }, examinados: 9, encontrados: 0 },
            { target: 1, previas: { acceptanceRate: 0.0001, candidateLatencyMs: 99999, searchesCompleted: 3 }, examinados: 9, encontrados: 0 },
        ];

        for (const caso of casos) {
            const estimador = crearEstimador({ target: caso.target, previas: caso.previas });
            estimador.observar({ examinados: caso.examinados, encontrados: caso.encontrados });
            const p = estimador.progreso({ examinados: caso.examinados, encontrados: caso.encontrados });

            const eta = p.estimatedRemainingMs;
            assert.ok(eta === null || (Number.isFinite(eta) && eta >= 0),
                `ETA invalida (${eta}) en ${JSON.stringify(caso)}`);
            assert.ok(eta === null || eta <= config.pluginEta.maxEstimateMs,
                `ETA por encima del techo: ${eta}`);
            assert.ok(p.completionRatio >= 0 && p.completionRatio <= 1);
        }
    });

    test('el progreso de resultados no se confunde con los candidatos examinados', async () => {
        const estimador = crearEstimador({ target: 10 });
        const p = estimador.progreso({ examinados: 80, encontrados: 3 });

        // 80 candidatos examinados NO son un 800% de progreso: la barra se pinta
        // con los resultados, que es lo unico que se pidio.
        assert.strictEqual(p.completionRatio, 0.3);
        assert.strictEqual(p.candidatesExamined, 80);
        assert.strictEqual(p.found, 3);
    });

    // ── EWMA por comunidad ───────────────────────────────────────────────────

    test('la EWMA arranca con la primera muestra y luego la suaviza', async () => {
        assert.strictEqual(ewma(null, 10), 10, 'la primera muestra deberia entrar tal cual');
        assert.strictEqual(ewma(10, 20, 0.5), 15);
        assert.strictEqual(ewma(10, undefined), 10, 'una muestra no finita no deberia mover la media');
        assert.strictEqual(ewma(10, NaN), 10);
    });

    test('el grupo aprende de cada busqueda y la media se adapta', async () => {
        poblar({ miembros: 250 });

        await buscar(port, { amount: 5 });
        const tras1 = base.estadisticas.get(String(GROUP_ID));
        assert.ok(tras1, 'no se registro el aprendizaje de la busqueda');
        assert.strictEqual(tras1.searchesCompleted, 1);
        assert.ok(tras1.acceptanceRate > 0);

        await buscar(port, { amount: 5 });
        const tras2 = base.estadisticas.get(String(GROUP_ID));
        assert.strictEqual(tras2.searchesCompleted, 2);
        assert.ok(Number.isFinite(tras2.candidateLatencyMs) && tras2.candidateLatencyMs >= 0);
    });

    test('el aprendizaje dimensiona el presupuesto de la siguiente busqueda', async () => {
        const { presupuestoDeCandidatos } = require('../services/pluginSearchService');

        const sinHistorial = presupuestoDeCandidatos(10, null);
        const grupoCaro = presupuestoDeCandidatos(10, { candidatesPerResult: 20 });
        const grupoGeneroso = presupuestoDeCandidatos(10, { candidatesPerResult: 1 });

        assert.ok(grupoCaro > sinHistorial,
            'un grupo donde cada resultado cuesta mas deberia permitir mirar a mas gente');
        assert.ok(grupoGeneroso <= sinHistorial);
        // Y nunca por encima del techo duro.
        assert.ok(grupoCaro <= config.pluginSearch.maxCandidates);
    });

    test('una busqueda que no examina a nadie no ensucia las medias del grupo', async () => {
        const original = config.pluginSearch.timeBudgetMs;
        config.pluginSearch.timeBudgetMs = 0;
        poblar({ miembros: 250 });

        try {
            await buscar(port, { amount: 5 });
            assert.strictEqual(base.estadisticas.get(String(GROUP_ID)), undefined,
                'una busqueda sin candidatos examinados no deberia registrar aprendizaje');
        } finally {
            config.pluginSearch.timeBudgetMs = original;
        }
    });

    // ── Observabilidad ───────────────────────────────────────────────────────

    test('stats describe el tramo recorrido sin publicar cursores enteros', async () => {
        poblar({ miembros: 250 });
        const res = await buscar(port, { amount: 5 });
        const s = res.body.stats;

        for (const campo of ['rotationMode', 'rotationCycle', 'rotationStart', 'rotationEnd',
            'rotationWraps', 'rotationCursorResets', 'acceptanceRate', 'emptySegments']) {
            assert.ok(campo in s, `a stats le falta ${campo}`);
        }

        // El cursor real mide mas de 20 caracteres; en stats va resumido.
        assert.ok(s.rotationEnd.cursor.length <= 12);
        assert.ok(!JSON.stringify(s).includes(CLAVE_PLUGIN), 'se filtro la credencial en stats');
    });

    const ok = await suite.run();

    roblox.listGroupMembers = original.listGroupMembers;
    roblox.getCurrentAvatar = original.getCurrentAvatar;
    roblox.getCatalogItemDetails = original.getCatalogItemDetails;
    Object.assign(repo, original.repo);
    Object.assign(jobRepo, original.jobRepo);
    cache.reset();
    ownRateLimit.reset();
    robloxRateLimiter.reset();
    jobs.reset();
    await new Promise(resolve => server.close(resolve));
    return ok;
};
