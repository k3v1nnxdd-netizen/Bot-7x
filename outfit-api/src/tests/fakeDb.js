'use strict';

const config = require('../config');
const repo = require('../db/pluginRotationRepo');
const jobRepo = require('../db/pluginJobRepo');
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
                if (trabajo.checkpoint) fila.checkpoint = JSON.parse(JSON.stringify(trabajo.checkpoint));
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
            disponible = true;
            fallarAdquirir = false;
            latidosQueFallan = 0;
            for (const k of Object.keys(operaciones)) operaciones[k] = 0;
        },
    };
}

module.exports = { crearBaseFalsa, ESTA_INSTANCIA };
