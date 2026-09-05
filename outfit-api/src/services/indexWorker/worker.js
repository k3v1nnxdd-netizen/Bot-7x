'use strict';

const config = require('../../config');
const logger = require('../../observability/logger');
const rateLimiter = require('../../roblox/rateLimiter');
const crawlRepo = require('../../db/indexCrawlRepo');
const memberRepo = require('../../db/groupMemberRepo');
const avatarRepo = require('../../db/avatarIndexRepo');
const catalogoRepo = require('../../db/assetCatalogRepo');
const { recorrer } = require('./crawler');
const { resolverAvatar, resolverPrecios, crearContador, MOTIVO } = require('./resolver');

// EL WORKER DEL INDICE: tres etapas, un ciclo.
//
// Un ciclo hace, en este orden y siempre sobre el mismo grupo:
//
//   1. CRAWLER   pagina miembros. Barato: no gasta la cuota del avatar.
//   2. AVATARES  una llamada por usuario. Lo caro, y lo que decide la cobertura.
//   3. PRECIOS   una pasada para muchos usuarios. Aqui es donde el catalogo se
//                comparte y las llamadas se desploman.
//
// EL ORDEN DE PRIORIDADES, que es lo que decide en que se gasta la cuota:
// primero ampliar cobertura (usuarios de los que no se sabe NADA), despues
// refrescar avatares vencidos, y por ultimo refrescar precios. Un usuario sin
// indexar no puede salir en ninguna busqueda; uno con el precio de hace tres
// dias si.
//
// SOBRE CEDER EL PASO. Antes bastaba con que existiera una busqueda viva para
// que el worker se parara entera. Eso lo dejaba bloqueado incluso cuando la
// busqueda estaba APARCADA esperando un cooldown — es decir, justo cuando la
// cuota estaba libre y no se estaba usando. Ahora lo que decide es la RUTA: si
// la ruta que el worker necesita esta frenada o hay peticiones en vuelo, se
// aparta de ESA ruta; si no, trabaja.

const RUTA_AVATAR = 'userAvatar';
const RUTA_CATALOGO = 'catalogDetails';

function crearWorker({ instancia, repos = {} } = {}) {
    const crawl = repos.crawl ?? crawlRepo;
    const miembros = repos.miembros ?? memberRepo;
    const avatares = repos.avatares ?? avatarRepo;

    const id = instancia ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

    // ── METRICAS ────────────────────────────────────────────────────────────
    // Las de catalogo estan para demostrar UNA cosa concreta: que las llamadas
    // al catalogo son una fraccion de las del avatar. Por eso se cuentan los
    // assets vistos, los unicos, los que ya estaban en Postgres y los que de
    // verdad se pidieron.
    const metricas = {
        instance: id,
        cycles: 0,
        groupsVisited: 0,

        membersDiscovered: 0,
        avatarsRequested: 0,
        avatarsIndexed: 0,
        belowMinAccessories: 0,

        pricingCandidates: 0,
        catalogAssetsSeen: 0,
        catalogAssetsUnique: 0,
        catalogCacheHitsPostgres: 0,
        catalogAssetsRequested: 0,
        catalogBatches: 0,
        usersPriced: 0,

        notFound: 0,
        emptyAvatar: 0,
        unpriceable: 0,
        leavers: 0,

        cooldowns: 0,
        cooldownMs: 0,
        errors: 0,
        leaseLost: 0,
        yieldedToTraffic: 0,

        lastCycleAt: null,
        lastCycleMs: null,
        lastGroupId: null,
        lastError: null,
        avatarsPerMinute: 0,
        coverage: null,
        freshness: null,
    };

    let corriendo = false;
    let temporizador = null;
    let parado = false;

    const ttl = () => ({
        ttlAvatarMs: config.indexWorker.avatarTtlMs,
        ttlPrecioMs: config.indexWorker.priceTtlMs,
        pricingVersion: config.indexWorker.pricingVersion,
        minAccessories: config.pluginSearch.minAccessories,
    });

    // ¿Se puede usar ESTA ruta ahora? Frenada por Roblox, no. Con peticiones en
    // vuelo, tampoco: son de una busqueda con alguien delante y la cuota es
    // suya. Una busqueda APARCADA no tiene peticiones en vuelo, asi que no
    // bloquea al worker — que es justo la correccion.
    function rutaLibre(routeKey) {
        const estado = rateLimiter.getThrottleState(routeKey);
        if (estado.throttled) return { libre: false, motivo: 'roblox_limitado', freno: estado };
        // `inFlight` son peticiones SALIENDO ahora mismo por esa ruta. Es la
        // señal honesta de "hay alguien usando esta cuota", y la diferencia con
        // el contador de busquedas vivas que habia antes: una busqueda aparcada
        // esperando un cooldown tiene cero peticiones en vuelo, asi que ya no
        // deja al worker de brazos cruzados con la cuota libre.
        if ((estado.inFlight ?? 0) > 0) return { libre: false, motivo: 'ruta_ocupada' };
        return { libre: true };
    }

    function anotarCooldown(freno) {
        metricas.cooldowns++;
        metricas.cooldownMs += freno?.cooldownRemainingMs ?? 0;
    }

    // ── UN CICLO ────────────────────────────────────────────────────────────
    async function ciclo() {
        if (!crawl.disponible()) return { hecho: false, motivo: 'sin_base' };

        const grupo = await crawl.tomar(id, {
            leaseMs: config.indexWorker.leaseMs,
            refrescarCadaMs: config.indexWorker.fullPassEveryMs,
        });
        if (!grupo) return { hecho: false, motivo: 'sin_trabajo' };

        const arranque = Date.now();
        const r = {
            hecho: true, groupId: grupo.groupId,
            cursorAntes: grupo.cursor ?? null, cursorDespues: grupo.cursor ?? null,
            miembrosVistos: 0, bajas: 0,
            avataresPedidos: 0, avataresEscritos: 0, bajoMinimo: 0,
            usuariosValorados: 0, lotesDeCatalogo: 0, assetsPedidos: 0, aciertosCatalogo: 0,
            limitado: false, errores: 0, vueltaCompleta: false,
        };

        try {
            // ── ETAPA 1: CRAWLER ────────────────────────────────────────────
            const paseo = await recorrer(grupo, {
                paginas: config.indexWorker.crawlPagesPerCycle,
                repos: { miembros },
            });
            r.miembrosVistos = paseo.miembrosVistos;
            r.cursorDespues = paseo.cursorDespues;
            r.vueltaCompleta = paseo.vueltaCompleta;
            r.bajas = paseo.bajas;
            metricas.membersDiscovered += paseo.miembrosVistos;
            metricas.leavers += paseo.bajas;
            if (paseo.error) { r.errores++; metricas.errors++; metricas.lastError = paseo.error; }

            // ── ETAPA 2: AVATARES ───────────────────────────────────────────
            const puertaAvatar = rutaLibre(RUTA_AVATAR);
            if (!puertaAvatar.libre) {
                if (puertaAvatar.motivo === 'roblox_limitado') anotarCooldown(puertaAvatar.freno);
                else metricas.yieldedToTraffic++;
                r.limitado = puertaAvatar.motivo === 'roblox_limitado';
            } else {
                const cola = await avatares.pendientesDeAvatar(grupo.groupId, {
                    limite: config.indexWorker.avatarsPerCycle,
                    ttlAvatarMs: config.indexWorker.avatarTtlMs,
                });

                for (const pendiente of cola) {
                    const puerta = rutaLibre(RUTA_AVATAR);
                    if (!puerta.libre) {
                        if (puerta.motivo === 'roblox_limitado') { anotarCooldown(puerta.freno); r.limitado = true; }
                        else metricas.yieldedToTraffic++;
                        break;
                    }

                    const contador = crearContador();
                    const desenlace = await resolverAvatar(pendiente, { contador });
                    r.avataresPedidos++;
                    metricas.avatarsRequested++;

                    if (!desenlace.ok) {
                        if (desenlace.motivo === MOTIVO.LIMITADO) {
                            // UN LIMITE NO ES UN DATO: no se escribe nada.
                            r.limitado = true;
                            metricas.cooldowns++;
                            break;
                        }
                        r.errores++;
                        metricas.errors++;
                        metricas.lastError = desenlace.detalle ?? 'error';
                        await avatares.anotarError(pendiente.userId, desenlace.detalle);
                        continue;
                    }

                    if (await avatares.upsertAvatar(desenlace.registro)) {
                        r.avataresEscritos++;
                        metricas.avatarsIndexed++;
                        if (desenlace.bajoMinimo) { r.bajoMinimo++; metricas.belowMinAccessories++; }
                        if (desenlace.registro.state === avatarRepo.ESTADO.NO_EXISTE) metricas.notFound++;
                        if (desenlace.registro.state === avatarRepo.ESTADO.AVATAR_VACIO) metricas.emptyAvatar++;
                    }
                }
            }

            // ── ETAPA 3: PRECIOS ────────────────────────────────────────────
            //
            // Se hace SIEMPRE que la ruta del catalogo este libre, aunque la del
            // avatar estuviera frenada: son cuotas independientes, y quedarse
            // parado en las dos porque una este cerrada es tiempo tirado.
            const puertaCatalogo = rutaLibre(RUTA_CATALOGO);
            if (!puertaCatalogo.libre) {
                if (puertaCatalogo.motivo === 'roblox_limitado') anotarCooldown(puertaCatalogo.freno);
                else metricas.yieldedToTraffic++;
            } else {
                const porValorar = await avatares.pendientesDePrecio(grupo.groupId, {
                    limite: config.indexWorker.pricingBatchUsers,
                    ttlPrecioMs: config.indexWorker.priceTtlMs,
                    pricingVersion: config.indexWorker.pricingVersion,
                    // EL MINIMO DE ACCESORIOS, desde la unica fuente que hay.
                    // A quien no llega no se le gasta ni un lote de catalogo.
                    minAccessories: config.pluginSearch.minAccessories,
                });
                metricas.pricingCandidates += porValorar.length;

                if (porValorar.length > 0) {
                    const contador = crearContador();
                    const pase = await resolverPrecios(porValorar, { contador });

                    r.lotesDeCatalogo = pase.medidas.lotes;
                    r.assetsPedidos = pase.medidas.pedidosARoblox;
                    r.aciertosCatalogo = pase.medidas.aciertosPostgres;
                    metricas.catalogAssetsSeen += pase.medidas.assetsVistos;
                    metricas.catalogAssetsUnique += pase.medidas.assetsUnicos;
                    metricas.catalogCacheHitsPostgres += pase.medidas.aciertosPostgres;
                    metricas.catalogAssetsRequested += pase.medidas.pedidosARoblox;
                    metricas.catalogBatches += pase.medidas.lotes;
                    if (pase.limitado) { r.limitado = true; metricas.cooldowns++; }

                    if (pase.valoraciones.length > 0) {
                        const escritas = await avatares.upsertValoraciones(pase.valoraciones, {
                            pricingVersion: config.indexWorker.pricingVersion,
                        });
                        r.usuariosValorados = escritas;
                        metricas.usersPriced += escritas;
                        metricas.unpriceable += pase.valoraciones
                            .filter(v => v.state === avatarRepo.ESTADO.SIN_PRECIO).length;
                    }
                }
            }

            // ── El avance ───────────────────────────────────────────────────
            const guardado = await crawl.guardarCursor(grupo.groupId, id, {
                cursor: r.cursorDespues,
                intraPageOffset: 0,
                cycle: paseo.cycle,
                membersSeen: r.miembrosVistos,
                usersIndexed: r.avataresEscritos,
                vueltaCompleta: r.vueltaCompleta,
                cycleStartedAt: paseo.cycleStartedAt ?? null,
                prioridadConsumida: (r.avataresEscritos > 0 || r.usuariosValorados > 0) ? 1 : 0,
                leaseMs: config.indexWorker.leaseMs,
            });
            if (!guardado) { metricas.leaseLost++; r.leasePerdido = true; }

            // ── Cobertura, una vez por ciclo ────────────────────────────────
            const foto = await avatares.cobertura(grupo.groupId, ttl());
            metricas.coverage = foto;
            metricas.freshness = foto?.freshness ?? null;

            metricas.groupsVisited++;
            return r;
        } catch (err) {
            metricas.errors++;
            metricas.lastError = err?.message ?? String(err);
            logger.warn('Ciclo del worker de indexado fallido', {
                groupId: grupo.groupId, instance: id, code: err?.code ?? null, detail: err?.message,
            });
            r.errores++;
            return r;
        } finally {
            await crawl.soltar(grupo.groupId, id, { error: metricas.lastError });

            const duracion = Date.now() - arranque;
            metricas.cycles++;
            metricas.lastCycleAt = Date.now();
            metricas.lastCycleMs = duracion;
            metricas.lastGroupId = grupo.groupId;
            if (r.avataresPedidos > 0) {
                metricas.avatarsPerMinute = Math.round((r.avataresPedidos / Math.max(1, duracion)) * 60_000);
            }
        }
    }

    function arrancar() {
        if (temporizador || parado) return false;
        if (!config.indexWorker.enabled) {
            logger.info('Worker de indexado desactivado por configuracion', { instance: id });
            return false;
        }

        temporizador = setInterval(() => {
            if (corriendo) return;
            corriendo = true;
            ciclo()
                .catch(err => {
                    metricas.errors++;
                    metricas.lastError = err?.message ?? String(err);
                })
                .finally(() => { corriendo = false; });
        }, config.indexWorker.tickMs);

        temporizador.unref();
        logger.info('Worker de indexado arrancado', {
            instance: id,
            tickMs: config.indexWorker.tickMs,
            avatarsPerCycle: config.indexWorker.avatarsPerCycle,
            pricingBatchUsers: config.indexWorker.pricingBatchUsers,
            minAccessories: config.pluginSearch.minAccessories,
        });
        return true;
    }

    function parar() {
        parado = true;
        if (temporizador) { clearInterval(temporizador); temporizador = null; }
    }

    return {
        get instancia() { return id; },
        get metricas() { return { ...metricas }; },
        ciclo,
        arrancar,
        parar,
        async catalogoPersistido() { return catalogoRepo.contar(); },
        __reiniciarMetricas() {
            for (const clave of Object.keys(metricas)) {
                if (typeof metricas[clave] === 'number') metricas[clave] = 0;
            }
        },
    };
}

const porDefecto = crearWorker({});

module.exports = {
    crearWorker,
    porDefecto,
    ciclo: () => porDefecto.ciclo(),
    arrancar: () => porDefecto.arrancar(),
    parar: () => porDefecto.parar(),
    get instancia() { return porDefecto.instancia; },
    get metricas() { return porDefecto.metricas; },
};
