'use strict';

const config = require('../config');
const logger = require('../observability/logger');
const { NotFoundError, UpstreamRateLimitedError, CircuitOpenError, UpstreamError } = require('./errors');

// Capa de resiliencia de TODA llamada saliente a Roblox. Tres mecanismos
// independientes que se complementan:
//
//   1. Gate de concurrencia GLOBAL — cuantas peticiones a Roblox pueden estar
//      vivas a la vez, sumando las tres rutas. Con miles de jugadores lo que
//      importa no es cuantas peticiones recibimos sino cuantas dejamos salir.
//   2. Cooldown REACTIVO por ruta — cuando Roblox dice "espera", esperamos lo
//      que pida y frenamos esa ruta para todos.
//   3. Circuit breaker por ruta — si una ruta falla de forma sostenida,
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
        consecutiveFailures: 0,
        circuitOpenUntil: 0,       // 0 = breaker cerrado
        circuitCooldownMs: circuitBaseCooldownMs,
        probeInFlight: false,      // half-open: una sola peticion de tanteo
        metrics: {
            calls: 0, ok: 0, notFound: 0,
            rateLimited: 0, serverErrors: 0, networkErrors: 0, otherErrors: 0,
            retries: 0, shed: 0, circuitOpens: 0,
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
function observeRateLimitHeaders(bucket, headers) {
    if (!headers) return;
    const remaining = Number(headers['x-ratelimit-remaining']);
    if (!Number.isFinite(remaining) || remaining > 0) return;

    const waitMs = parseWaitMs(headers);
    if (waitMs == null || waitMs <= 0) return;

    bucket.cooldownUntil = Math.max(bucket.cooldownUntil, Date.now() + waitMs);
    logger.warn('Cuota de Roblox agotada segun cabeceras, ruta en cooldown preventivo', {
        route: bucket.name, waitMs,
    });
}

// ── Circuit breaker ──────────────────────────────────────────────────────────

function onSuccess(bucket) {
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
function onHardFailure(bucket, reason) {
    bucket.consecutiveFailures++;
    if (bucket.consecutiveFailures < circuitFailureThreshold) return;

    bucket.circuitOpenUntil = Date.now() + bucket.circuitCooldownMs;
    bucket.metrics.circuitOpens++;
    logger.warn('Circuito de Roblox ABIERTO', {
        route: bucket.name,
        reason,
        consecutiveFailures: bucket.consecutiveFailures,
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

async function waitForCooldown(bucket) {
    const waitMs = bucket.cooldownUntil - Date.now();
    if (waitMs <= 0) return;

    // Si la espera cabe dentro de la peticion, se absorbe aqui y el llamador
    // ni se entera. Si no cabe, se le devuelve el control con un Retry-After
    // honesto: sostener el socket mas tiempo no acelera a Roblox y multiplica
    // las conexiones abiertas justo cuando menos conviene.
    if (waitMs > inlineWaitCeilingMs) {
        bucket.metrics.shed++;
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

async function callOnce(fn) {
    await acquire();
    try {
        return await fn();
    } finally {
        release();
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
async function run(routeKey, fn, { notFoundCode = 'not_found', notFoundWhen = null } = {}) {
    const bucket = buckets[routeKey];
    if (!bucket) throw new Error(`routeKey desconocido: ${routeKey}`);

    const isProbe = checkCircuit(bucket);

    try {
        for (let attempt = 0; ; attempt++) {
            await waitForCooldown(bucket);

            bucket.metrics.calls++;
            try {
                const response = await callOnce(fn);
                observeRateLimitHeaders(bucket, response?.headers);
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
                    const headerWait = parseWaitMs(err.response?.headers);
                    const waitMs = headerWait ?? backoffMs(attempt);
                    bucket.cooldownUntil = Math.max(bucket.cooldownUntil, Date.now() + waitMs);

                    logger.warn('Roblox respondio 429', {
                        route: bucket.name, attempt, waitMs, fromHeader: headerWait != null,
                    });

                    if (attempt < maxRetries && waitMs <= inlineWaitCeilingMs) {
                        bucket.metrics.retries++;
                        continue; // waitForCooldown de la siguiente vuelta absorbe la espera
                    }
                    onHardFailure(bucket, 'rate_limited');
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
                    onHardFailure(bucket, `http_${status}`);
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
                    onHardFailure(bucket, err?.code || 'network_error');
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
    const cooldownRemainingMs = Math.max(0, bucket.cooldownUntil - now);
    const circuitOpen = bucket.circuitOpenUntil > now;

    return {
        // `true` = una llamada nueva o se hace esperar o se rechaza de plano.
        throttled: cooldownRemainingMs > 0 || circuitOpen,
        cooldownRemainingMs,
        circuitOpen,
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

module.exports = { run, getMetrics, getThrottleState, reset, __buckets: buckets };
