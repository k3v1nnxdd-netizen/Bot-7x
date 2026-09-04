'use strict';

const config = require('../config');
const { safeEquals } = require('./apiKey');

// Guardia de las rutas /plugin. Modulo aparte de apiKey.js y de adminKey.js
// por la misma razon por la que aquellos dos estan separados entre si: son
// tres secretos que protegen tres cosas distintas y NO deben poder
// confundirse.
//
//   x-api-key    (OUTFIT_API_KEY) -> observabilidad interna (/v1/metrics).
//   x-admin-key  (ADMIN_API_KEY)  -> decidir QUIEN tiene licencia. Solo
//                nosotros.
//   x-plugin-key (PLUGIN_API_KEY) -> buscar outfits desde el plugin privado
//                de Roblox Studio. Vive en un plugin instalado en Studio, que
//                es un sitio distinto del .rbxl que se vende y del panel de
//                administracion.
//
// Cada una en su propia cabecera ademas de en su propia variable: si
// compartieran header, un cliente mal configurado podria mandar la clave de
// admin a la ruta del plugin, y un plugin con la clave equivocada podria
// acabar tocando /admin. Con tres nombres, cada secreto solo se acepta donde
// le corresponde y ninguno abre la puerta de otro. Revocar el plugin —
// cambiar PLUGIN_API_KEY — no le rompe el juego a ningun cliente con
// licencia, y ese es justo el punto.
//
// La comparacion en tiempo constante se reutiliza de apiKey.js: es el mismo
// problema exacto, y duplicarla seria arriesgarse a que una de las copias se
// degrade con el tiempo.
//
// Mismas tres reglas que las otras dos claves: SOLO por cabecera (nunca query
// ni body, para que no acabe en el log de acceso de ningun proxy), NUNCA sale
// en una respuesta, NUNCA se loguea — el logger ademas redacta por nombre
// cualquier campo que suene a credencial.

function requirePluginKey(req, res, next) {
    // Sin clave configurada la ruta no queda "abierta": queda APAGADA. Se
    // distingue del 401 a proposito, igual que en /admin — un 401 haria buscar
    // el fallo en el plugin, cuando lo que falta es una variable de entorno en
    // el servidor. Y falla CERRADO, que es lo unico admisible en una ruta que
    // dispara cientos de llamadas a Roblox por peticion.
    if (!config.pluginApiKey) {
        res.locals.errorCode = 'plugin_disabled';
        return res.status(503).json({
            error: {
                code: 'plugin_disabled',
                message: 'El plugin esta desactivado: falta configurar PLUGIN_API_KEY en el servidor',
            },
        });
    }

    if (!safeEquals(req.headers['x-plugin-key'], config.pluginApiKey)) {
        res.locals.errorCode = 'unauthorized';
        // La respuesta es identica falte la cabecera o sea incorrecta.
        // Distinguirlas solo ayuda a quien esta probando claves.
        return res.status(401).json({
            error: { code: 'unauthorized', message: 'Falta o es incorrecta la cabecera x-plugin-key' },
        });
    }

    next();
}

module.exports = { requirePluginKey };
