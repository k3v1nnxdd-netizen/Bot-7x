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

    let cursor = estado.cursor ?? null;
    if (cursor === null && inicioDeVuelta === null) inicioDeVuelta = Date.now();

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

            cursor = pagina?.nextCursor ?? null;

            if (cursor === null) {
                // ── VUELTA COMPLETA ──────────────────────────────────────────
                // Ahora, y solo ahora, se sabe quien falto: se recorrio la
                // comunidad entera y quien no aparecio no esta.
                resultado.vueltaCompleta = true;
                resultado.cycle = (estado.cycle ?? 1) + 1;
                if (inicioDeVuelta !== null) {
                    resultado.bajas = await miembros.marcarBajas(resultado.groupId, inicioDeVuelta);
                    if (resultado.bajas > 0) {
                        logger.info('Miembros marcados como bajas tras una vuelta completa', {
                            groupId: resultado.groupId, bajas: resultado.bajas, cycle: resultado.cycle,
                        });
                    }
                }
                inicioDeVuelta = Date.now();    // arranca la marca de la vuelta siguiente
                break;
            }
        }
    } catch (err) {
        // El cursor NO avanza si la pagina fallo: se reintenta la misma.
        resultado.error = err?.message ?? String(err);
        logger.warn('Fallo una pagina del crawler de miembros', {
            groupId: resultado.groupId, cursor, detail: resultado.error,
        });
    }

    resultado.cursorDespues = cursor;
    resultado.cycleStartedAt = inicioDeVuelta;
    return resultado;
}

module.exports = { recorrer };
