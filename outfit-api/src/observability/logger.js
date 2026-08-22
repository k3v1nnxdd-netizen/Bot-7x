'use strict';

const config = require('../config');

// Log estructurado: una linea JSON por evento. Railway (como cualquier
// agregador) indexa esto directamente, asi que filtrar por requestId, ruta o
// codigo de error es trivial sin parsear texto libre.
//
// GARANTIA DE SECRETO (requisito explicito del servicio): `x-api-key` es el
// unico secreto que nos manda el juego y NO PUEDE aparecer jamas en un log.
// Se protege en tres capas independientes:
//   1. Nada en el codigo pasa nunca el objeto `req.headers` completo a esta
//      funcion — los campos se eligen uno a uno (ver requestLogger.js).
//   2. `scrub()` de aqui abajo borra cualquier campo cuyo nombre suene a
//      credencial, por si alguien lo añade en el futuro sin darse cuenta.
//   3. El header nunca se acepta por query string (ver security/apiKey.js),
//      asi que tampoco puede colarse dentro de la URL que si se loguea.
// La capa 2 es la red de seguridad de las otras dos, y src/tests/app.test.js
// la verifica explicitamente.

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const activeLevel = LEVELS[config.logLevel] ?? LEVELS.info;

// Nombres que nunca deben serializarse, en minusculas y sin separadores para
// que `x-api-key`, `xApiKey` y `X_API_KEY` caigan todos en el mismo saco.
// `databaseurl` / `connectionstring` estan aqui por lo mismo: una cadena de
// conexion de Postgres lleva la contraseña dentro. Ningun modulo la loguea
// (src/db/pool.js solo emite host, puerto y nombre de base), pero esta es
// precisamente la capa que existe para cuando alguien lo intente sin querer.
const SENSITIVE = new Set([
    'xapikey', 'apikey', 'authorization', 'cookie', 'token', 'secret', 'password',
    'databaseurl', 'connectionstring', 'dsn',
]);

function isSensitive(key) {
    return SENSITIVE.has(String(key).toLowerCase().replace(/[-_]/g, ''));
}

function scrub(fields) {
    if (!fields || typeof fields !== 'object') return {};
    const out = {};
    for (const [key, value] of Object.entries(fields)) {
        if (isSensitive(key)) {
            out[key] = '[redacted]';
            continue;
        }
        out[key] = value;
    }
    return out;
}

function emit(level, msg, fields) {
    if (LEVELS[level] > activeLevel) return;
    let line;
    try {
        line = JSON.stringify({
            ts: new Date().toISOString(),
            level,
            svc: config.serviceName,
            msg,
            ...scrub(fields),
        });
    } catch {
        // Un campo con referencia circular no puede tumbar una peticion.
        line = JSON.stringify({ ts: new Date().toISOString(), level, svc: config.serviceName, msg, logError: 'unserializable_fields' });
    }
    process.stdout.write(line + '\n');
}

module.exports = {
    error: (msg, fields) => emit('error', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    debug: (msg, fields) => emit('debug', msg, fields),
    isSensitive, // exportado solo para el test que verifica la redaccion
};
