'use strict';

const express = require('express');
const healthRoute = require('./routes/health');
const avatarRoute = require('./routes/avatar');
const battleRoute = require('./routes/battle');
const { requireApiKey } = require('./middleware/auth');

// `client` is accepted (and stashed on `app.locals`) so future routes that
// need to act on the Discord bot (e.g. award a role after a Roblox purchase)
// can reach it via `req.app.locals.discordClient` without re-plumbing this.
function startServer(client) {
    const app = express();
    app.use(express.json());
    app.locals.discordClient = client;

    // Fail loudly (but don't crash the process) if the shared API key isn't
    // configured — without this, /avatar and /battle would silently 401
    // every single request and the cause wouldn't be obvious from outside.
    // Set API_KEY in .env locally, or in Railway's Variables tab in prod.
    if (!process.env.API_KEY) {
        console.error('[api] ERROR: falta configurar la variable de entorno API_KEY. Las rutas /avatar y /battle rechazarán todas las peticiones (401) hasta que la definas.');
    }

    // /health stays PUBLIC — Railway's healthcheck pings this with no
    // headers, so it must never require a key or the deploy would look dead.
    app.use('/health', healthRoute);

    // /avatar y /battle exigen un header `x-api-key` válido antes de llegar
    // a la ruta real — requireApiKey corta la petición con 401 si falta o
    // no coincide con process.env.API_KEY.
    app.use('/avatar', requireApiKey, avatarRoute);
    app.use('/battle', requireApiKey, battleRoute);

    const port = process.env.PORT || 3000;
    const server = app.listen(port, () => {
        console.log(`[api] Servidor Express escuchando en el puerto ${port}`);
    });

    return { app, server };
}

module.exports = { startServer };
