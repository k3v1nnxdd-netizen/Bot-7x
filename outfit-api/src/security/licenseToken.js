'use strict';

const crypto = require('crypto');
const { safeEquals } = require('./apiKey');

// La credencial POR LICENCIA: un token que identifica a UN grupo concreto y
// que vive dentro del juego de ese cliente. Es el TERCER secreto del sistema y
// no se parece a los otros dos, asi que conviene tener presente en que se
// diferencian:
//
//   x-api-key   (OUTFIT_API_KEY) -> "eres un cliente nuestro". La misma para
//               todos. Abre /v1.
//   x-admin-key (ADMIN_API_KEY)  -> "puedes decidir quien tiene licencia".
//               Solo nosotros. Abre /admin. JAMAS se usa en /v1/license/verify.
//   token       (este)           -> "soy el grupo 35216530". Uno por licencia,
//               y por eso es el unico que puede identificar a un cliente.
//
// LA REGLA QUE MANDA EN ESTE ARCHIVO: el token en claro existe UNA sola vez,
// en la respuesta del alta, y no se guarda en ningun sitio — ni en la base, ni
// en un log, ni en una variable que sobreviva a la peticion. Lo que se
// almacena es su SHA-256, y contra ese hash se busca despues.
//
// Por que un hash y no el token tal cual: si alguien consigue leer la tabla
// (una copia de seguridad mal guardada, un volcado en un ticket, un SELECT de
// mas), con los hashes no puede suplantar a ningun cliente. Con los tokens en
// claro, tendria la credencial de todos.
//
// Por que SHA-256 a secas y NO bcrypt/argon2, que es lo correcto para
// contraseñas: una contraseña la elige una persona y tiene poquisima entropia,
// asi que hay que encarecer cada intento a proposito. Esto son 256 bits
// ALEATORIOS: no hay diccionario que probar ni fuerza bruta que valga, y en
// cambio esta ruta se llama desde el juego en caliente. Un hash lento aqui
// solo compraria latencia.

// 32 bytes = 256 bits de entropia real, de la fuente criptografica del
// sistema. base64url en vez de hex porque cabe en 43 caracteres en vez de 64 y
// no lleva ningun caracter que se estropee al pegarlo en un script de Roblox,
// en una URL o en un JSON.
const TOKEN_BYTES = 32;

// Prefijo visible. No aporta seguridad: sirve para que un token pegado en el
// campo equivocado se reconozca de un vistazo, y para que un buscador de
// secretos pueda encontrarlo si alguien lo sube a un repositorio por error.
const TOKEN_PREFIX = '7xl_';

// Forma que puede tener un token. Se valida ANTES de tocar la base para no
// gastar una consulta con basura evidente, pero OJO: un token con forma
// invalida responde exactamente igual que uno desconocido (token_invalido).
// Distinguirlos solo ayudaria a quien esta probando tokens.
const TOKEN_PATTERN = /^7xl_[A-Za-z0-9_-]{43}$/;

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function generateToken() {
    return TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

// SHA-256 en hex. Determinista a proposito: es lo que permite BUSCAR por hash
// con una consulta parametrizada por clave unica, en vez de tener que leer
// todas las filas y comparar una a una como obligaria un hash con sal.
function hashToken(token) {
    if (typeof token !== 'string' || token === '') return null;
    return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function looksLikeToken(token) {
    return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

// Comparacion en tiempo constante del hash calculado contra el guardado.
//
// Es DELIBERADAMENTE redundante con el `WHERE license_token_hash = $1` que ya
// hizo la consulta, y no sobra: esa igualdad la resuelve Postgres, con su
// indice y sus optimizaciones, y no es una comparacion pensada para resistir
// medicion de tiempos. Esta ultima confirmacion la hace este proceso, en
// tiempo constante, sobre el hash completo. Reutiliza safeEquals de apiKey.js
// — es exactamente el mismo problema, y tener dos copias solo serviria para
// que una de las dos se degrade con el tiempo.
function matchesHash(token, storedHash) {
    if (typeof storedHash !== 'string' || !HASH_PATTERN.test(storedHash)) return false;
    const calculado = hashToken(token);
    if (calculado === null) return false;
    return safeEquals(calculado, storedHash);
}

module.exports = {
    generateToken,
    hashToken,
    looksLikeToken,
    matchesHash,
    TOKEN_PREFIX,
    TOKEN_PATTERN,
};
