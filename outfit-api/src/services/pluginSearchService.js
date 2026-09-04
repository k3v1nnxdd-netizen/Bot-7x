'use strict';

const config = require('../config');
const logger = require('../observability/logger');
const requestContext = require('../observability/requestContext');
const repo = require('../db/pluginRotationRepo');
const { abrirRotacion } = require('./pluginSearch/rotation');
const { traerOla } = require('./pluginSearch/avatarWave');
const { crearIndiceDeCatalogo } = require('./pluginSearch/catalogIndex');
const { crearIndiceDeBundles } = require('./pluginSearch/bundleIndex');
const { valorar, aplicarPolitica, necesitaBundle } = require('./pluginSearch/pricing');
const { crearStats, PARADA } = require('./pluginSearch/stats');
const { crearEstimador } = require('./pluginSearch/eta');

// Busqueda de outfits reales para el plugin de Studio. Este archivo es SOLO la
// orquestacion; cada etapa vive en su propio modulo bajo ./pluginSearch/.
//
//   rotation      por donde va la comunidad      (persistente, por groupId)
//   memberPool    una pagina de miembros         (1 llamada / 100 miembros)
//   avatarWave    que lleva puesto cada uno      (1 llamada / candidato)
//   catalogIndex  ficha de los assets, POR LOTES (1 llamada / ~100 assets nuevos)
//   bundleIndex   precio de las partes de bundle
//   pricing       clasificacion, valoracion, filtros (puro, sin red)
//   eta           estimacion de tiempo restante      (puro)
//   stats         contabilidad y motivo de parada
//
// DOS IDEAS SOSTIENEN TODO LO DEMAS:
//
// 1. POR OLAS. El avatar no admite lote (una llamada por candidato,
//    irreductible) pero el catalogo SI (~100 assets por llamada). Se traen los
//    avatares de una ola entera, se juntan TODOS sus assets, se deduplican
//    contra lo ya resuelto y se pide al catalogo una sola vez lo que falta. Es
//    lo que hizo que las llamadas al catalogo dejaran de escalar con el numero
//    de candidatos.
//
// 2. `amount` SON OUTFITS VALIDOS, NO INTENTOS. Un candidato que falla (avatar
//    inaccesible, precio fuera de rango, sin poder valorar) NO gasta una plaza:
//    se sustituye por el siguiente de la comunidad. La busqueda sigue pidiendo
//    segmentos a la rotacion hasta juntar `amount`, agotar un presupuesto o
//    quedarse sin miembros nuevos.
//
// La busqueda prefiere ESTABILIDAD a velocidad bruta. Ante un 429 no insiste:
// para, conserva lo encontrado y lo devuelve como resultado parcial.

// Presupuesto de candidatos. Es un TECHO, no un objetivo: la busqueda para en
// cuanto tiene lo pedido, y esto solo evita que un rango de precio imposible se
// lleve por delante la cuota de Roblox barriendo la comunidad entera.
function presupuestoDeCandidatos(amount, previas) {
    const { candidatesPerResult, minCandidates, maxCandidates } = config.pluginSearch;

    // Si la comunidad ya enseño cuantos candidatos cuesta cada resultado, se usa
    // ESO en vez de la constante: un grupo con mucha ropa cara necesita mirar a
    // mas gente para el mismo `amount`, y uno generoso, menos. El 1.5 es margen
    // sobre la media, y el techo evita que una racha mala de una busqueda
    // anterior dispare el presupuesto de todas las siguientes.
    const porResultado = Number.isFinite(previas?.candidatesPerResult) && previas.candidatesPerResult > 0
        ? Math.min(previas.candidatesPerResult * 1.5, candidatesPerResult * 4)
        : candidatesPerResult;

    return Math.min(maxCandidates, Math.max(minCandidates, Math.ceil(amount * porResultado)));
}

// Condiciones de parada, en orden de prioridad. Se comprueban ANTES de pedir el
// siguiente segmento: cortar a mitad desperdiciaria los avatares ya traidos.
//
// Ninguna es un error. Todas devuelven lo encontrado hasta ese momento, que es
// el contrato: un resultado parcial es util, un 500 no.
function motivoParaParar({ encontrados, amount, examinados, presupuesto, empezado, indice, rotacion }) {
    if (indice.frenadoPorLimite) return PARADA.LIMITE_CATALOGO;
    if (encontrados >= amount) return PARADA.COMPLETO;
    if (rotacion.agotado) return PARADA.SIN_CANDIDATOS;
    if (examinados >= presupuesto) return PARADA.TOPE_CANDIDATOS;
    if (Date.now() - empezado >= config.pluginSearch.timeBudgetMs) return PARADA.TIEMPO;
    return null;
}

// Composicion agregada de lo valorado. Se anota para TODO candidato que llegue a
// valorarse, entre o no en el resultado: si entraran solo los aceptados, un
// found:0 no diria nada sobre por que.
function anotarComposicion(stats, valoracion) {
    stats.sumar('assetsPriced', valoracion.pricedItems);
    stats.sumar('assetsUnpriced', valoracion.unpricedItems);
    stats.sumar('assetsLimited', valoracion.limitedItems);
    stats.sumar('assetsOffSale', valoracion.offSaleItems);
    stats.sumar('assetsBundled', valoracion.bundledItems);
    stats.sumar('assetsDeleted', valoracion.deletedItems);
}

// Devuelve { outfits, stats, progress }. La forma de la respuesta HTTP la arma
// la ruta; el trabajo asincrono la envuelve en su propio estado.
//
// Todo el cuerpo corre dentro de un contexto de correlacion para que las lineas
// que emite el limitador cuando Roblox nos frena lleven el requestId de ESTA
// busqueda: sin eso, un 429 en el log no se puede cruzar con la busqueda que lo
// provoco.
function searchOutfits(peticion, opciones = {}) {
    return requestContext.ejecutarCon(
        { requestId: opciones.requestId ?? null },
        () => ejecutarBusqueda(peticion, opciones)
    );
}

async function ejecutarBusqueda(
    { amount, groupId, minPrice, maxPrice, requireCompletePrice },
    { requestId = null, onProgress = null, onEncolado = null } = {}
) {
    const empezado = Date.now();
    const stats = crearStats();

    // Lo que la comunidad enseño en busquedas anteriores. Sirve para dos cosas
    // distintas: dimensionar el presupuesto y dar una ETA creible desde el
    // primer segundo. null en un grupo nuevo o sin base de datos.
    const previas = await repo.leerStats(groupId);
    const presupuesto = presupuestoDeCandidatos(amount, previas);
    const estimador = crearEstimador({ target: amount, previas });

    // La rotacion toma turno del grupo: si otra busqueda lo esta recorriendo,
    // esta espera aqui (sin sondear) y `onEncolado` deja constancia de que esta
    // en cola, no buscando.
    const rotacion = await abrirRotacion(groupId, stats, { onEncolado });
    const indice = crearIndiceDeCatalogo(stats);
    const bundles = crearIndiceDeBundles(stats);

    const encontrados = [];
    const yaIncluidos = new Set(); // ningun userId repetido en la respuesta
    let examinados = 0;
    let segmentosVacios = 0;
    let progreso = estimador.progreso({ examinados: 0, encontrados: 0 });

    try {
        for (;;) {
            const parada = motivoParaParar({
                encontrados: encontrados.length, amount, examinados, presupuesto,
                empezado, indice, rotacion,
            });
            if (parada) { stats.pararPor(parada); break; }

            // ── Etapa 0: siguiente tramo de la comunidad ─────────────────────
            //
            // El tamaño del tramo se ADAPTA a lo que esta costando cada
            // resultado en esta busqueda, y esa es la diferencia entre gastar lo
            // justo o el cuadruple.
            //
            // Empieza optimista (un candidato por resultado que falte) porque
            // quedarse corto es barato — se pide otro tramo — mientras que
            // pasarse cuesta llamadas de avatar que NO se recuperan y ademas
            // consume comunidad: cada miembro traido de mas es un miembro que la
            // rotacion da por visto. En cuanto hay muestra, el tramo se escala
            // por la tasa de aceptacion real.
            const faltan = amount - encontrados.length;
            const tasa = examinados > 0 && encontrados.length > 0
                ? encontrados.length / examinados
                : 1;
            const deseados = Math.min(
                config.pluginRotation.segmentSize,
                Math.max(config.pluginSearch.concurrency, Math.ceil(faltan / tasa)),
                presupuesto - examinados
            );

            const segmento = await rotacion.siguienteSegmento(Math.max(1, deseados));

            if (segmento.length === 0) {
                // La rotacion no tiene a nadie nuevo. Se cuenta y, tras unos
                // pocos intentos, se da la comunidad por agotada: sin esto un
                // grupo pequeño giraria en redondo hasta agotar el tiempo.
                segmentosVacios++;
                stats.sumar('emptySegments');
                if (segmentosVacios >= config.pluginRotation.emptySegmentsBeforeExhausted) {
                    stats.pararPor(PARADA.SIN_CANDIDATOS);
                    break;
                }
                continue;
            }
            segmentosVacios = 0;
            examinados += segmento.length;

            // ── Etapa 2: avatares de la ola, con concurrencia acotada ────────
            const avatares = await traerOla(segmento, stats, config.pluginSearch.concurrency);

            // ── Etapa 3: UN solo paso de catalogo para toda la ola ───────────
            const assetsDeLaOla = [];
            for (const resultado of avatares) {
                if (resultado.ok) assetsDeLaOla.push(...resultado.assetIds);
            }
            await indice.asegurar(assetsDeLaOla);

            // ── Etapa 3b: bundles, SOLO para lo que no tiene precio propio ───
            const sinPrecioPropio = [...new Set(assetsDeLaOla)]
                .filter(assetId => necesitaBundle(indice.ficha(assetId)));
            if (sinPrecioPropio.length > 0) await bundles.asegurar(sinPrecioPropio);

            // ── Etapas 4 y 5: valoracion y politica, ya sin tocar la red ─────
            for (const resultado of avatares) {
                if (!resultado.ok) { stats.rechazar(resultado.motivo); continue; }

                const valorado = valorar(resultado.assetIds, indice, bundles);
                if (!valorado.ok) { stats.rechazar(valorado.motivo); continue; }

                const v = valorado.valoracion;
                anotarComposicion(stats, v);

                const politica = aplicarPolitica(v, { requireCompletePrice, minPrice, maxPrice });
                if (!politica.ok) { stats.rechazar(politica.motivo); continue; }

                // Defensivo: la rotacion ya deduplica dentro de la busqueda.
                if (yaIncluidos.has(resultado.miembro.userId)) continue;

                stats.aceptar();
                yaIncluidos.add(resultado.miembro.userId);
                encontrados.push({
                    userId: resultado.miembro.userId,
                    username: resultado.miembro.username,
                    totalPrice: v.totalPrice,
                    priceComplete: v.priceComplete,
                    pricedItems: v.pricedItems,
                    unpricedItems: v.unpricedItems,
                    limitedItems: v.limitedItems,
                    offSaleItems: v.offSaleItems,
                    bundledItems: v.bundledItems,
                });

                // NO se corta la ola al llegar a `amount`. Sus avatares ya estan
                // pagados y valorados, asi que descartarlos sin veredicto los
                // dejaria fuera de stats y romperia la invariante
                // (examinados = aceptados + rechazados). El sobrante se recorta
                // al final; por eso `accepted` puede superar a `found` en unas
                // pocas unidades.
            }

            // ── Progreso y persistencia, UNA vez por segmento ────────────────
            // Persistir aqui y no solo al final es lo que hace que un reinicio
            // de Railway cueste un segmento y no la busqueda entera.
            estimador.observar({ examinados, encontrados: encontrados.length });
            progreso = estimador.progreso({ examinados, encontrados: encontrados.length });
            onProgress?.(progreso);

            await rotacion.persistir();
        }
    } finally {
        // SIEMPRE: un lease sin soltar bloquea el grupo hasta que caduque.
        await rotacion.cerrar();
    }

    const paradaFinal = motivoParaParar({
        encontrados: encontrados.length, amount, examinados, presupuesto,
        empezado, indice, rotacion,
    });
    if (paradaFinal) stats.pararPor(paradaFinal);

    stats.anotarRotacion({
        modo: rotacion.modo,
        cycle: rotacion.cycle,
        inicio: rotacion.inicio,
        fin: rotacion.posicion,
        wraps: rotacion.wraps,
        cursorResets: rotacion.cursorResets,
    });

    const publicas = stats.publicar();
    progreso = estimador.progreso({ examinados, encontrados: encontrados.length });

    // Lo que esta busqueda le enseña a la comunidad para la proxima. Solo si
    // hubo trabajo de verdad: una busqueda que no examino a nadie no enseña nada
    // y arrastraria las medias hacia cero.
    if (examinados > 0) {
        await repo.registrarBusqueda(groupId, estimador.muestraFinal({
            examinados, encontrados: encontrados.length,
        }));
    }

    // UNA linea por busqueda, agregada. Nunca una por candidato.
    logger.info('Busqueda de outfits del plugin', {
        requestId,
        groupId,
        amount,
        minPrice,
        maxPrice,
        requireCompletePrice,
        found: encontrados.length,
        candidateBudget: presupuesto,
        estimatedRemainingMs: progreso.estimatedRemainingMs,
        ...publicas,
    });

    return { outfits: encontrados.slice(0, amount), stats: publicas, progress: progreso };
}

module.exports = { searchOutfits, presupuestoDeCandidatos };
