'use strict';

const express = require('express');
const healthRoute = require('./routes/health');
const avatarRoute = require('./routes/avatar');
const battleRoute = require('./routes/battle');

// `client` is accepted (and stashed on `app.locals`) so future routes that
// need to act on the Discord bot (e.g. award a role after a Roblox purchase)
// can reach it via `req.app.locals.discordClient` without re-plumbing this.
function startServer(client) {
    const app = express();
    app.use(express.json());
    app.locals.discordClient = client;

    app.use('/health', healthRoute);
    app.use('/avatar', avatarRoute);
    app.use('/battle', battleRoute);

    const port = process.env.PORT || 3000;
    const server = app.listen(port, () => {
        console.log(`[api] Servidor Express escuchando en el puerto ${port}`);
    });

    return { app, server };
}

module.exports = { startServer };
