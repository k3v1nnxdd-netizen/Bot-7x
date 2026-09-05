'use strict';

const roblox = require('../../roblox/client');
const config = require('../../config');
const logger = require('../../observability/logger');
const memberRepo = require('../../db/groupMemberRepo');

// EL CRAWLER DE MIEMBROS.
//
// Descubre quien esta en la comunidad y lo guarda. Es la etapa BARATA y va
// aparte por eso: paginar miembros no gasta la cuota del avatar, que es la
// escasa, asi que puede correr rapido y por delante de todo lo demas.
//
// Su producto es una lista de userIds con fecha. No mira avatares ni precios:
// eso es trabajo de las otras dos etapas, que se sirven de esta tabla.
//
// LAS BAJAS SE MARCAN AL CERRAR UNA VUELTA, nunca a mitad. A mitad de recorrido
// "no le he visto" significa "aun no he llegado a el", que es lo contrario de
// "se ha ido". Confundir las dos cosas vaciaria la comunidad en cada pasada.

// ¿Es este error un cursor que Roblox ya no acepta? Reintentarlo no sirve de
// nada, asi que se distingue para poder volver al principio en vez de quedarse
// dando vueltas contra la misma pagina.
function esCursorInvalido(err) {
    const texto = `${err?.message ?? ''} ${JSON.stringify(err?.response?.data ?? '')}`.toLowerCase();
    return texto.includes('invalidcursor') || texto.includes('invalid cursor');
}

async function recorrer(estado, { paginas = 1, repos = {} } = {}) {
    const miembros = repos.miembros ?? memberRepo;

    const resultado = {
        groupId: String(estado.groupId),
        cursorAntes: estado.cursor ?? null,
        cursorDespues: estado.cursor ?? null,
        cycle: estado.cycle ?? 1,
        paginasPedidas: 0,
        miembrosVistos: 0,
        vueltaCompleta: false,
        bajas: 0,
        error: null,
    };

    // Marca de agua de la vuelta: el instante en que empezo. Al cerrarla, quien
    // no se haya visto desde entonces es que ya no esta.
    let inicioDeVuelta = estado.cycleStartedAt ?? null;

    // ¿ESTA VUELTA ES LIMPIA? Empieza siendo lo que diga la fila y se pone en
    // FALSE en cuanto algo la interrumpe. Es la unica autorizacion para marcar
    // bajas, y por eso no hay ningun porcentaje que pueda sustituirla: una
    // vuelta al 95% interrumpida sigue siendo una vuelta incompleta, y marcar
    // ahi convierte a usuarios activos en bajas.
    let vueltaLimpia = estado.lapClean === true;

    let cursor = estado.cursor ?? null;
    if (cursor === null && inicioDeVuelta === null) {
        // Vuelta nueva desde el principio: empieza limpia.
        inicioDeVuelta = Date.now();
        vueltaLimpia = true;
    }

    try {
        for (let i = 0; i < paginas; i++) {
            const pagina = await roblox.listGroupMembers(resultado.groupId, {
                cursor,
                sortOrder: estado.sortOrder ?? 'Asc',
            });
            resultado.paginasPedidas++;

            const lista = Array.isArray(pagina?.members) ? pagina.members : [];
            resultado.miembrosVistos += lista.length;
            if (lista.length > 0) await miembros.registrarPagina(resultado.groupId, lista);

            // Una pagina VACIA que ademas cierra la paginacion es la firma de un
            // final prematuro: un cursor caducado hace exactamente eso. No se
            // puede distinguir de un final legitimo, asi que se trata como
            // interrupcion y esta vuelta deja de autorizar bajas.
            if (lista.length === 0 && (pagina?.nextCursor ?? null) === null) {
                vueltaLimpia = false;
                resultado.interrumpidaPor = 'pagina_vacia_al_final';
                logger.warn('Paginacion terminada con una pagina vacia: la vuelta no autoriza bajas', {
                    groupId: resultado.groupId, cursor,
                });
            }

            cursor = pagina?.nextCursor ?? null;

            if (cursor === null) {
                // ── VUELTA COMPLETA ──────────────────────────────────────────
                // Ahora, y solo ahora, se sabe quien falto: se recorrio la
                // comunidad entera y quien no aparecio no esta.
                resultado.vueltaCompleta = true;
                resultado.cycle = (estado.cycle ?? 1) + 1;

                // ── LA GUARDA DE LAS BAJAS ───────────────────────────────
                //
                // "Se acabo la paginacion" no siempre significa "recorri la
                // comunidad entera". Un cursor caducado o un ultimo tramo vacio
                // hacen que Roblox termine antes de tiempo, y marcar bajas ahi
                // vacia media comunidad de golpe: el denominador que ve el
                // plugin se desploma y vuelve a subir en la vuelta siguiente,
                // que es exactamente la oscilacion que se vio en produccion.
                //
                // Asi que antes de marcar a nadie se comprueba cuantos
                // conocidos se han visto DE VERDAD en esta vuelta. Si son
                // menos de la fraccion minima, la vuelta no vale como completa:
                // no se marca nada y queda constancia.
                // ── LA UNICA AUTORIZACION PARA MARCAR BAJAS ──────────────
                //
                // Hacen falta LAS TRES, y ninguna es un porcentaje:
                //
                //   1. se sabe cuando empezo la vuelta (hay marca de agua);
                //   2. la vuelta llego limpia hasta aqui — ni un error, ni un
                //      timeout, ni un 429, ni un cursor invalido, ni una pagina
                //      fallida, ni una pagina vacia cerrando la paginacion;
                //   3. la paginacion termino de forma normal, que es lo que
                //      significa estar en esta rama.
                //
                // Una vuelta al 95% interrumpida NO autoriza nada: el 5% que
                // falta son usuarios activos que quedarian marcados como
                // bajas. La proporcion se sigue midiendo, pero solo como aviso.
                const autorizada = inicioDeVuelta !== null && vueltaLimpia;
                const conocidos = (await miembros.contar(resultado.groupId)).miembros;
                const vistos = inicioDeVuelta === null
                    ? 0
                    : await miembros.contarVistosDesde(resultado.groupId, inicioDeVuelta);
                resultado.conocidos = conocidos;
                resultado.vistosEnLaVuelta = vistos;
                resultado.vueltaLimpia = vueltaLimpia;

                if (!autorizada) {
                    resultado.vueltaSospechosa = true;
                    logger.warn('Vuelta sin evidencia de estar completa: NO se marcan bajas', {
                        groupId: resultado.groupId, conocidos, vistos,
                        motivo: inicioDeVuelta === null ? 'sin_marca_de_agua' : (resultado.interrumpidaPor ?? 'interrumpida'),
                        cycle: resultado.cycle,
                    });
                } else {
                    // Solo AVISO, nunca autorizacion: si la proporcion es baja
                    // aun habiendo ido todo bien, conviene mirarlo.
                    if (conocidos > 0 && vistos < Math.ceil(conocidos * config.indexWorker.leaverWarnRatio)) {
                        logger.warn('Vuelta limpia pero con pocos miembros vistos: se marcan bajas igualmente', {
                            groupId: resultado.groupId, conocidos, vistos, cycle: resultado.cycle,
                        });
                    }
                    resultado.bajas = await miembros.marcarBajas(resultado.groupId, inicioDeVuelta);
                    if (resultado.bajas > 0) {
                        logger.info('Miembros marcados como bajas tras una vuelta completa', {
                            groupId: resultado.groupId, bajas: resultado.bajas,
                            conocidos, vistos, cycle: resultado.cycle,
                        });
                    }
                }
                // Arranca la vuelta siguiente: marca nueva y limpia otra vez.
                inicioDeVuelta = Date.now();
                vueltaLimpia = true;
                break;
            }
        }
    } catch (err) {
        // El cursor NO avanza si la pagina fallo: se reintenta la misma. Y la
        // vuelta queda MARCADA: un error, un timeout o un 429 a mitad significa
        // que hay paginas sin ver, y con paginas sin ver no se puede decir de
        // nadie que se haya ido.
        vueltaLimpia = false;
        resultado.error = err?.message ?? String(err);
        resultado.interrumpidaPor = err?.code === 'ECONNABORTED' ? 'timeout'
            : err?.response?.status === 429 ? 'rate_limit'
            : esCursorInvalido(err) ? 'cursor_invalido'
            : 'pagina_fallida';

        // UN CURSOR INVALIDO no se puede reintentar: Roblox no lo va a aceptar
        // nunca mas. Se vuelve al principio y se empieza una vuelta nueva, que
        // tampoco autorizara bajas hasta completarse limpia.
        if (resultado.interrumpidaPor === 'cursor_invalido') {
            cursor = null;
            inicioDeVuelta = Date.now();
            resultado.cursorReiniciado = true;
        }

        logger.warn('Fallo una pagina del crawler de miembros', {
            groupId: resultado.groupId, cursor, motivo: resultado.interrumpidaPor,
            detail: resultado.error,
        });
    }

    resultado.cursorDespues = cursor;
    resultado.cycleStartedAt = inicioDeVuelta;
    resultado.lapClean = vueltaLimpia;
    return resultado;
}

module.exports = { recorrer };
