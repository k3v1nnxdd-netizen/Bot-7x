'use strict';

const licenseService = require('../services/licenseService');
const logger = require('../observability/logger');
const {
    parseLicenseVerifyBody, parseLicenseTokenHeader, parseLicenseContextHeaders,
} = require('../validation/params');

// Guardia de licencia para rutas de /v1 que NO deben abrirse solo con la
// `x-api-key`.
//
// POR QUE HACE FALTA, y no es paranoia: `x-api-key` viaja dentro del .rbxl que
// se vende. Todo el que compre el sistema la tiene, y todo el que le robe una
// copia tambien. Sirve para decir "esto viene de un juego que usa el sistema",
// no para decir "este juego ha pagado". Para lo segundo esta el token de
// licencia, que es unico por grupo y revocable de uno en uno.
//
// La inteligencia de catalogo (/v1/catalog/batch) es justamente lo que se
// mueve aqui para que no viaje dentro del .rbxl. Dejarla detras de una clave
// que si viaja dentro del .rbxl seria mover el problema, no resolverlo.
//
// NO HAY NI UNA LINEA DE LOGICA DE AUTORIZACION EN ESTE ARCHIVO. Se valida la
// FORMA de lo que llega y se llama al MISMO licenseService.verify: la cadena
// (token -> licencia -> activa -> propiedad real del juego contra Roblox) vive
// en un solo sitio y aqui solo se consume. Si mañana cambia esa cadena, cambia
// para TODAS las rutas a la vez, que es justo lo que evita que una de ellas se
// quede atras comprobando de menos.
//
// Coste: una consulta a Postgres por clave unica + la propiedad del juego, que
// sale de la cache de 6 h (src/services/gameOwnershipService.js). Abrir un
// outfit no vuelve a preguntarle a Roblox de quien es la experiencia.
//
// La consulta del token NO se cachea a proposito, aunque seria facil: es local
// y de una fila, y cachearla significaria que un /deletegroup tarda en surtir
// efecto. Que una licencia retirada deje de funcionar EN LA SIGUIENTE peticion
// vale mas que ahorrarse un milisegundo.

// PRIMERA PUERTA, y va montada ANTES del parser de cuerpo (ver src/app.js).
//
// Solo comprueba que la cabecera esta y tiene una forma razonable. Eso basta
// para que una peticion sin credencial se rechace sin leer un solo byte del
// cuerpo, sin abrir una conexion a Postgres y sin llamar a Roblox — que es
// justo el trabajo caro que no debe gastarse en quien no presenta nada.
//
// Lo que NO hace es decidir si el token vale: un token con forma correcta pero
// desconocido tiene que acabar en 403 token_invalido, indistinguible de uno mal
// formado, y esa decision vive entera en licenseService.
function requireLicenseTokenHeader(req, res, next) {
    // Lanza ValidationError (400) si falta o llega repetida. Express 5 propaga
    // el throw sincrono al error handler central.
    res.locals.licenseToken = parseLicenseTokenHeader(req.headers);
    next();
}

// Rastro de auditoria de una DENEGACION, con el mismo contenido que deja
// /v1/license/verify y por el mismo motivo: cuando un cliente reclama, lo que
// resuelve la discusion es ver juntos lo que Roblox dice y lo que el juego
// decia. Sin eso, un `grupo_no_coincide` en el log no distingue al comprador
// que copio mal su placeId de alguien usando un token robado.
//
// EL TOKEN NO SE REGISTRA NUNCA — ni entero, ni en trozos, ni su hash. Lo que
// identifica a la licencia en el log es el grupo, que no es un secreto.
//
// Solo se registran las denegaciones. Una peticion concedida ya deja su linea
// en requestLogger, y estas rutas las llama el juego constantemente: un log
// por acierto seria ruido a razon de miles por minuto.
function registrarDenegacion(req, datos, resultado) {
    const traza = {
        requestId: req.requestId,
        path: req.originalUrl,
        motivo: resultado.motivo,
        gameId: datos.gameId,
        placeId: datos.placeId,

        // Lo que Roblox dice (real) frente a lo que el juego dijo (declarado).
        // Verlos juntos es lo que convierte el log en algo util: se ve de un
        // vistazo si el script mentia.
        universoReal: resultado.propiedadReal?.universeId ?? null,
        duenoRealTipo: resultado.propiedadReal?.creatorType ?? null,
        duenoRealId: resultado.propiedadReal?.creatorId ?? null,
        creatorTypeDeclarado: datos.creatorType,
        creatorIdDeclarado: datos.creatorId,
    };

    if (licenseService.detectarDeclaracionFalsa(datos, resultado.propiedadReal)) {
        // El script declaro un dueño distinto del que dice Roblox. No cambia la
        // decision — ya se tomo con los datos reales —, pero es la firma exacta
        // de un .rbxl editado y merece verse aparte.
        return logger.warn('Acceso denegado con declaracion falsa del cliente', traza);
    }
    return logger.warn('Acceso denegado a una ruta con licencia', traza);
}

// Traduccion HTTP comun a las dos puertas. La forma de la denegacion es la
// MISMA que la de /v1/license/verify — 403 con { ok: false, motivo } — porque
// el juego ya sabe leerla y no tiene por que aprender una segunda.
//
// Un 403 aqui NO es un error: es la respuesta correcta a una pregunta bien
// hecha, asi que se responde en el sitio y no lanzando al error handler
// central, que impone el formato {error:{code,message}} del resto de la API.
function denegar(req, res, datos, resultado) {
    res.locals.errorCode = resultado.motivo; // lo recoge el requestLogger
    registrarDenegacion(req, datos, resultado);
    return res.status(403).json({ ok: false, motivo: resultado.motivo });
}

// Para el log de la peticion y para que el handler no tenga que repetir la
// verificacion si necesita saber de quien es el juego.
function anotarLicencia(res, datos, resultado) {
    res.locals.license = {
        groupId: resultado.groupId,
        universeId: resultado.propiedadReal?.universeId ?? null,
        gameId: datos.gameId,
        placeId: datos.placeId,
    };
}

// Guardia de las rutas de DATOS que consume el juego: /v1/users y /v1/outfits.
//
// EXIGE LA CADENA ENTERA, exactamente la misma que /v1/license/verify: token
// -> licencia -> activa -> Roblox conoce el place -> el universo cuadra -> el
// dueño REAL es un grupo -> ese grupo es el de la licencia. Ni un eslabon
// menos, y por una razon concreta: conformarse con "el token existe y esta
// activa" convierte la licencia en una llave suelta — el token de un cliente
// serviria para leer outfits desde CUALQUIER experiencia de Roblox, incluida
// la de quien se lo haya copiado. La licencia tiene que estar atada al juego,
// no solo al grupo.
//
// Como son GET sin cuerpo, los dos ids con los que se le pregunta a Roblox
// viajan por cabecera: `x-game-id` y `x-place-id` (ver
// parseLicenseContextHeaders). Que falte una es 400, jamas un pase: si su
// ausencia saltara la comprobacion, desactivarla seria tan facil como borrar
// una linea del script que se distribuye.
//
// `x-creator-type` y `x-creator-id` tambien llegan, y NO deciden nada. Son lo
// que el .rbxl AFIRMA de si mismo, y el .rbxl esta en el ordenador del
// comprador. Se guardan para el log, donde comparar lo declarado con lo real
// es lo que delata un cliente manipulado.
//
// ORDEN, y es deliberado: primero la FORMA de las cabeceras (400, sin tocar
// Postgres ni Roblox), luego el token (403, sin gastar cuota de Roblox) y solo
// al final la propiedad. Al reves, cualquiera podria sondear de quien son
// juegos ajenos sin presentar credencial.
//
// COSTE: una consulta a Postgres por peticion — por clave unica indexada — y
// CERO llamadas a Roblox salvo la primera vez que se ve un placeId, porque la
// propiedad se cachea 6 h (ver gameOwnershipService). La consulta del token no
// se cachea a proposito: cachearla significaria que un /deletegroup, un
// /regeneratetoken o desactivar una licencia tardan en surtir efecto, y eso
// vale mucho mas que el milisegundo que se ahorraria.
async function requireLicensedGame(req, res, next) {
    // Lanza ValidationError (400) si falta un id o llega mal formado. Es lo
    // primero que pasa: una peticion incompleta no llega a costar una consulta
    // a la base ni una llamada a Roblox.
    const datos = { ...parseLicenseContextHeaders(req.headers), token: res.locals.licenseToken };

    // La MISMA llamada que hace /v1/license/verify. Si Roblox no contesta,
    // esto LANZA (OwnershipUnavailableError -> 503) en vez de devolver una
    // denegacion: un mal rato de Roblox no puede echar a un cliente legitimo
    // de su propio juego.
    const resultado = await licenseService.verify(datos);

    if (!resultado.ok) {
        return denegar(req, res, datos, resultado);
    }

    anotarLicencia(res, datos, resultado);
    return next();
}

async function requireLicense(req, res, next) {
    // El token ya viene validado y guardado por requireLicenseTokenHeader, que
    // corrio antes de que se leyera el cuerpo. Aqui solo se junta con el resto.
    const datos = { ...parseLicenseVerifyBody(req.body), token: res.locals.licenseToken };

    const resultado = await licenseService.verify(datos);

    if (!resultado.ok) {
        return denegar(req, res, datos, resultado);
    }

    anotarLicencia(res, datos, resultado);
    return next();
}

module.exports = { requireLicense, requireLicensedGame, requireLicenseTokenHeader };
