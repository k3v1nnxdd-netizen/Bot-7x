'use strict';

const config = require('../config');
const logger = require('../observability/logger');
const requestContext = require('../observability/requestContext');
const repo = require('../db/pluginRotationRepo');
const { abrirRotacion } = require('./pluginSearch/rotation');
const { traerOla, RUTA_AVATAR } = require('./pluginSearch/avatarWave');
const { crearIndiceDeCatalogo } = require('./pluginSearch/catalogIndex');
const { crearIndiceDeBundles } = require('./pluginSearch/bundleIndex');
const { valorar, aplicarPolitica, necesitaBundle } = require('./pluginSearch/pricing');
const { crearStats, PARADA } = require('./pluginSearch/stats');
const { crearEstimador } = require('./pluginSearch/eta');
const presupuestos = require('./pluginSearch/budget');
const { crearPuerta, VEREDICTO } = require('./pluginSearch/throttleGate');

// Busqueda de outfits reales para el plugin de Studio. Este archivo es SOLO la
// orquestacion; cada etapa vive en su propio modulo bajo ./pluginSearch/.
//
//   rotation      por donde va la comunidad      (persistente, por groupId)
//   memberPool    una pagina de miembros         (1 llamada / 100 miembros)
//   avatarWave    que lleva puesto cada uno      (1 llamada / candidato)
//   catalogIndex  ficha de los assets, POR LOTES (1 llamada / ~100 assets nuevos)
//   bundleIndex   precio de las partes de bundle
//   pricing       clasificacion, valoracion, filtros (puro, sin red)
//   budget        presupuestos y techos              (puro)
//   eta           estimacion de tiempo restante      (puro)
//   stats         contabilidad y motivo de parada
//
// TRES IDEAS SOSTIENEN TODO LO DEMAS:
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
//    segmentos —y paginas, y ciclos— hasta juntar `amount`.
//
// 3. EL PRESUPUESTO PREVISTO NO TERMINA NADA. Que la busqueda salga mas cara de
//    lo estimado sube la estimacion, no corta el recorrido. Lo que termina una
//    busqueda es una de estas cosas, y solo estas:
//
//       1. `amount` alcanzado                      -> completed
//       2. vuelta completa a la comunidad          -> candidatesExhausted
//       3. Roblox frenando el CATALOGO             -> catalogRateLimit
//       4. Roblox frenando el AVATAR               -> avatarRateLimit
//       5. presupuesto de TIEMPO agotado           -> timeBudget
//       6. techo duro de seguridad (anti-bucle)    -> candidateCap
//
//    Los motivos 3 y 4 estan separados a proposito: son dos endpoints con
//    cuotas independientes y arreglos distintos, y un solo nombre para los dos
//    manda a mirar el que no es.
//
//    El 6 esta dimensionado para NO ocurrir en una busqueda sana. Cuando
//    aparece en una busqueda pequeña, es un sintoma, no un final normal.
//
// La busqueda prefiere ESTABILIDAD a velocidad bruta. Ante un 429 no insiste:
// para, conserva lo encontrado y lo devuelve como resultado parcial.

// Presupuesto DESEADO inicial de una busqueda, antes de examinar a nadie. Se
// mantiene exportado con este nombre porque es el numero que el aprendizaje del
// grupo dimensiona, y hay pruebas que lo comprueban directamente; el calculo
// completo (y el que corre en cada vuelta del bucle) vive en ./pluginSearch/budget.
function presupuestoDeCandidatos(amount, previas) {
    return presupuestos.presupuestoDeseado({ amount, encontrados: 0, examinados: 0, previas });
}

// Condiciones de parada, en orden de prioridad. Se comprueban ANTES de pedir el
// siguiente segmento: cortar a mitad desperdiciaria los avatares ya traidos.
//
// Ninguna es un error. Todas devuelven lo encontrado hasta ese momento, que es
// el contrato: un resultado parcial es util, un 500 no.
//
// NOTESE QUE EL PRESUPUESTO DESEADO NO ESTA AQUI. Ese era el bug: un numero
// calculado antes de empezar, suponiendo cuatro candidatos por resultado,
// terminaba busquedas que solo eran caras.
function motivoParaParar({
    encontrados, amount, examinados, techoCandidatos,
    trabajadoMs, relojRestante, tiempoMs, indice, rotacion, frenadoElAvatar,
}) {
    // 1. Ya esta lo pedido. Va PRIMERO: una busqueda que junto sus `amount`
    //    outfits termino bien, aunque por el camino Roblox nos frenara un rato.
    //    Decir que paro por un limite con la lista completa en la mano mandaria
    //    al plugin a enseñar "Roblox esta limitando" sobre un resultado
    //    perfecto.
    if (encontrados >= amount) return PARADA.COMPLETO;

    // 2. Roblox nos esta frenando Y LA ESPERA YA NO CABE. Ojo al matiz, que es
    //    todo el arreglo: un cooldown por si solo NO llega aqui. Un cooldown se
    //    espera (ver throttleGate.js) y la busqueda continua. Estas dos
    //    banderas se encienden unicamente cuando la pausa que Roblox pide no
    //    entra en lo que queda de presupuesto — entonces si, se para y se
    //    devuelve lo encontrado.
    //
    //    UN MOTIVO POR RUTA. El catalogo y el avatar son dos incidentes
    //    distintos: endpoints distintos, cuotas independientes (bucket propio
    //    cada uno) y arreglos distintos.
    if (indice.frenadoPorLimite) return PARADA.LIMITE_CATALOGO;
    if (frenadoElAvatar) return PARADA.LIMITE_AVATAR;

    // 3. No queda nadie nuevo en la comunidad: se le dio la vuelta entera.
    if (rotacion.topePaginas) return PARADA.TOPE_CANDIDATOS;
    if (rotacion.agotado) return PARADA.SIN_CANDIDATOS;

    // 4. Techo duro de seguridad. NO es el presupuesto previsto: es la
    //    proteccion contra un bucle. Llegar aqui NO significa que en esa
    //    comunidad no haya outfits en el rango pedido — significa unicamente
    //    que no conseguimos demostrar los suficientes dentro de nuestros
    //    limites seguros, y que reintentar puede dar mas (la rotacion continua
    //    donde quedo, asi que la siguiente busqueda mira gente nueva).
    if (examinados >= techoCandidatos) return PARADA.TOPE_CANDIDATOS;

    // 5. Tiempo, con sus DOS relojes. El de TRABAJO no corre mientras la
    //    busqueda esta parada esperando a Roblox; el de PARED corre siempre y
    //    es lo que impide que la suma de pausas no acabe nunca. El reloj
    //    arranca al empezar a BUSCAR: esperar turno del grupo tampoco cuenta.
    if (trabajadoMs >= tiempoMs) return PARADA.TIEMPO;
    if (relojRestante <= 0) return PARADA.TIEMPO;

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
// que emiten el limitador y la capa de base de datos lleven el requestId Y el
// searchId de ESTA busqueda: sin eso, un 429 o un fallo de Postgres en el log
// no se pueden cruzar con la busqueda que los provoco — y en modo asincrono la
// peticion HTTP ya termino hace minutos, asi que el searchId es lo unico que
// queda para atarlos.
function searchOutfits(peticion, opciones = {}) {
    return requestContext.ejecutarCon(
        { requestId: opciones.requestId ?? null, searchId: opciones.searchId ?? null },
        () => ejecutarBusqueda(peticion, opciones)
    );
}

async function ejecutarBusqueda(
    { amount, groupId, minPrice, maxPrice, requireCompletePrice, async: modoAsincrono = false },
    { requestId = null, searchId = null, onProgress = null, onEncolado = null } = {}
) {
    const stats = crearStats();

    // ── Presupuestos de esta busqueda ────────────────────────────────────────
    //
    // Lo que la comunidad enseño en busquedas anteriores sirve para dos cosas
    // distintas: sembrar la estimacion de coste por resultado y dar una ETA
    // creible desde el primer segundo. null en un grupo nuevo o sin base.
    const previas = await repo.leerStats(groupId);

    const techoCandidatos = presupuestos.techoDeCandidatos(amount);
    const techoPaginas = presupuestos.techoDePaginas(techoCandidatos);
    const tiempoMs = presupuestos.presupuestoDeTiempo(amount, { modoAsincrono });
    const relojDeParedMs = presupuestos.techoDeRelojDePared(tiempoMs);

    // La rotacion toma turno del grupo: si otra busqueda lo esta recorriendo,
    // esta espera aqui (sin sondear) y `onEncolado` deja constancia de que esta
    // en cola, no buscando. El lease se pide dimensionado a TODO lo que esta
    // busqueda puede llegar a durar, pausas por limite de Roblox incluidas.
    const rotacion = await abrirRotacion(groupId, stats, {
        onEncolado,
        leaseMs: presupuestos.duracionDelLease(relojDeParedMs),
        maxPaginas: techoPaginas,
    });

    // EL RELOJ ARRANCA AQUI, no al aceptar la peticion. Hacer cola no es
    // buscar: cobrarle la espera al presupuesto dejaba a la segunda busqueda de
    // una comunidad sin tiempo antes de haber mirado a nadie.
    const empezado = Date.now();
    const estimador = crearEstimador({ target: amount, previas });

    // ── DOS RELOJES, Y LA DIFERENCIA ES LA CORRECCION ────────────────────────
    //
    // `tiempoMs` mide TRABAJO. Estar parado porque Roblox pidio esperar no es
    // trabajar, asi que no lo consume: si lo consumiera, una sola pausa de ocho
    // segundos se comeria un tercio del presupuesto de una busqueda de 10 y la
    // dejaria sin tiempo para lo que de verdad quedaba por hacer.
    //
    // `relojDeParedMs` mide TODO, pausas incluidas, porque quien mira el plugin
    // mide en reloj de pared. Es el que impide que "esperar en vez de rendirse"
    // se convierta en "no terminar nunca".
    const trabajadoMs = () => Date.now() - empezado - puerta.esperadoMs;
    const relojRestante = () => relojDeParedMs - (Date.now() - empezado);

    // La puerta que convierte un cooldown de Roblox en una PAUSA en vez de en
    // el final de la busqueda. Su presupuesto es lo que quede de espera y lo que
    // quede de reloj de pared, lo que sea menor: nunca se empieza una pausa que
    // no se pueda terminar.
    const puerta = crearPuerta(stats, {
        presupuestoDeEspera: () => Math.min(
            config.pluginSearch.rateLimitWaitBudgetMs - puerta.esperadoMs,
            relojRestante()
        ),
    });

    const indice = crearIndiceDeCatalogo(stats, { puerta });
    const bundles = crearIndiceDeBundles(stats);

    const encontrados = [];
    const yaIncluidos = new Set(); // ningun userId repetido en la respuesta
    let examinados = 0;
    let segmentosVacios = 0;
    let frenadoElAvatar = false; // la puerta del avatar se quedo sin presupuesto
    let deseado = presupuestos.presupuestoDeseado({ amount, encontrados: 0, examinados: 0, previas });
    let coste = presupuestos.costePorResultado({ examinados: 0, encontrados: 0, previas });
    let progreso = estimador.progreso({ examinados: 0, encontrados: 0 });

    const estadoDeParada = () => ({
        encontrados: encontrados.length, amount, examinados, techoCandidatos,
        trabajadoMs: trabajadoMs(), relojRestante: relojRestante(),
        tiempoMs, indice, rotacion, frenadoElAvatar,
    });

    try {
        for (;;) {
            const parada = motivoParaParar(estadoDeParada());
            if (parada) { stats.pararPor(parada); break; }

            // ── Presupuesto DESEADO, recalculado con la evidencia de ahora ───
            //
            // Es una PREVISION, no un limite: sube cuando la comunidad resulta
            // cara y por eso una busqueda de 10 outfits con un 3% de aceptacion
            // ya no termina en 60 candidatos con 2 resultados. Lo unico que
            // acota de verdad es el techo duro, que ya se comprobo arriba.
            coste = presupuestos.costePorResultado({
                examinados, encontrados: encontrados.length, previas,
            });
            deseado = presupuestos.presupuestoDeseado({
                amount, encontrados: encontrados.length, examinados, previas,
            });

            // ── Puerta del AVATAR, antes de tocar la rotacion ────────────────
            //
            // Se pregunta ANTES de pedir el tramo, no despues, y el orden
            // importa: un tramo pedido es comunidad consumida — la rotacion da
            // por vistos a esos miembros — asi que sacarlos para descubrir
            // acto seguido que no podemos mirar sus avatares los perderia hasta
            // la siguiente vuelta entera al grupo.
            //
            // Si el avatar esta frenado se ESPERA lo que Roblox pida y se
            // sigue. Solo si esa espera no cabe se enciende la bandera y la
            // parada de arriba la recoge en la siguiente vuelta.
            const puertaAvatar = await puerta.abrir(RUTA_AVATAR);
            if (puertaAvatar === VEREDICTO.AGOTADO) { frenadoElAvatar = true; continue; }

            // ── Etapa 0: siguiente tramo de la comunidad ─────────────────────
            //
            // El tramo se dimensiona con la tasa de aceptacion VIVA, y empieza
            // OPTIMISTA: un candidato por resultado que falte. Quedarse corto es
            // barato — se pide otro tramo — mientras que pasarse cuesta llamadas
            // de avatar que NO se recuperan y ademas consume comunidad: cada
            // miembro traido de mas es un miembro que la rotacion da por visto.
            //
            // En cuanto se sabe que la cosa va cara (o que todavia no ha
            // entrado ninguno) el tramo crece hasta la ola completa, que es el
            // tamaño para el que esta afinado el lote de catalogo.
            const faltan = amount - encontrados.length;
            const tasa = encontrados.length > 0
                ? encontrados.length / examinados
                : (examinados > 0 ? 0 : 1); // 0 = nada ha entrado aun: ola completa
            const deseados = Math.min(
                config.pluginRotation.segmentSize,
                Math.max(config.pluginSearch.concurrency, Math.ceil(faltan / tasa)),
                techoCandidatos - examinados
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

    const paradaFinal = motivoParaParar(estadoDeParada());
    if (paradaFinal) stats.pararPor(paradaFinal);

    stats.anotarRotacion({
        modo: rotacion.modo,
        cycle: rotacion.cycle,
        inicio: rotacion.inicio,
        fin: rotacion.posicion,
        wraps: rotacion.wraps,
        cursorResets: rotacion.cursorResets,
    });

    // La prevision, ya cerrada. Se calcula UNA vez y se usa tanto en stats como
    // en el log: dos numeros con el mismo nombre y valores distintos mandan a
    // buscar el problema donde no esta.
    deseado = presupuestos.presupuestoDeseado({
        amount, encontrados: encontrados.length, examinados, previas,
    });

    stats.anotarPresupuestos({
        deseado,
        techo: techoCandidatos,
        // Los dos numeros por resultado, y hacen falta los dos: el que el techo
        // PERMITE para este `amount` y el que la busqueda ESTA COSTANDO. Juntos
        // dicen de un vistazo cuanto margen quedaba cuando se corto.
        porResultadoEfectivo: presupuestos.candidatosPorResultadoEfectivos(amount),
        techoPaginas,
        tiempoMs,
        relojDeParedMs,
        costePorResultado: Math.round(coste * 100) / 100,
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

    // UNA linea por busqueda, agregada. Nunca una por candidato. Lleva los dos
    // identificadores de correlacion (requestId y searchId) para poder cruzarla
    // con las lineas del limitador y de Postgres, que llevan los mismos.
    logger.info('Busqueda de outfits del plugin', {
        requestId,
        searchId,
        groupId,
        amount,
        minPrice,
        maxPrice,
        requireCompletePrice,
        async: modoAsincrono,
        found: encontrados.length,
        estimatedRemainingMs: progreso.estimatedRemainingMs,
        // Los presupuestos NO se repiten aqui: `publicas` ya trae
        // desiredCandidateBudget, hardCandidateLimit,
        // effectiveHardCandidatesPerResult, memberPageLimit y timeBudgetMs.
        // Duplicarlos con otro nombre solo crea dos numeros que pueden acabar
        // diciendo cosas distintas.
        ...publicas,
    });

    return { outfits: encontrados.slice(0, amount), stats: publicas, progress: progreso };
}

module.exports = { searchOutfits, presupuestoDeCandidatos };
