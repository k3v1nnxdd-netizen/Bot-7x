'use strict';

const { AsyncLocalStorage } = require('async_hooks');

// Contexto de correlacion que viaja con la cadena de promesas, sin pasarlo de
// mano en mano por cada funcion intermedia.
//
// EL PROBLEMA QUE RESUELVE. Cuando Roblox devuelve un 429, quien se entera es
// el limitador (src/roblox/rateLimiter.js), que es deliberadamente generico: no
// sabe quien le pidio la llamada ni por que. Para cruzar ese 429 con la
// busqueda que lo provoco hace falta el requestId, y el camino entre los dos es
// largo: ruta -> pluginSearchService -> catalogIndex -> catalogService ->
// roblox/client -> rateLimiter. Enhebrar un parametro por esas seis capas
// ensuciaria firmas que hoy estan limpias, y ademas obligaria a tocar el camino
// que comparten /v1/outfits y /v1/catalog.
//
// AsyncLocalStorage lo lleva por debajo: se abre el contexto una vez en el
// borde de la busqueda y cualquier codigo que corra dentro de esa cadena
// asincrona puede leerlo, incluido el limitador, sin que las capas de en medio
// se enteren de que existe.
//
// NO ES UN CANAL DE DATOS DE NEGOCIO. Aqui solo entra lo que sirve para
// CORRELACIONAR lineas de log: hoy, el requestId. Nunca credenciales, nunca
// datos de usuario, nunca nada de lo que decida una respuesta — un valor que
// viaja invisible es exactamente el sitio donde no debe vivir la logica.
const almacen = new AsyncLocalStorage();

// Ejecuta `fn` con `contexto` disponible para toda su cadena asincrona.
function ejecutarCon(contexto, fn) {
    return almacen.run(contexto, fn);
}

// El contexto activo, o null si no hay ninguno. Devolver null y no lanzar es
// deliberado: el limitador lo llaman tambien caminos que no abren contexto
// (las rutas del juego), y quedarse sin requestId es una perdida de detalle en
// un log, jamas un motivo para romper una peticion.
function actual() {
    return almacen.getStore() ?? null;
}

// Atajo para el unico campo que se usa hoy.
function requestId() {
    return almacen.getStore()?.requestId ?? null;
}

module.exports = { ejecutarCon, actual, requestId };
