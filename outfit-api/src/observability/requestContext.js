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
// NO ES UN CANAL DE DATOS DE NEGOCIO. Aqui solo entran los identificadores que
// sirven para CORRELACIONAR lineas de log: el requestId y el searchId. Nunca
// credenciales, nunca datos de usuario, nunca nada de lo que decida una
// respuesta — un valor que viaja invisible es exactamente el sitio donde no
// debe vivir la logica.
//
// POR QUE HACEN FALTA LOS DOS. El requestId identifica la peticion HTTP que
// arranco la busqueda; el searchId es lo que el plugin tiene delante y lo unico
// por lo que se puede preguntar despues. En modo asincrono la peticion HTTP
// termina en milisegundos y la busqueda sigue durante minutos, asi que TODO lo
// que se registre a partir de ahi — un 429 del avatar, un fallo de Postgres —
// solo se puede cruzar con lo que ve el usuario a traves del searchId.
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

// Atajos para los dos campos que se usan hoy. Devuelven null fuera de contexto
// por el mismo motivo que `actual`: perder detalle en un log jamas puede ser
// motivo para romper una peticion.
function requestId() {
    return almacen.getStore()?.requestId ?? null;
}

function searchId() {
    return almacen.getStore()?.searchId ?? null;
}

// El grupo que recorre la busqueda. Es un identificador de comunidad, no de
// persona, y es lo que permite que un fallo de Postgres diga "en la rotacion
// del grupo X" sin que nadie tenga que cruzarlo a mano con el searchId.
function groupId() {
    return almacen.getStore()?.groupId ?? null;
}

// Acumulador de tiempos de la peticion en curso, o null si no hay ninguno.
//
// POR QUE VIVE EN EL CONTEXTO Y NO SE PASA POR PARAMETRO. Para saber cuanto se
// va en esperar al limitador y cuanto en Roblox hace falta medir DENTRO del
// limitador, que esta cuatro capas por debajo de la ruta (ruta -> servicio ->
// cliente -> limitador). Enhebrar un objeto de medicion por esas cuatro capas
// ensuciaria firmas que hoy estan limpias y que comparten todas las rutas.
//
// El limitador suma aqui si hay acumulador; si no lo hay —el caso de casi todo
// el trafico— no hace nada y no cuesta nada. Es opcional por diseño: ninguna
// ruta esta obligada a medirse.
function medidor() {
    return almacen.getStore()?.medidor ?? null;
}

// Crea un acumulador vacio. Los milisegundos son SUMAS sobre todas las llamadas
// salientes de la peticion, no maximos: con concurrencia, la suma puede superar
// la duracion real de la peticion, y eso es lo que se quiere saber (cuanto
// trabajo hubo), no cuanto reloj paso.
function nuevoMedidor() {
    return { esperaLimitadorMs: 0, robloxMs: 0, llamadasUpstream: 0 };
}

module.exports = { ejecutarCon, actual, requestId, searchId, groupId, medidor, nuevoMedidor };
