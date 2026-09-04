'use strict';

const config = require('../config');
const logger = require('../observability/logger');
const requestContext = require('../observability/requestContext');
const { descubrirCandidatos } = require('./pluginSearch/memberPool');
const { traerOla } = require('./pluginSearch/avatarWave');
const { crearIndiceDeCatalogo } = require('./pluginSearch/catalogIndex');
const { calcularPrecio, dentroDelRango } = require('./pluginSearch/pricing');
const { crearStats, PARADA } = require('./pluginSearch/stats');

// Busqueda de outfits reales para el plugin de Studio. Este archivo es SOLO la
// orquestacion; cada etapa vive en su propio modulo bajo ./pluginSearch/.
//
//   memberPool    descubrimiento de candidatos     (1 llamada / 100 miembros)
//   avatarWave    que lleva puesto cada uno        (1 llamada / candidato)
//   catalogIndex  precio de los assets, POR LOTES  (1 llamada / ~100 assets nuevos)
//   pricing       calculo de precio y filtros      (puro, sin red)
//   stats         contabilidad y motivo de parada
//
// POR QUE POR OLAS, que es la decision que sostiene todo lo demas:
//
// Roblox impone la forma. El avatar de un usuario no admite lote (una llamada
// por candidato, irreductible), pero el catalogo SI (hasta ~100 assets por
// llamada). La version anterior resolvia el catalogo candidato a candidato, asi
// que 60 candidatos costaban 60 llamadas al catalogo con lotes minusculos:
// Roblox devolvia 429, el limitador ponia la ruta en cooldown y la busqueda
// terminaba en found:0 por falta de cuota, no por falta de outfits.
//
// Yendo por olas se traen N avatares, se juntan TODOS sus assets, se deduplican
// contra lo ya resuelto y se pide al catalogo UNA sola vez lo que de verdad
// falta. Las llamadas al catalogo dejan de escalar con el numero de candidatos
// y pasan a escalar con el numero de assets DISTINTOS Y NUEVOS, que en una
// comunidad real crece mucho mas despacio: la ropa se repite muchisimo.
//
// La busqueda prefiere ESTABILIDAD a velocidad bruta. Ante un 429 no insiste:
// para, conserva lo encontrado y lo devuelve como resultado parcial.

// Cuantos candidatos merece la pena examinar para `amount` resultados. Se
// escala con lo pedido (pedir 5 no puede costar lo mismo que pedir 500) pero
// con suelo y techo: el suelo evita que un `amount` pequeño con un rango de
// precio estrecho se quede sin muestra, y el techo impide que esto se convierta
// en un barrido de la comunidad entera.
function cuposDeCandidatos(amount) {
    const { candidatesPerResult, minCandidates, maxCandidates } = config.pluginSearch;
    return Math.min(maxCandidates, Math.max(minCandidates, amount * candidatesPerResult));
}

// Tamaño de la proxima ola, en candidatos.
//
// Ni fijo ni ilimitado. Se dimensiona por lo que FALTA por encontrar, porque
// una ola es trabajo que se paga entero aunque sobre: con `amount` 1 no tiene
// sentido traer 25 avatares para quedarse con uno. Y se acota por arriba con
// `waveSize` para que el lote de catalogo siga siendo predecible y para no
// tener cientos de avatares pendientes de una sola vuelta.
//
// El suelo es la concurrencia: una ola mas pequeña que el pool dejaria
// trabajadores ociosos sin ganar nada a cambio.
function tamanoDeOla(faltan, cupoRestante) {
    const { candidatesPerResult, waveSize, concurrency } = config.pluginSearch;
    const estimado = Math.max(concurrency, faltan * candidatesPerResult);
    return Math.max(1, Math.min(waveSize, estimado, cupoRestante));
}

// Condiciones de parada, en orden de prioridad. Se comprueban ANTES de empezar
// cada ola: cortar a mitad desperdiciaria los avatares ya traidos.
//
// Ninguna es un error. Todas devuelven lo encontrado hasta ese momento, que es
// el contrato: un resultado parcial es util, un 500 no.
function motivoParaParar({ encontrados, amount, examinados, cupo, empezado, indice }) {
    if (indice.frenadoPorLimite) return PARADA.LIMITE_CATALOGO;
    if (encontrados >= amount) return PARADA.COMPLETO;
    if (examinados >= cupo) return PARADA.TOPE_CANDIDATOS;
    if (Date.now() - empezado >= config.pluginSearch.timeBudgetMs) return PARADA.TIEMPO;
    return null;
}

// Devuelve { outfits, stats }. La forma de la respuesta HTTP la arma la ruta.
//
// Todo el cuerpo corre dentro de un contexto de correlacion (ver
// observability/requestContext.js) para que las lineas que emite el limitador
// cuando Roblox nos frena lleven el requestId de ESTA busqueda. Sin eso, un 429
// en el log de Railway no se puede cruzar con la busqueda que lo provoco, que
// es justo lo que hace falta para saber que endpoint esta limitando.
function searchOutfits(peticion, opciones = {}) {
    return requestContext.ejecutarCon(
        { requestId: opciones.requestId ?? null },
        () => ejecutarBusqueda(peticion, opciones)
    );
}

async function ejecutarBusqueda({ amount, groupId, minPrice, maxPrice }, { requestId = null } = {}) {
    const empezado = Date.now();
    const stats = crearStats();
    const cupo = cuposDeCandidatos(amount);

    // ── Etapa 1: descubrimiento ──────────────────────────────────────────────
    const { candidatos, sortOrder } = await descubrirCandidatos(groupId, cupo, stats);

    const indice = crearIndiceDeCatalogo(stats);
    const encontrados = [];
    const yaIncluidos = new Set(); // ningun userId repetido en la respuesta
    let examinados = 0;

    while (examinados < candidatos.length) {
        const parada = motivoParaParar({
            encontrados: encontrados.length, amount, examinados, cupo, empezado, indice,
        });
        if (parada) { stats.pararPor(parada); break; }

        const ola = candidatos.slice(
            examinados,
            examinados + tamanoDeOla(amount - encontrados.length, cupo - examinados)
        );
        examinados += ola.length;

        // ── Etapa 2: avatares de la ola, con concurrencia acotada ────────────
        const avatares = await traerOla(ola, stats, config.pluginSearch.concurrency);

        // ── Etapa 3: UN solo paso de catalogo para toda la ola ───────────────
        // Aqui esta el ahorro: todos los assets de todos los avatares de la ola,
        // deduplicados entre si y contra lo ya resuelto, en el minimo numero de
        // lotes. Si Roblox esta limitando, `asegurar` para sola y lo marca.
        const assetsDeLaOla = [];
        for (const resultado of avatares) {
            if (resultado.ok) assetsDeLaOla.push(...resultado.assetIds);
        }
        await indice.asegurar(assetsDeLaOla);

        // ── Etapas 4 y 5: precio y filtros, ya sin tocar la red ──────────────
        for (const resultado of avatares) {
            if (!resultado.ok) { stats.rechazar(resultado.motivo); continue; }

            const precio = calcularPrecio(resultado.assetIds, indice);
            if (!precio.ok) { stats.rechazar(precio.motivo); continue; }

            const rango = dentroDelRango(precio.totalPrice, minPrice, maxPrice);
            if (!rango.ok) { stats.rechazar(rango.motivo); continue; }

            // Defensivo: el bombo ya viene sin duplicados de memberPool.
            if (yaIncluidos.has(resultado.miembro.userId)) continue;

            stats.aceptar();
            yaIncluidos.add(resultado.miembro.userId);
            encontrados.push({
                userId: resultado.miembro.userId,
                username: resultado.miembro.username,
                totalPrice: precio.totalPrice,
            });
        }
    }

    // La ultima ola puede completar el pedido o toparse con el limite justo al
    // terminar; se reevalua para que `stoppedBy` describa el final real y no el
    // estado con el que se entro en la ultima vuelta.
    const paradaFinal = motivoParaParar({
        encontrados: encontrados.length, amount, examinados, cupo, empezado, indice,
    });
    if (paradaFinal) stats.pararPor(paradaFinal);

    const publicas = stats.publicar();

    // UNA linea por busqueda, agregada. Nunca una por candidato: con cientos de
    // candidatos eso ahogaria el log de todo el servicio y no diria mas. Lleva
    // las mismas casillas que la respuesta, para poder diagnosticar desde el log
    // sin depender de que alguien pegue lo que le devolvio el plugin.
    logger.info('Busqueda de outfits del plugin', {
        requestId,
        groupId,
        amount,
        minPrice,
        maxPrice,
        found: encontrados.length,
        sortOrder,
        ...publicas,
    });

    return {
        // slice defensivo: la ultima ola puede aceptar varios a la vez y pasarse
        // de `amount` por unos pocos. Por eso `accepted` puede superar a `found`:
        // cuenta a los que pasaron TODOS los filtros, y found es lo que cabe en
        // lo pedido.
        outfits: encontrados.slice(0, amount),
        stats: publicas,
    };
}

module.exports = { searchOutfits, cuposDeCandidatos, tamanoDeOla };
