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
async function requireLicense(req, res, next) {
    // Mismo transporte que /v1/license/verify: el token por cabecera, el resto
    // en el cuerpo. La limitacion de Roblox que lo obliga alli (un Secret no se
    // puede serializar con JSONEncode) es exactamente la misma aqui, asi que
    // separar los dos transportes solo serviria para que este endpoint fuera
    // inusable desde un juego que guarde su token como Secret.
    const token = parseLicenseTokenHeader(req.headers);
    const datos = { ...parseLicenseVerifyBody(req.body), token };

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

module.exports = { requireLicense };
