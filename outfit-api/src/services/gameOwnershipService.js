'use strict';

const roblox = require('../roblox/client');
const cache = require('../cache/cacheStore');
const config = require('../config');
const logger = require('../observability/logger');
const { NotFoundError, UpstreamRateLimitedError, CircuitOpenError, UpstreamError } = require('../roblox/errors');

// DE QUIEN ES REALMENTE UNA EXPERIENCIA DE ROBLOX.
//
// Este modulo existe por una razon de seguridad, no de comodidad. El comprador
// tiene el .rbxl en su ordenador: puede abrir el script, cambiar cualquier
// numero y mandar lo que quiera. Todo lo que el juego AFIRMA sobre a quien
// pertenece — `game.CreatorId`, `game.CreatorType` — es una declaracion del
// llamador, no un hecho, y usarla para autorizar equivale a preguntarle a
// alguien si tiene permiso y creerle.
//
// Aqui la propiedad se AVERIGUA, preguntandosela a Roblox:
//
//     placeId (declarado)
//        -> apis.roblox.com/universes/v1/places/{placeId}/universe
//     universeId REAL
//        -> games.roblox.com/v1/games?universeIds={universeId}
//     creator REAL { type: "Group"|"User", id }
//
// LO QUE ESTO SI RESUELVE: nadie puede ya inventarse un dueño. Un `creatorId`
// falso en el JSON no cambia el resultado, porque el resultado no sale del
// JSON. Para pasar por grupo X hay que estar dentro de un universo que Roblox
// diga que es de X.
//
// LO QUE ESTO NO RESUELVE, y conviene tenerlo escrito: `placeId` sigue siendo
// un dato que manda el cliente. Quien tenga el token de una licencia puede
// mandar el placeId REAL del cliente legitimo — es publico — y la cadena dara
// que si. Ningun esquema basado solo en un JSON de HttpService puede impedir
// eso, porque Roblox no firma nada que demuestre desde que servidor se llama.
// Lo que se gana es que la mentira ya tiene que ser CONSISTENTE con datos
// publicos de Roblox, no una cifra inventada. Cerrar el resto exige atar la
// licencia a un universo concreto (ver el README) o un intercambio con Open
// Cloud usando credenciales del propio cliente.

// Fallo TEMPORAL resolviendo la propiedad. Es una clase aparte y no un
// booleano porque la diferencia entre "no es tuyo" y "ahora mismo no lo se"
// tiene que llegar entera hasta la respuesta HTTP: la primera es un 403
// definitivo y la segunda un 503 que se reintenta. Confundirlas dejaria a un
// cliente legitimo fuera de su propio juego cada vez que Roblox tosa.
class OwnershipUnavailableError extends Error {
    constructor(message, retryAfterSeconds = 5, cause = null) {
        super(message);
        this.name = 'OwnershipUnavailableError';
        this.code = 'verificacion_no_disponible';
        this.retryAfterSeconds = retryAfterSeconds;
        this.cause = cause;
    }
}

// Resultado cuando Roblox responde con certeza que ese place no existe. Es
// definitivo (se puede cachear y se puede denegar), al contrario que un fallo
// de red.
const DESCONOCIDO = { found: false };

// Resuelve la propiedad real a partir del placeId. Cacheado por placeId: un
// juego con 200 servidores arrancando resuelve UNA vez (single-flight incluido
// en withCache) y el resto se sirve de memoria.
//
// La cache no es solo velocidad: es lo que sostiene la verificacion cuando
// Roblox falla. Un juego ya visto se sigue verificando con lo que Roblox dijo
// hace horas, que para "de quien es este universo" sigue siendo verdad.
async function resolveByPlaceId(placeId) {
    const cacheKey = cache.key('ownership', 'place', placeId);

    try {
        return await cache.withCache(
            cacheKey,
            config.ttl.gameOwnership,
            async () => {
                const universeId = await roblox.getUniverseIdForPlace(placeId);
                const owner = await roblox.getUniverseOwner(universeId);
                return { found: true, ...owner };
            },
            // Cache negativa para un place inexistente: sin ella, un cliente
            // mal configurado reintentando en bucle se lleva por delante el
            // limite de Roblox para todos los demas.
            { negativeTtlMs: config.ttl.negative }
        );
    } catch (err) {
        // Roblox dice con certeza que no existe. Es una RESPUESTA, no un
        // fallo: se devuelve como dato para que la decision de licencia la
        // tome un solo sitio.
        if (err instanceof NotFoundError) return DESCONOCIDO;

        // A partir de aqui, todo es "no lo se ahora mismo". NUNCA se traduce a
        // una denegacion: una caida de Roblox no puede convertir a un cliente
        // legitimo en un pirata.
        if (err instanceof UpstreamRateLimitedError || err instanceof CircuitOpenError) {
            throw new OwnershipUnavailableError(
                'No se pudo comprobar la propiedad del juego con Roblox en este momento',
                err.retryAfterSeconds ?? 5,
                err
            );
        }
        if (err instanceof UpstreamError) {
            logger.warn('Fallo resolviendo la propiedad de un juego', {
                placeId,
                detail: err.cause?.message ?? err.message,
            });
            throw new OwnershipUnavailableError(
                'No se pudo comprobar la propiedad del juego con Roblox en este momento',
                5,
                err
            );
        }

        throw err;
    }
}

module.exports = { resolveByPlaceId, OwnershipUnavailableError };
