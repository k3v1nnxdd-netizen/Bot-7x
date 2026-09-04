'use strict';

const config = require('../../config');
const { MIEMBROS_POR_PAGINA } = require('./memberPool');

// PRESUPUESTOS DE LA BUSQUEDA. Puro: aritmetica sobre lo ya medido, sin red,
// sin base y sin reloj propio salvo el que le pasen.
//
// ── EL PROBLEMA QUE ESTE MODULO ARREGLA ──────────────────────────────────────
//
// Habia UN solo numero de candidatos, calculado una vez antes de empezar:
//
//     min(maxCandidates, max(minCandidates, amount * candidatesPerResult))
//
// Con amount=10 eso daba max(60, 40) = 60, y ese 60 era a la vez el SUELO del
// muestreo y el TECHO de la busqueda. En una comunidad donde solo el 3% de los
// avatares encaja en el rango de precio, 60 candidatos producen 2 outfits: la
// busqueda paraba con `candidateCap`, 2 de 10, sin haber pasado de la primera
// pagina de miembros — no porque no hubiera outfits, sino porque el presupuesto
// se habia dimensionado suponiendo que cada resultado costaria 4 intentos.
//
// ── LA SEPARACION ────────────────────────────────────────────────────────────
//
//   DESEADO      Cuantos candidatos ESPERAMOS necesitar, recalculado en cada
//                vuelta con la evidencia que hay en ese momento. Es una
//                PREVISION: dimensiona, estima y explica. NO termina la
//                busqueda. Que un grupo salga caro sube el numero, no corta.
//
//   TECHO DURO   Proteccion extrema contra bucles, calculado una vez por
//                `amount`. Esta dimensionado para NO alcanzarse en una busqueda
//                sana: lo normal es terminar por `amount` alcanzado, por vuelta
//                completa a la comunidad, por limite real de Roblox o por
//                tiempo.
//
// El deseado NUNCA supera al techo duro, asi que quien dimensiona con el deseado
// tampoco puede pasarse.

function acotar(valor, minimo, maximo) {
    return Math.min(maximo, Math.max(minimo, valor));
}

// COSTE POR RESULTADO: cuantos candidatos cuesta, hoy, cada outfit valido.
//
// Tres fuentes, y se usan en este orden de preferencia segun la muestra que
// haya, porque las tres son buenas en momentos distintos:
//
//   1. La tasa VIVA de esta busqueda. Es la unica que refleja el rango de
//      precio PEDIDO AHORA — el historial del grupo se hizo con otros filtros.
//   2. La EWMA historica del grupo (Postgres). Sirve desde el candidato cero,
//      cuando la tasa viva todavia es ruido.
//   3. La constante de configuracion, para un grupo nuevo sin historial.
//
// La 1 y la 2 se MEZCLAN con un peso que crece con la muestra en vez de
// conmutar de golpe: con 10 candidatos examinados, dos aciertos o dos fallos
// mueven la tasa viva a la mitad, y saltar ahi del historial a lo vivo haria
// que el presupuesto pegara un bandazo por ruido puro.
//
// EL CASO `encontrados === 0` es el importante, y el que rompia antes: la tasa
// viva es cero y su inversa infinita. Lo honesto no es ni ignorarlo ni
// rendirse, sino decir "va costando AL MENOS lo que llevamos gastado": el
// coste crece con lo examinado, el deseado crece con el, y la busqueda sigue
// mientras quede presupuesto seguro.
function costePorResultado({ examinados = 0, encontrados = 0, previas = null } = {}) {
    const {
        candidatesPerResult, maxCandidatesPerResult, candidateFullWeightSample,
    } = config.pluginSearch;

    const historico = Number.isFinite(previas?.candidatesPerResult) && previas.candidatesPerResult > 0
        ? previas.candidatesPerResult
        : candidatesPerResult;

    if (examinados <= 0) return acotar(historico, 1, maxCandidatesPerResult);

    if (encontrados <= 0) {
        // Todavia ninguno. Cuesta, como minimo, todo lo que llevamos mirado.
        return acotar(Math.max(historico, examinados), 1, maxCandidatesPerResult);
    }

    const vivo = examinados / encontrados;
    const peso = Math.min(1, examinados / Math.max(1, candidateFullWeightSample));
    return acotar(vivo * peso + historico * (1 - peso), 1, maxCandidatesPerResult);
}

// TECHO DURO. Una vez por busqueda, solo a partir de `amount`: no depende de la
// evidencia a proposito, porque una proteccion anti-bucle que se mueva con lo
// que esta pasando deja de ser una proteccion.
//
// LOS TRES TRAMOS, Y EL EFECTO QUE TIENEN. `clamp` significa que la tolerancia
// por resultado NO es constante — cambia con `amount`, y decir "el sistema
// aguanta hasta un X% de aceptacion" sin mas es sencillamente falso:
//
//   amount    techo    candidatos/resultado   tramo
//      1      1 500          1 500            suelo: pedir poco puede recorrer
//     10      1 500            150            una comunidad normal entera
//    100     15 000            150            proporcional
//    500     25 000             50            techo absoluto: el rendimiento
//                                             manda sobre la proporcionalidad
//
// El tramo proporcional (150) es generoso; el de arriba NO, y es deliberado.
// 25 000 candidatos ya son 25 000 llamadas de avatar — la unica etapa que no
// admite lote — y subir ese techo para mantener la proporcion en pedidos
// grandes cargaria la cuota de Roblox del servicio entero para perseguir un
// caso que el presupuesto de tiempo cortaria igualmente antes. Un limite
// conservador y honesto vale mas que una cifra teorica que no se va a alcanzar.
//
// Y LO QUE SIGNIFICA TOCARLO, que importa tanto como el numero: alcanzar el
// techo NO demuestra que en esa comunidad no haya outfits en el rango pedido.
// Demuestra unicamente que no conseguimos encontrar los suficientes dentro de
// nuestros limites seguros. La rotacion continua donde quedo, asi que
// reintentar mira gente nueva y puede perfectamente dar mas.
function techoDeCandidatos(amount) {
    const {
        hardCandidateLimit, hardCandidatesPerResult, minHardCandidates, maxCandidates,
    } = config.pluginSearch;

    // Override explicito: manda sobre el calculo, pero nunca sobre el techo
    // absoluto.
    if (Number.isFinite(hardCandidateLimit) && hardCandidateLimit > 0) {
        return Math.min(hardCandidateLimit, maxCandidates);
    }

    return acotar(amount * hardCandidatesPerResult, minHardCandidates, maxCandidates);
}

// Candidatos por resultado que el techo permite DE VERDAD para este `amount`.
//
// Existe porque `hardCandidatesPerResult` (150) solo describe el tramo
// proporcional: en los extremos, el suelo y el techo absoluto lo cambian sin
// avisar. Publicarlo evita la lectura equivocada de siempre —"el techo son 150
// por resultado"— cuando en una busqueda de 500 son 50, y da el numero con el
// que de verdad se compara la tasa de aceptacion observada.
function candidatosPorResultadoEfectivos(amount) {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return Math.round((techoDeCandidatos(amount) / amount) * 100) / 100;
}

// TECHO DE PAGINAS DE MIEMBROS. Sale del de candidatos, porque una pagina son
// como mucho 100 candidatos: pedir muchas mas paginas de las que ese techo
// puede consumir solo puede significar que las paginas no traen a nadie nuevo,
// que es justo el bucle contra el que esto protege.
//
// El margen cubre las paginas que se gastan legitimamente sin producir
// candidatos: el solape del wrap-around y los miembros ya vistos.
function techoDePaginas(techoCandidatos) {
    const { maxMemberPages, memberPageSlack } = config.pluginSearch;
    const necesarias = Math.ceil(techoCandidatos / MIEMBROS_POR_PAGINA) + memberPageSlack;
    return Math.max(1, Math.min(maxMemberPages, necesarias));
}

// PRESUPUESTO DESEADO. Donde esperamos ACABAR, no cuanto queda: incluye lo ya
// examinado, asi que solo puede crecer conforme la busqueda se pone cara.
//
//   deseado = examinados + (resultados que faltan) x (coste por resultado) x margen
//
// El margen existe porque el coste es una MEDIA: sin el, la mitad de las
// busquedas se quedarian cortas por definicion.
function presupuestoDeseado({ amount, encontrados = 0, examinados = 0, previas = null } = {}) {
    const { minCandidates, candidateBudgetMargin } = config.pluginSearch;

    const techo = techoDeCandidatos(amount);
    const faltan = Math.max(0, amount - encontrados);
    if (faltan === 0) return Math.min(Math.max(examinados, minCandidates), techo);

    const coste = costePorResultado({ examinados, encontrados, previas });
    const margen = Number.isFinite(candidateBudgetMargin) && candidateBudgetMargin > 0
        ? candidateBudgetMargin
        : 1;

    const proyectado = examinados + Math.ceil(faltan * coste * margen);
    return acotar(proyectado, Math.min(minCandidates, techo), techo);
}

// PRESUPUESTO DE TIEMPO. Escala con `amount` porque el trabajo escala con
// `amount`, entre un suelo y un techo.
//
// EL MODO SINCRONO TIENE SU PROPIO TECHO, y no por simetria: ahi hay un socket
// abierto y el HttpService de Roblox tiene su plazo, asi que prometer tres
// minutos seria prometer un timeout. En asincrono no hay nadie sosteniendo
// nada — el plugin pregunta por `searchId` — y el limite puede ser el que el
// trabajo necesita.
function presupuestoDeTiempo(amount, { modoAsincrono = false } = {}) {
    const {
        timeBudgetMs, timeBudgetBaseMs, timeBudgetPerResultMs,
        timeBudgetMinMs, timeBudgetMaxMs, timeBudgetSyncCeilingMs,
    } = config.pluginSearch;

    // Un valor explicito manda sobre el calculo (variable de entorno, o un
    // ajuste en caliente). Incluido el 0, que es como se apaga la busqueda.
    const base = Number.isFinite(timeBudgetMs) && timeBudgetMs >= 0
        ? timeBudgetMs
        : acotar(timeBudgetBaseMs + amount * timeBudgetPerResultMs, timeBudgetMinMs, timeBudgetMaxMs);

    return modoAsincrono ? base : Math.min(base, timeBudgetSyncCeilingMs);
}

// Cuanto tiene que durar el lease de rotacion de ESTA busqueda: lo que puede
// llegar a durar, mas margen. Ver el comentario de pluginRotation.leaseMs.
function duracionDelLease(presupuestoTiempoMs) {
    const { leaseMs, leaseMarginMs } = config.pluginRotation;
    return Math.max(leaseMs, presupuestoTiempoMs + leaseMarginMs);
}

module.exports = {
    costePorResultado,
    presupuestoDeseado,
    techoDeCandidatos,
    candidatosPorResultadoEfectivos,
    techoDePaginas,
    presupuestoDeTiempo,
    duracionDelLease,
};
