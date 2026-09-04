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
    incompletePrice: 'rejectedIncompletePrice',
    minPrice: 'rejectedMinPrice',
    maxPrice: 'rejectedMaxPrice',
});

function crearStats() {
    const empezado = Date.now();

    const contadores = {
        // Descubrimiento
        memberPagesFetched: 0,
        emptySegments: 0,

        // Trabajo hecho
        avatarRequests: 0,        // llamadas al avatar, incluidas las que fallaron
        avatarsFetched: 0,        // de esas, las que devolvieron un avatar usable
        assetIdsSeen: 0,          // con repeticiones, tal como venian en los avatares
        assetIdsUnique: 0,        // distintos en TODA la busqueda
        assetIdsRequested: 0,     // los que de verdad se mandaron a Roblox
        catalogBatches: 0,        // lotes despachados (<= 1 llamada upstream cada uno)
        bundleLookups: 0,         // busquedas inversas asset -> bundle (1 llamada cada una)
        bundleLookupsSkipped: 0,  // las que NO se hicieron: presupuesto agotado o ruta frenada
        bundleSpecialHits: 0,     // resueltas de memoria por el registro curado
        bundleBatches: 0,         // lotes de precio de bundle (bundles/details)
        cacheHits: 0,
        cacheMisses: 0,

        // Veredictos
        accepted: 0,
        rejectedAvatarError: 0,
        rejectedEmptyAvatar: 0,
        rejectedCatalogError: 0,
        rejectedUnknownPrice: 0,
        rejectedIncompletePrice: 0,
        rejectedMinPrice: 0,
        rejectedMaxPrice: 0,

        // Composicion de lo valorado, agregada sobre TODOS los candidatos
        // examinados. Es lo que dice si un found bajo viene de Limiteds sin
        // reventa, de articulos retirados o de partes de bundle sin resolver.
        assetsPriced: 0,
        assetsUnpriced: 0,
        assetsLimited: 0,
        assetsOffSale: 0,
        assetsBundled: 0,
        assetsDeleted: 0,
    };

    let parada = PARADA.SIN_CANDIDATOS;

    // Donde empezo y donde acabo el recorrido de la comunidad. No es adorno:
    // es lo que permite comprobar desde el log que dos busquedas seguidas del
    // mismo grupo NO recorrieron el mismo tramo.
    let rotacion = null;

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

        anotarRotacion(datos) {
            rotacion = datos;
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
                + contadores.rejectedIncompletePrice
                + contadores.rejectedMinPrice + contadores.rejectedMaxPrice;

            return {
                candidatesExamined: contadores.accepted + rechazados,
                memberPagesFetched: contadores.memberPagesFetched,
                emptySegments: contadores.emptySegments,

                // Rotacion: en que modo fue, por que ciclo va la comunidad y
                // entre que dos puntos se recorrio esta vez. Los cursores NO se
                // publican enteros — son opacos y largos — sino resumidos, que
                // es lo unico que hace falta para ver que hubo avance.
                rotationMode: rotacion?.modo ?? null,
                rotationCycle: rotacion?.cycle ?? null,
                rotationStart: describirPosicion(rotacion?.inicio),
                rotationEnd: describirPosicion(rotacion?.fin),
                rotationWraps: rotacion?.wraps ?? 0,
                rotationCursorResets: rotacion?.cursorResets ?? 0,
                avatarRequests: contadores.avatarRequests,
                avatarsFetched: contadores.avatarsFetched,

                assetIdsSeen: contadores.assetIdsSeen,
                assetIdsUnique: contadores.assetIdsUnique,
                assetIdsRequested: contadores.assetIdsRequested,
                catalogBatches: contadores.catalogBatches,
                bundleLookups: contadores.bundleLookups,
                bundleLookupsSkipped: contadores.bundleLookupsSkipped,
                bundleSpecialHits: contadores.bundleSpecialHits,
                bundleBatches: contadores.bundleBatches,
                cacheHits: contadores.cacheHits,
                cacheMisses: contadores.cacheMisses,

                accepted: contadores.accepted,
                rejectedAvatarError: contadores.rejectedAvatarError,
                rejectedEmptyAvatar: contadores.rejectedEmptyAvatar,
                rejectedCatalogError: contadores.rejectedCatalogError,
                rejectedUnknownPrice: contadores.rejectedUnknownPrice,
                rejectedIncompletePrice: contadores.rejectedIncompletePrice,
                rejectedMinPrice: contadores.rejectedMinPrice,
                rejectedMaxPrice: contadores.rejectedMaxPrice,

                // Composicion de lo valorado, agregada sobre TODOS los
                // candidatos examinados. Es lo que dice si un found bajo viene
                // de Limiteds sin reventa, de articulos retirados o de partes
                // de bundle que no se pudieron resolver.
                assetsPriced: contadores.assetsPriced,
                assetsUnpriced: contadores.assetsUnpriced,
                assetsLimited: contadores.assetsLimited,
                assetsOffSale: contadores.assetsOffSale,
                assetsBundled: contadores.assetsBundled,
                assetsDeleted: contadores.assetsDeleted,

                stoppedBy: parada,
                // Booleano explicito ademas de `stoppedBy`, y no es redundante:
                // es LA condicion sobre la que el plugin tiene que ramificar
                // para decirle a quien mira "Roblox esta limitando, prueba en un
                // momento" en vez de "no se encontro nada".
                stoppedByCatalogRateLimit: parada === PARADA.LIMITE_CATALOGO,

                // Proporcion de candidatos que acabaron siendo outfits validos.
                // Es el numero que de verdad explica cuanto costo la busqueda, y
                // el que alimenta la estimacion de la siguiente.
                acceptanceRate: contadores.accepted + rechazados > 0
                    ? Math.round((contadores.accepted / (contadores.accepted + rechazados)) * 1000) / 1000
                    : 0,

                durationMs: Date.now() - empezado,
            };
        },
    };
}

// Un cursor de Roblox es una cadena opaca y larga. En el log solo interesa
// PODER COMPARAR dos posiciones, asi que se resume: 'first' para el principio
// del ciclo y un prefijo corto del cursor para el resto. Suficiente para ver de
// un vistazo que la busqueda de hoy empezo donde acabo la de ayer, sin
// arrastrar trescientos caracteres por linea.
function describirPosicion(posicion) {
    if (!posicion) return null;
    const cursor = posicion.cursor ? String(posicion.cursor).slice(0, 12) : 'first';
    return { cursor, offset: posicion.offset, cycle: posicion.cycle };
}

module.exports = { crearStats, PARADA };
