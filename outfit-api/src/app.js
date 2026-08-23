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
const { requireLicenseTokenHeader, requireLicensedGame } = require('./security/licenseGuard');
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

    // ── Rutas gobernadas por la LICENCIA ─────────────────────────────────────
    //
    // SIN `x-api-key`. La credencial del juego aqui es UNA sola: el token de
    // licencia, unico por grupo y revocable de uno en uno.
    //
    // Quitar la key compartida no afloja nada, al reves. `OUTFIT_API_KEY` es la
    // misma para todos los clientes y vive dentro del .rbxl que se vende: la
    // tiene cualquiera que compre el sistema y cualquiera que le robe una
    // copia. Exigirla ADEMAS del token solo añadia un secreto que no
    // identifica a nadie y que no se puede revocar sin romperle el juego a
    // todos los clientes a la vez. Lo que decide sigue siendo lo mismo de
    // siempre: token -> licencia activa -> propiedad real del juego.
    //
    // ORDEN: estos dos montajes van ANTES del de /v1 a proposito. Express
    // recorre las capas en orden, asi que si el general fuera primero, su
    // `requireApiKey` respondaria 401 antes de que la peticion llegara aqui.
    //
    // `requireLicenseTokenHeader` va antes del parser de cuerpo (que se monta
    // dentro de cada router): una peticion sin la cabecera se rechaza sin leer
    // ni un byte del body, sin tocar la base y sin llamar a Roblox.
    //
    // `notFoundHandler` cierra cada prefijo. Sin el, un `/v1/license/loquesea`
    // no encontraria ruta aqui, caeria al montaje general de /v1 y acabaria
    // respondiendo 401 por falta de api key en vez del 404 que corresponde.
    app.use('/v1/license', rateLimit, requireLicenseTokenHeader, latencyMiddleware, licenseRoute, notFoundHandler);
    app.use('/v1/catalog', rateLimit, requireLicenseTokenHeader, latencyMiddleware, catalogRoute, notFoundHandler);

    // Rutas de DATOS que consume el juego. Tambien con el token de licencia y
    // nada mas: el comprador configura UN solo Secret en su experiencia
    // (`OutfitLicenseToken`) y con el llama a todo lo que necesita.
    //
    // `requireLicensedGame` exige la CADENA ENTERA, la misma que
    // /v1/license/verify: token -> licencia -> activa -> propiedad real del
    // juego contra Roblox -> ese dueño es un grupo -> es el grupo de la
    // licencia. Los dos ids que hacen falta para preguntarselo a Roblox
    // (`x-game-id`, `x-place-id`) viajan por cabecera, porque estas rutas son
    // GET y no tienen cuerpo.
    //
    // Que aqui se compruebe lo mismo que en /verify no es redundancia: sin
    // ello, el token de un cliente abriria estas rutas desde CUALQUIER
    // experiencia de Roblox, y la licencia dejaria de estar atada al juego que
    // se pago. Verificar al arrancar el servidor no sirve de nada si cada
    // lectura posterior se conforma con menos.
    app.use('/v1/users', rateLimit, requireLicenseTokenHeader, requireLicensedGame,
        latencyMiddleware, usersRoute, notFoundHandler);
    app.use('/v1/outfits', rateLimit, requireLicenseTokenHeader, requireLicensedGame,
        latencyMiddleware, outfitsRoute, notFoundHandler);

    // ── Lo unico que queda con la clave compartida ───────────────────────────
    //
    // /v1/metrics es observabilidad NUESTRA: el juego no la consume y no tiene
    // por que poder consultarla. Migrarla a licencia significaria que cualquier
    // cliente puede ver los percentiles, el estado del breaker y los contadores
    // de la base — asi que se queda con `x-api-key`, que es una clave que solo
    // manejamos nosotros y quien opere el servicio.
    const v1 = express.Router();
    v1.use('/metrics', metricsRoute);

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
