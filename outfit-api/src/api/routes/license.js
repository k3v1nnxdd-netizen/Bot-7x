'use strict';

const express = require('express');
const router = express.Router();
const licenseService = require('../../services/licenseService');
const logger = require('../../observability/logger');
const { parseLicenseVerifyBody } = require('../../validation/params');

// Verificacion de licencia para el JUEGO. Cuelga de /v1, con el resto de lo
// que consume Roblox, y por tanto detras de `x-api-key` y del limitador por
// IP que ya protegen esa rama (ver src/app.js).
//
// ADMIN_API_KEY NO PINTA NADA AQUI, y es una separacion que hay que sostener a
// conciencia: `x-admin-key` decide QUIEN tiene licencia y solo la conocemos
// nosotros. Si esta ruta la aceptara, la clave que gobierna el negocio tendria
// que viajar dentro de un script distribuido a servidores de Roblox que no
// controlamos. Lo que el juego presenta aqui es su PROPIO token de licencia,
// que solo le sirve a el y que se puede revocar sin tocar nada mas.
//
// Tres secretos, tres alcances, y ninguno abre la puerta del otro:
//   x-api-key   -> "eres cliente nuestro"        (la misma para todos)
//   token       -> "soy el grupo 35216530"       (uno por licencia)
//   x-admin-key -> "puedes dar y quitar licencias" (solo /admin)

// Parser de cuerpo montado SOLO en este router, igual que hace
// /admin/groups. La API de outfits sigue sin parser a nivel de app: es de solo
// lectura y no tener uno le quita de encima una familia entera de problemas.
// 2kb sobran para cinco campos, y el limite convierte un cuerpo desmedido en
// un 413 barato en vez de en memoria ocupada.
router.use(express.json({ limit: '2kb' }));

// POST /v1/license/verify
//   body: { token, creatorType, creatorId, gameId, placeId }
//
// DOS FORMAS DE RESPUESTA, y la distincion es deliberada:
//
//   200 { ok: true,  groupId }   -> autorizado.
//   403 { ok: false, motivo }    -> denegado, con el motivo exacto.
//   400 { error: {...} }         -> la peticion esta mal formada (falta un
//                                   campo, un id que no es numero). Es un bug
//                                   del script que llama, no una denegacion.
//
// Un 403 NO es un error: es la respuesta correcta a una pregunta bien hecha,
// asi que se devuelve aqui directamente y no lanzando al error handler central
// (que impone el formato {error:{code,message}} del resto de la API). El
// juego hace `if respuesta.ok then` y, si no, muestra `motivo`.
router.post('/verify', async (req, res) => {
    res.locals.routeLabel = 'POST /v1/license/verify';

    const datos = parseLicenseVerifyBody(req.body);
    const resultado = await licenseService.verify(datos);

    // ¿El juego declaro un dueño distinto del que dice Roblox? No cambia la
    // decision — la decision ya se tomo con los datos reales —, pero es la
    // firma de un .rbxl manipulado y merece verse en el log.
    const declaracionFalsa = licenseService.detectarDeclaracionFalsa(datos, resultado.propiedadReal);

    // Rastro de auditoria: quien verifico, desde que juego y con que resultado.
    // EL TOKEN NO SE REGISTRA NUNCA — ni entero, ni en trozos, ni su hash.
    const traza = {
        ok: resultado.ok,
        motivo: resultado.motivo ?? null,
        groupId: resultado.groupId ?? null,
        gameId: datos.gameId,
        placeId: datos.placeId,

        // Lo que Roblox dice (real) frente a lo que el juego dijo (declarado).
        // Verlos juntos es lo que convierte el log en algo util cuando alguien
        // reclama: se ve de un vistazo si el script mentia.
        universoReal: resultado.propiedadReal?.universeId ?? null,
        dueñoRealTipo: resultado.propiedadReal?.creatorType ?? null,
        dueñoRealId: resultado.propiedadReal?.creatorId ?? null,
        creatorTypeDeclarado: datos.creatorType,
        creatorIdDeclarado: datos.creatorId,
    };

    if (declaracionFalsa) {
        logger.warn('Verificacion de licencia con declaracion falsa del cliente', traza);
    } else {
        logger.info('Verificacion de licencia', traza);
    }

    if (!resultado.ok) {
        res.locals.errorCode = resultado.motivo; // lo recoge el requestLogger
        return res.status(403).json({ ok: false, motivo: resultado.motivo });
    }

    return res.json({ ok: true, groupId: resultado.groupId });
});

module.exports = router;
