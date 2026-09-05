'use strict';

const { createSuite } = require('./harness');
const config = require('../config');
const presupuestos = require('../services/pluginSearch/budget');
const { MIEMBROS_POR_PAGINA } = require('../services/pluginSearch/memberPool');

// Presupuestos de la busqueda, probados COMO LO QUE SON: aritmetica pura. Sin
// HTTP, sin dobles de Roblox y sin base de datos, para que un fallo aqui señale
// la formula y no el andamiaje.
//
// LO QUE ESTE ARCHIVO PROTEGE, y es una sola propiedad con varias caras:
//
//   EL PRESUPUESTO PREVISTO NO TERMINA BUSQUEDAS. Se adapta a lo cara que este
//   saliendo la comunidad y crece con ella; el unico numero que corta es el
//   techo duro, y ese esta dimensionado para no aparecer en una busqueda sana.
//
// Es exactamente lo que fallaba antes: `min(600, max(60, amount * 4))` daba 60
// para amount=10, y ese 60 era a la vez el suelo del muestreo y el techo de la
// busqueda. Una comunidad con un 3% de aceptacion producia 2 outfits y paraba.

module.exports = async function run() {
    const suite = createSuite('pluginBudget');
    const { test, assert } = suite;

    const { costePorResultado, presupuestoDeseado, techoDeCandidatos,
        techoDePaginas, presupuestoDeTiempo, duracionDelLease } = presupuestos;

    // ── Coste por resultado ──────────────────────────────────────────────────

    test('sin evidencia ninguna, el coste es la constante de configuracion', () => {
        assert.strictEqual(
            costePorResultado({ examinados: 0, encontrados: 0, previas: null }),
            config.pluginSearch.candidatesPerResult
        );
    });

    test('con historial del grupo y sin muestra propia, manda el historial', () => {
        // Es lo que hace util la primera vuelta del bucle en un grupo conocido:
        // no hay tasa propia todavia, pero si se sabe lo que costo la ultima vez.
        const coste = costePorResultado({
            examinados: 0, encontrados: 0, previas: { candidatesPerResult: 25 },
        });
        assert.strictEqual(coste, 25);
    });

    test('la tasa VIVA desplaza al historial conforme crece la muestra', () => {
        const previas = { candidatesPerResult: 4 };

        // Muestra pequeña: la tasa propia es ruido y pesa poco.
        const pronto = costePorResultado({ examinados: 10, encontrados: 1, previas });
        // Muestra grande: la tasa propia manda y el historial ya no cuenta.
        const tarde = costePorResultado({ examinados: 200, encontrados: 10, previas });

        assert.ok(pronto > 4 && pronto < 10,
            `con 10 candidatos el coste deberia estar entre el historial y lo vivo, y fue ${pronto}`);
        assert.strictEqual(tarde, 20, 'con muestra de sobra el coste deberia ser exactamente el vivo');
    });

    test('sin ningun acierto todavia, el coste crece con lo ya examinado', () => {
        // El caso que rompia la formula anterior: la tasa viva es 0 y su inversa
        // infinita. Lo honesto no es ignorarlo ni rendirse, sino decir "cuesta al
        // menos lo que llevamos gastado" — y seguir.
        const a = costePorResultado({ examinados: 40, encontrados: 0, previas: null });
        const b = costePorResultado({ examinados: 200, encontrados: 0, previas: null });

        assert.strictEqual(a, 40);
        assert.ok(b > a, 'el coste estimado no crecio al seguir sin encontrar nada');
        assert.ok(Number.isFinite(b), 'el coste se fue a infinito con cero aciertos');
    });

    test('el coste estimado nunca pasa de su techo', () => {
        const coste = costePorResultado({ examinados: 100_000, encontrados: 0, previas: null });
        assert.strictEqual(coste, config.pluginSearch.maxCandidatesPerResult);
    });

    // ── Presupuesto deseado ──────────────────────────────────────────────────

    test('el presupuesto inicial de 10 outfits es el suelo, no una previsión de 40', () => {
        const inicial = presupuestoDeseado({ amount: 10 });
        assert.strictEqual(inicial, config.pluginSearch.minCandidates);
    });

    test('UNA TASA DE ACEPTACION BAJA AMPLIA EL PRESUPUESTO', () => {
        // El caso real: 10 pedidos, 60 candidatos examinados, 2 validos.
        // Con la formula antigua el presupuesto seguia siendo 60 y la busqueda
        // moria justo ahi. Ahora tiene que proyectar varios cientos.
        const conMalaTasa = presupuestoDeseado({
            amount: 10, encontrados: 2, examinados: 60, previas: null,
        });

        assert.ok(conMalaTasa > 250,
            `con 2 de 60 el presupuesto deberia proyectar cientos de candidatos y fue ${conMalaTasa}`);
        assert.ok(conMalaTasa <= techoDeCandidatos(10), 'el presupuesto se salto el techo duro');
    });

    test('cuanto peor va la busqueda, mas presupuesto se proyecta', () => {
        const buena = presupuestoDeseado({ amount: 10, encontrados: 8, examinados: 60 });
        const mala = presupuestoDeseado({ amount: 10, encontrados: 2, examinados: 60 });
        const pesima = presupuestoDeseado({ amount: 10, encontrados: 1, examinados: 60 });

        assert.ok(mala > buena, 'una tasa peor no amplio el presupuesto');
        assert.ok(pesima > mala, 'una tasa aun peor no amplio mas el presupuesto');
    });

    test('el presupuesto incluye lo ya examinado: solo puede crecer', () => {
        // Es "donde esperamos acabar", no "cuanto queda". Si no incluyera lo
        // gastado, la comparacion contra `examinados` se volveria absurda en
        // cuanto la busqueda avanzara.
        const deseado = presupuestoDeseado({ amount: 10, encontrados: 3, examinados: 400 });
        assert.ok(deseado >= 400, `el presupuesto (${deseado}) quedo por debajo de lo ya examinado`);
    });

    test('el presupuesto JAMAS supera el techo duro, por mal que vaya', () => {
        const techo = techoDeCandidatos(10);
        const deseado = presupuestoDeseado({ amount: 10, encontrados: 0, examinados: 1_400 });
        assert.ok(deseado <= techo, `${deseado} supera el techo duro ${techo}`);
    });

    test('con el pedido ya cubierto no se proyecta nada nuevo', () => {
        const deseado = presupuestoDeseado({ amount: 10, encontrados: 10, examinados: 120 });
        assert.ok(deseado <= Math.max(120, config.pluginSearch.minCandidates));
    });

    // ── Techo duro ───────────────────────────────────────────────────────────

    test('el techo duro escala con amount, entre su suelo y su techo absoluto', () => {
        const uno = techoDeCandidatos(1);
        const diez = techoDeCandidatos(10);
        const cien = techoDeCandidatos(100);
        const quinientos = techoDeCandidatos(500);

        // Pedir 1 o pedir 10 comparte suelo: los dos tienen que poder recorrer
        // una comunidad de tamaño normal antes de rendirse.
        assert.strictEqual(uno, config.pluginSearch.minHardCandidates);
        assert.strictEqual(diez, config.pluginSearch.minHardCandidates);
        assert.strictEqual(cien, 100 * config.pluginSearch.hardCandidatesPerResult);
        assert.strictEqual(quinientos, config.pluginSearch.maxCandidates);
        assert.ok(quinientos >= cien && cien >= diez);
    });

    test('la tolerancia por resultado NO es constante: depende del tramo', () => {
        // La lectura facil y equivocada es "el techo son 150 candidatos por
        // resultado". Solo lo es en el tramo proporcional: el suelo lo sube en
        // pedidos pequeños y el techo absoluto lo baja en pedidos grandes.
        const { candidatosPorResultadoEfectivos } = presupuestos;

        assert.strictEqual(candidatosPorResultadoEfectivos(1), 1500);   // suelo
        assert.strictEqual(candidatosPorResultadoEfectivos(10), 150);   // suelo, ya al ras
        assert.strictEqual(candidatosPorResultadoEfectivos(100), 150);  // proporcional
        assert.strictEqual(candidatosPorResultadoEfectivos(500), 50);   // techo absoluto

        // Y decrece: pedir mas nunca compra MAS tolerancia por resultado.
        const serie = [1, 10, 100, 500].map(candidatosPorResultadoEfectivos);
        for (let i = 1; i < serie.length; i++) {
            assert.ok(serie[i] <= serie[i - 1],
                `la tolerancia subio de ${serie[i - 1]} a ${serie[i]}`);
        }
    });

    test('el efectivo cuadra siempre con el techo y con amount', () => {
        // Es la propiedad que hace que el campo sirva para leer stats: si no
        // fuera exactamente techo/amount, compararlo contra la tasa de
        // aceptacion observada daria una conclusion falsa.
        for (const amount of [1, 3, 10, 25, 100, 250, 500]) {
            assert.strictEqual(
                presupuestos.candidatosPorResultadoEfectivos(amount),
                Math.round((techoDeCandidatos(amount) / amount) * 100) / 100
            );
        }
    });

    test('el efectivo sigue al override del techo, no a la constante', () => {
        const original = config.pluginSearch.hardCandidateLimit;
        try {
            config.pluginSearch.hardCandidateLimit = 300;
            assert.strictEqual(presupuestos.candidatosPorResultadoEfectivos(10), 30,
                'el efectivo no reflejo el techo bajado en caliente');
        } finally {
            config.pluginSearch.hardCandidateLimit = original;
        }
    });

    test('el techo duro es generoso comparado con lo que cuesta una busqueda normal', () => {
        // Lo que lo convierte en proteccion anti-bucle y no en el final
        // habitual: la comunidad real que motivo el cambio costaba ~30
        // candidatos por resultado, y el techo de una busqueda de 10 permite
        // cinco veces eso. Alcanzarlo NO demuestra que no haya outfits en el
        // rango: solo que no conseguimos demostrar los suficientes dentro de
        // nuestros limites seguros.
        assert.ok(presupuestos.candidatosPorResultadoEfectivos(10) >= 30 * 4);
        assert.ok(presupuestos.candidatosPorResultadoEfectivos(100) >= 30 * 4);
    });

    test('el override explicito manda, pero nunca por encima del techo absoluto', () => {
        const original = config.pluginSearch.hardCandidateLimit;
        try {
            config.pluginSearch.hardCandidateLimit = 200;
            assert.strictEqual(techoDeCandidatos(500), 200);

            config.pluginSearch.hardCandidateLimit = 10_000_000;
            assert.strictEqual(techoDeCandidatos(10), config.pluginSearch.maxCandidates);
        } finally {
            config.pluginSearch.hardCandidateLimit = original;
        }
    });

    // ── Techo de paginas ─────────────────────────────────────────────────────

    test('el techo de paginas da para consumir el techo de candidatos entero', () => {
        for (const amount of [1, 10, 100, 500]) {
            const techo = techoDeCandidatos(amount);
            const paginas = techoDePaginas(techo);
            assert.ok(paginas * MIEMBROS_POR_PAGINA >= Math.min(techo, config.pluginSearch.maxMemberPages * MIEMBROS_POR_PAGINA),
                `con amount=${amount} el techo de paginas (${paginas}) no da para ${techo} candidatos`);
        }
    });

    test('una busqueda de 10 puede recorrer muchas mas de una pagina', () => {
        // El sintoma que se vio en produccion fue `memberPagesFetched: 1`. Con
        // 100 miembros por pagina, poder pedir una sola pagina es poder mirar a
        // 100 personas: absurdo para un pedido que necesita cientos.
        const paginas = techoDePaginas(techoDeCandidatos(10));
        assert.ok(paginas >= 15, `una busqueda de 10 solo puede recorrer ${paginas} paginas`);
    });

    test('el techo de paginas nunca pasa del absoluto configurado', () => {
        assert.ok(techoDePaginas(1_000_000) <= config.pluginSearch.maxMemberPages);
        assert.ok(techoDePaginas(0) >= 1, 'un techo de cero paginas no dejaria empezar');
    });

    // ── Presupuesto de tiempo ────────────────────────────────────────────────

    test('el presupuesto de tiempo escala con amount entre suelo y techo', () => {
        const diez = presupuestoDeTiempo(10, { modoAsincrono: true });
        const cien = presupuestoDeTiempo(100, { modoAsincrono: true });
        const quinientos = presupuestoDeTiempo(500, { modoAsincrono: true });

        assert.strictEqual(diez, config.pluginSearch.timeBudgetMinMs);
        assert.ok(cien > diez, 'pedir 100 no puede tener el mismo presupuesto que pedir 10');
        assert.strictEqual(quinientos, config.pluginSearch.timeBudgetMaxMs);

        // Y ninguno se va de madre: el techo sigue siendo un techo.
        for (const ms of [diez, cien, quinientos]) {
            assert.ok(ms <= config.pluginSearch.timeBudgetMaxMs);
            assert.ok(ms >= config.pluginSearch.timeBudgetMinMs);
        }
    });

    test('el modo SINCRONO tiene su propio techo, mas corto', () => {
        // Ahi si hay un socket abierto y HttpService de Roblox tiene su plazo:
        // prometer tres minutos seria prometer un timeout.
        const sincrono = presupuestoDeTiempo(500, { modoAsincrono: false });
        const asincrono = presupuestoDeTiempo(500, { modoAsincrono: true });

        assert.strictEqual(sincrono, config.pluginSearch.timeBudgetSyncCeilingMs);
        assert.ok(asincrono > sincrono);
    });

    test('un presupuesto de tiempo explicito manda sobre el calculo', () => {
        const original = config.pluginSearch.timeBudgetMs;
        try {
            config.pluginSearch.timeBudgetMs = 1_234;
            assert.strictEqual(presupuestoDeTiempo(500, { modoAsincrono: true }), 1_234);
            // Incluido el 0, que es como se apaga una busqueda desde fuera.
            config.pluginSearch.timeBudgetMs = 0;
            assert.strictEqual(presupuestoDeTiempo(10, { modoAsincrono: true }), 0);
        } finally {
            config.pluginSearch.timeBudgetMs = original;
        }
    });

    // ── Lease ────────────────────────────────────────────────────────────────

    test('el lease del grupo cubre siempre el presupuesto de tiempo de la busqueda', () => {
        // Si expirase a mitad, otra busqueda podria empezar a avanzar el mismo
        // cursor — la corrupcion exacta que el lease existe para impedir.
        for (const amount of [1, 10, 100, 500]) {
            const tiempo = presupuestoDeTiempo(amount, { modoAsincrono: true });
            const lease = duracionDelLease(tiempo);
            assert.ok(lease > tiempo, `el lease (${lease}) no cubre el presupuesto (${tiempo})`);
            assert.ok(lease >= config.pluginRotation.leaseMs, 'el lease bajo del minimo configurado');
        }
    });

    test('una busqueda pequeña no reserva el grupo el tiempo de una grande', () => {
        // La razon de que el lease se pida por busqueda en vez de fijarse al
        // peor caso: un proceso que muera durante una busqueda de 10 outfits no
        // puede dejar la comunidad bloqueada tres minutos.
        const pequeña = duracionDelLease(presupuestoDeTiempo(10, { modoAsincrono: true }));
        const grande = duracionDelLease(presupuestoDeTiempo(500, { modoAsincrono: true }));
        assert.ok(pequeña < grande);
    });

    // ── Coherencia entre presupuestos ────────────────────────────────────────

    test('la cola aguanta a la busqueda mas larga que puede haber delante', () => {
        // Si no, una busqueda de 500 expulsaria de la cola a todas las que
        // llegaran detras, y el `queue_timeout` que verian no diria nada de lo
        // que en realidad paso.
        assert.ok(config.pluginQueue.waitTimeoutMs > config.pluginSearch.timeBudgetMaxMs,
            'la espera en cola es mas corta que la busqueda mas larga posible');
    });

    test('la adopcion tolera muchos latidos fallidos seguidos: un bache de la base no roba trabajos', () => {
        // Todo trabajo vivo late cada `heartbeatIntervalMs`, haga lo que haga.
        // Solo se adopta tras `adoptAfterMs` sin latir: la relacion entre los
        // dos es la tolerancia a fallos transitorios de Postgres.
        const latidosPerdidos = config.pluginJobs.adoptAfterMs / config.pluginJobs.heartbeatIntervalMs;
        assert.ok(latidosPerdidos >= 6,
            `hacen falta solo ${latidosPerdidos} latidos fallidos para perder un trabajo: demasiado fragil`);
        // Y un trabajo estacionado por Roblox late mas a menudo de lo que tarda
        // en darse por huerfano.
        assert.ok(config.pluginSearch.rateLimitHeartbeatMs * 3 < config.pluginJobs.adoptAfterMs);
        // La recuperacion pasa lo bastante a menudo para que un trabajo soltado
        // en un redeploy no espere ni un minuto a que alguien lo continue.
        assert.ok(config.pluginJobs.recoveryIntervalMs <= 60_000);
    });

    return suite.run();
};
