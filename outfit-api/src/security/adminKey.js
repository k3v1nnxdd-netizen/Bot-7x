'use strict';

const config = require('../config');
const { safeEquals } = require('./apiKey');

// Guardia de las rutas /admin. Es un modulo aparte de apiKey.js porque los dos
// secretos protegen cosas distintas y NO deben poder confundirse:
//
//   x-api-key   (OUTFIT_API_KEY) -> leer outfits. La conoce el juego de
//               Roblox, o sea que vive en un script distribuido a servidores
//               que no controlamos. Hay que asumirla filtrable.
//   x-admin-key (ADMIN_API_KEY)  -> decidir QUIEN esta autorizado. Solo la
//               conocemos nosotros.
//
// Por eso van en cabeceras distintas ademas de en variables distintas: si
// compartieran header, un cliente administrativo mal configurado podria
// mandar la key de admin a un endpoint del juego, y un juego con la key
// equivocada podria acabar tocando /admin. Con dos nombres, cada secreto solo
// se acepta donde le corresponde y ninguno abre la puerta del otro.
//
// La comparacion en tiempo constante se reutiliza de apiKey.js — es
// exactamente el mismo problema, y duplicarla seria arriesgarse a que una de
// las dos copias se degrade con el tiempo.
//
// Mismas tres reglas que la key del juego: SOLO por cabecera (nunca query ni
// body, para que no acabe en el log de acceso de ningun proxy), NUNCA sale en
// una respuesta, NUNCA se loguea.

function requireAdminKey(req, res, next) {
    // Sin clave configurada, la administracion no esta "abierta": esta
    // APAGADA. Se distingue del 401 a proposito — un 401 haria pensar que la
    // clave enviada es incorrecta y llevaria a buscar el fallo en el cliente,
    // cuando lo que falta es una variable de entorno en el servidor. No
    // revela nada util a un atacante: en ambos casos no se pasa.
    if (!config.adminApiKey) {
        res.locals.errorCode = 'admin_disabled';
        return res.status(503).json({
            error: {
                code: 'admin_disabled',
                message: 'La administracion esta desactivada: falta configurar ADMIN_API_KEY en el servidor',
            },
        });
    }

    if (!safeEquals(req.headers['x-admin-key'], config.adminApiKey)) {
        res.locals.errorCode = 'unauthorized';
        // Igual que en /v1: la respuesta es identica falte la cabecera o sea
        // incorrecta. Distinguirlas solo ayuda a quien esta probando claves.
        return res.status(401).json({
            error: { code: 'unauthorized', message: 'Falta o es incorrecta la cabecera x-admin-key' },
        });
    }

    next();
}

module.exports = { requireAdminKey };
