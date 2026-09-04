'use strict';

const logger = require('../../observability/logger');

// Contabilidad de una busqueda. Un solo sitio donde se cuenta, para que la
// respuesta y el log no puedan contar cosas distintas.
//
// LA INVARIANTE, y es la que hace que estos numeros sirvan para algo:
//
//   candidatesExamined === accepted + todos los rejected*
//
// Un candidato contado dos veces, o ninguna, manda a buscar el problema donde
// no esta. Por eso `candidatesExamined` NO se lleva en un contador aparte: se
// calcula sumando las casillas al publicar, asi que no puede desviarse de
// ellas ni por un bug futuro.
//
// NADA SENSIBLE: enteros, dos booleanos y una etiqueta de parada de un conjunto
// cerrado. Ni credenciales, ni ids de usuario, ni nombres, ni nada de lo que
// devolvio Roblox.

// Motivos de parada, en orden de "lo que le interesa saber a quien mira".
// `completed` y `candidatesExhausted` son finales normales; los otros tres
// dicen que la busqueda se corto y que reintentar mas tarde puede dar mas.
const PARADA = Object.freeze({
    COMPLETO: 'completed',
    SIN_CANDIDATOS: 'candidatesExhausted',
    TOPE_CANDIDATOS: 'candidateCap',
    TIEMPO: 'timeBudget',
    LIMITE_CATALOGO: 'catalogRateLimit',
});

// Motivo interno de descarte -> casilla publica.
const CASILLA_POR_MOTIVO = Object.freeze({
    avatarError: 'rejectedAvatarError',
    emptyAvatar: 'rejectedEmptyAvatar',
    catalogError: 'rejectedCatalogError',
    unknownPrice: 'rejectedUnknownPrice',
    minPrice: 'rejectedMinPrice',
    maxPrice: 'rejectedMaxPrice',
});

function crearStats() {
    const empezado = Date.now();

    const contadores = {
        // Descubrimiento
        candidatesDiscovered: 0,
        memberPagesFetched: 0,

        // Trabajo hecho
        avatarRequests: 0,        // llamadas al avatar, incluidas las que fallaron
        avatarsFetched: 0,        // de esas, las que devolvieron un avatar usable
        assetIdsSeen: 0,          // con repeticiones, tal como venian en los avatares
        assetIdsUnique: 0,        // distintos en TODA la busqueda
        assetIdsRequested: 0,     // los que de verdad se mandaron a Roblox
        catalogBatches: 0,        // lotes despachados (<= 1 llamada upstream cada uno)
        cacheHits: 0,
        cacheMisses: 0,

        // Veredictos
        accepted: 0,
        rejectedAvatarError: 0,
        rejectedEmptyAvatar: 0,
        rejectedCatalogError: 0,
        rejectedUnknownPrice: 0,
        rejectedMinPrice: 0,
        rejectedMaxPrice: 0,
    };

    let parada = PARADA.SIN_CANDIDATOS;

    return {
        contadores,

        sumar(clave, cuanto = 1) {
            contadores[clave] += cuanto;
        },

        // Marca de cache para las entidades que pasan por withCache (paginas de
        // miembros y avatares). Se cuenta en AGREGADO: una busqueda toca
        // cientos de claves y empujar una marca por cada una convertiria la
        // linea de log de la peticion en un churro ilegible.
        marcarCache(estado) {
            if (estado === 'hit' || estado === 'negative-hit') contadores.cacheHits++;
            else contadores.cacheMisses++;
        },

        // Un candidato rechazado, en su casilla y solo en esa.
        rechazar(motivo) {
            const casilla = CASILLA_POR_MOTIVO[motivo];
            if (!casilla) {
                // Un motivo desconocido descuadraria la invariante en silencio.
                logger.warn('Motivo de descarte desconocido en la busqueda del plugin', { motivo });
                return;
            }
            contadores[casilla]++;
        },

        aceptar() {
            contadores.accepted++;
        },

        // La ULTIMA parada gana: se llama en cuanto se detecta la condicion, y
        // las condiciones se comprueban en orden de prioridad.
        pararPor(motivo) {
            parada = motivo;
        },

        get parada() {
            return parada;
        },

        // Forma publica, ordenada como se lee al diagnosticar: cuanto se
        // descubrio, cuanto trabajo costo, que entro, por que se cayo el resto
        // y por que termino.
        publicar() {
            const rechazados = contadores.rejectedAvatarError + contadores.rejectedEmptyAvatar
                + contadores.rejectedCatalogError + contadores.rejectedUnknownPrice
                + contadores.rejectedMinPrice + contadores.rejectedMaxPrice;

            return {
                candidatesDiscovered: contadores.candidatesDiscovered,
                candidatesExamined: contadores.accepted + rechazados,
                memberPagesFetched: contadores.memberPagesFetched,
                avatarRequests: contadores.avatarRequests,
                avatarsFetched: contadores.avatarsFetched,

                assetIdsSeen: contadores.assetIdsSeen,
                assetIdsUnique: contadores.assetIdsUnique,
                assetIdsRequested: contadores.assetIdsRequested,
                catalogBatches: contadores.catalogBatches,
                cacheHits: contadores.cacheHits,
                cacheMisses: contadores.cacheMisses,

                accepted: contadores.accepted,
                rejectedAvatarError: contadores.rejectedAvatarError,
                rejectedEmptyAvatar: contadores.rejectedEmptyAvatar,
                rejectedCatalogError: contadores.rejectedCatalogError,
                rejectedUnknownPrice: contadores.rejectedUnknownPrice,
                rejectedMinPrice: contadores.rejectedMinPrice,
                rejectedMaxPrice: contadores.rejectedMaxPrice,

                stoppedBy: parada,
                // Booleano explicito ademas de `stoppedBy`, y no es redundante:
                // es LA condicion sobre la que el plugin tiene que ramificar
                // para decirle a quien mira "Roblox esta limitando, prueba en un
                // momento" en vez de "no se encontro nada".
                stoppedByCatalogRateLimit: parada === PARADA.LIMITE_CATALOGO,

                durationMs: Date.now() - empezado,
            };
        },
    };
}

module.exports = { crearStats, PARADA };
