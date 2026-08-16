'use strict';

const express = require('express');
const router = express.Router();

// PUBLICO: sin API key, sin rate limit, sin log por peticion (Railway lo
// consulta constantemente y ahogaria el log util), y sin una sola llamada a
// Roblox.
//
// Responde por "el proceso esta vivo y atendiendo HTTP", NADA MAS. Es
// deliberado: si este healthcheck dependiera del estado de Roblox, un mal
// rato de Roblox haria que Railway diera el contenedor por muerto y lo
// reiniciara en bucle — justo cuando la cache caliente en memoria es lo
// unico que esta salvando la situacion. Para saber como esta Roblox esta
// GET /v1/metrics, que si expone el estado de los circuitos.
router.get('/', (req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

module.exports = router;
