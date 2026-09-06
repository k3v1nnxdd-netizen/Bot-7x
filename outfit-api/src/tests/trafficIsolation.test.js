'use strict';

const { createSuite, axiosError } = require('./harness');
const rateLimiter = require('../roblox/rateLimiter');
const roblox = require('../roblox/client');
const config = require('../config');

// AISLAMIENTO ENTRE EL TRAFICO DEL JUEGO Y EL TRABAJO DE FONDO.
//
// Este archivo existe por un fallo de produccion concreto: los precios dejaron
// de cargarse en el juego. No porque el juego fallara, sino porque el plugin de
// Studio y el worker del indice pedian precios POR EL MISMO CUBO del limitador,
// y un 429 provocado indexando una comunidad entera ponia en cooldown la ruta
// con la que el juego resuelve el catalogo. El sintoma era mudo:
// `attachCatalogStatus` se traga el error y devuelve el outfit sin precios.
//
// Lo que se prueba aqui es la separacion, y se prueba sobre el LIMITADOR REAL
// —no sobre dobles— porque lo que hay que demostrar es que dos cubos distintos
// tienen estados distintos: cooldown, breaker y slots.

// Un 429 con Retry-After alto: por encima del techo de espera en linea, asi que
// el limitador no lo absorbe y deja la ruta en cooldown de verdad.
const CUOTA_AGOTADA = { 'retry-after': '30' };

async function provocar429(routeKey) {
    await rateLimiter.run(routeKey, async () => {
        throw axiosError(429, CUOTA_AGOTADA);
    }, { endpoint: 'catalog.roblox.com/v1/catalog/items/details' }).catch(() => null);
}

module.exports = async function run() {
    const suite = createSuite('trafficIsolation');
    const { test, assert } = suite;

    const original = { postCatalog: null };

    // ── Cubos separados: cooldown y breaker ──────────────────────────────────

    test('un 429 del PLUGIN no pone en cooldown la ruta del juego', async () => {
        rateLimiter.reset();

        await provocar429('catalogDetailsBackground');

        const fondo = rateLimiter.getThrottleState('catalogDetailsBackground');
        const juego = rateLimiter.getThrottleState('catalogDetails');

        assert.strictEqual(fondo.throttled, true, 'el cubo de fondo deberia haber quedado frenado');
        assert.strictEqual(juego.throttled, false,
            'el 429 del trabajo de fondo freno tambien al juego: los cubos NO estan separados');
        assert.strictEqual(juego.cooldownRemainingMs, 0);

        rateLimiter.reset();
    });

    test('un 429 del INDEX WORKER no afecta a la ruta de catalogo del juego', async () => {
        rateLimiter.reset();

        // El worker sale por el mismo cubo de fondo que el plugin, a proposito:
        // los dos son trabajo diferible y comparten presupuesto entre ellos.
        for (let i = 0; i < 3; i++) await provocar429('catalogDetailsBackground');

        assert.strictEqual(rateLimiter.getThrottleState('catalogDetails').throttled, false,
            'el juego quedo frenado por los 429 del worker');

        rateLimiter.reset();
    });

    test('el juego SIGUE resolviendo catalogo mientras el fondo esta limitado', async () => {
        rateLimiter.reset();
        await provocar429('catalogDetailsBackground');

        // Con el fondo en cooldown, una llamada del juego tiene que salir.
        let salio = false;
        const respuesta = await rateLimiter.run('catalogDetails', async () => {
            salio = true;
            return { status: 200, headers: {}, data: { data: [] } };
        }, { endpoint: 'catalog.roblox.com/v1/catalog/items/details' });

        assert.strictEqual(salio, true, 'la llamada del juego no llego a salir');
        assert.strictEqual(respuesta.status, 200);

        // Y la del fondo sigue rechazandose.
        await assert.rejects(
            () => rateLimiter.run('catalogDetailsBackground', async () => ({ status: 200, headers: {} }), {
                endpoint: 'catalog.roblox.com/v1/catalog/items/details',
            }),
            () => true,
            'el cubo de fondo deberia seguir frenado'
        );

        rateLimiter.reset();
    });

    test('el breaker del fondo no abre el del juego', async () => {
        rateLimiter.reset();

        // Fallos duros repetidos hasta abrir el circuito del fondo.
        for (let i = 0; i < config.upstream.circuitFailureThreshold + 1; i++) {
            await rateLimiter.run('catalogDetailsBackground', async () => {
                throw axiosError(500);
            }, { endpoint: 'catalog.roblox.com/v1/catalog/items/details' }).catch(() => null);
        }

        const fondo = rateLimiter.getThrottleState('catalogDetailsBackground');
        const juego = rateLimiter.getThrottleState('catalogDetails');

        assert.strictEqual(fondo.circuitOpen, true, 'el circuito del fondo deberia estar abierto');
        assert.strictEqual(juego.circuitOpen, false,
            'se abrio el circuito del juego por fallos del trabajo de fondo');

        rateLimiter.reset();
    });

    // ── Licencia: jamas comparte bloqueo con el catalogo ─────────────────────

    test('licencia y propiedad de juego no comparten bloqueo con NINGUN catalogo', async () => {
        rateLimiter.reset();

        await provocar429('catalogDetails');            // el del juego
        await provocar429('catalogDetailsBackground');  // el del fondo

        for (const ruta of ['placeUniverse', 'universeInfo']) {
            const estado = rateLimiter.getThrottleState(ruta);
            assert.strictEqual(estado.throttled, false,
                `${ruta} quedo frenada por un cooldown de catalogo`);
            assert.strictEqual(estado.circuitOpen, false);
        }

        rateLimiter.reset();
    });

    test('la verificacion de licencia sale aunque los dos catalogos esten frenados', async () => {
        rateLimiter.reset();
        await provocar429('catalogDetails');
        await provocar429('catalogDetailsBackground');

        let salio = false;
        await rateLimiter.run('placeUniverse', async () => {
            salio = true;
            return { status: 200, headers: {}, data: { universeId: 1 } };
        }, { endpoint: 'apis.roblox.com/universes/v1/places/{id}/universe' });

        assert.strictEqual(salio, true, 'la verificacion de licencia no pudo salir');
        rateLimiter.reset();
    });

    // ── Gate global: el fondo no puede quedarse con toda la concurrencia ─────
    //
    // Se usa `groupMembers` para saturar porque es una ruta de FONDO sin tope
    // propio ni suelo de ritmo: lo unico que la frena es el gate global, que es
    // justo lo que se quiere medir. Con una ruta que tenga tope por ruta, el
    // corte llegaria antes y el test no probaria el gate.
    //
    // Todas las llamadas de saturacion esperan a la MISMA compuerta, asi que
    // abrirla una vez las termina todas, arranquen cuando arranquen. Repartir
    // resolvedores uno a uno dejaba colgadas las que entraban despues.
    function saturarConFondo(cuantas) {
        let abrir;
        const compuerta = new Promise(resolve => { abrir = resolve; });
        const enVuelo = [];

        for (let i = 0; i < cuantas; i++) {
            enVuelo.push(rateLimiter.run(
                'groupMembers',
                () => compuerta.then(() => ({ status: 200, headers: {} })),
                { endpoint: 'groups.roblox.com/v1/groups/{id}/users' }
            ).catch(() => null));
        }

        return {
            enVuelo,
            async soltar() {
                abrir();
                await Promise.allSettled(enVuelo);
            },
        };
    }

    // Deja al bucle de eventos repartir todo lo que vaya a repartir.
    async function asentar() {
        for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve));
    }

    test('el trabajo de fondo NO puede ocupar todos los slots del gate', async () => {
        rateLimiter.reset();

        const { maxConcurrent, foregroundReserved } = config.upstream;
        const techoDeFondo = Math.max(1, maxConcurrent - foregroundReserved);

        const saturacion = saturarConFondo(maxConcurrent * 4);
        await asentar();

        const concurrencia = rateLimiter.getMetrics().concurrency;

        assert.ok(concurrencia.active <= techoDeFondo,
            `el fondo ocupo ${concurrencia.active} slots y su techo es ${techoDeFondo}`);
        assert.ok(concurrencia.active < maxConcurrent,
            'el fondo se quedo con TODOS los slots: no queda hueco para el juego');
        assert.ok(concurrencia.queuedBackground > 0,
            'el resto del fondo deberia estar esperando en SU cola');
        assert.strictEqual(concurrencia.maxBackground, techoDeFondo);
        assert.strictEqual(concurrencia.foregroundReserved, foregroundReserved);

        await saturacion.soltar();
        rateLimiter.reset();
    });

    test('el juego entra al gate aunque el fondo lo tenga saturado', async () => {
        rateLimiter.reset();

        const saturacion = saturarConFondo(config.upstream.maxConcurrent * 4);
        await asentar();

        // Con el fondo saturado, una llamada del JUEGO tiene que salir SIN
        // esperar a que ninguna de las de fondo termine. Es el escenario exacto
        // del incidente: el indexador trabajando y el juego pidiendo precios.
        let salioElJuego = false;
        await rateLimiter.run('outfitDetails', async () => {
            salioElJuego = true;
            return { status: 200, headers: {}, data: {} };
        }, { endpoint: 'avatar.roblox.com/v3/outfits/{id}/details' });

        assert.strictEqual(salioElJuego, true,
            'el juego se quedo esperando detras del trabajo de fondo');

        await saturacion.soltar();
        rateLimiter.reset();
    });

    test('la licencia tambien entra con el gate saturado de fondo', async () => {
        rateLimiter.reset();

        const saturacion = saturarConFondo(config.upstream.maxConcurrent * 4);
        await asentar();

        let verifico = false;
        await rateLimiter.run('universeInfo', async () => {
            verifico = true;
            return { status: 200, headers: {}, data: {} };
        }, { endpoint: 'develop.roblox.com/v1/universes/{id}' });

        assert.strictEqual(verifico, true,
            'la verificacion de licencia quedo bloqueada por el trabajo de fondo');

        await saturacion.soltar();
        rateLimiter.reset();
    });

    test('el juego tiene prioridad sobre el fondo al repartir un slot libre', async () => {
        rateLimiter.reset();

        const saturacion = saturarConFondo(config.upstream.maxConcurrent * 4);
        await asentar();

        // Se encolan a la vez fondo y juego. Al liberarse un slot, el juego
        // tiene que salir primero aunque el fondo llevara esperando mas tiempo:
        // la cola de produccion se sirve entera antes de mirar la de fondo.
        const orden = [];
        const delFondo = rateLimiter.run('groupMembers', async () => {
            orden.push('fondo');
            return { status: 200, headers: {} };
        }, { endpoint: 'groups.roblox.com/v1/groups/{id}/users' }).catch(() => null);

        const delJuego = rateLimiter.run('outfitList', async () => {
            orden.push('juego');
            return { status: 200, headers: {}, data: {} };
        }, { endpoint: 'avatar.roblox.com/v2/avatar/users/{id}/outfits' }).catch(() => null);

        await delJuego;
        assert.strictEqual(orden[0], 'juego',
            `salio primero "${orden[0]}": el juego no tiene prioridad al repartir`);

        await saturacion.soltar();
        await delFondo;
        rateLimiter.reset();
    });

    // ── Cableado: cada llamador usa el cubo que le toca ──────────────────────

    test('el catalogo del JUEGO sale por el cubo del juego', async () => {
        rateLimiter.reset();
        original.postCatalog = roblox.__postCatalogDetails ?? null;

        // Se mide por los contadores del limitador: son la fuente de verdad de
        // por que cubo salio cada llamada.
        const antes = rateLimiter.getMetrics().byRoute;
        await roblox.getCatalogItemDetails([{ itemType: 'Asset', id: 1 }])
            .catch(() => null); // la llamada real fallara; solo interesa el cubo

        const despues = rateLimiter.getMetrics().byRoute;
        assert.ok(despues.catalogDetails.calls > antes.catalogDetails.calls,
            'la llamada del juego no salio por el cubo del juego');
        assert.strictEqual(despues.catalogDetailsBackground.calls, antes.catalogDetailsBackground.calls,
            'la llamada del juego salio por el cubo de fondo');

        rateLimiter.reset();
    });

    test('el catalogo del FONDO sale por el cubo de fondo', async () => {
        rateLimiter.reset();

        const antes = rateLimiter.getMetrics().byRoute;
        await roblox.getCatalogItemDetails([{ itemType: 'Asset', id: 1 }], {
            trafico: roblox.TRAFICO.FONDO,
        }).catch(() => null);

        const despues = rateLimiter.getMetrics().byRoute;
        assert.ok(despues.catalogDetailsBackground.calls > antes.catalogDetailsBackground.calls,
            'la llamada de fondo no salio por su cubo');
        assert.strictEqual(despues.catalogDetails.calls, antes.catalogDetails.calls,
            'la llamada de fondo contamino el cubo del juego');

        rateLimiter.reset();
    });

    test('el default sin etiquetar es el cubo del JUEGO (se protege de mas)', async () => {
        assert.strictEqual(roblox.TRAFICO.JUEGO, 'catalogDetails');
        assert.strictEqual(roblox.TRAFICO.FONDO, 'catalogDetailsBackground');
        assert.notStrictEqual(roblox.TRAFICO.JUEGO, roblox.TRAFICO.FONDO);
    });

    // ── Grupos fijados en el indexado ────────────────────────────────────────
    //
    // La prioridad calculada (`priority`) sube con la demanda y BAJA al
    // servirse, asi que un valor puesto a mano se erosiona solo. Un grupo
    // fijado es una decision de negocio — "esta comunidad es la nuestra" — y no
    // puede depender de eso. Lo que se comprueba aqui es que la condicion vive
    // en el SQL de seleccion, que es lo unico que garantiza que no decaiga.

    test('la lista de grupos fijados se lee y se sanea desde el entorno', async () => {
        const original = process.env.INDEX_WORKER_PINNED_GROUPS;
        const leer = () => {
            delete require.cache[require.resolve('../config')];
            return require('../config').indexWorker.pinnedGroups;
        };

        try {
            process.env.INDEX_WORKER_PINNED_GROUPS = '59218460';
            assert.deepStrictEqual(leer(), ['59218460']);

            // Varios, con espacios y basura por medio: solo sobreviven los ids
            // que de verdad lo son.
            process.env.INDEX_WORKER_PINNED_GROUPS = ' 59218460 , 123 ,, abc, 0, 007 ';
            assert.deepStrictEqual(leer(), ['59218460', '123']);

            // Sin variable, ninguno: la funcion por defecto no cambia.
            delete process.env.INDEX_WORKER_PINNED_GROUPS;
            assert.deepStrictEqual(leer(), []);
        } finally {
            if (original === undefined) delete process.env.INDEX_WORKER_PINNED_GROUPS;
            else process.env.INDEX_WORKER_PINNED_GROUPS = original;
            delete require.cache[require.resolve('../config')];
            require('../config');
        }
    });

    test('el SQL de seleccion ordena los fijados por delante de la prioridad', async () => {
        // Se lee el propio SQL: es donde vive la garantia, y un cambio que la
        // rompa (volver a ordenar solo por priority) tiene que fallar aqui.
        const fuente = require('fs').readFileSync(
            require('path').join(__dirname, '..', 'db', 'indexCrawlRepo.js'), 'utf8'
        );

        const seleccion = fuente.slice(fuente.indexOf('WITH elegido AS'), fuente.indexOf('RETURNING c.*'));

        assert.ok(/ORDER BY \(c\.group_id = ANY\(\$5::text\[\]\)\) DESC/.test(seleccion),
            'los grupos fijados ya no ordenan primero en el SQL de seleccion');
        assert.ok(seleccion.indexOf('ANY($5::text[])) DESC') < seleccion.indexOf('priority DESC'),
            'la prioridad calculada quedo por delante de los fijados');
        assert.ok(/c\.group_id = ANY\(\$5::text\[\]\)\s*\n\s*OR priority > 0/.test(seleccion),
            'un grupo fijado deberia ser elegible aunque no tenga demanda acumulada');
    });

    const ok = await suite.run();
    rateLimiter.reset();
    return ok;
};
