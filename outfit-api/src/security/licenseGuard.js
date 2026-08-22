'use strict';

const licenseService = require('../services/licenseService');
const { parseLicenseVerifyBody, parseLicenseTokenHeader } = require('../validation/params');

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
// NO HAY NI UNA LINEA DE LOGICA DE AUTORIZACION EN ESTE ARCHIVO. Se valida el
// cuerpo con el MISMO parser que /v1/license/verify y se llama al MISMO
// licenseService.verify: la cadena (token -> licencia -> activa -> propiedad
// real del juego contra Roblox) vive en un solo sitio y aqui solo se consume.
// Si mañana cambia esa cadena, cambia para las dos rutas a la vez.
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

// Guardia de las rutas de DATOS que consume el juego: /v1/users y /v1/outfits.
//
// Comprueba lo unico comprobable ahi — token existente, licencia encontrada,
// licencia activa — reutilizando licenseService.authenticate(), que es el mismo
// codigo (mismo hash, misma comparacion en tiempo constante) que usa la
// verificacion completa. Un token regenerado deja de valer solo: la busqueda es
// por hash y el hash viejo ya no existe en ninguna fila.
//
// LO QUE NO COMPRUEBA, y no es un olvido: la propiedad real del juego. Estas
// rutas son GET sin cuerpo, asi que no traen gameId ni placeId con los que
// preguntarle a Roblox de quien es la experiencia. Tampoco haria falta: son
// lecturas sobre datos PUBLICOS de Roblox, no la autorizacion del producto.
// Esa sigue siendo /v1/license/verify, con su cadena entera.
//
// COSTE: una consulta a Postgres por peticion, por clave unica indexada. No se
// cachea a proposito — cachearla significaria que un /deletegroup o un
// /regeneratetoken tardan en surtir efecto, y que una licencia retirada siga
// leyendo datos un rato mas vale menos que el milisegundo que se ahorra.
async function requireActiveLicense(req, res, next) {
    const resultado = await licenseService.authenticate(res.locals.licenseToken);

    if (!resultado.ok) {
        res.locals.errorCode = resultado.motivo;
        // Mismo formato de denegacion que /v1/license/verify: el juego ya sabe
        // leerlo y no necesita aprender un segundo.
        return res.status(403).json({ ok: false, motivo: resultado.motivo });
    }

    res.locals.license = { groupId: resultado.licencia.groupId };
    return next();
}

async function requireLicense(req, res, next) {
    // El token ya viene validado y guardado por requireLicenseTokenHeader, que
    // corrio antes de que se leyera el cuerpo. Aqui solo se junta con el resto.
    const datos = { ...parseLicenseVerifyBody(req.body), token: res.locals.licenseToken };

    const resultado = await licenseService.verify(datos);

    if (!resultado.ok) {
        res.locals.errorCode = resultado.motivo;
        // Misma forma que /v1/license/verify: el juego ya sabe interpretarla y
        // no necesita aprender un segundo formato de denegacion.
        return res.status(403).json({ ok: false, motivo: resultado.motivo });
    }

    // Para el log de la peticion y para que el handler no tenga que repetir la
    // verificacion si necesita saber de quien es el juego.
    res.locals.license = {
        groupId: resultado.groupId,
        universeId: resultado.propiedadReal?.universeId ?? null,
        gameId: datos.gameId,
        placeId: datos.placeId,
    };

    return next();
}

module.exports = { requireLicense, requireActiveLicense, requireLicenseTokenHeader };
