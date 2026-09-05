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
// `completed` y `candidatesExhausted` son finales normales; los demas dicen que
// la busqueda se corto y que reintentar mas tarde puede dar mas.
//
// CONJUNTO CERRADO: un valor fuera de esta lista seria una fuga de detalle
// interno hacia el cliente. Dos matices que conviene tener presentes:
//
//   TOPE_CANDIDATOS  significa TECHO DURO alcanzado (candidatos o paginas), no
//                    "se acabo el presupuesto previsto". Un presupuesto
//                    previsto que se queda corto ya no termina nada: se
//                    recalcula y la busqueda sigue.
//
//   LIMITE_*         UN MOTIVO POR RUTA, y no uno generico. Que Roblox nos
//                    frene el catalogo y que nos frene el avatar son dos
//                    incidentes distintos, con endpoints distintos, cuotas
//                    distintas y arreglos distintos. Meter los dos bajo un
//                    nombre que dice "catalog" obligaria a leer OTRO campo para
//                    saber si la palabra del primero es literal — y manda a
//                    mirar el endpoint equivocado a quien no lo lea.
const PARADA = Object.freeze({
    COMPLETO: 'completed',
    SIN_CANDIDATOS: 'candidatesExhausted',
    TOPE_CANDIDATOS: 'candidateCap',
    TIEMPO: 'timeBudget',
    LIMITE_CATALOGO: 'catalogRateLimit',
    LIMITE_AVATAR: 'avatarRateLimit',
});

// Los dos motivos que significan "Roblox nos esta frenando". Se agrupan aqui y
// no en cada sitio que necesite la pregunta, para que añadir una tercera ruta
// limitada el dia de mañana no obligue a acordarse de tres condicionales.
const PARADAS_POR_LIMITE = Object.freeze({
    [PARADA.LIMITE_CATALOGO]: 'catalogDetails',
    [PARADA.LIMITE_AVATAR]: 'userAvatar',
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

        // De los avatares que fallaron, los que fallaron PORQUE ROBLOX NOS
        // ESTA FRENANDO (429, cooldown de la ruta, breaker abierto). Va aparte
        // de rejectedAvatarError, que es el veredicto del candidato, porque son
        // dos preguntas distintas: "cuantos candidatos se cayeron" y "cuantos
        // se cayeron por culpa nuestra/de Roblox y no porque la cuenta este
        // baneada". Sin este contador, una busqueda entera podia salir con
        // found bajo y ningun campo de limitacion activo mientras el log se
        // llenaba de 429 del avatar, y nada en stats lo relacionaba.
        //
        // Es ademas independiente de la parada: cuenta los avatares perdidos
        // por un limite AUNQUE la busqueda acabara completando el pedido. Un
        // valor alto con `stoppedBy: completed` avisa de que la siguiente
        // busqueda de ese grupo puede no tener tanta suerte.
        avatarRateLimited: 0,

        // Candidatos que NO se pudieron mirar porque la ruta del avatar estaba
        // cerrada en ese momento. No son descartes: vuelven a la cola y se
        // retoman cuando la ruta reabre. Cuenta EVENTOS de diferimiento, asi
        // que un mismo candidato puede sumar mas de una vez si se difiere en
        // dos pausas seguidas.
        avatarDeferred: 0,

        // Avatares servidos desde la cache: cero peticiones a Roblox y sin
        // necesitar permiso de ruta. Es la cifra que dice cuanto ahorra repetir
        // una busqueda sobre la misma comunidad.
        avatarCacheHits: 0,

        // Candidatos pendientes que se RETOMARON tras una pausa (o tras un
        // reinicio, desde el checkpoint). Cuadra con avatarDeferred: lo que se
        // difirio y luego se retomo.
        deferredResumed: 0,
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

        // Pausas por limite de Roblox. Son la diferencia entre "la busqueda se
        // rindio" y "la busqueda espero lo que le pidieron y siguio": sin
        // ellas, dos busquedas de 40 s — una trabajando y otra parada — se leen
        // exactamente igual.
        rateLimitWaits: 0,
        rateLimitWaitedMs: 0,

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

    // Los presupuestos con los que corrio, tal como quedaron al final. Se
    // publican porque son la mitad de la respuesta a "por que paro aqui": un
    // `candidateCap` no dice nada sin saber en que numero estaba el techo, y un
    // deseado muy por encima de lo examinado dice que la busqueda se quedo sin
    // tiempo, no sin ganas.
    let presupuestos = null;

    return {
        contadores,

        sumar(clave, cuanto = 1) {
            contadores[clave] += cuanto;
        },

        // Reanudacion desde un checkpoint: los contadores continuan donde se
        // quedaron, para que las stats finales describan la busqueda ENTERA y
        // no solo el tramo posterior al reinicio. Solo se restauran claves
        // conocidas: un checkpoint de otra version no puede colar campos.
        restaurar(guardados = {}) {
            for (const clave of Object.keys(contadores)) {
                const valor = guardados[clave];
                if (Number.isFinite(valor) && valor >= 0) contadores[clave] = valor;
            }
        },

        // Foto de los contadores, para el checkpoint.
        instantanea() {
            return { ...contadores };
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
        //
        // La ruta limitada NO se pasa: se DERIVA del motivo (ver
        // PARADAS_POR_LIMITE). Asi `stoppedBy` y `rateLimitedRoute` no pueden
        // contradecirse, que es justo lo que pasaria si dependieran de que cada
        // sitio que corta la busqueda se acuerde de mandar la etiqueta buena.
        pararPor(motivo) {
            parada = motivo;
        },

        anotarRotacion(datos) {
            rotacion = datos;
        },

        anotarPresupuestos(datos) {
            presupuestos = datos;
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
                avatarRateLimited: contadores.avatarRateLimited,
                avatarDeferred: contadores.avatarDeferred,
                deferredResumed: contadores.deferredResumed,
                avatarCacheHits: contadores.avatarCacheHits,

                // Presupuestos con los que corrio. `desiredCandidateBudget` es
                // la PREVISION final (cuantos candidatos se esperaba necesitar)
                // y `hardCandidateLimit` la proteccion anti-bucle; que el
                // segundo aparezca en `candidatesExamined` es lo unico que
                // justifica un stoppedBy 'candidateCap'.
                desiredCandidateBudget: presupuestos?.deseado ?? null,
                hardCandidateLimit: presupuestos?.techo ?? null,

                // Candidatos por resultado que el techo permite DE VERDAD para
                // este `amount`. La constante de configuracion (150) solo vale
                // en el tramo proporcional: con amount=10 el suelo lo deja
                // igual en 150, pero con amount=500 el techo absoluto lo baja a
                // 50. Sin este campo, comparar la tasa de aceptacion observada
                // contra "150" seria comparar contra un numero que en media
                // busqueda no es el que se esta aplicando.
                effectiveHardCandidatesPerResult: presupuestos?.porResultadoEfectivo ?? null,

                memberPageLimit: presupuestos?.techoPaginas ?? null,
                timeBudgetMs: presupuestos?.tiempoMs ?? null,
                wallClockBudgetMs: presupuestos?.relojDeParedMs ?? null,
                candidatesPerResultEstimate: presupuestos?.costePorResultado ?? null,

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
                rateLimitWaits: contadores.rateLimitWaits,
                rateLimitWaitedMs: Math.round(contadores.rateLimitWaitedMs),

                // Tiempo de TRABAJO, ya descontadas las pausas. Es contra este
                // y no contra durationMs contra el que se compara timeBudgetMs.
                workingMs: Math.max(0, Date.now() - empezado - contadores.rateLimitWaitedMs),

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

                // ── Los tres campos de limitacion, y por que son tres ────────
                //
                // Booleanos explicitos ademas de `stoppedBy` porque son LA
                // condicion sobre la que hay que ramificar para decir "Roblox
                // esta limitando, prueba en un momento" en vez de "no se
                // encontro nada". Pero cada uno responde una pregunta distinta
                // y ninguno se puede deducir de otro sin comparar cadenas:
                //
                //   stoppedByRobloxRateLimit  ¿nos freno Roblox?  <- para el
                //                             mensaje al usuario, que es el
                //                             mismo venga el freno de donde
                //                             venga. Añadir una tercera ruta
                //                             limitada no cambia a quien lo lea.
                //
                //   stoppedByCatalogRateLimit ¿fue el CATALOGO?   <- literal, y
                //                             solo eso. Un 429 del avatar aqui
                //                             es `false`: un campo que dice
                //                             "catalog" no puede significar
                //                             "cualquier ruta" sin mandar a
                //                             mirar el endpoint equivocado.
                //
                //   rateLimitedRoute          ¿cual exactamente? <- el bucket
                //                             del limitador, para cruzarlo con
                //                             el campo `routeKey` de sus lineas
                //                             de log.
                stoppedByRobloxRateLimit: Object.hasOwn(PARADAS_POR_LIMITE, parada),
                stoppedByCatalogRateLimit: parada === PARADA.LIMITE_CATALOGO,
                rateLimitedRoute: Object.hasOwn(PARADAS_POR_LIMITE, parada)
                    ? PARADAS_POR_LIMITE[parada]
                    : null,

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
