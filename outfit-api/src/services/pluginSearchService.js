'use strict';

const config = require('../config');
const logger = require('../observability/logger');
const requestContext = require('../observability/requestContext');
const rateLimiter = require('../roblox/rateLimiter');
const repo = require('../db/pluginRotationRepo');
const crawlRepo = require('../db/indexCrawlRepo');
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
//   avatarWave    que lleva puesto cada uno      (1 llamada / candidato, gateada POR PETICION)
//   catalogIndex  ficha de los assets, POR LOTES (1 llamada / ~120 assets nuevos)
//   bundleIndex   precio de las partes de bundle
//   pricing       clasificacion, valoracion, filtros (puro, sin red)
//   budget        presupuestos y techos              (puro)
//   throttleGate  park / resume ante un limite de Roblox
//   eta           estimacion de tiempo restante      (puro)
//   stats         contabilidad y motivo de parada
//
// CUATRO IDEAS SOSTIENEN TODO LO DEMAS:
//
// 1. POR OLAS. El avatar no admite lote (una llamada por candidato,
//    irreductible) pero el catalogo SI (~120 assets por llamada). Se traen los
//    avatares de una ola entera, se juntan TODOS sus assets, se deduplican
//    contra lo ya resuelto y se pide al catalogo una sola vez lo que falta.
//
// 2. `amount` SON OUTFITS VALIDOS, NO INTENTOS. Un candidato que falla (avatar
//    inaccesible, precio fuera de rango, sin poder valorar) NO gasta una plaza:
//    se sustituye por el siguiente de la comunidad. La busqueda sigue pidiendo
//    segmentos —y paginas, y ciclos— hasta juntar `amount`.
//
// 3. UN LIMITE DE ROBLOX ES UNA PAUSA, NO UN FINAL. Cuando una ruta pide
//    esperar, la busqueda se ESTACIONA: persiste su checkpoint, mantiene el
//    grupo reservado, no manda ni una peticion, y reanuda al llegar resumeAt
//    exactamente donde estaba — en este proceso, o en otro si este muere.
//    Puede atravesar varios cooldowns; eso es lo normal, no la excepcion. Y un
//    candidato al que el limite no dejo mirar NO es un candidato invalido: se
//    queda pendiente y se retoma.
//
// 4. EL PRESUPUESTO PREVISTO NO TERMINA NADA. Que la busqueda salga mas cara de
//    lo estimado sube la estimacion, no corta el recorrido. Lo que termina una
//    busqueda es una de estas cosas, y solo estas:
//
//       1. `amount` alcanzado                          -> completed
//       2. vuelta completa a la comunidad              -> candidatesExhausted
//       3. catalogo frenado y la pausa YA NO CABE      -> catalogRateLimit
//       4. avatar frenado y la pausa YA NO CABE        -> avatarRateLimit
//       5. presupuesto de TRABAJO o de RELOJ DE PARED  -> timeBudget
//       6. techo duro de seguridad (anti-bucle)        -> candidateCap
//
//    Los motivos 3-6 son PROTECCIONES EXTREMAS. En una busqueda sana no
//    aparecen; cuando aparecen en una busqueda pequeña son un sintoma.

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
function motivoParaParar({
    encontrados, amount, examinados, techoCandidatos,
    trabajadoMs, relojRestante, tiempoMs, indice, rotacion, frenadoElAvatar,
}) {
    // 1. Ya esta lo pedido. Va PRIMERO: una busqueda que junto sus `amount`
    //    outfits termino bien, aunque por el camino Roblox nos frenara un rato.
    if (encontrados >= amount) return PARADA.COMPLETO;

    // 2. Roblox nos esta frenando Y LA PAUSA YA NO CABE. Ojo al matiz, que es
    //    todo el arreglo: un cooldown por si solo NO llega aqui. Un cooldown se
    //    espera estacionado (ver throttleGate.js) y la busqueda continua. Estas
    //    dos banderas se encienden unicamente cuando la pausa que Roblox pide
    //    no entra en lo que queda de reloj de pared — entonces si, se para y se
    //    devuelve lo encontrado. UN MOTIVO POR RUTA: son dos endpoints con
    //    cuotas independientes y arreglos distintos.
    //
    // El motivo nombra LA RUTA QUE ESTA CERRADA, la haya cerrado esta busqueda
    // o la anterior: es el endpoint que hay que ir a mirar y la cuota que hay
    // que dejar respirar. Cuantas peticiones puso ESTA busqueda se lee aparte,
    // en `avatarRequests` / `catalogBatches`: un motivo de ruta con cero
    // peticiones propias significa "me encontre la puerta cerrada al llegar",
    // y en modo asincrono ya no puede terminar una busqueda — se espera.
    if (indice.frenadoPorLimite) return PARADA.LIMITE_CATALOGO;
    if (frenadoElAvatar) return PARADA.LIMITE_AVATAR;

    // 3. No queda nadie nuevo en la comunidad: se le dio la vuelta entera.
    if (rotacion.topePaginas) return PARADA.TOPE_CANDIDATOS;
    if (rotacion.agotado) return PARADA.SIN_CANDIDATOS;

    // 4. Techo duro de seguridad. NO es el presupuesto previsto: es la
    //    proteccion contra un bucle. Llegar aqui NO significa que en esa
    //    comunidad no haya outfits en el rango pedido — significa unicamente
    //    que no conseguimos demostrar los suficientes dentro de nuestros
    //    limites seguros, y que reintentar puede dar mas.
    if (examinados >= techoCandidatos) return PARADA.TOPE_CANDIDATOS;

    // 5. Tiempo, con sus DOS relojes. El de TRABAJO no corre mientras la
    //    busqueda esta estacionada; el de PARED corre siempre y es lo que
    //    impide que la suma de pausas no acabe nunca. Los dos arrancan al
    //    empezar a BUSCAR: esperar turno del grupo tampoco cuenta.
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
// searchId de ESTA busqueda.
function searchOutfits(peticion, opciones = {}) {
    return requestContext.ejecutarCon(
        {
            requestId: opciones.requestId ?? null,
            searchId: opciones.searchId ?? null,
            groupId: peticion?.groupId != null ? Number(peticion.groupId) : null,
        },
        () => ejecutarBusqueda(peticion, opciones)
    );
}

// Version del formato de checkpoint. Un checkpoint de otra version se ignora y
// la busqueda arranca de cero con el mismo searchId: mejor repetir trabajo que
// interpretar mal un campo.
const CHECKPOINT_VERSION = 1;

async function ejecutarBusqueda(
    { amount, groupId, minPrice, maxPrice, requireCompletePrice, async: modoAsincrono = false },
    {
        requestId = null, searchId = null, checkpoint = null,
        onProgress = null, onEncolado = null,
        onParquear = null, onLatido = null, onReanudar = null, onCheckpoint = null,
        // ¿Sigue siendo este proceso el dueño del trabajo? Lo sabe el registro
        // de trabajos (por su latido). Se pregunta ANTES de gastar nada: una
        // busqueda cuyo trabajo se traspaso o se solto no debe tocar ni la
        // rotacion ni Roblox, aunque acabe de conseguir el turno del grupo.
        esDueño = () => true,
    } = {}
) {
    const stats = crearStats();

    // ── Reanudacion desde un checkpoint ──────────────────────────────────────
    //
    // Si esta busqueda la empezo otra instancia (o este proceso antes de un
    // reinicio), todo lo que ya se sabia vuelve aqui: los outfits encontrados,
    // los candidatos que quedaron pendientes por un limite, los contadores y
    // los relojes. Nada de eso se recalcula ni se repite.
    const reanudacion = checkpoint?.version === CHECKPOINT_VERSION ? checkpoint : null;
    if (checkpoint && !reanudacion) {
        logger.warn('Checkpoint de otra version: la busqueda arranca de cero con el mismo searchId', {
            searchId, version: checkpoint?.version ?? null,
        });
    }
    if (reanudacion) stats.restaurar(reanudacion.contadores);

    // ── Presupuestos de esta busqueda ────────────────────────────────────────
    const previas = await repo.leerStats(groupId);

    const techoCandidatos = presupuestos.techoDeCandidatos(amount);
    const techoPaginas = presupuestos.techoDePaginas(techoCandidatos);
    const tiempoMs = presupuestos.presupuestoDeTiempo(amount, { modoAsincrono });
    const relojDeParedMs = presupuestos.techoDeRelojDePared(tiempoMs, { modoAsincrono });

    const encontrados = reanudacion ? [...reanudacion.outfits] : [];
    const yaIncluidos = new Set(encontrados.map(o => String(o.userId)));
    // Candidatos que se entregaron y NO se pudieron mirar porque Roblox tenia
    // la ruta cerrada. Van PRIMERO en la siguiente ola. No cuentan como
    // examinados, no avanzan la rotacion y viajan en el checkpoint.
    const pendientes = reanudacion ? [...reanudacion.pendientes] : [];

    // La rotacion toma turno del grupo: si otra busqueda lo esta recorriendo,
    // esta espera aqui (sin sondear). El lease se pide dimensionado a TODO lo
    // que esta busqueda puede llegar a durar, pausas incluidas.
    const rotacion = await abrirRotacion(groupId, stats, {
        onEncolado,
        leaseMs: presupuestos.duracionDelLease(relojDeParedMs),
        maxPaginas: techoPaginas,
        yaVistos: [...yaIncluidos, ...pendientes.map(m => String(m.userId))],
    });

    // Con el turno del grupo en la mano, ANTES de mover nada: ¿sigue siendo
    // nuestro el trabajo? Mientras se esperaba turno pudo traspasarse (o
    // soltarse en un apagado). Si ya no lo es, se suelta el turno sin haber
    // avanzado el cursor ni gastado una llamada.
    if (!esDueño()) {
        await rotacion.cerrar({ guardarAvance: false });
        throw trabajoPerdido(searchId);
    }

    // EL RELOJ ARRANCA AQUI, no al aceptar la peticion. Hacer cola no es
    // buscar. Y al reanudar, los relojes continuan desde lo que ya llevaban.
    const empezado = Date.now();
    const trabajadoPrevio = reanudacion?.relojes?.trabajadoMs ?? 0;
    const paredPrevia = reanudacion?.relojes?.wallElapsedMs ?? 0;
    const esperadoPrevio = reanudacion?.relojes?.esperadoMs ?? 0;

    const estimador = crearEstimador({ target: amount, previas });
    if (reanudacion) estimador.restaurar({ pausadoMs: reanudacion.relojes?.pausadoMs ?? 0 });

    // ── DOS RELOJES, Y LA DIFERENCIA ES LA CORRECCION ────────────────────────
    //
    // `tiempoMs` mide TRABAJO (maxWorking). Estar estacionado porque Roblox
    // pidio esperar no es trabajar, asi que no lo consume.
    //
    // `relojDeParedMs` mide TODO (maxWallClock), pausas incluidas, porque quien
    // mira el plugin mide en reloj de pared. Es el que impide que "esperar en
    // vez de rendirse" se convierta en "no terminar nunca".
    const esperadoAqui = () => puerta.esperadoMs - esperadoPrevio;
    const trabajadoMs = () => trabajadoPrevio + (Date.now() - empezado) - esperadoAqui();
    const relojRestante = () => relojDeParedMs - paredPrevia - (Date.now() - empezado);

    let examinados = reanudacion?.examinados ?? 0;
    let segmentosVacios = 0;
    let frenadoElAvatar = false;
    let olaEnCurso = [];   // miembros de la ola actual aun sin veredicto
    let deseado = presupuestos.presupuestoDeseado({ amount, encontrados: encontrados.length, examinados, previas });
    let coste = presupuestos.costePorResultado({ examinados, encontrados: encontrados.length, previas });
    let progreso = estimador.progreso({ examinados, encontrados: encontrados.length });

    // La foto exacta para seguir desde aqui en cualquier proceso. `extraPendientes`
    // son los candidatos de la ola en curso cuando la pausa cae a mitad de ola:
    // ya tienen avatar (cacheado), pero aun no tienen veredicto.
    const construirCheckpoint = (parqueo = null) => ({
        version: CHECKPOINT_VERSION,
        outfits: encontrados.slice(),
        pendientes: [...olaEnCurso, ...pendientes].map(m => ({ userId: m.userId, username: m.username })),
        examinados,
        contadores: stats.instantanea(),
        relojes: {
            trabajadoMs: Math.max(0, Math.round(trabajadoMs())),
            wallElapsedMs: Math.max(0, paredPrevia + (Date.now() - empezado)),
            esperadoMs: puerta.esperadoMs,
            esperas: puerta.esperas,
            pausadoMs: progreso.pausedMs ?? 0,
        },
        parqueo: parqueo ? { route: parqueo.route, resumeAt: parqueo.resumeAt } : null,
    });

    // ── La puerta: un cooldown de Roblox es una PAUSA, no un final ───────────
    //
    // Sus ganchos son lo que hace la pausa DURABLE: al estacionar se baja el
    // checkpoint y se renueva el lease; en cada latido se refresca el trabajo y
    // el lease; al reanudar se deja constancia. Cualquiera de ellos lanza si
    // otra instancia adopto el trabajo o si el lease dejo de ser nuestro — y ese
    // lanzamiento sube tal cual: es la señal de que este proceso tiene que
    // soltar la busqueda.
    let inicioDePausa = 0;
    const puerta = crearPuerta(stats, {
        // EL PRESUPUESTO DE ESPERA ES EL DE ESPERA, y en modo asincrono NO se
        // recorta con el reloj de pared. Nadie sostiene un socket: esperar es
        // gratis para quien mira el plugin, que ve la fase 'rateLimitWait' y
        // sus outfits acumulados. Lo que acota el total sigue existiendo y son
        // dos cosas distintas: este presupuesto acota lo ESPERADO, y el reloj
        // de pared acota la vida entera del trabajo desde el bucle (motivo
        // 'timeBudget', que es la verdad). Mezclarlos hacia que un cooldown
        // HEREDADO de otra busqueda — 25 s que ya estaban corriendo cuando esta
        // empezo — no cupiera en el reloj y terminara la busqueda al instante.
        //
        // En modo SINCRONO si se recorta: ahi hay un socket abierto y su plazo
        // manda sobre cualquier ganas de esperar.
        presupuestoDeEspera: () => (modoAsincrono
            ? config.pluginSearch.rateLimitWaitBudgetMs - puerta.esperadoMs
            : Math.min(config.pluginSearch.rateLimitWaitBudgetMs - puerta.esperadoMs, relojRestante())),
        alParquear: async info => {
            inicioDePausa = puerta.esperadoMs;
            if (!(await rotacion.renovar())) throw leasePerdido(groupId);
            progreso = estimador.progreso({ examinados, encontrados: encontrados.length, parqueo: info });
            await onParquear?.({ ...info, checkpoint: construirCheckpoint(info), progreso });
        },
        latido: async info => {
            if (!(await rotacion.renovar())) throw leasePerdido(groupId);
            progreso = estimador.progreso({ examinados, encontrados: encontrados.length, parqueo: info });
            await onLatido?.(progreso);
        },
        alReanudar: async () => {
            estimador.pausar(puerta.esperadoMs - inicioDePausa);
            progreso = estimador.progreso({ examinados, encontrados: encontrados.length });
            await onReanudar?.(progreso);
        },
    });
    if (reanudacion) puerta.restaurar(reanudacion.relojes);

    // Si el checkpoint dice que Roblox tenia una ruta cerrada hasta cierto
    // instante, se reaplica: el limitador de este proceso no lo sabe (su
    // estado vive en memoria) y sin esto la primera ola saldria contra una
    // ruta que Roblox ya dijo que estaba cerrada.
    if (reanudacion?.parqueo?.resumeAt > Date.now()) {
        rateLimiter.imponerCooldown(reanudacion.parqueo.route, reanudacion.parqueo.resumeAt, 'checkpoint');
    }

    const indice = crearIndiceDeCatalogo(stats, { puerta });
    const bundles = crearIndiceDeBundles(stats);

    // Llamadas REALES que salieron por las dos rutas, contadas por el propio
    // limitador. `avatarRequests` cuenta lo que pidio la busqueda; esto cuenta
    // ademas lo que el limitador reintento por su cuenta tras esperar un
    // Retry-After corto. Es el numero exacto de lo que Roblox recibio de este
    // proceso durante la busqueda (proceso entero: con dos busquedas a la vez
    // en la misma instancia, se reparte entre las dos).
    const llamadasDeRuta = ruta => rateLimiter.getMetrics().byRoute[ruta]?.calls ?? 0;
    const llamadasAlEmpezar = { userAvatar: llamadasDeRuta('userAvatar'), catalogDetails: llamadasDeRuta('catalogDetails') };

    const estadoDeParada = () => ({
        encontrados: encontrados.length, amount, examinados, techoCandidatos,
        trabajadoMs: trabajadoMs(), relojRestante: relojRestante(),
        tiempoMs, indice, rotacion, frenadoElAvatar,
    });

    // Si el trabajo deja de ser nuestro a mitad, la rotacion se cierra SIN
    // guardar avance: lo que esta busqueda hubiera entregado sin veredicto lo
    // volvera a entregar a quien continue. Guardar avance de un trabajo que ya
    // continua otra instancia le saltaria candidatos.
    let perdido = false;

    try {
        for (;;) {
            if (!esDueño()) { perdido = true; throw trabajoPerdido(searchId); }

            const parada = motivoParaParar(estadoDeParada());
            if (parada) { stats.pararPor(parada); break; }

            // ── Presupuesto DESEADO, recalculado con la evidencia de ahora ───
            coste = presupuestos.costePorResultado({ examinados, encontrados: encontrados.length, previas });
            deseado = presupuestos.presupuestoDeseado({ amount, encontrados: encontrados.length, examinados, previas });

            // ── Etapa 0: candidatos. Los PENDIENTES van primero ──────────────
            //
            // Un candidato que quedo pendiente por un limite se retoma antes
            // de pedirle nadie nuevo a la comunidad: se le debe un veredicto, y
            // la rotacion ya lo dio por entregado.
            let segmento;
            if (pendientes.length > 0) {
                segmento = pendientes.splice(0, config.pluginRotation.segmentSize);
                stats.sumar('deferredResumed', segmento.length);
            } else {
                // El tramo se dimensiona con la tasa de aceptacion VIVA, y
                // empieza OPTIMISTA: un candidato por resultado que falte.
                // Quedarse corto es barato — se pide otro tramo — mientras que
                // pasarse cuesta avatares que NO se recuperan y consume
                // comunidad. En cuanto se sabe que la cosa va cara (o que aun
                // no ha entrado ninguno) el tramo crece hasta la ola completa.
                const faltan = amount - encontrados.length;
                const tasa = encontrados.length > 0
                    ? encontrados.length / examinados
                    : (examinados > 0 ? 0 : 1);
                const deseados = Math.min(
                    config.pluginRotation.segmentSize,
                    Math.max(config.pluginSearch.concurrency, Math.ceil(faltan / tasa)),
                    techoCandidatos - examinados
                );

                segmento = await rotacion.siguienteSegmento(Math.max(1, deseados));

                if (segmento.length === 0) {
                    segmentosVacios++;
                    stats.sumar('emptySegments');
                    if (segmentosVacios >= config.pluginRotation.emptySegmentsBeforeExhausted) {
                        stats.pararPor(PARADA.SIN_CANDIDATOS);
                        break;
                    }
                    continue;
                }
                segmentosVacios = 0;
            }
            olaEnCurso = segmento;

            // ── Etapa 2: avatares, gateados POR PETICION ─────────────────────
            // Cada candidato mira la cache primero (un acierto no necesita
            // permiso ni ruta) y solo despues pregunta si la ruta esta abierta
            // PARA ESA PETICION. En cuanto se cierra a mitad de ola, el resto
            // NO se despacha y vuelve a pendientes. Lo que ya estaba en vuelo
            // termina.
            const ola = await traerOla(segmento, stats, config.pluginSearch.concurrency);
            if (ola.pendientes.length > 0) pendientes.unshift(...ola.pendientes);
            olaEnCurso = ola.resultados.map(r => r.miembro);

            // ── Etapa 3: UN solo paso de catalogo para toda la ola ───────────
            // El indice tiene la misma puerta: si el catalogo pide esperar, se
            // estaciona (con esta ola en el checkpoint) y se reanuda el lote.
            const assetsDeLaOla = [];
            for (const resultado of ola.resultados) {
                if (resultado.ok) assetsDeLaOla.push(...resultado.assetIds);
            }
            await indice.asegurar(assetsDeLaOla);

            // ── Etapa 3b: bundles, SOLO para lo que no tiene precio propio ───
            const sinPrecioPropio = [...new Set(assetsDeLaOla)]
                .filter(assetId => necesitaBundle(indice.ficha(assetId)));
            if (sinPrecioPropio.length > 0) await bundles.asegurar(sinPrecioPropio);

            // ── Etapas 4 y 5: valoracion y politica, ya sin tocar la red ─────
            // `examinados` sube POR VEREDICTO, no por tramo: un candidato solo
            // cuenta cuando se ha decidido algo sobre el.
            for (const resultado of ola.resultados) {
                examinados++;

                if (!resultado.ok) { stats.rechazar(resultado.motivo); continue; }

                const valorado = valorar(resultado.assetIds, indice, bundles);
                if (!valorado.ok) { stats.rechazar(valorado.motivo); continue; }

                const v = valorado.valoracion;
                anotarComposicion(stats, v);

                const politica = aplicarPolitica(v, { requireCompletePrice, minPrice, maxPrice });
                if (!politica.ok) { stats.rechazar(politica.motivo); continue; }

                // Defensivo: la rotacion ya deduplica dentro de la busqueda.
                if (yaIncluidos.has(String(resultado.miembro.userId))) continue;

                stats.aceptar();
                yaIncluidos.add(String(resultado.miembro.userId));
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

                // NO se corta la ola al llegar a `amount`: sus avatares ya
                // estan pagados y valorados. El sobrante se recorta al final.
            }
            olaEnCurso = [];

            // ── Progreso, checkpoint y persistencia, UNA vez por ola ─────────
            estimador.observar({ examinados, encontrados: encontrados.length });
            progreso = estimador.progreso({ examinados, encontrados: encontrados.length });
            onCheckpoint?.(construirCheckpoint());
            await onProgress?.(progreso);

            // La rotacion guarda hasta DONDE EMPIEZAN LOS PENDIENTES. Un
            // pendiente es un miembro entregado sin veredicto: guardar por
            // encima de el lo perderia. Pero no guardar NADA por su culpa
            // tiraba tambien el prefijo ya procesado, y era el segundo fallo de
            // produccion: tras una busqueda frenada, la siguiente volvia a
            // examinar desde el principio a los cientos de miembros que ya
            // tenian veredicto. Se guarda el prefijo y se retoman solo ellos.
            await rotacion.persistirHasta(pendientes);

            // ── Puerta del AVATAR: solo si hay trabajo BLOQUEADO ─────────────
            //
            // Se pregunta DESPUES de la ola y no antes, y la diferencia es
            // exactamente el caso de la cache: con los avatares ya en cache la
            // ola entera pasa sin tocar la ruta, aunque Roblox la tenga cerrada,
            // y estacionarse ahi habria sido esperar por nada. Solo cuando la
            // ola dejo candidatos pendientes Y la ruta sigue cerrada hay algo
            // que esperar: se ESTACIONA lo que Roblox pida, y a la vuelta los
            // pendientes van los primeros. Si la pausa no cabe, se enciende la
            // bandera y la parada de arriba la recoge en la siguiente vuelta.
            if (pendientes.length > 0 && encontrados.length < amount) {
                const puertaAvatar = await puerta.abrir(RUTA_AVATAR);
                if (puertaAvatar === VEREDICTO.AGOTADO) frenadoElAvatar = true;
            }
        }
    } catch (err) {
        // Un traspaso detectado en cualquier gancho (progreso, latido de
        // pausa, checkpoint) llega aqui como 'job_adopted': la rotacion no
        // debe guardar avance por encima de lo que otra instancia continuara.
        if (err?.code === 'job_adopted') perdido = true;
        throw err;
    } finally {
        // SIEMPRE: un lease sin soltar bloquea el grupo hasta que caduque. Con
        // pendientes en la mano se guarda solo hasta el primero de ellos (el
        // prefijo procesado no se repite, los pendientes si se vuelven a
        // entregar). Si el trabajo YA NO ES NUESTRO no se guarda nada: quien lo
        // continua movera el cursor, y moverlo dos veces saltaria candidatos.
        await rotacion.cerrar({ guardarAvance: !perdido, hasta: pendientes });
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

    deseado = presupuestos.presupuestoDeseado({ amount, encontrados: encontrados.length, examinados, previas });
    stats.anotarPresupuestos({
        deseado,
        techo: techoCandidatos,
        porResultadoEfectivo: presupuestos.candidatosPorResultadoEfectivos(amount),
        techoPaginas,
        tiempoMs,
        relojDeParedMs,
        costePorResultado: Math.round(coste * 100) / 100,
        avatarRouteCalls: Math.max(0, llamadasDeRuta('userAvatar') - llamadasAlEmpezar.userAvatar),
        catalogRouteCalls: Math.max(0, llamadasDeRuta('catalogDetails') - llamadasAlEmpezar.catalogDetails),
    });

    const publicas = stats.publicar();
    progreso = estimador.progreso({ examinados, encontrados: encontrados.length });

    // Lo que esta busqueda le enseña a la comunidad para la proxima.
    if (examinados > 0) {
        await repo.registrarBusqueda(groupId, estimador.muestraFinal({
            examinados, encontrados: encontrados.length,
        }));
    }

    // DEMANDA DE INDEXADO. Una busqueda que no junto lo que le pidieron es la
    // señal de que esa comunidad necesita mas indice, y es lo que hace que el
    // worker vaya donde se busca en vez de recorrer la whitelist entera.
    //
    // No cambia nada de lo que se devuelve. Va detras del resultado, se traga
    // sus propios fallos y no puede alterar el contrato del POST: en la fase 1
    // nadie lee todavia el indice, asi que esto es solo una nota para el worker.
    if (encontrados.length < amount) {
        try {
            await crawlRepo.registrarDemanda(groupId, { faltan: amount - encontrados.length });
        } catch { /* la demanda es una pista, no un requisito */ }
    }

    // UNA linea por busqueda, agregada. Nunca una por candidato.
    logger.info('Busqueda de outfits del plugin', {
        requestId,
        searchId,
        groupId,
        amount,
        minPrice,
        maxPrice,
        requireCompletePrice,
        async: modoAsincrono,
        resumed: Boolean(reanudacion),
        found: encontrados.length,
        pendingCandidates: pendientes.length,
        estimatedRemainingMs: progreso.estimatedRemainingMs,
        ...publicas,
    });

    return { outfits: encontrados.slice(0, amount), stats: publicas, progress: progreso };
}

function leasePerdido(groupId) {
    const err = new Error(`El lease de rotacion del grupo ${groupId} dejo de ser de esta busqueda`);
    err.code = 'lease_lost';
    return err;
}

// El trabajo ya no es de este proceso (traspasado o soltado). Mismo codigo que
// el error del registro de trabajos, para que el runner lo trate igual: se
// suelta la busqueda sin marcar nada como fallido.
function trabajoPerdido(searchId) {
    const err = new Error(`El trabajo ${searchId} ya no es de esta instancia`);
    err.code = 'job_adopted';
    return err;
}

module.exports = { searchOutfits, presupuestoDeCandidatos };
