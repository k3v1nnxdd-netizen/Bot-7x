'use strict';

const express = require('express');
const healthRoute = require('./api/routes/health');
const usersRoute = require('./api/routes/users');
const outfitsRoute = require('./api/routes/outfits');
const metricsRoute = require('./api/routes/metrics');
const { requireApiKey } = require('./security/apiKey');
const { rateLimit } = require('./security/rateLimit');
const { requestLogger } = require('./observability/requestLogger');
const { latencyMiddleware } = require('./observability/metrics');
const { errorHandler, notFoundHandler } = require('./api/errorHandler');

// Construye la app y la DEVUELVE sin llamar a listen(): asi los tests pueden
// levantarla en un puerto efimero sin tocar server.js, y server.js se queda
// con la unica responsabilidad de gestionar el ciclo de vida del proceso.
function createApp() {
    const app = express();

    // La cabecera X-Powered-By anuncia gratis que hay un Express detras.
    app.disable('x-powered-by');

    // Railway (como cualquier PaaS) termina el TLS y reenvia por un edge. Sin
    // `trust proxy`, req.ip seria la direccion del PROXY en todas y cada una
    // de las peticiones, y el limitador por IP colapsaria a todo el mundo en
    // un unico cubo — es decir, dejaria de limitar.
    app.set('trust proxy', true);

    // NO hay parser de body, ni JSON ni de ningun tipo, y es intencional:
    // esta API es enteramente de lectura y todos sus endpoints son GET. No
    // añadir un parser elimina de raiz toda una familia de problemas (bodies
    // gigantes, JSON malformado, content-type inesperado) en vez de tener que
    // acotarla con limites y manejadores de error.

    // /health va PRIMERO, deliberadamente por delante del logger, del
    // limitador y de la API key: Railway lo consulta sin cabeceras y no puede
    // parecer caido por un limite ajeno ni inundar el log de lineas inutiles.
    app.use('/health', healthRoute);

    app.use(requestLogger);

    // Orden del resto: guardia de abuso barato primero (rechaza una avalancha
    // antes de gastar nada), luego la API key, luego la instrumentacion de
    // latencia — que asi mide trabajo real y no rechazos instantaneos que
    // falsearian los percentiles a la baja.
    const v1 = express.Router();
    v1.use('/users', usersRoute);
    v1.use('/outfits', outfitsRoute);
    v1.use('/metrics', metricsRoute);

    app.use('/v1', rateLimit, requireApiKey, latencyMiddleware, v1);

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}

module.exports = { createApp };
