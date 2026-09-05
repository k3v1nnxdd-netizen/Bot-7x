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

// EL WORKER DEL INDICE: tres etapas independientes, y un ciclo que SIEMPRE
// vuelve.
//
// ── EL FALLO QUE ESTO CORRIGE ───────────────────────────────────────────────
//
// Produccion se quedo clavada en treinta usuarios indexados durante quince
// minutos. No habia error, no habia excepcion y el proceso estaba vivo: el
// worker simplemente no tenia nada que hacer, porque un grupo A MEDIO INDEXAR y
// sin demanda registrada dejaba de ser elegible hasta la siguiente vuelta
// completa — siete dias. Cada tick preguntaba, recibia "sin trabajo" y se
// callaba. La correccion tiene dos mitades: el grupo se revisita solo (ver
// config.indexWorker.revisitEveryMs) y el worker DICE lo que hace.
//
// ── LAS TRES ETAPAS SON INDEPENDIENTES ──────────────────────────────────────
//
//   CRAWLER   pagina miembros por la ruta `groupMembers`. Es una cuota DISTINTA
//             de la del avatar, asi que sigue descubriendo gente aunque
//             `userAvatar` este en un cooldown de una hora. Esto importa: la
//             cobertura del indice sigue creciendo mientras se espera.
//   AVATARES  una llamada por usuario, ruta `userAvatar`.
//   PRECIOS   lotes por la ruta `catalogDetails`, tambien independiente.
//
// Cada una va en su propio try: una excepcion en una NO puede impedir que las
// otras dos avancen, y un error de UN usuario no aborta el grupo entero.
//
// ── NADA PUEDE DEJARLO DORMIDO ──────────────────────────────────────────────
//
// Ni un 429, ni un timeout, ni el breaker, ni un fallo de red, ni una excepcion
// dentro de un usuario o de un lote. Todos conservan el cursor, conservan los
// datos buenos, esperan lo que Roblox pida y vuelven al bucle en el siguiente
// tick. Y si un ciclo se colgara en un await que no vuelve, el vigilante lo da
// por perdido y deja pasar al siguiente en vez de dejar el worker congelado.

const RUTA_AVATAR = 'userAvatar';
const RUTA_CATALOGO = 'catalogDetails';

const ETAPA = { CRAWLER: 'crawler', AVATAR: 'avatar', PRECIO: 'pricing', OCIOSO: 'idle' };

function crearWorker({ instancia, repos = {} } = {}) {
    const crawl = repos.crawl ?? crawlRepo;
    const miembros = repos.miembros ?? memberRepo;
    const avatares = repos.avatares ?? avatarRepo;

    const id = instancia ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

    const metricas = {
        instance: id,
        cycles: 0,
        groupsVisited: 0,

        // FILAS de miembros vistas, con repeticiones: el crawler da vueltas y
        // vuelve a ver a la misma gente. NO es el numero de miembros.
        memberRowsSeen: 0,
        // Miembros DISTINTOS conocidos del ultimo grupo recorrido, leido de la
        // base. Este si es el denominador que el plugin enseña, y por eso los
        // dos numeros viven separados y con nombres que no se confunden.
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
        stalls: 0,
        cycleTimeouts: 0,

        lastCycleAt: null,
        lastCycleMs: null,
        lastGroupId: null,
        lastError: null,
        avatarsPerMinute: 0,
        coverage: null,
        freshness: null,
    };

    // ── Estado de vida, lo que publica el latido ────────────────────────────
    const vida = {
        etapa: ETAPA.OCIOSO,
        groupId: null,
        cursor: null,
        pendientesAvatar: null,
        pendientesPrecio: null,
        ultimoProgresoAt: Date.now(),
        ciclosSinProgreso: 0,
        arrancadoAt: Date.now(),
    };

    let corriendo = false;
    let temporizador = null;
    let latido = null;
    let parado = false;

    const ttl = () => ({
        ttlAvatarMs: config.indexWorker.avatarTtlMs,
        ttlPrecioMs: config.indexWorker.priceTtlMs,
        pricingVersion: config.indexWorker.pricingVersion,
        minAccessories: config.pluginSearch.minAccessories,
    });

    // Estado de una ruta AHORA. `inFlight > 0` significa que hay peticiones de
    // otro saliendo por ella: se cede el paso a quien tiene a alguien delante.
    // Una busqueda APARCADA no tiene nada en vuelo, asi que no bloquea.
    function estadoDeRuta(routeKey) {
        const estado = rateLimiter.getThrottleState(routeKey);
        if (estado.throttled) {
            return { libre: false, motivo: 'roblox_limitado', esperaMs: estado.cooldownRemainingMs ?? 0 };
        }
        if ((estado.inFlight ?? 0) > 0) return { libre: false, motivo: 'ruta_ocupada', esperaMs: 0 };
        return { libre: true, esperaMs: 0 };
    }

    // Cuanto falta para que la ruta mas frenada reabra. Es lo que distingue
    // "esperando a Roblox" de "atascado sin motivo", y por eso se publica.
    function cooldownRestanteMs() {
        return Math.max(
            rateLimiter.getThrottleState(RUTA_AVATAR).cooldownRemainingMs ?? 0,
            rateLimiter.getThrottleState(RUTA_CATALOGO).cooldownRemainingMs ?? 0
        );
    }

    // ── UN CICLO ────────────────────────────────────────────────────────────
    async function ciclo() {
        if (!crawl.disponible()) return { hecho: false, motivo: 'sin_base' };

        const grupo = await crawl.tomar(id, {
            leaseMs: config.indexWorker.leaseMs,
            refrescarCadaMs: config.indexWorker.fullPassEveryMs,
            // La revisita: un grupo ya visto vuelve a la cola solo. Sin esto,
            // uno a medio indexar y sin demanda no se miraba en dias.
            revisitarCadaMs: config.indexWorker.revisitEveryMs,
        });
        if (!grupo) {
            vida.etapa = ETAPA.OCIOSO;
            return { hecho: false, motivo: 'sin_trabajo' };
        }

        const arranque = Date.now();
        const r = {
            hecho: true, groupId: grupo.groupId,
            cursorAntes: grupo.cursor ?? null, cursorDespues: grupo.cursor ?? null,
            miembrosVistos: 0, bajas: 0,
            avataresPedidos: 0, avataresEscritos: 0, bajoMinimo: 0,
            usuariosValorados: 0, lotesDeCatalogo: 0, assetsPedidos: 0, aciertosCatalogo: 0,
            limitado: false, errores: 0, vueltaCompleta: false,
            etapasConError: [],
        };

        vida.groupId = grupo.groupId;
        vida.cursor = grupo.cursor ?? null;

        logger.info('workerCycleStart', {
            instance: id,
            groupId: grupo.groupId,
            cursor: grupo.cursor ?? null,
            priority: grupo.priority,
            cooldownRemainingMs: cooldownRestanteMs(),
        });

        let paseo = null;

        // ── ETAPA 1: CRAWLER ────────────────────────────────────────────────
        //
        // Va SIEMPRE y va PRIMERO, pase lo que pase con el avatar. Es otra
        // cuota (`groupMembers`), asi que un cooldown de una hora en el avatar
        // no puede congelar el descubrimiento de miembros — que es justo lo que
        // hace que la cobertura siga creciendo mientras se espera.
        vida.etapa = ETAPA.CRAWLER;
        try {
            paseo = await recorrer(grupo, {
                paginas: config.indexWorker.crawlPagesPerCycle,
                repos: { miembros },
            });
            r.miembrosVistos = paseo.miembrosVistos;
            r.cursorDespues = paseo.cursorDespues;
            r.vueltaCompleta = paseo.vueltaCompleta;
            r.bajas = paseo.bajas;
            vida.cursor = paseo.cursorDespues;
            metricas.memberRowsSeen += paseo.miembrosVistos;
            metricas.leavers += paseo.bajas;
            if (paseo.error) { r.errores++; metricas.errors++; metricas.lastError = paseo.error; }
        } catch (err) {
            // El crawler fallo. NO se toca el cursor y las otras dos etapas
            // siguen: puede haber cientos de usuarios ya descubiertos por
            // indexar.
            r.errores++;
            r.etapasConError.push(ETAPA.CRAWLER);
            metricas.errors++;
            metricas.lastError = err?.message ?? String(err);
            logger.warn('Etapa del worker fallida: se continua con las demas', {
                instance: id, groupId: grupo.groupId, etapa: ETAPA.CRAWLER, detail: err?.message,
            });
        }

        // ── ETAPA 2: AVATARES ───────────────────────────────────────────────
        vida.etapa = ETAPA.AVATAR;
        try {
            const puerta = estadoDeRuta(RUTA_AVATAR);
            if (!puerta.libre) {
                if (puerta.motivo === 'roblox_limitado') {
                    metricas.cooldowns++;
                    metricas.cooldownMs += puerta.esperaMs;
                    r.limitado = true;
                } else {
                    metricas.yieldedToTraffic++;
                }
            } else {
                const cola = await avatares.pendientesDeAvatar(grupo.groupId, {
                    limite: config.indexWorker.avatarsPerCycle,
                    ttlAvatarMs: config.indexWorker.avatarTtlMs,
                });
                vida.pendientesAvatar = cola.length;

                for (const pendiente of cola) {
                    const ahora = estadoDeRuta(RUTA_AVATAR);
                    if (!ahora.libre) {
                        if (ahora.motivo === 'roblox_limitado') {
                            metricas.cooldowns++;
                            metricas.cooldownMs += ahora.esperaMs;
                            r.limitado = true;
                        } else {
                            metricas.yieldedToTraffic++;
                        }
                        break;
                    }

                    // UN USUARIO NO PUEDE TUMBAR EL GRUPO. Cada uno va en su
                    // propio try: una excepcion suya se anota y se pasa al
                    // siguiente en el mismo ciclo.
                    let desenlace;
                    try {
                        desenlace = await resolverAvatar(pendiente, { contador: crearContador() });
                    } catch (err) {
                        r.errores++;
                        metricas.errors++;
                        metricas.lastError = err?.message ?? String(err);
                        logger.debug('Usuario descartado por una excepcion: se sigue con el siguiente', {
                            instance: id, userId: pendiente.userId, detail: err?.message,
                        });
                        continue;
                    }

                    r.avataresPedidos++;
                    metricas.avatarsRequested++;

                    if (!desenlace.ok) {
                        if (desenlace.motivo === MOTIVO.LIMITADO) {
                            // UN LIMITE NO ES UN DATO: no se escribe nada, se
                            // deja el resto para el siguiente ciclo.
                            r.limitado = true;
                            metricas.cooldowns++;
                            metricas.cooldownMs += cooldownRestanteMs();
                            break;
                        }
                        // Error temporal de ESTE usuario: se anota y se sigue
                        // con el siguiente. Nunca se le pone un veredicto.
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
        } catch (err) {
            r.errores++;
            r.etapasConError.push(ETAPA.AVATAR);
            metricas.errors++;
            metricas.lastError = err?.message ?? String(err);
            logger.warn('Etapa del worker fallida: se continua con las demas', {
                instance: id, groupId: grupo.groupId, etapa: ETAPA.AVATAR, detail: err?.message,
            });
        }

        // ── ETAPA 3: PRECIOS ────────────────────────────────────────────────
        //
        // Corre AUNQUE el avatar este frenado: son cuotas independientes y
        // puede haber cientos de usuarios con avatar y sin valorar. Quedarse
        // parado en las tres porque una este cerrada es tiempo tirado.
        vida.etapa = ETAPA.PRECIO;
        try {
            const puerta = estadoDeRuta(RUTA_CATALOGO);
            if (!puerta.libre) {
                if (puerta.motivo === 'roblox_limitado') {
                    metricas.cooldowns++;
                    metricas.cooldownMs += puerta.esperaMs;
                } else {
                    metricas.yieldedToTraffic++;
                }
            } else {
                const porValorar = await avatares.pendientesDePrecio(grupo.groupId, {
                    limite: config.indexWorker.pricingBatchUsers,
                    ttlPrecioMs: config.indexWorker.priceTtlMs,
                    pricingVersion: config.indexWorker.pricingVersion,
                    minAccessories: config.pluginSearch.minAccessories,
                });
                vida.pendientesPrecio = porValorar.length;
                metricas.pricingCandidates += porValorar.length;

                if (porValorar.length > 0) {
                    const pase = await resolverPrecios(porValorar, { contador: crearContador() });

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
        } catch (err) {
            r.errores++;
            r.etapasConError.push(ETAPA.PRECIO);
            metricas.errors++;
            metricas.lastError = err?.message ?? String(err);
            logger.warn('Etapa del worker fallida: se continua con las demas', {
                instance: id, groupId: grupo.groupId, etapa: ETAPA.PRECIO, detail: err?.message,
            });
        }

        // ── El avance ───────────────────────────────────────────────────────
        try {
            const guardado = await crawl.guardarCursor(grupo.groupId, id, {
                cursor: r.cursorDespues,
                intraPageOffset: 0,
                cycle: paseo?.cycle ?? grupo.cycle,
                membersSeen: r.miembrosVistos,
                usersIndexed: r.avataresEscritos,
                vueltaCompleta: r.vueltaCompleta,
                cycleStartedAt: paseo?.cycleStartedAt ?? null,
                // La evidencia viaja con el cursor: una vuelta dura muchos
                // ciclos y puede cruzar un redeploy.
                lapClean: paseo?.lapClean === true,
                prioridadConsumida: (r.avataresEscritos > 0 || r.usuariosValorados > 0) ? 1 : 0,
                leaseMs: config.indexWorker.leaseMs,
            });
            if (!guardado) { metricas.leaseLost++; r.leasePerdido = true; }

            const foto = await avatares.cobertura(grupo.groupId, ttl());
            metricas.coverage = foto;
            metricas.freshness = foto?.freshness ?? null;
            // El denominador honesto, recien contado en la base.
            metricas.membersDiscovered = foto?.knownMembers ?? foto?.members ?? metricas.membersDiscovered;
        } catch (err) {
            metricas.errors++;
            metricas.lastError = err?.message ?? String(err);
        }

        // ── Progreso y atasco ───────────────────────────────────────────────
        const progreso = r.miembrosVistos + r.avataresEscritos + r.usuariosValorados;
        const enfriando = cooldownRestanteMs();

        if (progreso > 0) {
            vida.ultimoProgresoAt = Date.now();
            vida.ciclosSinProgreso = 0;
        } else {
            vida.ciclosSinProgreso++;
            // ATASCO: varios ciclos sin avanzar Y sin un cooldown que lo
            // explique. No se mata nada — se deja constancia y se sigue, que es
            // lo que convierte un silencio de quince minutos en una linea que
            // alguien puede buscar.
            if (vida.ciclosSinProgreso >= config.indexWorker.stallCycles && enfriando === 0) {
                metricas.stalls++;
                logger.warn('worker_stalled', {
                    instance: id,
                    groupId: grupo.groupId,
                    etapa: vida.etapa,
                    ciclosSinProgreso: vida.ciclosSinProgreso,
                    cursor: vida.cursor,
                    pendientesAvatar: vida.pendientesAvatar,
                    pendientesPrecio: vida.pendientesPrecio,
                    cooldownRemainingMs: 0,
                    sinProgresoDesdeMs: Date.now() - vida.ultimoProgresoAt,
                    lastError: metricas.lastError,
                });
            }
        }

        // ── Cierre del lease y del ciclo ────────────────────────────────────
        try {
            await crawl.soltar(grupo.groupId, id, { error: metricas.lastError });
        } catch { /* soltar nunca puede tumbar un ciclo */ }

        const duracion = Date.now() - arranque;
        metricas.cycles++;
        metricas.groupsVisited++;
        metricas.lastCycleAt = Date.now();
        metricas.lastCycleMs = duracion;
        metricas.lastGroupId = grupo.groupId;
        if (r.avataresPedidos > 0) {
            metricas.avatarsPerMinute = Math.round((r.avataresPedidos / Math.max(1, duracion)) * 60_000);
        }
        vida.etapa = ETAPA.OCIOSO;

        const dormirMs = config.indexWorker.tickMs;
        logger.info('workerCycleEnd', {
            instance: id,
            groupId: grupo.groupId,
            etapas: {
                crawler: { membersDiscovered: r.miembrosVistos, cursor: r.cursorDespues, vueltaCompleta: r.vueltaCompleta },
                avatar: { avatarsRequested: r.avataresPedidos, avatarsIndexed: r.avataresEscritos, belowMin: r.bajoMinimo },
                pricing: { usersPriced: r.usuariosValorados, catalogBatches: r.lotesDeCatalogo, catalogHits: r.aciertosCatalogo },
            },
            memberRowsSeen: r.miembrosVistos,
            membersDiscovered: metricas.membersDiscovered,
            avatarsIndexed: r.avataresEscritos,
            usersPriced: r.usuariosValorados,
            errores: r.errores,
            etapasConError: r.etapasConError,
            cooldownRemainingMs: enfriando,
            sleepMs: dormirMs,
            nextRunAt: new Date(Date.now() + dormirMs).toISOString(),
            durationMs: duracion,
            ciclosSinProgreso: vida.ciclosSinProgreso,
        });

        return r;
    }

    // ── El bucle, con vigilante ─────────────────────────────────────────────
    //
    // `corriendo` impide que dos ciclos se solapen. El vigilante existe porque
    // esa misma bandera, si un ciclo se colgara en un await que no vuelve,
    // dejaria el worker parado PARA SIEMPRE y sin sintoma: el proceso vivo, el
    // intervalo latiendo y nada ocurriendo.
    async function cicloVigilado() {
        let vencido = false;
        const limite = new Promise(resolve => {
            const t = setTimeout(() => { vencido = true; resolve('timeout'); }, config.indexWorker.cycleTimeoutMs);
            t.unref?.();
        });

        const resultado = await Promise.race([ciclo().catch(err => {
            metricas.errors++;
            metricas.lastError = err?.message ?? String(err);
            logger.warn('Ciclo del worker fallido: se reintenta en el siguiente tick', {
                instance: id, groupId: vida.groupId, etapa: vida.etapa, detail: err?.message,
            });
            return { hecho: false, motivo: 'error' };
        }), limite]);

        if (vencido) {
            metricas.cycleTimeouts++;
            logger.warn('Ciclo del worker dado por colgado: se deja pasar al siguiente', {
                instance: id, groupId: vida.groupId, etapa: vida.etapa,
                cycleTimeoutMs: config.indexWorker.cycleTimeoutMs,
            });
        }
        return resultado;
    }

    function emitirLatido() {
        logger.info('workerHeartbeat', {
            alive: true,
            instance: id,
            etapa: vida.etapa,
            groupId: vida.groupId,
            cursor: vida.cursor,
            pendientesAvatar: vida.pendientesAvatar,
            pendientesPrecio: vida.pendientesPrecio,
            cycles: metricas.cycles,
            memberRowsSeen: metricas.memberRowsSeen,
            membersDiscovered: metricas.membersDiscovered,
            avatarsIndexed: metricas.avatarsIndexed,
            usersPriced: metricas.usersPriced,
            ultimoProgresoAt: new Date(vida.ultimoProgresoAt).toISOString(),
            segundosDesdeUltimoProgreso: Math.round((Date.now() - vida.ultimoProgresoAt) / 1000),
            ciclosSinProgreso: vida.ciclosSinProgreso,
            cooldownRemainingMs: cooldownRestanteMs(),
            errors: metricas.errors,
            lastError: metricas.lastError,
        });
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
            cicloVigilado().finally(() => { corriendo = false; });
        }, config.indexWorker.tickMs);
        temporizador.unref();

        latido = setInterval(emitirLatido, config.indexWorker.heartbeatEveryMs);
        latido.unref();

        logger.info('Worker de indexado arrancado', {
            instance: id,
            tickMs: config.indexWorker.tickMs,
            avatarsPerCycle: config.indexWorker.avatarsPerCycle,
            pricingBatchUsers: config.indexWorker.pricingBatchUsers,
            revisitEveryMs: config.indexWorker.revisitEveryMs,
            minAccessories: config.pluginSearch.minAccessories,
        });
        return true;
    }

    function parar() {
        parado = true;
        if (temporizador) { clearInterval(temporizador); temporizador = null; }
        if (latido) { clearInterval(latido); latido = null; }
    }

    return {
        get instancia() { return id; },
        get metricas() { return { ...metricas }; },
        get vida() { return { ...vida }; },
        ciclo,
        cicloVigilado,
        emitirLatido,
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
    ETAPA,
    ciclo: () => porDefecto.ciclo(),
    arrancar: () => porDefecto.arrancar(),
    parar: () => porDefecto.parar(),
    get instancia() { return porDefecto.instancia; },
    get metricas() { return porDefecto.metricas; },
    get vida() { return porDefecto.vida; },
};
