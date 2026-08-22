'use strict';

const express = require('express');
const healthRoute = require('./api/routes/health');
const usersRoute = require('./api/routes/users');
const outfitsRoute = require('./api/routes/outfits');
const metricsRoute = require('./api/routes/metrics');
const adminGroupsRoute = require('./api/routes/adminGroups');
const licenseRoute = require('./api/routes/license');
const catalogRoute = require('./api/routes/catalog');
const { requireApiKey } = require('./security/apiKey');
const { requireAdminKey } = require('./security/adminKey');
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

    // NO hay parser de body A NIVEL DE APP, y sigue siendo intencional: los
    // endpoints de outfits son todos GET, y no añadir un parser ahi elimina de
    // raiz toda una familia de problemas (bodies gigantes, JSON malformado,
    // content-type inesperado) en vez de tener que acotarla con limites y
    // manejadores de error.
    //
    // Los DOS unicos que necesitan cuerpo montan el suyo DENTRO de su propio
    // router, con su propio limite: POST /admin/groups (4kb) y POST
    // /v1/license/verify (2kb). Asi cada uno paga solo el coste de lo que usa
    // y las rutas de outfits no ganan superficie por que existan.

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

    // Verificacion de licencia del juego. Va en /v1 y NO en /admin porque el
    // secreto que presenta es el token de la propia licencia, no la clave de
    // administracion: `x-admin-key` gobierna quien tiene licencia y no puede
    // acabar dentro de un script distribuido a servidores de Roblox.
    v1.use('/license', licenseRoute);

    // Inteligencia de catalogo. Ademas de la x-api-key de /v1 exige el TOKEN de
    // licencia (ver src/security/licenseGuard.js): la key del juego viaja
    // dentro del .rbxl que se vende, asi que por si sola no puede abrir lo que
    // precisamente se ha sacado del .rbxl para protegerlo.
    v1.use('/catalog', catalogRoute);

    app.use('/v1', rateLimit, requireApiKey, latencyMiddleware, v1);

    // Administracion de licencias. Fuera de /v1 y con OTRO secreto
    // (`x-admin-key`), de modo que la key que vive dentro del juego de Roblox
    // no abre estas rutas ni aunque se filtre — y la de admin tampoco sirve
    // para leer outfits.
    //
    // Comparte el limitador por IP con /v1: es el mismo guardia anti-abuso, y
    // aqui ademas frena de paso cualquier intento de probar claves a lo bruto.
    // NO pasa por latencyMiddleware: esas metricas describen el trafico que
    // atiende al juego, y mezclarles unas pocas llamadas administrativas
    // ensuciaria los percentiles que sirven para vigilar la carga real.
    app.use('/admin/groups', rateLimit, requireAdminKey, adminGroupsRoute);

    app.use(notFoundHandler);
    app.use(errorHandler);

    return app;
}

module.exports = { createApp };
