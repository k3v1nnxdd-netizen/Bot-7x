'use strict';

const config = require('../config');
const logger = require('../observability/logger');
const { NotFoundError, UpstreamRateLimitedError, CircuitOpenError, UpstreamError } = require('./errors');
const requestContext = require('../observability/requestContext');

// Capa de resiliencia de TODA llamada saliente a Roblox. Cuatro mecanismos
// independientes que se complementan:
//
//   1. Gate de concurrencia GLOBAL — cuantas peticiones a Roblox pueden estar
//      vivas a la vez, sumando las tres rutas. Con miles de jugadores lo que
//      importa no es cuantas peticiones recibimos sino cuantas dejamos salir.
//   2. Marcapasos PREVENTIVO por ruta — separacion minima entre llamadas, que
//      arranca en cero y solo aparece cuando Roblox señala presion. Es el unico
//      de los cuatro que evita el 429 en vez de sobrevivirlo.
//   3. Cooldown REACTIVO por ruta — cuando Roblox dice "espera", esperamos lo
//      que pida y frenamos esa ruta para todos.
//   4. Circuit breaker por ruta — si una ruta falla de forma sostenida,
//      dejamos de insistir un rato y fallamos rapido.
//
// DECISION CENTRAL: aqui no hay NINGUNA cuota asumida. No se codifica "N
// req/min" para ningun endpoint, porque Roblox no publica limites estables
// para estas rutas y los endurece sin avisar; una constante nuestra estaria
// mal el dia que la cambien, en la direccion peligrosa. Un 429 se trata como
// condicion NORMAL de operacion y la pauta la marca Roblox: `Retry-After` y
// `x-ratelimit-*` cuando los manda, y backoff exponencial con jitter cuando
// no manda nada. La defensa real contra los limites no es este archivo, es la
// cache; esto es lo que hace que un limite duela poco en vez de tumbar todo.

const {
    maxConcurrent, maxQueue, maxRetries,
    retryBaseDelayMs, retryMaxDelayMs, inlineWaitCeilingMs,
    circuitFailureThreshold, circuitBaseCooldownMs, circuitMaxCooldownMs,
    pacerBaseMs, pacerMaxMs, pacerMinMs, pacerDecay,
    pacerHeaderFraction, routeConcurrency,
    rateLimitFallbackBaseMs, rateLimitFallbackMaxMs,
} = config.upstream;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Gate de concurrencia global ──────────────────────────────────────────────

let active = 0;
const queue = [];

function acquire() {
    if (active < maxConcurrent) {
        active++;
        return Promise.resolve();
    }
    // Cola llena: se rechaza AL INSTANTE en vez de acumular. Con miles de
    // jugadores, un "vuelve en 2 segundos" inmediato es infinitamente mejor
    // que un socket retenido medio minuto para acabar fallando igual.
    if (queue.length >= maxQueue) {
        return Promise.reject(new UpstreamRateLimitedError(
            'Demasiadas consultas en cola hacia Roblox, reintenta en unos segundos',
            2
        ));
    }
    return new Promise(resolve => queue.push(resolve));
}

function release() {
    const next = queue.shift();
    // El slot se TRASPASA al siguiente en cola (active no baja): si bajara y
    // volviera a subir, una peticion nueva podria colarse entre medias y
    // dejar a la cola esperando indefinidamente.
    if (next) next();
    else active--;
}

// ── Estado por ruta ──────────────────────────────────────────────────────────

function makeBucket(name) {
    return {
        name,
        cooldownUntil: 0,          // impuesto por Roblox (Retry-After / x-ratelimit-reset)
        cooldownAvisado: 0,        // ultima ventana de cooldown ya registrada en el log
        consecutiveFailures: 0,
        circuitOpenUntil: 0,       // 0 = breaker cerrado
        circuitCooldownMs: circuitBaseCooldownMs,
        probeInFlight: false,      // half-open: una sola peticion de tanteo

        // ── Marcapasos adaptativo ────────────────────────────────────────────
        // Separacion MINIMA entre dos llamadas de esta ruta, y el instante mas
        // temprano en el que puede salir la siguiente. Ver esperarMarcapasos.
        spacingMs: 0,              // 0 = sin marcapasos (estado sano)
        nextAllowedAt: 0,

        // ── Concurrencia efectiva POR RUTA ─────────────────────────────────
        // Cuantas llamadas de ESTA ruta pueden estar en vuelo a la vez. Es
        // independiente del gate global (que suma todas las rutas) y existe
        // para el burst inicial: sin esto, una ola de 25 avatares mete tres
        // en vuelo antes de que la primera respuesta haya podido enseñar nada.
        // 0 = sin tope propio (solo el global).
        maxInFlight: routeConcurrency[name] ?? 0,
        inFlight: 0,
        esperandoSlot: [],

        // ── Cuota APRENDIDA de las cabeceras de Roblox ─────────────────────
        // Lo ultimo que Roblox dijo de esta ruta. null hasta que lo diga: no
        // se inventa ninguna cuota que Roblox no haya publicado. `windowMs` es
        // la duracion de la ventana, estimada como el mayor 'reset' visto: al
        // principio de una ventana fresca, reset == ventana entera.
        quota: { limit: null, remaining: null, resetAt: null, windowMs: null },

        // 429 seguidos sin ninguna respuesta buena entre medias. Es lo que
        // escala el cooldown cuando Roblox NO dice cuanto esperar.
        consecutiveLimits: 0,

        metrics: {
            calls: 0, ok: 0, notFound: 0,
            rateLimited: 0, serverErrors: 0, networkErrors: 0, otherErrors: 0,
            retries: 0, shed: 0, circuitOpens: 0, paced: 0,
            maxInFlightObserved: 0,
        },
    };
}

// Un bucket por ruta de Roblox, con estado independiente: que
// catalog.roblox.com este limitado no debe frenar avatar.roblox.com ni al
// reves. `assetBundles` existe aparte precisamente por eso — es el unico
// camino opcional (?bundles=1) y el mas caro, y no puede robarle cuota a los
// tres endpoints que atienden el trafico normal.
const buckets = {
    usernameLookup: makeBucket('usernameLookup'),
    outfitList: makeBucket('outfitList'),
    outfitDetails: makeBucket('outfitDetails'),
    assetBundles: makeBucket('assetBundles'),
    catalogDetails: makeBucket('catalogDetails'),

    // Propiedad real de una experiencia (verificacion de licencia). Buckets
    // propios y no compartidos con los de outfits a proposito: si Roblox
    // aprieta el limite del catalogo, eso no puede dejar sin verificar a los
    // juegos con licencia, y al reves tampoco.
    placeUniverse: makeBucket('placeUniverse'),
    universeInfo: makeBucket('universeInfo'),

    // Detalles de bundles por lote (composicion + precio), para
    // /v1/catalog/batch. Bucket propio y no el de `catalogDetails`: si Roblox
    // aprieta uno de los dos, el otro sigue atendiendo.
    bundleDetails: makeBucket('bundleDetails'),

    // Busqueda de outfits del plugin de Studio. Dos buckets propios y
    // SEPARADOS de todo lo anterior a proposito: es el unico camino que hace
    // rafagas (un avatar por candidato), y si Roblox le aprieta el limite, eso
    // no puede dejar sin servicio a los juegos con licencia — que son los que
    // pagan. Al reves tampoco: una tarde de mucho trafico de juego no puede
    // congelar la herramienta interna.
    groupMembers: makeBucket('groupMembers'),
    userAvatar: makeBucket('userAvatar'),
};

// ── Diagnostico de limitacion ────────────────────────────────────────────────
//
// Cuando Roblox nos frena hay que poder responder a UNA pregunta con el log
// delante: QUE endpoint concreto esta limitando y con que margen. Sin eso, un
// "429" suelto obliga a adivinar entre las diez rutas que usa el servicio.
//
// Se registra siempre el mismo juego de campos, para que las lineas de las tres
// situaciones (429 recibido, cooldown preventivo por cabeceras, peticion
// rechazada por cooldown) sean comparables entre si y agregables por endpoint.
//
// NADA SENSIBLE. Ni cabeceras completas, ni credenciales, ni cuerpos: se
// eligen los campos uno a uno. La URL se normaliza (ver plantillaDeUrl) para
// que tampoco se cuelen ids de usuario.

// De una URL concreta a su plantilla: los segmentos numericos se sustituyen por
// {id} y la query se descarta entera.
//
// Dos motivos, y los dos importan. Uno, agregacion: cien lineas de
// '/users/123/avatar', '/users/456/avatar'... no se pueden contar juntas, y
// '/users/{id}/avatar' si — que es justo lo que hace falta para saber que
// endpoint limita. Dos, higiene: el userId deja de aparecer en el log sin que
// haya que acordarse de quitarlo.
function plantillaDeUrl(url) {
    if (typeof url !== 'string' || url === '') return null;
    const sinQuery = url.split('?')[0];
    return sinQuery.replace(/\/\d+/g, '/{id}');
}

// Las tres cabeceras de cuota que publica Roblox. Se leen de una en una y solo
// estas: volcar el objeto de cabeceras entero arrastraria cookies y cualquier
// cosa que Roblox añada en el futuro.
function cuotaDeCabeceras(headers) {
    if (!headers) return { rateLimitLimit: null, rateLimitRemaining: null, rateLimitReset: null };
    const leer = nombre => (headers[nombre] === undefined ? null : String(headers[nombre]));
    return {
        rateLimitLimit: leer('x-ratelimit-limit'),
        rateLimitRemaining: leer('x-ratelimit-remaining'),
        rateLimitReset: leer('x-ratelimit-reset'),
    };
}

function estadoDelCircuito(bucket, now) {
    if (bucket.circuitOpenUntil > now) return 'open';
    return bucket.circuitOpenUntil !== 0 ? 'half-open' : 'closed';
}

// El juego completo de campos. 'endpoint' sale de lo que declaro el llamador
// (ver el parametro "endpoint" de run) y, si no lo declaro, de la propia
// respuesta de axios.
function diagnostico(bucket, { endpoint = null, status = null, headers = null, urlDeError = null } = {}) {
    const now = Date.now();
    return {
        routeKey: bucket.name,
        endpoint: endpoint ?? plantillaDeUrl(urlDeError),
        status,
        retryAfter: headers?.['retry-after'] === undefined ? null : String(headers['retry-after']),
        ...cuotaDeCabeceras(headers),
        cooldownRemainingMs: Math.max(0, bucket.cooldownUntil - now),
        circuitState: estadoDelCircuito(bucket, now),
        consecutiveFailures: bucket.consecutiveFailures,
        // Correlacion con la busqueda que provoco la llamada. null cuando quien
        // llama no abrio contexto (las rutas del juego), que no es un problema.
        //
        // El searchId va ADEMAS del requestId y no en su lugar: el requestId
        // ata la linea a la peticion HTTP y el searchId al trabajo que el
        // plugin esta siguiendo, que en modo asincrono le sobrevive por
        // minutos. Con solo el primero, un 429 emitido a mitad de una busqueda
        // asincrona no se podia cruzar con el `searchId` que devolvio el POST.
        requestId: requestContext.requestId(),
        searchId: requestContext.searchId(),
    };
}

function retryAfterSecondsFrom(until) {
    return Math.max(1, Math.ceil((until - Date.now()) / 1000));
}

// ── Lectura de las señales que manda Roblox ──────────────────────────────────

// `Retry-After` admite dos formatos por HTTP: segundos o fecha. Se soportan
// los dos. `x-ratelimit-reset` es la variante que usan varios endpoints de
// Roblox; se acota a una hora para que un valor absurdo (o un epoch absoluto
// interpretado como duracion) no nos deje una ruta congelada eternamente.
function parseWaitMs(headers) {
    if (!headers) return null;

    const retryAfter = headers['retry-after'];
    if (retryAfter != null) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 3600_000);
        const when = Date.parse(retryAfter);
        if (!Number.isNaN(when)) return Math.max(0, Math.min(when - Date.now(), 3600_000));
    }

    const reset = headers['x-ratelimit-reset'];
    if (reset != null) {
        const seconds = Number(reset);
        if (Number.isFinite(seconds) && seconds > 0 && seconds <= 3600) return seconds * 1000;
    }

    return null;
}

// Frenado PROACTIVO: si Roblox nos dice que nos queda 0 de cuota, paramos esa
// ruta antes de gastar el 429, en vez de descubrirlo chocando. Solo actua si
// las cabeceras existen — nunca inventa una cuota.
// Recibe la RESPUESTA completa y no solo sus cabeceras, para poder sacar de
// ella la URL que se acaba de llamar y decir en el log que endpoint es el que
// se ha quedado sin cuota.
function observeRateLimitHeaders(bucket, response, endpoint) {
    const headers = response?.headers;
    if (!headers) return;
    const remaining = Number(headers['x-ratelimit-remaining']);
    if (!Number.isFinite(remaining)) return;

    // ── APRENDIZAJE DE LA CUOTA ──────────────────────────────────────────────
    // Lo que Roblox acaba de decir de esta ruta se guarda tal cual, para dos
    // usos: marcar el paso ANTES de agotar la ventana (aqui abajo) y que quien
    // mire el estado de la ruta sepa con que margen esta trabajando.
    aprenderCuota(bucket, headers, remaining);

    if (remaining > 0) return;

    // Roblox acaba de decir que la ventana esta agotada. Aunque la respuesta
    // fuera correcta, esto es la señal MAS TEMPRANA de presion que existe: es
    // el momento de separar las llamadas, no cuando ya nos hayan devuelto 429.
    apretarMarcapasos(bucket);

    const waitMs = parseWaitMs(headers);
    if (waitMs == null || waitMs <= 0) return;

    bucket.cooldownUntil = Math.max(bucket.cooldownUntil, Date.now() + waitMs);
    logger.warn('Cuota de Roblox agotada segun cabeceras, ruta en cooldown preventivo', {
        ...diagnostico(bucket, {
            endpoint,
            status: response?.status ?? null,
            headers,
            urlDeError: response?.config?.url,
        }),
        waitMs,
    });
}

// ── Cuota aprendida de las cabeceras ─────────────────────────────────────────
//
// EL BURST INICIAL, y por que el AIMD solo no lo evita. El marcapasos reacciona
// a la presion; pero una ola de 25 avatares con tres en vuelo puede comerse la
// ventana entera antes de que la primera respuesta haya enseñado nada. La
// unica forma de no chocar es LEER LA CUOTA MIENTRAS SE GASTA: Roblox manda
// x-ratelimit-limit / -remaining / -reset en estas rutas, y con eso se puede
// repartir lo que queda de ventana a lo largo de lo que queda de tiempo en vez
// de gastarlo tan deprisa como la red permita.
//
//   separacion = tiempo que queda de ventana / llamadas que quedan de cuota
//
// Solo se aplica cuando la fraccion restante baja de pacerHeaderFraction: con
// la ventana casi entera por delante no hay nada que repartir, y el trafico
// normal del juego no paga ninguna separacion. NO SE INVENTA NINGUNA CUOTA:
// sin cabeceras, solo queda el AIMD reactivo.
function aprenderCuota(bucket, headers, remaining) {
    const limit = Number(headers['x-ratelimit-limit']);
    const reset = Number(headers['x-ratelimit-reset']);
    const ahora = Date.now();

    const resetValido = Number.isFinite(reset) && reset > 0 && reset <= 3600;
    bucket.quota = {
        limit: Number.isFinite(limit) && limit > 0 ? limit : bucket.quota.limit,
        remaining,
        resetAt: resetValido ? ahora + reset * 1000 : bucket.quota.resetAt,
        windowMs: resetValido ? Math.max(bucket.quota.windowMs ?? 0, reset * 1000) : bucket.quota.windowMs,
    };

    const { limit: cuota, resetAt, windowMs } = bucket.quota;
    if (!cuota) return;

    // ── DOS RITMOS, y se aplica el mas lento ─────────────────────────────────
    //
    //   SOSTENIBLE  ventana / cuota. Es el ritmo al que la cuota entera dura
    //               la ventana entera. Se aplica desde que se conoce, SIEMPRE,
    //               como suelo: es la forma de no gastar la ventana de golpe
    //               ni siquiera la primera vez. Conservador a proposito.
    //
    //   DE REPARTO  ventana restante / cuota restante, solo cuando ya se gasto
    //               mas de la mitad. Cubre el caso en que la ventana empezo
    //               con una rafaga (otra instancia, el juego) y el sostenible
    //               ya no basta para llegar al reset sin chocar.
    const sostenible = windowMs ? windowMs / cuota : 0;

    let reparto = 0;
    if (resetAt && remaining > 0 && remaining / cuota <= pacerHeaderFraction) {
        reparto = Math.max(0, resetAt - ahora) / remaining;
    }

    const objetivo = Math.min(pacerMaxMs, Math.max(sostenible, reparto));
    if (objetivo < pacerMinMs) return;

    // Solo se aprieta, nunca se afloja desde aqui: aflojar es cosa del AIMD,
    // que lo hace despacio y con evidencia de llamadas buenas — y nunca por
    // debajo del sostenible mientras la cuota se conozca (ver aflojar).
    if (objetivo > bucket.spacingMs) {
        const previo = bucket.spacingMs;
        bucket.spacingMs = objetivo;
        if (previo === 0) {
            logger.info('Marcapasos de Roblox activado por cabeceras', {
                route: bucket.name, spacingMs: Math.round(objetivo), remaining, limit: cuota,
                windowMs: windowMs ?? null, sustainableMs: Math.round(sostenible), spreadMs: Math.round(reparto),
            });
        }
    }
}

// Ritmo sostenible aprendido, o 0 si Roblox no ha publicado cuota y ventana.
function sueloSostenible(bucket) {
    const { limit, windowMs } = bucket.quota;
    if (!limit || !windowMs) return 0;
    return Math.min(pacerMaxMs, windowMs / limit);
}

// Impone un cooldown desde FUERA del limitador. Existe para un unico caso: un
// trabajo que se estaciono porque Roblox pidio esperar, murio con su proceso, y
// lo reanuda otra instancia. Esa instancia arranca con los buckets limpios — el
// estado del limitador vive en memoria — y sin esto mandaria peticiones contra
// una ruta que Roblox ya dijo que estaba cerrada. El resumeAt persistido es la
// unica memoria que sobrevive, y aqui se vuelve a aplicar.
function imponerCooldown(routeKey, untilMs, reason = 'resumed') {
    const bucket = buckets[routeKey];
    if (!bucket) throw new Error(`routeKey desconocido: ${routeKey}`);
    if (!Number.isFinite(untilMs) || untilMs <= Date.now()) return false;
    bucket.cooldownUntil = Math.max(bucket.cooldownUntil, untilMs);
    apretarMarcapasos(bucket);
    logger.info('Cooldown de Roblox reaplicado a una ruta', {
        route: bucket.name, reason, cooldownRemainingMs: untilMs - Date.now(),
    });
    return true;
}

// ── Concurrencia efectiva por ruta ───────────────────────────────────────────
//
// Un semaforo POR BUCKET, distinto del gate global. Se adquiere antes que el
// marcapasos y que el gate: si no hay slot de ruta, la llamada ni reserva turno
// ni ocupa un hueco global mientras espera.
function acquireRouteSlot(bucket) {
    if (bucket.maxInFlight <= 0 || bucket.inFlight < bucket.maxInFlight) {
        bucket.inFlight++;
        bucket.metrics.maxInFlightObserved = Math.max(bucket.metrics.maxInFlightObserved, bucket.inFlight);
        return Promise.resolve();
    }
    return new Promise(resolve => bucket.esperandoSlot.push(resolve));
}

function releaseRouteSlot(bucket) {
    const siguiente = bucket.esperandoSlot.shift();
    // Mismo traspaso que el gate global: el slot pasa al siguiente sin bajar
    // el contador, para que nadie se cuele entre medias.
    if (siguiente) siguiente();
    else bucket.inFlight--;
}

// ── Marcapasos adaptativo (AIMD) ─────────────────────────────────────────────
//
// EL CUARTO MECANISMO, y el unico PREVENTIVO. Los otros tres reaccionan a un
// limite que ya nos comieron: el cooldown espera lo que Roblox pida, el breaker
// deja de insistir y el gate acota cuantas van a la vez. Ninguno evita el 429;
// solo hacen que duela menos.
//
// El marcapasos si lo evita, y hacia falta por una razon concreta: la busqueda
// del plugin es la unica cosa de este servicio que hace RAFAGAS sostenidas
// contra una misma ruta. Doce olas seguidas de catalogo agotan la ventana de
// cuota, Roblox contesta 'remaining: 0' con su reset, y la busqueda se quedaba
// a medias — no porque no hubiera outfits, sino porque habiamos gastado la
// cuota tan deprisa como se podia.
//
// AIMD (aumento agresivo, reduccion suave), y arranca EN CERO a proposito:
// mientras Roblox no se queje no hay separacion ninguna y el comportamiento es
// exactamente el de siempre — lo que importa porque estos buckets los comparte
// el trafico del juego, que no puede pagar por las rafagas del plugin. En
// cuanto Roblox señala presion (un 429, o 'remaining: 0' en una respuesta
// buena) la separacion salta y se va relajando sola conforme las llamadas
// vuelven a salir bien.
function apretarMarcapasos(bucket) {
    const previo = bucket.spacingMs;
    bucket.spacingMs = Math.min(Math.max(previo * 2, pacerBaseMs), pacerMaxMs);
    if (previo === 0) {
        logger.info('Marcapasos de Roblox activado para una ruta', {
            route: bucket.name, spacingMs: bucket.spacingMs,
        });
    }
}

function aflojarMarcapasos(bucket) {
    if (bucket.spacingMs <= 0) return;
    // Nunca por debajo del ritmo sostenible que Roblox publico: relajar mas
    // que eso es volver a la rafaga que agoto la ventana la primera vez.
    const suelo = sueloSostenible(bucket);
    const relajado = Math.max(suelo, bucket.spacingMs * pacerDecay);
    // Por debajo del minimo no merece la pena mantener temporizadores vivos: se
    // apaga del todo y la ruta vuelve a ir a pelo.
    bucket.spacingMs = relajado < pacerMinMs ? 0 : relajado;
    if (bucket.spacingMs === 0) {
        logger.info('Marcapasos de Roblox apagado: la ruta va suelta otra vez', { route: bucket.name });
    }
}

// Reserva el turno ANTES de dormir, no despues. Es lo que hace que N llamadas
// simultaneas de la misma ruta salgan separadas y en orden en vez de dormir
// todas lo mismo y despertar juntas — que es exactamente la rafaga que el
// marcapasos existe para deshacer.
async function esperarMarcapasos(bucket) {
    if (bucket.spacingMs <= 0) return;

    const ahora = Date.now();
    const turno = Math.max(ahora, bucket.nextAllowedAt);
    bucket.nextAllowedAt = turno + bucket.spacingMs;

    const espera = turno - ahora;
    if (espera <= 0) return;
    bucket.metrics.paced++;
    await sleep(espera);
}

// ── Circuit breaker ──────────────────────────────────────────────────────────

function onSuccess(bucket) {
    bucket.consecutiveLimits = 0;
    aflojarMarcapasos(bucket);
    if (bucket.circuitOpenUntil !== 0 || bucket.circuitCooldownMs !== circuitBaseCooldownMs) {
        logger.info('Circuito de Roblox cerrado tras respuesta correcta', { route: bucket.name });
    }
    bucket.consecutiveFailures = 0;
    bucket.circuitOpenUntil = 0;
    bucket.circuitCooldownMs = circuitBaseCooldownMs;
}

// Solo los fallos DUROS cuentan (429 agotado, 5xx, red). Un 404 no: es una
// respuesta valida y definitiva de un Roblox que funciona perfectamente, y
// contarla abriria el breaker por consultar usuarios inexistentes.
function onHardFailure(bucket, reason, endpoint = null) {
    bucket.consecutiveFailures++;
    if (bucket.consecutiveFailures < circuitFailureThreshold) return;

    bucket.circuitOpenUntil = Date.now() + bucket.circuitCooldownMs;
    bucket.metrics.circuitOpens++;
    logger.warn('Circuito de Roblox ABIERTO', {
        ...diagnostico(bucket, { endpoint }),
        reason,
        cooldownMs: bucket.circuitCooldownMs,
    });
    // El siguiente ciclo espera el doble, hasta el techo: si Roblox sigue
    // mal, insistimos cada vez menos en lugar de sondear a ritmo fijo.
    bucket.circuitCooldownMs = Math.min(bucket.circuitCooldownMs * 2, circuitMaxCooldownMs);
}

// Decide si esta peticion puede pasar. Devuelve `true` si va como sondeo
// (half-open) y hay que liberar el testigo al terminar.
function checkCircuit(bucket) {
    if (bucket.circuitOpenUntil === 0) return false;

    const now = Date.now();
    if (now < bucket.circuitOpenUntil) {
        bucket.metrics.shed++;
        throw new CircuitOpenError(
            'Roblox no esta respondiendo de forma fiable ahora mismo, reintenta en unos segundos',
            retryAfterSecondsFrom(bucket.circuitOpenUntil)
        );
    }

    // Ventana cumplida: se deja pasar UNA sola peticion de tanteo. Si el
    // breaker se abriera de par en par de golpe, las miles de peticiones
    // acumuladas caerian juntas sobre un Roblox que quiza sigue mal.
    if (bucket.probeInFlight) {
        bucket.metrics.shed++;
        throw new CircuitOpenError('Roblox en verificacion de recuperacion, reintenta en unos segundos', 1);
    }

    bucket.probeInFlight = true;
    logger.info('Circuito de Roblox en half-open, enviando peticion de tanteo', { route: bucket.name });
    return true;
}

// ── Cooldown impuesto por Roblox ─────────────────────────────────────────────

async function waitForCooldown(bucket, endpoint) {
    const waitMs = bucket.cooldownUntil - Date.now();
    if (waitMs <= 0) return;

    // Si la espera cabe dentro de la peticion, se absorbe aqui y el llamador
    // ni se entera. Si no cabe, se le devuelve el control con un Retry-After
    // honesto: sostener el socket mas tiempo no acelera a Roblox y multiplica
    // las conexiones abiertas justo cuando menos conviene.
    if (waitMs > inlineWaitCeilingMs) {
        bucket.metrics.shed++;

        // UNA linea por ventana de cooldown, no una por peticion rechazada.
        // Bajo carga, una ruta frenada rechaza cientos de peticiones y loguear
        // cada una ahogaria el log justo cuando mas falta hace leerlo. El
        // evento que interesa es "esta ruta ha entrado en cooldown", y ese
        // ocurre una vez por ventana.
        if (bucket.cooldownAvisado !== bucket.cooldownUntil) {
            bucket.cooldownAvisado = bucket.cooldownUntil;
            logger.warn('Peticion rechazada: la ruta esta en cooldown impuesto por Roblox', {
                ...diagnostico(bucket, { endpoint }),
                waitMs,
            });
        }

        throw new UpstreamRateLimitedError(
            'Roblox esta limitando las consultas ahora mismo, reintenta en unos segundos',
            retryAfterSecondsFrom(bucket.cooldownUntil)
        );
    }
    await sleep(waitMs);
}

// ── Ejecucion ────────────────────────────────────────────────────────────────

function backoffMs(attempt) {
    const exponential = Math.min(retryMaxDelayMs, retryBaseDelayMs * 2 ** attempt);
    // Jitter completo: sin el, N peticiones que fallan a la vez reintentan a
    // la vez y reproducen exactamente el pico que causo el fallo.
    return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

// Una llamada, con todas las puertas en el orden que importa:
//
//   1. slot de RUTA         (cuantas de esta ruta en vuelo)
//   2. marcapasos           (separacion entre llamadas de esta ruta)
//   3. RECOMPROBAR cooldown (ver abajo)
//   4. gate GLOBAL          (cuantas en vuelo sumando todas)
//   5. la llamada
//
// LA RECOMPROBACION DEL PASO 3 ES LA INVARIANTE "cero peticiones durante un
// cooldown". Entre que una llamada paso el cooldown al entrar en run() y que le
// toca salir de verdad pueden pasar cientos de milisegundos de slot y de
// marcapasos, y en ese hueco otra respuesta puede haber cerrado la ruta. Sin
// esta comprobacion, la llamada saldria contra una ruta que Roblox acaba de
// cerrar: exactamente la peticion que no puede salir.
async function callOnce(bucket, fn) {
    await acquireRouteSlot(bucket);
    try {
        await esperarMarcapasos(bucket);

        if (bucket.cooldownUntil > Date.now()) {
            bucket.metrics.shed++;
            throw new UpstreamRateLimitedError(
                'Roblox esta limitando las consultas ahora mismo, reintenta en unos segundos',
                retryAfterSecondsFrom(bucket.cooldownUntil)
            );
        }

        await acquire();
        try {
            // `calls` se cuenta AQUI, en el punto exacto en que la peticion
            // sale, y no al entrar en run(): entre la entrada y este punto hay
            // tres puertas (slot de ruta, marcapasos, recomprobacion del
            // cooldown) que pueden rechazarla sin que Roblox la vea. Contarla
            // antes inflaria el numero con intentos que nunca salieron.
            bucket.metrics.calls++;
            return await fn();
        } finally {
            release();
        }
    } finally {
        releaseRouteSlot(bucket);
    }
}

// Ejecuta `fn` (una llamada axios ya construida) con todas las protecciones.
// `routeKey` identifica el bucket; `notFoundCode` es el codigo semantico que
// se le da a un 404 en esta ruta concreta ('user_not_found' vs
// 'outfit_not_found'), porque el limitador no sabe que recurso se pidio.
//
// `notFoundWhen(status, data)` es la valvula para las rutas de Roblox que NO
// usan 404 para decir "esto no existe". develop.roblox.com contesta 400 con
// {"errors":[{"code":1,"field":"universeId","message":"The universe does not
// exist."}]}, que sin esto acabaria de 502 — un fallo temporal — cuando en
// realidad es una respuesta definitiva.
//
// LA DIRECCION DEL RIESGO NO ES SIMETRICA, y por eso el predicado lo pone cada
// llamada y no una regla general: quedarse corto (tratar un "no existe" como
// fallo temporal) devuelve un 503 que se reintenta, molesto pero inofensivo.
// Pasarse (tratar un 4xx cualquiera como "no existe") convierte un problema de
// Roblox en una DENEGACION definitiva contra un cliente legitimo. Ante la duda,
// el predicado tiene que decir que no.
async function run(routeKey, fn, { notFoundCode = 'not_found', notFoundWhen = null, endpoint = null } = {}) {
    const bucket = buckets[routeKey];
    if (!bucket) throw new Error(`routeKey desconocido: ${routeKey}`);

    const isProbe = checkCircuit(bucket);

    try {
        for (let attempt = 0; ; attempt++) {
            await waitForCooldown(bucket, endpoint);

            try {
                const response = await callOnce(bucket, fn);
                observeRateLimitHeaders(bucket, response, endpoint);
                bucket.metrics.ok++;
                onSuccess(bucket);
                return response;
            } catch (err) {
                // Un rechazo del propio gate (cola llena) no es un fallo de
                // Roblox: no cuenta para el breaker ni se reintenta.
                if (err instanceof UpstreamRateLimitedError && !err.fromRoblox) {
                    bucket.metrics.shed++;
                    throw err;
                }

                const status = err?.response?.status;

                // ── 404 (o el "no existe" propio de esta ruta): valido y definitivo ──
                // El predicado solo se consulta si HUBO respuesta: sin ella no
                // hay nada que Roblox haya confirmado.
                if (status === 404 || (err?.response && notFoundWhen?.(status, err.response.data) === true)) {
                    bucket.metrics.notFound++;
                    onSuccess(bucket); // Roblox funciona: el recurso es el que no existe
                    throw new NotFoundError(notFoundCode, 'El recurso solicitado no existe en Roblox');
                }

                // ── 429: condicion normal, la pauta la marca Roblox ──
                if (status === 429) {
                    bucket.metrics.rateLimited++;
                    bucket.consecutiveLimits++;
                    // Llegamos tarde a la señal preventiva: a partir de ahora,
                    // separacion obligatoria en esta ruta, y nunca por debajo
                    // del ritmo sostenible si Roblox lo publico.
                    apretarMarcapasos(bucket);
                    bucket.spacingMs = Math.max(bucket.spacingMs, sueloSostenible(bucket));

                    // Lo que se aprende de las cabeceras del propio 429 tambien
                    // cuenta: suelen traer limit / reset aunque remaining sea 0.
                    if (err.response?.headers) {
                        const rem = Number(err.response.headers['x-ratelimit-remaining']);
                        if (Number.isFinite(rem)) aprenderCuota(bucket, err.response.headers, rem);
                    }

                    // ── CUANTO ESPERAR ──────────────────────────────────────
                    //
                    // Con cabecera, lo que Roblox diga, exactamente.
                    //
                    // SIN cabecera, un cooldown CONSERVADOR que se dobla con
                    // cada 429 seguido: 5 s, 10 s, 20 s, 40 s, hasta el techo.
                    // Antes aqui habia un backoff de 150-3000 ms con reintento
                    // en linea, y eso era un SONDEO: volver a llamar medio
                    // segundo despues de que Roblox dijera que no, tres veces,
                    // para descubrir que seguia diciendo que no. Cada sondeo
                    // gastaba cuota, renovaba el limite y, como cada uno
                    // acababa en una pausa de un segundo, agotaba el contador
                    // de pausas de una busqueda en veinte segundos. Roblox no
                    // dijo cuanto esperar: la respuesta honesta es esperar
                    // bastante y esperar mas si insiste, no adivinar por lo bajo.
                    const headerWait = parseWaitMs(err.response?.headers);
                    const escalon = Math.min(
                        rateLimitFallbackMaxMs,
                        rateLimitFallbackBaseMs * 2 ** Math.max(0, bucket.consecutiveLimits - 1)
                    );
                    const waitMs = headerWait ?? escalon;
                    bucket.cooldownUntil = Math.max(bucket.cooldownUntil, Date.now() + waitMs);

                    logger.warn('Roblox respondio 429', {
                        ...diagnostico(bucket, {
                            endpoint,
                            status,
                            headers: err.response?.headers,
                            urlDeError: err.config?.url,
                        }),
                        attempt,
                        waitMs,
                        fromHeader: headerWait != null,
                        // Si va a reintentarse en linea o si se devuelve el
                        // control al llamador: sin esto, dos lineas de 429
                        // seguidas no se distinguen de dos peticiones distintas.
                        willRetry: attempt < maxRetries && waitMs <= inlineWaitCeilingMs,
                    });

                    if (attempt < maxRetries && waitMs <= inlineWaitCeilingMs) {
                        bucket.metrics.retries++;
                        continue; // waitForCooldown de la siguiente vuelta absorbe la espera
                    }
                    onHardFailure(bucket, 'rate_limited', endpoint);
                    const rateErr = new UpstreamRateLimitedError(
                        'Roblox esta limitando las consultas ahora mismo, reintenta en unos segundos',
                        retryAfterSecondsFrom(bucket.cooldownUntil)
                    );
                    rateErr.fromRoblox = true;
                    throw rateErr;
                }

                // ── 5xx: problema de Roblox, reintentable ──
                if (status >= 500 && status < 600) {
                    bucket.metrics.serverErrors++;
                    if (attempt < maxRetries) {
                        bucket.metrics.retries++;
                        await sleep(backoffMs(attempt));
                        continue;
                    }
                    onHardFailure(bucket, `http_${status}`, endpoint);
                    throw new UpstreamError(`Roblox respondio ${status}`, err);
                }

                // ── Sin respuesta: timeout, DNS, socket caido ──
                if (!err?.response) {
                    bucket.metrics.networkErrors++;
                    if (attempt < maxRetries) {
                        bucket.metrics.retries++;
                        await sleep(backoffMs(attempt));
                        continue;
                    }
                    onHardFailure(bucket, err?.code || 'network_error', endpoint);
                    throw new UpstreamError('No se pudo contactar con Roblox', err);
                }

                // ── 4xx restantes: la peticion esta mal, reintentar no arregla nada ──
                bucket.metrics.otherErrors++;
                onSuccess(bucket); // Roblox respondio correctamente; el problema es nuestro
                throw new UpstreamError(`Roblox rechazo la peticion (${status})`, err);
            }
        }
    } finally {
        if (isProbe) bucket.probeInFlight = false;
    }
}

// ¿Esta ruta esta frenada AHORA MISMO? Consulta de solo lectura: no reserva
// slot, no toca contadores y no espera.
//
// Existe porque quien va a lanzar una rafaga cara necesita poder preguntar
// antes de empezar, en vez de enterarse a base de 429. El limitador es el
// unico que conoce este estado (cooldown impuesto por Roblox y breaker), asi
// que preguntarselo es mas barato y mas honesto que deducirlo de los errores.
// Lo usa la busqueda del plugin para dejar de pedir lotes de catalogo en
// cuanto Roblox aprieta, en lugar de seguir chocando contra la pared.
function getThrottleState(routeKey) {
    const bucket = buckets[routeKey];
    if (!bucket) throw new Error(`routeKey desconocido: ${routeKey}`);

    const now = Date.now();
    const circuitOpen = bucket.circuitOpenUntil > now;
    // Lo que falta para poder llamar, venga el freno del cooldown de Roblox o
    // del breaker nuestro. Antes solo contaba el primero, y con el breaker
    // abierto quien preguntaba veia "0 ms" — estacionaba solo su margen,
    // volvia, seguia cerrado, y asi hasta agotar sus pausas.
    const cooldownRemainingMs = Math.max(0, Math.max(bucket.cooldownUntil, bucket.circuitOpenUntil) - now);

    return {
        // `true` = una llamada nueva o se hace esperar o se rechaza de plano.
        throttled: cooldownRemainingMs > 0 || circuitOpen,
        cooldownRemainingMs,
        circuitOpen,
        // Separacion vigente del marcapasos. No implica `throttled`: la ruta
        // sigue atendiendo, solo que a un ritmo mas espaciado.
        spacingMs: Math.round(bucket.spacingMs),
        // Instante ABSOLUTO en el que la ruta vuelve a estar disponible. Es lo
        // que un trabajo persiste como resumeAt para poder estacionarse de
        // forma durable y reanudar despues de un reinicio.
        resumeAt: Math.max(bucket.cooldownUntil, bucket.circuitOpenUntil) || null,
        inFlight: bucket.inFlight,
        maxInFlight: bucket.maxInFlight,
        quota: { ...bucket.quota },
        // Motivo, para poder decir en el log POR QUE se corto.
        reason: circuitOpen ? 'circuit_open' : cooldownRemainingMs > 0 ? 'cooldown' : null,
    };
}

function getMetrics() {
    const now = Date.now();
    const byRoute = {};
    for (const [routeKey, bucket] of Object.entries(buckets)) {
        byRoute[routeKey] = {
            ...bucket.metrics,
            circuit: {
                state: bucket.circuitOpenUntil > now ? 'open'
                    : bucket.circuitOpenUntil !== 0 ? 'half-open'
                    : 'closed',
                consecutiveFailures: bucket.consecutiveFailures,
                cooldownRemainingMs: Math.max(0, bucket.cooldownUntil - now),
            },
        };
    }
    return { concurrency: { active, queued: queue.length, maxConcurrent, maxQueue }, byRoute };
}

// Solo para los tests.
function reset() {
    active = 0;
    queue.length = 0;
    for (const routeKey of Object.keys(buckets)) buckets[routeKey] = makeBucket(routeKey);
}

module.exports = {
    run, getMetrics, getThrottleState, imponerCooldown, reset,
    __buckets: buckets,
    // Puros; exportados SOLO para los tests. Deciden que sale en el log cuando
    // Roblox nos frena, asi que merecen pruebas propias en vez de ejercitarse
    // de refilon.
    __diagnostico: diagnostico,
    __plantillaDeUrl: plantillaDeUrl,
};
