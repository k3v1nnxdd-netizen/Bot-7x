'use strict';

const memoryDriver = require('./memoryDriver');
const singleFlight = require('./singleFlight');
const { NotFoundError } = require('../roblox/errors');

// Fachada de cache. Los servicios hablan SOLO con este modulo; ninguno
// conoce el driver que hay debajo.
//
// ── PUNTO DE INSERCION DE REDIS ──────────────────────────────────────────────
// Migrar a Redis es exactamente esto y nada mas:
//   1. Crear `redisDriver.js` con las mismas cuatro funciones asincronas que
//      expone memoryDriver.js: get(key) / set(key, value, ttlMs) / del(key) /
//      getMetrics(). Serializar con JSON y usar `SET key value PX ttlMs`.
//   2. Cambiar el `selectDriver()` de aqui abajo para devolverlo cuando
//      config.cacheDriver sea 'redis'.
// Ni un solo call-site cambia. Tres decisiones tomadas hoy son las que lo
// garantizan:
//   - La interfaz ya es asincrona, aunque hoy no haga falta.
//   - Las claves ya van namespaced y VERSIONADAS ("v1:user:name:x"), asi que
//     un cambio de forma en lo que guardamos solo necesita subir el prefijo
//     para invalidar toda una familia sin tocar el resto.
//   - Los valores son objetos planos serializables: nada de Map, Set, Date ni
//     clases, que no sobrevivirian un viaje por red.
// Lo que NO se movera a Redis es el single-flight: una promesa en memoria no
// es compartible entre instancias. Seguira siendo por proceso, y esta bien —
// con N instancias el peor caso son N llamadas simultaneas en lugar de miles.

function selectDriver() {
    // Hoy solo hay uno; config/index.js ya avisa si se pide otro.
    return memoryDriver;
}

const driver = selectDriver();

// Prefijo de version del ESQUEMA de cache, no de la API. Subirlo invalida
// todo lo guardado de golpe — util cuando cambia la forma de lo que se
// almacena y no queremos servir entradas viejas con forma antigua.
const SCHEMA_VERSION = 'v1';

function key(...parts) {
    return `${SCHEMA_VERSION}:${parts.join(':')}`;
}

// Marca de "Roblox confirmo que esto no existe". Se guarda con su propio TTL
// (mas corto) y al releerla se relanza el NotFoundError original sin tocar la
// red. Es la pieza que impide que un buscador de usernames con errores de
// tecleo se convierta en un martilleo constante contra Roblox.
const NEGATIVE = '__negative__';

function isNegative(entry) {
    return entry !== null && typeof entry === 'object' && entry.__marker === NEGATIVE;
}

const metrics = {
    negativeHits: 0,
    negativeStores: 0,
};

// Lee de cache, y si no hay nada ejecuta `fetchFn` UNA sola vez por clave
// (single-flight) guardando el resultado.
//
// opts.negativeTtlMs — si `fetchFn` lanza NotFoundError, cachea la ausencia
//   ese tiempo y relanza. Omitirlo desactiva la cache negativa para esa clave.
// opts.onStatus — recibe 'hit' | 'miss' | 'negative-hit'. Lo usan las rutas
//   para que el log de cada peticion diga de donde salio la respuesta, sin
//   que este modulo tenga que saber nada de Express.
async function withCache(cacheKey, ttlMs, fetchFn, opts = {}) {
    const { negativeTtlMs, onStatus } = opts;

    const cached = await driver.get(cacheKey);
    if (cached !== undefined) {
        if (isNegative(cached)) {
            metrics.negativeHits++;
            onStatus?.('negative-hit');
            throw new NotFoundError(cached.code, cached.message);
        }
        onStatus?.('hit');
        return cached;
    }

    onStatus?.('miss');

    return singleFlight.run(cacheKey, async () => {
        try {
            const value = await fetchFn();
            await driver.set(cacheKey, value, ttlMs);
            return value;
        } catch (err) {
            // Solo se cachea la AUSENCIA confirmada. Un 429, un 5xx o un
            // timeout no dicen nada sobre si el recurso existe, y guardarlos
            // convertiria un bache momentaneo de Roblox en minutos de 404
            // falsos para todo el mundo.
            if (negativeTtlMs && err instanceof NotFoundError) {
                await driver.set(cacheKey, { __marker: NEGATIVE, code: err.code, message: err.message }, negativeTtlMs);
                metrics.negativeStores++;
            }
            throw err;
        }
    });
}

function getMetrics() {
    return { ...driver.getMetrics(), ...metrics, singleFlight: singleFlight.getMetrics() };
}

// Solo para los tests.
function reset() {
    driver.reset();
    singleFlight.reset();
    metrics.negativeHits = 0;
    metrics.negativeStores = 0;
}

// Acceso directo al almacen, para el patron "lee muchas claves, agrupa las que
// falten en UNA sola llamada, guarda cada una por separado" — que es como se
// consulta el catalogo de varios assets a la vez (ver outfitService). withCache
// no sirve ahi porque razona sobre una clave y una llamada; aqui hay N claves
// y una llamada. Sigue siendo la misma cache, con las mismas claves.
async function get(cacheKey) {
    const value = await driver.get(cacheKey);
    return isNegative(value) ? undefined : value;
}

async function set(cacheKey, value, ttlMs) {
    return driver.set(cacheKey, value, ttlMs);
}

module.exports = { key, withCache, get, set, getMetrics, reset, __driver: driver };
