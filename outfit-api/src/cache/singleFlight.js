'use strict';

// Deduplicacion de peticiones concurrentes por clave: si mil jugadores piden
// el mismo usuario en el mismo instante y no hay nada en cache, sale UNA
// sola llamada a Roblox y las 999 restantes se cuelgan de esa misma promesa.
//
// Esto es lo que separa "una cache" de "una cache que aguanta miles de
// jugadores": sin single-flight, el momento exacto en que expira una entrada
// popular es una estampida — N peticiones simultaneas ven el mismo miss y
// disparan N llamadas identicas, justo el pico que Roblox castiga con 429.
//
// POR QUE ES UN MODULO APARTE Y NO ESTA FUSIONADO CON LA CACHE: cuando el
// almacen pase a Redis, la cache sera REMOTA y compartida entre instancias,
// pero esta deduplicacion seguira siendo POR PROCESO — una promesa en
// memoria no puede compartirse por red. Son dos ciclos de vida distintos, y
// fusionarlos ahora obligaria a separarlos despues.

const inFlight = new Map(); // key -> Promise

const metrics = {
    started: 0, // vuelos que iniciaron una ejecucion real
    joined: 0,  // llamadas que se engancharon a un vuelo ya en curso
};

// Ejecuta `fn` bajo `key`, o devuelve la promesa en curso si ya hay una.
//
// Quien se engancha comparte tambien el RECHAZO, no solo el resultado: si la
// llamada real falla, todos reciben el mismo error. Es lo correcto — habrian
// fallado igual — y ademas es lo que impide que un fallo de Roblox se
// convierta en N reintentos inmediatos contra el mismo endpoint caido.
function run(key, fn) {
    const existing = inFlight.get(key);
    if (existing) {
        metrics.joined++;
        return existing;
    }

    metrics.started++;
    // La entrada se borra en el `finally` interno, ANTES de que la promesa
    // se resuelva de cara a quien espera: asi la siguiente peticion tras el
    // settle arranca un vuelo nuevo y limpio en vez de reutilizar uno ya
    // terminado. Se guarda la promesa original (no un `.finally()` encadenado)
    // para que todos los enganchados reciban exactamente el mismo valor.
    const promise = (async () => {
        try {
            return await fn();
        } finally {
            inFlight.delete(key);
        }
    })();

    inFlight.set(key, promise);
    return promise;
}

function getMetrics() {
    return { ...metrics, inFlight: inFlight.size };
}

// Solo para los tests.
function reset() {
    inFlight.clear();
    metrics.started = 0;
    metrics.joined = 0;
}

module.exports = { run, getMetrics, reset };
