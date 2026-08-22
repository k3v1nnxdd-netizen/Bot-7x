'use strict';

const config = require('../config');

// Driver de cache en memoria: TTL por entrada + tope LRU + barrido periodico.
// Sin disco, sin Volume, sin persistencia — todo se pierde al reiniciar, que
// es exactamente lo pedido: estos datos se re-piden a Roblox y se vuelven a
// llenar solos en segundos.
//
// La interfaz es ASINCRONA aunque un Map responda al instante. No es adorno:
// es lo que permite que enchufar Redis mañana sea añadir un driver hermano
// sin tocar una sola linea de los servicios que la consumen. Ver cacheStore.js.
//
// El LRU se apoya en una propiedad del Map de JS: preserva el orden de
// insercion. Al leer una entrada se borra y se reinserta, con lo que pasa al
// final; la mas antigua es siempre la primera que devuelve el iterador. Da un
// LRU real en O(1) sin lista enlazada ni dependencias.

// El tope se lee EN CADA expulsion, no se captura al cargar el modulo. La
// diferencia importa: capturado en una `const`, el valor queda fijado por el
// orden de los `require` y deja de poder ajustarse sin reiniciar el proceso —
// que es justo lo que hace falta poder hacer en los tests, donde una suite
// necesita un tope minusculo para provocar expulsiones y otra necesita sitio
// para trabajar. Leerlo aqui no cuesta nada (es una propiedad de un objeto ya
// cargado) y en produccion se comporta exactamente igual.
const maxEntries = () => config.cache.maxEntries;
const SWEEP_INTERVAL_MS = 60_000;

const store = new Map(); // key -> { value, expiresAt }

const metrics = {
    hits: 0,
    misses: 0,
    sets: 0,
    evictions: 0, // expulsadas por tope LRU
    expired: 0,   // encontradas caducadas (en lectura o en barrido)
};

async function get(key) {
    const entry = store.get(key);
    if (entry === undefined) {
        metrics.misses++;
        return undefined;
    }

    if (Date.now() > entry.expiresAt) {
        store.delete(key);
        metrics.expired++;
        metrics.misses++;
        return undefined;
    }

    // Marca como recien usada: borrar + reinsertar la manda al final del
    // orden de insercion, que es lo que la salva de la proxima expulsion.
    store.delete(key);
    store.set(key, entry);

    metrics.hits++;
    return entry.value;
}

async function set(key, value, ttlMs) {
    // Reinsertar tambien renueva la posicion LRU, no solo el TTL.
    if (store.has(key)) store.delete(key);
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
    metrics.sets++;

    // Tope duro de memoria. Se expulsa en bucle (y no una sola entrada) por
    // si el tope se bajara en caliente por configuracion.
    while (store.size > maxEntries()) {
        const oldestKey = store.keys().next().value;
        if (oldestKey === undefined) break;
        store.delete(oldestKey);
        metrics.evictions++;
    }
}

async function del(key) {
    store.delete(key);
}

// Barrido periodico: sin el, una entrada que nadie vuelve a consultar jamas
// se quedaria ocupando memoria hasta que el LRU la empujara. `unref()` para
// que este temporizador no mantenga vivo el proceso durante un apagado.
const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
        if (now > entry.expiresAt) {
            store.delete(key);
            metrics.expired++;
        }
    }
}, SWEEP_INTERVAL_MS);
sweepTimer.unref();

function getMetrics() {
    const lookups = metrics.hits + metrics.misses;
    return {
        driver: 'memory',
        entries: store.size,
        maxEntries: maxEntries(),
        ...metrics,
        hitRate: lookups === 0 ? null : +(metrics.hits / lookups).toFixed(4),
    };
}

// Solo para los tests.
function reset() {
    store.clear();
    for (const key of Object.keys(metrics)) metrics[key] = 0;
}

module.exports = { get, set, del, getMetrics, reset };
