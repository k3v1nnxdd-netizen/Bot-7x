'use strict';

// Taxonomia de fallos de la capa saliente (Roblox). Existe para que el
// resto del servicio nunca tenga que inspeccionar `err.response.status`:
// quien captura decide por CLASE, y src/api/errorHandler.js hace la unica
// traduccion a HTTP que hay en todo el codigo.
//
// La distincion que mas importa es 429-nuestro vs 429-de-Roblox. El juego
// debe poder diferenciarlos porque la reaccion correcta es distinta: si lo
// frenamos nosotros, que baje su ritmo; si lo frena Roblox, que espere el
// Retry-After y reintente. Por eso un limite de Roblox sale como 503
// `upstream_rate_limited` y jamas como 429.

// Roblox respondio 404: el usuario o el outfit no existe (o no es publico).
// NO es un fallo de infraestructura — es una respuesta valida y definitiva,
// no se reintenta nunca y no cuenta para el circuit breaker.
class NotFoundError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'NotFoundError';
        this.code = code; // 'user_not_found' | 'outfit_not_found'
    }
}

// Roblox nos limito (429) y agotamos lo que estabamos dispuestos a esperar
// dentro de la peticion. `retryAfterSeconds` viene de Roblox cuando lo manda
// y se propaga tal cual al llamador en la cabecera Retry-After.
class UpstreamRateLimitedError extends Error {
    constructor(message, retryAfterSeconds) {
        super(message);
        this.name = 'UpstreamRateLimitedError';
        this.code = 'upstream_rate_limited';
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

// El breaker de esa ruta esta abierto: Roblox viene fallando de forma
// sostenida y dejamos de insistir a proposito. Cortar aqui es lo que evita
// que un mal momento de Roblox se convierta en una tormenta de reintentos
// que empeore el limite justo cuando peor esta.
class CircuitOpenError extends Error {
    constructor(message, retryAfterSeconds) {
        super(message);
        this.name = 'CircuitOpenError';
        this.code = 'upstream_unavailable';
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

// Cajon de sastre de lo saliente: 5xx de Roblox, timeout, DNS, socket caido,
// o una respuesta con forma inesperada. `cause` guarda el error original
// para el log; nunca se filtra al cuerpo de la respuesta.
class UpstreamError extends Error {
    constructor(message, cause) {
        super(message);
        this.name = 'UpstreamError';
        this.code = 'upstream_error';
        this.cause = cause;
    }
}

module.exports = { NotFoundError, UpstreamRateLimitedError, CircuitOpenError, UpstreamError };
