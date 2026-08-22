'use strict';

const groupWhitelist = require('./groupWhitelistService');
const gameOwnership = require('./gameOwnershipService');
const licenseToken = require('../security/licenseToken');

// La decision de "¿este juego puede usar el sistema?", en un solo sitio.
//
// Vive en un servicio y no en la ruta porque es LOGICA, no transporte: la ruta
// traduce a HTTP y esto decide. Asi se puede probar la cadena entera sin
// levantar un servidor, y el dia que el juego pregunte por otra via la
// respuesta seguira siendo la misma.
//
// ═══ LA REGLA QUE GOBIERNA ESTE ARCHIVO ═══
//
// NADA que venga en el cuerpo de la peticion demuestra propiedad. El comprador
// tiene el .rbxl y puede editar el script: `creatorId` y `creatorType` son
// afirmaciones SUYAS. Se aceptan, se registran y se comparan con la realidad
// para detectar manipulacion — pero no deciden nada.
//
// Quien decide de quien es la experiencia es ROBLOX, preguntado desde aqui
// (ver gameOwnershipService.js). El unico dato del cliente que entra en la
// decision es el `placeId`, y no como prueba de propiedad sino como PUNTERO:
// "mira este sitio y dime tu de quien es".
//
// ═══ LA CADENA, EN ESTE ORDEN EXACTO ═══
//
//   1. token valido            -> existe y su hash coincide.     token_invalido
//   2. licencia encontrada     -> hay fila que autorizar.        token_invalido
//   3. active = true           -> no esta retirada.              licencia_inactiva
//   4. Roblox conoce el place  -> el puntero apunta a algo real. juego_desconocido
//   5. placeId y gameId cuadran-> el universo real del place es
//                                 el que el juego dice.          juego_no_coincide
//   6. el dueño REAL es un grupo                                 no_es_grupo
//   7. ese grupo REAL es el de la licencia                       grupo_no_coincide
//
// Los pasos 4-7 van DESPUES del token a proposito: primero se demuestra quien
// eres y solo despues se mira si eso encaja con donde estas. Al reves,
// cualquiera podria sondear la propiedad de juegos ajenos sin credencial.
//
// Y ninguno de los siete puede fallar por un problema de infraestructura: si
// Roblox no responde, esto LANZA (OwnershipUnavailableError -> 503) en vez de
// devolver una denegacion. Una caida de Roblox no puede echar a un cliente
// legitimo de su propio juego.

const MOTIVOS = {
    TOKEN_INVALIDO: 'token_invalido',
    LICENCIA_INACTIVA: 'licencia_inactiva',
    GRUPO_NO_COINCIDE: 'grupo_no_coincide',
    NO_ES_GRUPO: 'no_es_grupo',
    // Añadidos con la resolucion server-side: son estados que antes no se
    // podian distinguir porque la propiedad no se comprobaba.
    JUEGO_DESCONOCIDO: 'juego_desconocido',
    JUEGO_NO_COINCIDE: 'juego_no_coincide',
};

const CREADOR_GRUPO = 'Group';

const denegado = (motivo, real = null) => ({ ok: false, motivo, propiedadReal: real });

async function verify({ token, gameId, placeId, creatorType = null, creatorId = null }) {
    // Un token con forma imposible no llega a costar una consulta. La
    // respuesta es IDENTICA a la de un token desconocido: distinguir "mal
    // formado" de "no existe" solo le sirve a quien esta probando tokens.
    if (!licenseToken.looksLikeToken(token)) {
        return denegado(MOTIVOS.TOKEN_INVALIDO);
    }

    const licencia = await groupWhitelist.findByTokenHash(licenseToken.hashToken(token));
    if (!licencia) {
        return denegado(MOTIVOS.TOKEN_INVALIDO);
    }

    // Confirmacion en tiempo constante sobre el hash completo. Redundante con
    // el WHERE de la consulta y deliberada: esa igualdad la resuelve Postgres
    // con su indice, y no es una comparacion pensada para resistir medicion de
    // tiempos.
    if (!licenseToken.matchesHash(token, licencia.tokenHash)) {
        return denegado(MOTIVOS.TOKEN_INVALIDO);
    }

    if (licencia.active !== true) {
        return denegado(MOTIVOS.LICENCIA_INACTIVA);
    }

    // ── A partir de aqui, la palabra la tiene Roblox ─────────────────────────
    // Si esto lanza, lanza: es un fallo temporal y sube hasta el 503. Lo que
    // NO puede hacer es convertirse en un `ok: false`.
    const real = await gameOwnership.resolveByPlaceId(placeId);

    if (!real.found) {
        return denegado(MOTIVOS.JUEGO_DESCONOCIDO);
    }

    // Coherencia entre los dos ids que manda el juego. El universo lo resolvio
    // Roblox a partir del placeId; si el gameId declarado es otro, o el script
    // esta mal, o alguien esta mezclando ids de dos sitios distintos. En
    // cualquiera de los dos casos no hay nada que autorizar.
    if (real.universeId !== gameId) {
        return denegado(MOTIVOS.JUEGO_NO_COINCIDE, real);
    }

    // El dueño REAL — el que dice Roblox, no el que dice el JSON.
    if (real.creatorType !== CREADOR_GRUPO) {
        return denegado(MOTIVOS.NO_ES_GRUPO, real);
    }

    // LA comparacion que sostiene todo el sistema. Los dos lados son texto:
    // `group_id` es TEXT en la base porque un id de Roblox no cabe en un
    // entero de JavaScript sin perder precision, y `creatorId` viene ya
    // normalizado a cadena desde el cliente de Roblox.
    if (real.creatorId !== licencia.groupId) {
        return denegado(MOTIVOS.GRUPO_NO_COINCIDE, real);
    }

    return { ok: true, groupId: licencia.groupId, propiedadReal: real };
}

// ¿Lo que el juego DECLARA coincide con lo que Roblox dice? No decide nada:
// sirve para que el log distinga un script mal configurado de un intento
// deliberado de suplantar a otro grupo. Un `creatorId` declarado que no es el
// real, con el resto cuadrando, es exactamente la firma de un .rbxl editado.
function detectarDeclaracionFalsa({ creatorType, creatorId }, real) {
    if (!real?.found) return false;
    if (creatorId != null && creatorId !== real.creatorId) return true;
    if (creatorType != null && creatorType !== real.creatorType) return true;
    return false;
}

module.exports = { verify, detectarDeclaracionFalsa, MOTIVOS };
