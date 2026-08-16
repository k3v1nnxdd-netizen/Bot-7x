'use strict';

const crypto = require('crypto');
const config = require('../config');

// Unico secreto del servicio, y unico que el juego de Roblox necesita
// enviarnos: el header `x-api-key`. Tres reglas que lo sostienen:
//
//  1. SOLO por header. Nunca se acepta por query string ni por body, aunque
//     seria comodo desde Lua: un secreto en la URL acaba en los logs de
//     acceso de cualquier proxy intermedio, en el Referer y en el historial.
//     Al no leerlo nunca de la query, no puede acabar en un log ni por
//     accidente — y src/observability/requestLogger.js si loguea la URL.
//  2. NUNCA sale. No aparece en ninguna respuesta, ni en el eco de un error
//     de validacion, ni en /v1/metrics. El 401 no dice si la key era erronea
//     o si faltaba: esa distincion solo ayuda a quien esta probando keys.
//  3. NUNCA se loguea. El logger redacta cualquier campo que suene a
//     credencial (src/observability/logger.js) y aqui jamas se pasa el header
//     a ninguna funcion de log.
//
// Si OUTFIT_API_KEY no esta configurada, `config.apiKey` es null y esto
// rechaza a todo el mundo. Falla CERRADO a proposito: un servicio sin secreto
// configurado que dejara pasar seria una API abierta silenciosamente. El
// aviso ruidoso lo da src/config/index.js al arrancar.

// Comparacion en tiempo constante: un `!==` normal corta en el primer byte
// distinto, y ese microscopico salto de tiempo es medible a suficientes
// intentos. timingSafeEqual exige buffers de igual longitud, asi que la
// longitud si se compara antes — es informacion que un atacante puede
// deducir igualmente probando, y no acerca a adivinar el contenido.
function safeEquals(provided, expected) {
    if (typeof provided !== 'string' || typeof expected !== 'string') return false;
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function requireApiKey(req, res, next) {
    if (!safeEquals(req.headers['x-api-key'], config.apiKey)) {
        return res.status(401).json({
            error: { code: 'unauthorized', message: 'Falta o es incorrecta la cabecera x-api-key' },
        });
    }
    next();
}

module.exports = { requireApiKey, safeEquals };
