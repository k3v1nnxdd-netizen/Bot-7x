'use strict';

const cacheStore = require('../../cache/cacheStore');
const config = require('../../config');
const logger = require('../../observability/logger');
const rateLimiter = require('../../roblox/rateLimiter');
const requestContext = require('../../observability/requestContext');
const { resolverFichasDeAsset, catalogCacheKey } = require('../catalogService');
const { trocear } = require('./concurrency');

// ETAPA 3 — CATALOGO. Es LA etapa que decide si esta busqueda tumba la cuota
// de Roblox o no, y por eso vive en su propio modulo.
//
// EL PROBLEMA QUE RESUELVE. La version anterior resolvia el catalogo candidato
// a candidato: 60 candidatos = 60 llamadas a catalog/items/details, en rafaga,
// con lotes minusculos de 5-10 assets. Roblox respondia 429, el limitador ponia
// la ruta en cooldown y la busqueda acababa en found:0 — no porque no hubiera
// outfits, sino porque nos habiamos quedado sin cuota para averiguar su precio.
//
// LA IDEA. El precio de un asset NO depende del jugador. Si veinte miembros de
// una comunidad llevan la misma camiseta, esa camiseta se pregunta UNA vez para
// los veinte. Este indice es lo que lo garantiza:
//
//   1. Indice LOCAL de la busqueda: un asset resuelto no se vuelve a mirar,
//      ni siquiera para leer la cache.
//   2. Sondeo de la CACHE COMPARTIDA antes de pedir nada. Lo que ya resolvio
//      otra busqueda —o /v1/outfits?catalog=1, o /v1/catalog/batch— entra
//      gratis. Esto ademas es lo que permite empaquetar bien: sin el sondeo se
//      mandarian lotes de 100 ids de los que 90 ya estaban en cache, y serian
//      llamadas enteras desperdiciadas.
//   3. Lo que de verdad falta se agrupa en lotes de hasta MAX_CATALOG_BATCH_SIZE
//      y se despacha DE UNO EN UNO, nunca en paralelo.
//
// Resultado: las llamadas al catalogo dejan de escalar con el numero de
// candidatos y pasan a escalar con el numero de assets DISTINTOS Y NUEVOS, que
// en una comunidad real crece mucho mas despacio.

// La ruta del limitador que protege catalog/items/details. Se consulta su
// estado antes de despachar cada lote.
const RUTA_CATALOGO = 'catalogDetails';

function crearIndiceDeCatalogo(stats) {
    // assetId (texto) -> ficha de catalogo. Es la memoria de la busqueda: una
    // vez dentro, ese asset no vuelve a costar nada.
    const fichas = new Map();

    // Assets que Roblox no pudo responder en esta busqueda. Se recuerdan para
    // no volver a pedirlos en la siguiente ola (si fallo por 429, insistir es
    // exactamente lo que no hay que hacer) y para poder descartar sin dudas a
    // quien los lleve puesto.
    const irresolubles = new Set();

    let frenadoPorLimite = false;

    return {
        get frenadoPorLimite() {
            return frenadoPorLimite;
        },

        // ¿Que se sabe ya de este asset? `undefined` = no se sabe.
        ficha(assetId) {
            return fichas.get(assetId);
        },

        irresoluble(assetId) {
            return irresolubles.has(assetId);
        },

        // Resuelve todo lo que falte de `assetIds`, en el minimo numero de
        // llamadas posible. No lanza: los fallos se anotan y quien llama decide
        // que hacer con los candidatos afectados.
        async asegurar(assetIds) {
            // 1. Fuera lo que ya sabemos de esta misma busqueda.
            const desconocidos = [...new Set(assetIds)]
                .filter(id => !fichas.has(id) && !irresolubles.has(id));

            if (desconocidos.length === 0) return;
            stats.sumar('assetIdsUnique', desconocidos.length);

            // 2. Sondeo de la cache COMPARTIDA. Lo que ya esta resuelto entra
            //    sin gastar cuota, y ademas deja los lotes llenos solo de lo
            //    que de verdad falta.
            const faltantes = [];
            for (const assetId of desconocidos) {
                const cacheada = await cacheStore.get(catalogCacheKey(assetId));
                if (cacheada !== undefined) {
                    fichas.set(assetId, cacheada);
                    stats.marcarCache('hit');
                } else {
                    faltantes.push(assetId);
                    stats.marcarCache('miss');
                }
            }

            if (faltantes.length === 0) return;

            // 3. Lotes de tamaño acotado. El tope no es una preferencia: el
            //    endpoint de Roblox rechaza por encima de 120 items, y
            //    MAX_CATALOG_BATCH_SIZE (100) deja margen.
            for (const lote of trocear(faltantes, config.maxCatalogBatchSize)) {
                // ── BACKPRESSURE ────────────────────────────────────────────
                // Se pregunta ANTES de cada lote, no despues del error. Si la
                // ruta esta en cooldown o el breaker abierto, seguir mandando
                // lotes solo alarga el cooldown y retrasa la recuperacion.
                // Se para en seco y se devuelve lo que ya haya.
                const freno = rateLimiter.getThrottleState(RUTA_CATALOGO);
                if (freno.throttled) {
                    frenadoPorLimite = true;
                    for (const assetId of lote) irresolubles.add(assetId);
                    logger.warn('Busqueda del plugin detenida: el catalogo de Roblox esta limitado', {
                        requestId: requestContext.requestId(),
                        searchId: requestContext.searchId(),
                        routeKey: RUTA_CATALOGO,
                        reason: freno.reason,
                        cooldownRemainingMs: freno.cooldownRemainingMs,
                        assetsSinResolver: lote.length,
                    });
                    return;
                }

                // El resolutor compartido con /v1/catalog/batch: misma cache por
                // asset, mismo single-flight, mismo bucket del limitador y los
                // mismos reintentos. Aqui NO se reintenta nada por cuenta
                // propia — duplicar reintentos sobre un Roblox que ya dice que
                // no puede es como se convierte un 429 en un incidente.
                const fallos = { assetIds: [] };
                stats.sumar('catalogBatches');
                stats.sumar('assetIdsRequested', lote.length);

                let resueltas;
                try {
                    resueltas = await resolverFichasDeAsset(lote, fallos);
                } catch (err) {
                    // resolverFichasDeAsset documenta que no lanza (reporta en
                    // `fallos`). Si algun dia lo hiciera, se trata igual que un
                    // lote fallido en vez de tumbar la busqueda entera.
                    logger.warn('Fallo inesperado resolviendo un lote de catalogo', { detail: err?.message });
                    resueltas = new Map();
                    fallos.assetIds.push(...lote);
                }

                for (const assetId of lote) {
                    const ficha = resueltas.get(assetId);
                    if (ficha === undefined) irresolubles.add(assetId);
                    else fichas.set(assetId, ficha);
                }

                // Un lote fallido con la ruta ya frenada es la firma de un 429:
                // el limitador acaba de imponer el cooldown al agotarse los
                // reintentos. Se corta aqui en vez de esperar al siguiente lote.
                if (fallos.assetIds.length > 0) {
                    const despues = rateLimiter.getThrottleState(RUTA_CATALOGO);
                    if (despues.throttled) {
                        frenadoPorLimite = true;
                        logger.warn('Busqueda del plugin detenida: Roblox limito el catalogo a mitad', {
                            requestId: requestContext.requestId(),
                            searchId: requestContext.searchId(),
                            routeKey: RUTA_CATALOGO,
                            reason: despues.reason,
                            cooldownRemainingMs: despues.cooldownRemainingMs,
                            assetsSinResolver: fallos.assetIds.length,
                        });
                        return;
                    }
                }
            }
        },
    };
}

module.exports = { crearIndiceDeCatalogo, RUTA_CATALOGO };
