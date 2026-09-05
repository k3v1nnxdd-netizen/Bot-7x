'use strict';

const config = require('../config');
const repo = require('../db/pluginRotationRepo');
const jobRepo = require('../db/pluginJobRepo');
const avatarRepo = require('../db/avatarIndexRepo');
const memberRepo = require('../db/groupMemberRepo');
const crawlRepo = require('../db/indexCrawlRepo');
const catalogoRepo = require('../db/assetCatalogRepo');
const pool = require('../db/pool');
const { ewma } = require('../services/pluginSearch/eta');

// Doble de Postgres EN MEMORIA con la misma semantica que las tres tablas del
// plugin: el lease con caducidad (lo que impide que dos busquedas del mismo
// grupo corrompan el cursor), la EWMA de las estadisticas, y los trabajos con
// su checkpoint, su VALLADO POR INSTANCIA, su latido y su adopcion.
//
// EL VALLADO ES POR TRABAJO, NO GLOBAL: cada trabajo en memoria lleva la
// instancia que lo creo o adopto (`trabajo.instanceId`), y la fila del doble
// solo acepta escrituras de esa instancia — exactamente como la sentencia real
// (`WHERE instance_id = $me`). Eso es lo que permite levantar DOS registros en
// el mismo proceso (una instancia "vieja" y una "nueva", como en un redeploy)
// sobre la misma base y probar quien puede escribir que.
//
// Compartido por pluginRotation.test.js, pluginPark.test.js y
// pluginHandoff.test.js: dos copias del mismo doble acabarian con dos
// semanticas distintas de la misma tabla.

const ESTA_INSTANCIA = jobRepo.__instancia;

function crearBaseFalsa() {
    const rotaciones = new Map();
    const estadisticas = new Map();
    const trabajosPersistidos = new Map();

    // ── Las tres tablas del indice de avatares ──────────────────────────────
    // avatares: user_id -> fila de roblox_user_avatar
    // miembros: "grupo|usuario" -> fila de plugin_group_member
    // recorridos: group_id -> fila de plugin_index_crawl (cursor + lease)
    const avatares = new Map();
    const miembros = new Map();
    const recorridos = new Map();
    const catalogo = new Map();     // assetId -> ficha persistida

    // Filas de pertenencia BLOQUEADAS por una transaccion en curso. Es lo que
    // simula `FOR UPDATE OF m SKIP LOCKED`: dos busquedas simultaneas del mismo
    // grupo no pueden llevarse al mismo usuario.
    const bloqueadas = new Set();
    let disponible = true;
    let fallarAdquirir = false;

    // Fallos TRANSITORIOS inyectados: cuantos latidos/volcados seguidos deben
    // fallar (como si la base no respondiera).
    let latidosQueFallan = 0;

    // Contadores de operaciones, para poder afirmar sobre lo que se escribio.
    const operaciones = { renew: 0, snapshot: 0, heartbeat: 0, adopt: 0, release: 0 };

    const filaAJob = fila => ({
        searchId: fila.searchId, groupId: fila.groupId, status: fila.status,
        target: fila.target, found: fila.found, candidatesExamined: fila.candidatesExamined,
        stoppedBy: fila.stoppedBy, progress: fila.progress, outfits: fila.outfits,
        stats: fila.stats, error: fila.error,
        params: fila.params ?? null, phase: fila.phase ?? 'working',
        resumeAt: fila.resumeAt ?? null, rateLimitedRoute: fila.rateLimitedRoute ?? null,
        checkpoint: fila.checkpoint ?? null,
        instanceId: fila.instanceId ?? null, previousInstanceId: fila.previousInstanceId ?? null,
        handoffs: fila.handoffs ?? 0, adoptedAt: fila.adoptedAt ?? null, heartbeatAt: fila.heartbeatAt ?? null,
        createdAt: fila.createdAt, startedAt: fila.startedAt, finishedAt: fila.finishedAt,
        desdeBase: true,
    });

    // Quien es el dueño, como la consulta real.
    const quienEsElDueño = async searchId => {
        const fila = trabajosPersistidos.get(searchId);
        if (!fila) return { ok: false, motivo: jobRepo.NO_ES_MIO.AUSENTE, dueño: null, estado: null };
        if (!['queued', 'running'].includes(fila.status)) {
            return { ok: false, motivo: jobRepo.NO_ES_MIO.TERMINAL, dueño: fila.instanceId, estado: fila.status };
        }
        if (fila.instanceId === null) return { ok: false, motivo: jobRepo.NO_ES_MIO.SOLTADO, dueño: null, estado: fila.status };
        return {
            ok: false, motivo: jobRepo.NO_ES_MIO.ADOPTADO, dueño: fila.instanceId, estado: fila.status,
            previo: fila.previousInstanceId ?? null, handoffs: fila.handoffs ?? 0,
        };
    };

    const veredicto = async (trabajo, tocada) => {
        if (tocada) return { ok: true };
        const quien = await quienEsElDueño(trabajo.searchId);
        if (quien.motivo === jobRepo.NO_ES_MIO.ADOPTADO && quien.dueño === trabajo.instanceId) return { ok: true, transitorio: true };
        return quien;
    };

    return {
        rotaciones,
        estadisticas,
        trabajosPersistidos,
        operaciones,
        ESTA_INSTANCIA,
        set disponible(v) { disponible = v; },
        set fallarAdquirir(v) { fallarAdquirir = v; },
        set latidosQueFallan(n) { latidosQueFallan = n; },

        instalar() {
            repo.disponible = () => disponible;

            // ── plugin_search_jobs ───────────────────────────────────────────
            jobRepo.disponible = () => disponible;
            jobRepo.quienEsElDueño = quienEsElDueño;

            jobRepo.crear = async trabajo => {
                if (!disponible) return { persistido: false };
                trabajosPersistidos.set(trabajo.searchId, {
                    searchId: trabajo.searchId, groupId: String(trabajo.groupId),
                    status: trabajo.status, target: trabajo.target, found: 0,
                    candidatesExamined: 0, stoppedBy: null, progress: null,
                    outfits: [], stats: null, error: null,
                    params: trabajo.params ? JSON.parse(JSON.stringify(trabajo.params)) : null,
                    phase: 'working', resumeAt: null, rateLimitedRoute: null, checkpoint: null,
                    instanceId: trabajo.instanceId, previousInstanceId: null, handoffs: 0, adoptedAt: null,
                    createdAt: Date.now(), startedAt: null, finishedAt: null,
                    heartbeatAt: Date.now(), expiresAt: null,
                });
                return { persistido: true };
            };

            // VALLADO, como la sentencia real: solo escribe si la fila es de la
            // instancia del trabajo, y si no, diagnostica.
            jobRepo.actualizar = async trabajo => {
                if (!disponible) return { ok: true, transitorio: true };
                if (latidosQueFallan > 0) { latidosQueFallan--; return { ok: true, transitorio: true }; }
                const fila = trabajosPersistidos.get(trabajo.searchId);
                if (!fila || fila.instanceId !== trabajo.instanceId) return veredicto(trabajo, false);
                operaciones.snapshot++;
                fila.status = trabajo.status;
                fila.found = trabajo.progress?.found ?? 0;
                fila.candidatesExamined = trabajo.progress?.candidatesExamined ?? 0;
                fila.progress = trabajo.progress ?? null;
                fila.startedAt = fila.startedAt ?? trabajo.startedAt ?? null;
                fila.phase = trabajo.phase ?? 'working';
                fila.resumeAt = trabajo.resumeAt ?? null;
                fila.rateLimitedRoute = trabajo.rateLimitedRoute ?? null;
                if (trabajo.checkpointPendiente) fila.checkpoint = JSON.parse(JSON.stringify(trabajo.checkpointPendiente));
                fila.heartbeatAt = Date.now();
                return { ok: true };
            };

            jobRepo.latir = async trabajo => {
                if (!disponible) return { ok: true, transitorio: true };
                if (latidosQueFallan > 0) { latidosQueFallan--; return { ok: true, transitorio: true }; }
                const fila = trabajosPersistidos.get(trabajo.searchId);
                if (!fila || fila.instanceId !== trabajo.instanceId) return veredicto(trabajo, false);
                operaciones.heartbeat++;
                fila.heartbeatAt = Date.now();
                fila.status = trabajo.status;
                fila.phase = trabajo.phase ?? 'working';
                fila.resumeAt = trabajo.resumeAt ?? null;
                fila.rateLimitedRoute = trabajo.rateLimitedRoute ?? null;
                if (trabajo.progress) fila.progress = trabajo.progress;
                return { ok: true };
            };

            jobRepo.terminar = async trabajo => {
                if (!disponible) return { ok: true };
                const fila = trabajosPersistidos.get(trabajo.searchId);
                if (!fila || fila.instanceId !== trabajo.instanceId) return veredicto(trabajo, false);
                fila.status = trabajo.status;
                fila.found = trabajo.outfits?.length ?? 0;
                fila.candidatesExamined = trabajo.stats?.candidatesExamined ?? 0;
                fila.stoppedBy = trabajo.stoppedBy ?? null;
                fila.progress = trabajo.progress ?? null;
                fila.outfits = trabajo.outfits ?? [];
                fila.stats = trabajo.stats ?? null;
                fila.error = trabajo.error ?? null;
                fila.phase = 'working';
                fila.resumeAt = null;
                fila.rateLimitedRoute = null;
                fila.finishedAt = Date.now();
                fila.heartbeatAt = Date.now();
                fila.expiresAt = Date.now() + config.pluginJobs.retentionMs;
                return { ok: true };
            };

            // Soltar al apagar: sin dueño, con el ultimo checkpoint.
            jobRepo.soltar = async trabajo => {
                if (!disponible) return { ok: false };
                const fila = trabajosPersistidos.get(trabajo.searchId);
                if (!fila || fila.instanceId !== trabajo.instanceId) return { ok: false };
                if (!['queued', 'running'].includes(fila.status)) return { ok: false };
                operaciones.release++;
                fila.previousInstanceId = fila.instanceId;
                fila.instanceId = null;
                fila.phase = 'recovering';
                const ultimo = trabajo.checkpointPendiente ?? trabajo.checkpoint;
                if (ultimo) fila.checkpoint = JSON.parse(JSON.stringify(ultimo));
                if (trabajo.progress) fila.progress = trabajo.progress;
                fila.updatedAt = Date.now();
                return { ok: true };
            };

            jobRepo.leer = async searchId => {
                if (!disponible) return null;
                const fila = trabajosPersistidos.get(searchId);
                return fila ? filaAJob(fila) : null;
            };

            // Adopcion atomica de lo soltado o con latido viejo, para la
            // instancia que lo pide.
            jobRepo.adoptarHuerfanos = async (instancia, limite = 8) => {
                if (!disponible) return [];
                const adoptadas = [];
                const ahora = Date.now();
                for (const fila of trabajosPersistidos.values()) {
                    if (adoptadas.length >= limite) break;
                    if (!['queued', 'running'].includes(fila.status)) continue;
                    if (!fila.params) continue;
                    const ultimo = fila.heartbeatAt ?? fila.createdAt;
                    const soltado = fila.instanceId === null;
                    const viejo = ultimo < ahora - config.pluginJobs.adoptAfterMs;
                    if (!soltado && !viejo) continue;
                    const previo = fila.instanceId;
                    fila.previousInstanceId = previo;
                    fila.instanceId = instancia;
                    fila.adoptedAt = ahora;
                    fila.handoffs = (fila.handoffs ?? 0) + 1;
                    fila.heartbeatAt = ahora;
                    operaciones.adopt++;
                    adoptadas.push({
                        ...filaAJob(fila),
                        adoptedFrom: previo,
                        heartbeatAgeMs: Math.max(0, ahora - ultimo),
                        adoptionReason: soltado ? 'released' : 'heartbeat_stale',
                    });
                }
                return adoptadas;
            };

            jobRepo.expirarHuerfanos = async () => {
                if (!disponible) return 0;
                let n = 0;
                const ahora = Date.now();
                for (const fila of trabajosPersistidos.values()) {
                    if (!['queued', 'running'].includes(fila.status)) continue;
                    const ultimo = fila.heartbeatAt ?? fila.createdAt;
                    const legado = !fila.params && ultimo < ahora - config.pluginJobs.adoptAfterMs;
                    const soltadoOlvidado = fila.instanceId === null
                        && (fila.updatedAt ?? ultimo) < ahora - config.pluginJobs.releasedExpireMs;
                    if (!legado && !soltadoOlvidado) continue;
                    fila.status = 'expired';
                    fila.stoppedBy = 'expired';
                    fila.finishedAt = ahora;
                    fila.expiresAt = ahora + config.pluginJobs.retentionMs;
                    n++;
                }
                return n;
            };

            // RETIRADA del sistema antiguo: con el indice sirviendo, los
            // trabajos pendientes se marcan expirados en vez de adoptarse.
            jobRepo.retirarLegacy = async () => {
                let n = 0;
                for (const fila of trabajosPersistidos.values()) {
                    if (!["queued", "running"].includes(fila.status)) continue;
                    fila.status = "expired";
                    fila.stoppedBy = "expired";
                    fila.errorCode = "index_serving";
                    fila.instanceId = null;
                    fila.finishedAt = Date.now();
                    n++;
                }
                return n;
            };

            jobRepo.limpiarVencidos = async () => {
                if (!disponible) return 0;
                let n = 0;
                for (const [id, fila] of trabajosPersistidos) {
                    if (fila.expiresAt !== null && fila.expiresAt < Date.now()) {
                        trabajosPersistidos.delete(id);
                        n++;
                    }
                }
                return n;
            };

            // ── plugin_group_rotation ────────────────────────────────────────
            repo.adquirir = async (groupId, ordenInicial, leaseMs) => {
                if (!disponible || fallarAdquirir) return null;
                const clave = String(groupId);
                const fila = rotaciones.get(clave);
                const ahora = Date.now();

                if (fila && fila.leaseExpiresAt && fila.leaseExpiresAt > ahora) return null; // otro lo tiene

                const nueva = fila ?? {
                    groupId: clave, sortOrder: ordenInicial, cursor: null, intraPageOffset: 0,
                    lastUserId: null, cycle: 1, cursorResets: 0,
                };
                const owner = `test-${Math.random().toString(16).slice(2)}`;
                nueva.leaseOwner = owner;
                nueva.leaseExpiresAt = ahora + Math.max(leaseMs ?? 0, config.pluginRotation.leaseMs);
                rotaciones.set(clave, nueva);

                return {
                    groupId: clave, sortOrder: nueva.sortOrder, cursor: nueva.cursor,
                    intraPageOffset: nueva.intraPageOffset, lastUserId: nueva.lastUserId,
                    cycle: nueva.cycle, cursorResets: nueva.cursorResets, owner,
                };
            };

            repo.guardar = async estado => {
                if (!disponible) return false;
                const fila = rotaciones.get(String(estado.groupId));
                if (!fila || fila.leaseOwner !== estado.owner) return false;
                fila.cursor = estado.cursor;
                fila.intraPageOffset = estado.intraPageOffset;
                fila.lastUserId = estado.lastUserId;
                fila.cycle = estado.cycle;
                fila.cursorResets = estado.cursorResets;
                fila.leaseExpiresAt = Date.now() + Math.max(estado.leaseMs ?? 0, config.pluginRotation.leaseMs);
                return true;
            };

            repo.renovar = async (groupId, owner, leaseMs) => {
                if (!disponible) return true;
                const fila = rotaciones.get(String(groupId));
                if (!fila || fila.leaseOwner !== owner) return false;
                operaciones.renew++;
                fila.leaseExpiresAt = Date.now() + Math.max(leaseMs ?? 0, config.pluginRotation.leaseMs);
                return true;
            };

            repo.soltar = async (groupId, owner) => {
                const fila = rotaciones.get(String(groupId));
                if (fila && fila.leaseOwner === owner) {
                    fila.leaseOwner = null;
                    fila.leaseExpiresAt = null;
                }
            };

            repo.esperaDelLease = async groupId => {
                const fila = rotaciones.get(String(groupId));
                if (!fila || !fila.leaseExpiresAt) return 0;
                return Math.max(0, fila.leaseExpiresAt - Date.now());
            };

            repo.posicionGlobalEnCola = async groupId => {
                let esperando = 0;
                for (const fila of trabajosPersistidos.values()) {
                    if (fila.groupId === String(groupId) && fila.status === 'queued') esperando++;
                }
                return esperando + 1;
            };

            repo.leerStats = async groupId => estadisticas.get(String(groupId)) ?? null;

            // ── INDICE DE AVATARES ──────────────────────────────────────
            //
            // Misma semantica que las sentencias reales: el upsert conserva el
            // precio cuando no hay valoracion nueva, el lease valla el cursor,
            // y `pendientes` ordena por necesidad. Sin esto los tests del
            // worker probarian un doble mas amable que Postgres.

            avatarRepo.disponible = () => disponible;
            memberRepo.disponible = () => disponible;
            crawlRepo.disponible = () => disponible;

            // ESCRITURA 1: solo los hechos del avatar. Nunca toca el precio.
            avatarRepo.upsertAvatar = async ({ userId, username = null, state, assetIds = [],
                assetTypeIds = [], accessories = 0, playerAvatarType = null }) => {
                if (!disponible) return false;
                const id = String(userId);
                const previa = avatares.get(id);
                const ahora = Date.now();
                avatares.set(id, {
                    ...(previa ?? {}),
                    userId: id,
                    username: username ?? previa?.username ?? null,
                    state,
                    assetIds: assetIds.map(String),
                    assetTypeIds: assetTypeIds.map(Number),
                    accessories,
                    playerAvatarType,
                    avatarFetchedAt: ahora,
                    totalPrice: previa?.totalPrice ?? null,
                    priceComplete: previa?.priceComplete ?? null,
                    pricedItems: previa?.pricedItems ?? null,
                    unpricedItems: previa?.unpricedItems ?? null,
                    limitedItems: previa?.limitedItems ?? null,
                    offSaleItems: previa?.offSaleItems ?? null,
                    bundledItems: previa?.bundledItems ?? null,
                    pricedAt: previa?.pricedAt ?? null,
                    pricingVersion: previa?.pricingVersion ?? 1,
                    consecutiveErrors: 0,
                    lastError: null,
                    updatedAt: ahora,
                });
                return true;
            };

            // ESCRITURA 2: la valoracion, para MUCHOS usuarios de una vez. Con
            // valoracion nula cambia el estado pero conserva el precio bueno.
            avatarRepo.upsertValoraciones = async (valoraciones, { pricingVersion = 1 } = {}) => {
                if (!disponible) return 0;
                let n = 0;
                const ahora = Date.now();
                for (const v of valoraciones) {
                    const fila = avatares.get(String(v.userId));
                    if (!fila) continue;
                    fila.state = v.state;
                    if (v.valoracion) {
                        fila.totalPrice = v.valoracion.totalPrice;
                        fila.priceComplete = v.valoracion.priceComplete;
                        fila.pricedItems = v.valoracion.pricedItems;
                        fila.unpricedItems = v.valoracion.unpricedItems;
                        fila.limitedItems = v.valoracion.limitedItems;
                        fila.offSaleItems = v.valoracion.offSaleItems;
                        fila.bundledItems = v.valoracion.bundledItems;
                        fila.pricedAt = ahora;
                    }
                    fila.pricingVersion = pricingVersion;
                    fila.consecutiveErrors = 0;
                    fila.lastError = null;
                    fila.updatedAt = ahora;
                    n++;
                }
                return n;
            };

            avatarRepo.anotarError = async (userId, detalle) => {
                const fila = avatares.get(String(userId));
                if (!fila) return false;
                fila.consecutiveErrors++;
                fila.lastError = String(detalle ?? '').slice(0, 200);
                fila.updatedAt = Date.now();
                return true;
            };

            avatarRepo.leer = async userId => avatares.get(String(userId)) ?? null;

            avatarRepo.leerVarios = async userIds => {
                const salida = new Map();
                for (const id of userIds) {
                    const fila = avatares.get(String(id));
                    if (fila) salida.set(String(id), fila);
                }
                return salida;
            };

            // COLA 1: avatares. Primero los que NO se han mirado nunca
            // (ampliar cobertura), despues los vencidos.
            avatarRepo.pendientesDeAvatar = async (groupId, { limite = 25, ttlAvatarMs } = {}) => {
                const ahora = Date.now();
                const candidatos = [];
                for (const fila of miembros.values()) {
                    if (fila.groupId !== String(groupId) || fila.leftAt) continue;
                    const avatar = avatares.get(fila.userId);
                    let urgencia = null;
                    if (!avatar) urgencia = 0;
                    else if (avatar.avatarFetchedAt < ahora - ttlAvatarMs) urgencia = 1;
                    if (urgencia === null) continue;
                    candidatos.push({
                        userId: fila.userId, username: fila.username, nuevo: !avatar, urgencia,
                        edad: avatar?.avatarFetchedAt ?? 0,
                    });
                }
                candidatos.sort((a, b) => a.urgencia - b.urgencia || a.edad - b.edad
                    || Number(a.userId) - Number(b.userId));
                return candidatos.slice(0, limite).map(({ userId, username, nuevo, urgencia }) =>
                    ({ userId, username, nuevo, urgencia }));
            };

            // COLA 2: precios. Devuelve tambien los assetIds, que es lo que
            // quien llama va a unir y deduplicar. El minimo de accesorios se
            // aplica AQUI: a quien no llega no se le gasta catalogo.
            avatarRepo.pendientesDePrecio = async (groupId, { limite = 60, ttlPrecioMs,
                pricingVersion = 1, minAccessories = 0 } = {}) => {
                const ahora = Date.now();
                const valorables = new Set(avatarRepo.VALORABLES);
                const candidatos = [];
                for (const fila of miembros.values()) {
                    if (fila.groupId !== String(groupId) || fila.leftAt) continue;
                    const avatar = avatares.get(fila.userId);
                    if (!avatar || !valorables.has(avatar.state)) continue;
                    if (avatar.accessories < minAccessories) continue;
                    if (!avatar.assetIds || avatar.assetIds.length === 0) continue;
                    let urgencia = null;
                    if (avatar.pricedAt === null || avatar.pricedAt === undefined) urgencia = 0;
                    else if (avatar.pricingVersion < pricingVersion) urgencia = 1;
                    else if (avatar.pricedAt < ahora - ttlPrecioMs) urgencia = 2;
                    if (urgencia === null) continue;
                    candidatos.push({
                        userId: avatar.userId, username: avatar.username,
                        assetIds: [...avatar.assetIds], accessories: avatar.accessories,
                        state: avatar.state, urgencia, edad: avatar.pricedAt ?? 0,
                    });
                }
                candidatos.sort((a, b) => a.urgencia - b.urgencia || a.edad - b.edad
                    || Number(a.userId) - Number(b.userId));
                return candidatos.slice(0, limite).map(({ edad, ...resto }) => resto);
            };

            avatarRepo.cobertura = async (groupId, { ttlAvatarMs, ttlPrecioMs, minAccessories = 0 } = {}) => {
                const ahora = Date.now();
                let total = 0, indexados = 0, validos = 0, elegibles = 0, bajoMinimo = 0, frescos = 0;
                for (const fila of miembros.values()) {
                    if (fila.groupId !== String(groupId) || fila.leftAt) continue;
                    total++;
                    const avatar = avatares.get(fila.userId);
                    if (!avatar) continue;
                    indexados++;
                    if (avatar.accessories < minAccessories) bajoMinimo++;
                    if (avatar.state !== 'valid') continue;
                    validos++;
                    if (avatar.accessories >= minAccessories) elegibles++;
                    if (avatar.avatarFetchedAt >= ahora - ttlAvatarMs
                        && avatar.pricedAt !== null && avatar.pricedAt >= ahora - ttlPrecioMs) frescos++;
                }
                return {
                    groupId: String(groupId), members: total, knownMembers: total, indexed: indexados,
                    valid: validos, eligible: elegibles, belowMinAccessories: bajoMinimo, fresh: frescos,
                    coverage: total > 0 ? Number((indexados / total).toFixed(4)) : 0,
                    freshness: total > 0 ? Number((frescos / total).toFixed(4)) : 0,
                };
            };

            // ── CATALOGO PERSISTENTE ────────────────────────────────────
            catalogoRepo.disponible = () => disponible;

            catalogoRepo.leerFrescos = async (assetIds, { ttlMs }) => {
                const pedidos = [...new Set(assetIds.map(String))];
                if (!disponible) return { fichas: new Map(), faltan: pedidos, aciertos: 0 };
                const ahora = Date.now();
                const fichas = new Map();
                for (const id of pedidos) {
                    const fila = catalogo.get(id);
                    if (fila && fila.fetchedAt >= ahora - ttlMs) fichas.set(id, { ...fila });
                }
                return {
                    fichas,
                    faltan: pedidos.filter(id => !fichas.has(id)),
                    aciertos: fichas.size,
                };
            };

            catalogoRepo.guardar = async (fichas, { faltantes = [] } = {}) => {
                if (!disponible) return 0;
                const ahora = Date.now();
                let n = 0;
                for (const [id, ficha] of fichas) {
                    const previa = catalogo.get(String(id));
                    catalogo.set(String(id), {
                        ...ficha,
                        // El bundle es estructural: si ya se sabia y no viene, se conserva.
                        bundleId: ficha.bundleId ?? previa?.bundleId ?? null,
                        bundlePrice: ficha.bundlePrice ?? previa?.bundlePrice ?? null,
                        bundleAvailable: ficha.bundleAvailable ?? previa?.bundleAvailable ?? null,
                        missing: false,
                        fetchedAt: ahora,
                    });
                    n++;
                }
                for (const id of faltantes) {
                    catalogo.set(String(id), { missing: true, available: false, fetchedAt: ahora });
                    n++;
                }
                return n;
            };

            catalogoRepo.contar = async () => ({ fichas: catalogo.size });

            // ── PERTENENCIA ─────────────────────────────────────────────
            memberRepo.registrarPagina = async (groupId, lista) => {
                if (!disponible) return 0;
                // El EXISTS de la sentencia real: sin recorrido no hay
                // pertenencia. Es lo que impide que un ciclo en vuelo resucite
                // a medias una comunidad que acaban de eliminar.
                if (!recorridos.has(String(groupId))) return 0;
                for (const m of lista) {
                    const clave = `${groupId}|${m.userId}`;
                    const previa = miembros.get(clave);
                    miembros.set(clave, {
                        groupId: String(groupId), userId: String(m.userId),
                        username: m.username ?? previa?.username ?? null,
                        discoveredAt: previa?.discoveredAt ?? Date.now(),
                        lastSeenAt: Date.now(),
                        leftAt: null,
                        lastDeliveredAt: previa?.lastDeliveredAt ?? null,
                        deliveries: previa?.deliveries ?? 0,
                    });
                }
                return lista.length;
            };

            memberRepo.marcarBajas = async (groupId, desde) => {
                // El EXISTS de la sentencia real: sobre una comunidad apagada o
                // cancelada NO se marca ni una baja, aunque el ciclo que la
                // pidio arrancara antes de la cancelacion.
                const recorrido = recorridos.get(String(groupId));
                if (recorrido && (!recorrido.enabled || recorrido.pausedAt)) return 0;
                let n = 0;
                for (const fila of miembros.values()) {
                    if (fila.groupId !== String(groupId) || fila.leftAt) continue;
                    if (fila.lastSeenAt < desde) { fila.leftAt = Date.now(); n++; }
                }
                return n;
            };

            memberRepo.contarVistosDesde = async (groupId, desde) => {
                let n = 0;
                for (const fila of miembros.values()) {
                    if (fila.groupId !== String(groupId) || fila.leftAt) continue;
                    if (fila.lastSeenAt >= desde) n++;
                }
                return n;
            };

            memberRepo.contar = async groupId => {
                let activos = 0, bajas = 0;
                for (const fila of miembros.values()) {
                    if (fila.groupId !== String(groupId)) continue;
                    if (fila.leftAt) bajas++; else activos++;
                }
                return { miembros: activos, bajas };
            };

            memberRepo.marcarEntregados = async (groupId, userIds) => {
                let n = 0;
                for (const id of userIds) {
                    const fila = miembros.get(`${groupId}|${id}`);
                    if (!fila) continue;
                    fila.lastDeliveredAt = Date.now();
                    fila.deliveries++;
                    n++;
                }
                return n;
            };

            // ── RECORRIDO DEL WORKER ────────────────────────────────────
            const nuevoRecorrido = groupId => ({
                groupId: String(groupId), sortOrder: 'Asc', cursor: null,
                intraPageOffset: 0, cycle: 1, priority: 0, demands: 0, lastDemandAt: null,
                membersSeen: 0, usersIndexed: 0, lastRunAt: null, lastFullPassAt: null,
                cycleStartedAt: null, lapClean: false,
                lastError: null, leaseOwner: null, leaseExpiresAt: null, enabled: true,
                pausedAt: null, pausedReason: null,
            });

            crawlRepo.asegurar = async groupId => {
                const clave = String(groupId);
                if (!recorridos.has(clave)) recorridos.set(clave, nuevoRecorrido(clave));
                return recorridos.get(clave);
            };

            crawlRepo.registrarDemanda = async (groupId, { faltan = 1, peso = 1 } = {}) => {
                if (!disponible) return false;
                const clave = String(groupId);
                if (!recorridos.has(clave)) recorridos.set(clave, nuevoRecorrido(clave));
                const fila = recorridos.get(clave);
                // Igual que el `WHERE ... paused_at IS NULL` del ON CONFLICT
                // real: sobre una comunidad cancelada la demanda no hace nada.
                // Es lo que impide que buscar en ella la reactive por detras.
                if (fila.pausedAt) return false;
                fila.priority = Math.min(fila.priority + Math.max(1, Math.round(faltan * peso)), 10000);
                fila.demands++;
                fila.lastDemandAt = Date.now();
                return true;
            };

            crawlRepo.tomar = async (instancia, { leaseMs, refrescarCadaMs = null, revisitarCadaMs = null } = {}) => {
                if (!disponible) return null;
                const ahora = Date.now();
                const elegibles = [...recorridos.values()].filter(fila => {
                    if (!fila.enabled) return false;
                    if (fila.leaseOwner && fila.leaseExpiresAt > ahora) return false;
                    if (fila.priority > 0) return true;
                    if (fila.lastRunAt === null) return true;
                    // REVISITA: un grupo ya visto vuelve a la cola solo. Sin
                    // esto, uno a medio indexar y sin demanda no se miraba en
                    // dias, y el worker se quedaba sin trabajo teniendo
                    // cientos de usuarios por indexar.
                    if (revisitarCadaMs !== null && fila.lastRunAt <= ahora - revisitarCadaMs) return true;
                    if (refrescarCadaMs === null) return false;
                    return fila.lastFullPassAt === null || fila.lastFullPassAt < ahora - refrescarCadaMs;
                });
                elegibles.sort((a, b) => b.priority - a.priority
                    || (a.lastRunAt ?? 0) - (b.lastRunAt ?? 0));
                const fila = elegibles[0];
                if (!fila) return null;
                fila.leaseOwner = instancia;
                fila.leaseExpiresAt = ahora + leaseMs;
                fila.lastRunAt = ahora;
                return { ...fila };
            };

            crawlRepo.guardarCursor = async (groupId, instancia, avance) => {
                const fila = recorridos.get(String(groupId));
                // EL VALLADO: si el lease ya no es nuestro, no se escribe.
                if (!fila || fila.leaseOwner !== instancia) return false;
                fila.cursor = avance.cursor ?? null;
                fila.intraPageOffset = avance.intraPageOffset ?? 0;
                fila.cycle = avance.cycle ?? fila.cycle;
                fila.membersSeen += avance.membersSeen ?? 0;
                fila.usersIndexed += avance.usersIndexed ?? 0;
                fila.lastRunAt = Date.now();
                // La MARCA DE AGUA de la vuelta. Sin persistirla, el crawler la
                // pierde entre ciclos y no puede saber desde cuando lleva sin
                // ver a alguien: nadie se marcaria nunca como baja.
                if (avance.cycleStartedAt !== undefined && avance.cycleStartedAt !== null) {
                    fila.cycleStartedAt = avance.cycleStartedAt;
                }
                // La EVIDENCIA de vuelta limpia viaja con el cursor: una vuelta
                // dura muchos ciclos y es lo unico que autoriza marcar bajas.
                //
                // Sobre una comunidad cancelada el veredicto se descarta, igual
                // que el `CASE WHEN paused_at IS NULL` de la sentencia real: el
                // ciclo que ya estaba en marcha termina de guardar su cursor,
                // pero no puede declarar limpia una vuelta que se interrumpio.
                fila.lapClean = fila.pausedAt ? false : avance.lapClean === true;
                if (avance.vueltaCompleta) fila.lastFullPassAt = Date.now();
                fila.priority = Math.max(0, fila.priority - (avance.prioridadConsumida ?? 0));
                fila.leaseExpiresAt = Date.now() + (avance.leaseMs ?? 60_000);
                return true;
            };

            crawlRepo.renovar = async (groupId, instancia, leaseMs) => {
                const fila = recorridos.get(String(groupId));
                if (!fila || fila.leaseOwner !== instancia) return false;
                fila.leaseExpiresAt = Date.now() + leaseMs;
                return true;
            };

            crawlRepo.soltar = async (groupId, instancia, { error = null } = {}) => {
                const fila = recorridos.get(String(groupId));
                if (!fila || fila.leaseOwner !== instancia) return false;
                fila.leaseOwner = null;
                fila.leaseExpiresAt = null;
                fila.lastError = error ? String(error).slice(0, 200) : null;
                return true;
            };

            crawlRepo.leer = async groupId => {
                const fila = recorridos.get(String(groupId));
                return fila ? { ...fila } : null;
            };

            crawlRepo.listar = async ({ limite = 10 } = {}) => [...recorridos.values()]
                .filter(f => f.enabled)
                .sort((a, b) => b.priority - a.priority || (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0))
                .slice(0, limite)
                .map(f => ({ ...f }));

            // ── ADMINISTRACION POR COMUNIDAD ────────────────────────────
            //
            // Sin estos dobles, el codigo real correria contra `db.query`, que
            // sin DATABASE_URL lanza — y con un .env puesto escribiria en la
            // base de verdad desde la suite. Cada uno reproduce EXACTAMENTE lo
            // que hace su sentencia, campo por campo, porque un doble que se
            // parece pero no coincide es un test verde que describe una API
            // que nadie va a recibir.

            crawlRepo.pausar = async (groupId, { motivo = null } = {}) => {
                if (!disponible) return null;
                const fila = recorridos.get(String(groupId));
                if (!fila) return null;
                fila.enabled = false;
                fila.pausedAt = fila.pausedAt ?? Date.now();
                fila.pausedReason = motivo;
                // La vuelta en curso deja de estar limpia: se interrumpio a la
                // mitad y no puede autorizar bajas al reanudar.
                fila.lapClean = false;
                // El lease NO se suelta: el ciclo que estuviera en marcha tiene
                // que poder guardar su avance, que esta vallado por lease.
                return { ...fila };
            };

            crawlRepo.reanudar = async groupId => {
                if (!disponible) return null;
                const fila = recorridos.get(String(groupId));
                if (!fila) return null;
                fila.enabled = true;
                fila.pausedAt = null;
                fila.pausedReason = null;
                // `lapClean` NO se restaura: sigue siendo una vuelta rota.
                return { ...fila };
            };

            crawlRepo.eliminar = async groupId => {
                if (!disponible) return null;
                const clave = String(groupId);
                const existia = recorridos.has(clave);

                // Los avatares que se quedan sin ninguna comunidad. Se CUENTAN
                // y no se borran, igual que en produccion: son globales.
                const deEste = new Set();
                const deOtros = new Set();
                for (const fila of miembros.values()) {
                    if (fila.groupId === clave) { deEste.add(String(fila.userId)); continue; }
                    // Solo cuenta como "esta en otra" una pertenencia VIVA: si
                    // se fue de la otra comunidad hace meses, el avatar SI se
                    // queda huerfano.
                    if (!fila.leftAt) deOtros.add(String(fila.userId));
                }
                let huerfanos = 0;
                for (const userId of deEste) {
                    if (!deOtros.has(userId) && avatares.has(userId)) huerfanos++;
                }


                let borrados = 0;
                for (const [k, fila] of [...miembros.entries()]) {
                    if (fila.groupId === clave) { miembros.delete(k); borrados++; }
                }
                let trabajos = 0;
                for (const t of trabajosPersistidos.values()) {
                    if (String(t.groupId) === clave && (t.status === 'queued' || t.status === 'running')) {
                        t.status = 'expired'; t.stoppedBy = 'expired';
                        t.errorCode = 'group_deleted'; t.instanceId = null;
                        // Con caducidad: el recolector borra por fecha, y sin
                        // ella estas filas serian las unicas que no caducan.
                        t.expiresAt = Date.now() + config.pluginJobs.retentionMs;
                        t.finishedAt = Date.now();
                        trabajos++;
                    }
                }
                rotaciones.delete(clave);
                estadisticas.delete(clave);
                recorridos.delete(clave);

                return {
                    groupId: clave, existia,
                    miembrosBorrados: borrados,
                    trabajosRetirados: trabajos,
                    avataresHuerfanos: huerfanos,
                };
            };

            crawlRepo.listarTodas = async ({ limite = 100, minAccessories = 0 } = {}) =>
                [...recorridos.values()]
                    // SIN filtro por `enabled`: el panel tiene que ver
                    // precisamente las canceladas, que son las unicas sobre las
                    // que se puede pulsar "reanudar".
                    .sort((a, b) => (a.pausedAt ? 1 : 0) - (b.pausedAt ? 1 : 0)
                        || b.priority - a.priority
                        || (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0))
                    .slice(0, limite)
                    .map(fila => {
                        let conocidos = 0, indexados = 0, elegibles = 0;
                        for (const m of miembros.values()) {
                            if (m.groupId !== fila.groupId || m.leftAt) continue;
                            conocidos++;
                            const a = avatares.get(String(m.userId));
                            if (!a) continue;
                            indexados++;
                            if (a.state === 'valid' && (a.accessories ?? 0) >= minAccessories) elegibles++;
                        }
                        // Sin whitelist en el doble: el panel enseña el numero.
                        return { ...fila, groupName: null, knownMembers: conocidos, indexed: indexados, eligible: elegibles };
                    });

            // ── LA TRANSACCION QUE SIRVE DESDE EL INDICE ────────────────
            //
            // Reproduce lo que importa de `FOR UPDATE OF m SKIP LOCKED`: las
            // filas que una transaccion en curso tiene cogidas NO las ve otra.
            // Sin eso, dos busquedas simultaneas del mismo grupo devolverian a
            // la misma gente y el test de concurrencia no probaria nada.
            pool.isConfigured = () => disponible;
            pool.withTransaction = async fn => {
                if (!disponible) throw Object.assign(new Error('sin base'), { code: 'DB_NOT_CONFIGURED' });
                const mias = new Set();
                const q = async (texto, params = []) => {
                    const sql = String(texto);

                    if (sql.includes('FROM plugin_group_member m') && sql.includes('FOR UPDATE OF m')) {
                        const [groupId, minAcc, minPrice, maxPrice, requiereCompleto, limite] = params;
                        const elegidas = [...miembros.values()]
                            .filter(m => m.groupId === String(groupId) && !m.leftAt)
                            .filter(m => !bloqueadas.has(`${m.groupId}|${m.userId}`))
                            .map(m => ({ m, a: avatares.get(m.userId) }))
                            .filter(({ a }) => a && a.state === 'valid' && a.accessories >= minAcc)
                            .filter(({ a }) => a.totalPrice !== null && a.totalPrice !== undefined)
                            .filter(({ a }) => a.totalPrice >= (minPrice ?? 0))
                            .filter(({ a }) => maxPrice === null || maxPrice === undefined || a.totalPrice <= maxPrice)
                            .filter(({ a }) => requiereCompleto !== true || a.priceComplete === true)
                            .sort((x, y) => (x.m.lastDeliveredAt ?? -1) - (y.m.lastDeliveredAt ?? -1)
                                || Number(x.m.userId) - Number(y.m.userId))
                            .slice(0, limite);

                        for (const { m } of elegidas) {
                            const clave = `${m.groupId}|${m.userId}`;
                            bloqueadas.add(clave);
                            mias.add(clave);
                        }

                        return { rows: elegidas.map(({ m, a }) => ({
                            user_id: m.userId, username: a.username,
                            total_price: a.totalPrice, price_complete: a.priceComplete,
                            priced_items: a.pricedItems, unpriced_items: a.unpricedItems,
                            limited_items: a.limitedItems, off_sale_items: a.offSaleItems,
                            bundled_items: a.bundledItems,
                        })) };
                    }

                    if (sql.includes('UPDATE plugin_group_member') && sql.includes('last_delivered_at = NOW()')) {
                        const [groupId, ids] = params;
                        for (const id of ids) {
                            const fila = miembros.get(`${groupId}|${id}`);
                            if (!fila) continue;
                            fila.lastDeliveredAt = Date.now();
                            fila.deliveries = (fila.deliveries ?? 0) + 1;
                        }
                        return { rows: [], rowCount: ids.length };
                    }

                    if (sql.includes('INSERT INTO plugin_index_crawl')) {
                        // Es LA MISMA sentencia que `registrarDemanda`: desde que
                        // las dos comparten `SQL_DEMANDA`, delegar aqui ya no es
                        // una aproximacion. Y se devuelve el rowCount de verdad,
                        // que sobre una comunidad cancelada es cero.
                        const [groupId, faltan] = params;
                        const subio = await crawlRepo.registrarDemanda(groupId, { faltan });
                        return { rows: [], rowCount: subio ? 1 : 0 };
                    }

                    if (sql.includes('COUNT(DISTINCT') && sql.includes('conocidos')) {
                        const [groupId, minAcc] = params;
                        let total = 0, indexados = 0, elegibles = 0;
                        for (const fila of miembros.values()) {
                            if (fila.groupId !== String(groupId) || fila.leftAt) continue;
                            total++;
                            const avatar = avatares.get(fila.userId);
                            if (!avatar) continue;
                            indexados++;
                            if (avatar.state === 'valid' && avatar.accessories >= minAcc) elegibles++;
                        }
                        return { rows: [{ conocidos: total, indexados, elegibles }] };
                    }

                    return { rows: [], rowCount: 0 };
                };

                try {
                    return await fn(q);
                } finally {
                    // COMMIT o ROLLBACK: en los dos casos se sueltan las filas.
                    for (const clave of mias) bloqueadas.delete(clave);
                }
            };

            repo.registrarBusqueda = async (groupId, muestra) => {
                if (!disponible) return;
                const clave = String(groupId);
                const previo = estadisticas.get(clave);
                const alpha = config.pluginEta.ewmaAlpha;
                estadisticas.set(clave, {
                    acceptanceRate: ewma(previo?.acceptanceRate ?? null, muestra.acceptanceRate, alpha),
                    candidateLatencyMs: ewma(previo?.candidateLatencyMs ?? null, muestra.candidateLatencyMs, alpha),
                    candidatesPerResult: ewma(previo?.candidatesPerResult ?? null, muestra.candidatesPerResult, alpha),
                    searchDurationMs: ewma(previo?.searchDurationMs ?? null, muestra.durationMs, alpha),
                    searchesCompleted: (previo?.searchesCompleted ?? 0) + 1,
                });
            };
        },

        // Las tablas del indice, para poder afirmar sobre ellas.
        avatares,
        miembros,
        recorridos,
        catalogo,

        // Envejece una fila del indice: su avatar (y opcionalmente su precio)
        // pasan a estar mas viejos que el TTL. Es como se prueba el refresco
        // sin esperar catorce dias.
        envejecerAvatar(userId, { avatarMs = 0, precioMs = 0 } = {}) {
            const fila = avatares.get(String(userId));
            if (!fila) return null;
            if (avatarMs) fila.avatarFetchedAt -= avatarMs;
            if (precioMs && fila.pricedAt !== null) fila.pricedAt -= precioMs;
            return fila;
        },

        // Simula que OTRA instancia tiene cogido el recorrido de un grupo.
        otroWorkerToma(groupId, instancia, { duracionMs = 60_000 } = {}) {
            const clave = String(groupId);
            if (!recorridos.has(clave)) {
                recorridos.set(clave, {
                    groupId: clave, sortOrder: 'Asc', cursor: null, intraPageOffset: 0,
                    cycle: 1, priority: 0, demands: 0, lastDemandAt: null, membersSeen: 0,
                    usersIndexed: 0, lastRunAt: null, lastFullPassAt: null, cycleStartedAt: null,
                    lapClean: false, lastError: null,
                    leaseOwner: null, leaseExpiresAt: null, enabled: true,
                    pausedAt: null, pausedReason: null,
                });
            }
            const fila = recorridos.get(clave);
            fila.leaseOwner = instancia;
            fila.leaseExpiresAt = Date.now() + duracionMs;
            return fila;
        },

        otraInstanciaToma(groupId, { duracionMs = config.pluginRotation.leaseMs } = {}) {
            const clave = String(groupId);
            const fila = rotaciones.get(clave) ?? {
                groupId: clave, sortOrder: 'Asc', cursor: null, intraPageOffset: 0,
                lastUserId: null, cycle: 1, cursorResets: 0,
            };
            fila.leaseOwner = 'instancia-remota';
            fila.leaseExpiresAt = Date.now() + duracionMs;
            rotaciones.set(clave, fila);
            return fila;
        },

        otraInstanciaSuelta(groupId, avance = {}) {
            const fila = rotaciones.get(String(groupId));
            if (!fila) return;
            Object.assign(fila, avance);
            fila.leaseOwner = null;
            fila.leaseExpiresAt = null;
        },

        // Simula la MUERTE del dueño de un trabajo desde el punto de vista de
        // la base: la fila conserva al dueño, pero su latido es viejo. Es
        // exactamente lo que ve la siguiente instancia al arrancar.
        instanciaMuereCon(searchId) {
            const fila = trabajosPersistidos.get(searchId);
            if (!fila) return null;
            fila.heartbeatAt = Date.now() - config.pluginJobs.adoptAfterMs - 1;
            return fila;
        },

        limpiar() {
            rotaciones.clear();
            estadisticas.clear();
            trabajosPersistidos.clear();
            avatares.clear();
            miembros.clear();
            recorridos.clear();
            catalogo.clear();
            bloqueadas.clear();
            disponible = true;
            fallarAdquirir = false;
            latidosQueFallan = 0;
            for (const k of Object.keys(operaciones)) operaciones[k] = 0;
        },
    };
}

module.exports = { crearBaseFalsa, ESTA_INSTANCIA };
