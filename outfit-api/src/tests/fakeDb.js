'use strict';

const config = require('../config');
const repo = require('../db/pluginRotationRepo');
const jobRepo = require('../db/pluginJobRepo');
const { ewma } = require('../services/pluginSearch/eta');

// Doble de Postgres EN MEMORIA con la misma semantica que las tres tablas del
// plugin: el lease con caducidad (lo que impide que dos busquedas del mismo
// grupo corrompan el cursor), la EWMA de las estadisticas, y los trabajos con
// su checkpoint, su fencing por instancia y su adopcion tras una caida.
//
// Compartido por pluginRotation.test.js y pluginPark.test.js: dos copias del
// mismo doble acabarian con dos semanticas distintas de la misma tabla.

// Identidad de "este proceso" dentro del doble. Un trabajo cuya fila lleve otra
// instancia no es nuestro, y las escrituras vallada lo rechazan igual que la
// sentencia real (`WHERE instance_id = $me`).
const ESTA_INSTANCIA = 'instancia-de-pruebas';

function crearBaseFalsa() {
    const rotaciones = new Map();
    const estadisticas = new Map();
    const trabajosPersistidos = new Map();
    let disponible = true;
    let fallarAdquirir = false;

    // Contadores de operaciones, para poder afirmar sobre lo que se escribio.
    const operaciones = { renew: 0, snapshot: 0, adopt: 0 };

    const filaAJob = fila => ({
        searchId: fila.searchId, groupId: fila.groupId, status: fila.status,
        target: fila.target, found: fila.found, candidatesExamined: fila.candidatesExamined,
        stoppedBy: fila.stoppedBy, progress: fila.progress, outfits: fila.outfits,
        stats: fila.stats, error: fila.error,
        params: fila.params ?? null, phase: fila.phase ?? 'working',
        resumeAt: fila.resumeAt ?? null, rateLimitedRoute: fila.rateLimitedRoute ?? null,
        checkpoint: fila.checkpoint ?? null, instanceId: fila.instanceId ?? null,
        createdAt: fila.createdAt, startedAt: fila.startedAt, finishedAt: fila.finishedAt,
        desdeBase: true,
    });

    return {
        rotaciones,
        estadisticas,
        trabajosPersistidos,
        operaciones,
        ESTA_INSTANCIA,
        set disponible(v) { disponible = v; },
        set fallarAdquirir(v) { fallarAdquirir = v; },

        instalar() {
            repo.disponible = () => disponible;

            // ── plugin_search_jobs ───────────────────────────────────────────
            jobRepo.disponible = () => disponible;

            jobRepo.crear = async trabajo => {
                if (!disponible) return;
                trabajosPersistidos.set(trabajo.searchId, {
                    searchId: trabajo.searchId, groupId: String(trabajo.groupId),
                    status: trabajo.status, target: trabajo.target, found: 0,
                    candidatesExamined: 0, stoppedBy: null, progress: null,
                    outfits: [], stats: null, error: null,
                    params: trabajo.params ? JSON.parse(JSON.stringify(trabajo.params)) : null,
                    phase: 'working', resumeAt: null, rateLimitedRoute: null, checkpoint: null,
                    instanceId: ESTA_INSTANCIA,
                    createdAt: Date.now(), startedAt: null, finishedAt: null,
                    heartbeatAt: Date.now(), expiresAt: null,
                });
            };

            // FENCED, como la sentencia real: solo escribe si la fila sigue
            // siendo de esta instancia, y devuelve si lo era.
            jobRepo.actualizar = async trabajo => {
                if (!disponible) return true;
                const fila = trabajosPersistidos.get(trabajo.searchId);
                if (!fila) return true;
                if (fila.instanceId !== ESTA_INSTANCIA) return false;
                operaciones.snapshot++;
                fila.status = trabajo.status;
                fila.found = trabajo.progress?.found ?? 0;
                fila.candidatesExamined = trabajo.progress?.candidatesExamined ?? 0;
                fila.progress = trabajo.progress ?? null;
                fila.startedAt = fila.startedAt ?? trabajo.startedAt ?? null;
                fila.phase = trabajo.phase ?? 'working';
                fila.resumeAt = trabajo.resumeAt ?? null;
                fila.rateLimitedRoute = trabajo.rateLimitedRoute ?? null;
                if (trabajo.checkpointPendiente) {
                    fila.checkpoint = JSON.parse(JSON.stringify(trabajo.checkpointPendiente));
                }
                fila.heartbeatAt = Date.now();
                return true;
            };

            jobRepo.terminar = async trabajo => {
                if (!disponible) return;
                const fila = trabajosPersistidos.get(trabajo.searchId);
                if (!fila) return;
                if (fila.instanceId !== ESTA_INSTANCIA) return;
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
            };

            jobRepo.leer = async searchId => {
                if (!disponible) return null;
                const fila = trabajosPersistidos.get(searchId);
                return fila ? filaAJob(fila) : null;
            };

            // Adopcion atomica de lo reanudable con latido viejo: cambia de
            // dueño y devuelve las filas, igual que el UPDATE ... RETURNING.
            jobRepo.adoptarHuerfanos = async (limite = 8) => {
                if (!disponible) return [];
                const adoptadas = [];
                const ahora = Date.now();
                for (const fila of trabajosPersistidos.values()) {
                    if (adoptadas.length >= limite) break;
                    if (!['queued', 'running'].includes(fila.status)) continue;
                    if (!fila.params) continue;
                    const plazo = fila.status === 'queued'
                        ? config.pluginJobs.queuedTimeoutMs
                        : config.pluginJobs.heartbeatTimeoutMs;
                    if (fila.heartbeatAt !== null && fila.heartbeatAt >= ahora - plazo) continue;
                    fila.instanceId = ESTA_INSTANCIA;
                    fila.heartbeatAt = ahora;
                    operaciones.adopt++;
                    adoptadas.push(filaAJob(fila));
                }
                return adoptadas;
            };

            jobRepo.expirarHuerfanos = async () => {
                if (!disponible) return 0;
                let n = 0;
                const ahora = Date.now();
                for (const fila of trabajosPersistidos.values()) {
                    if (!['queued', 'running'].includes(fila.status)) continue;
                    if (fila.params) continue; // reanudable: se adopta, no se expira
                    const plazo = fila.status === 'queued'
                        ? config.pluginJobs.queuedTimeoutMs
                        : config.pluginJobs.heartbeatTimeoutMs;
                    if (fila.heartbeatAt !== null && fila.heartbeatAt >= ahora - plazo) continue;
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
                // El WHERE lease_owner de la sentencia real: si el lease ya no
                // es tuyo, no se escribe nada.
                if (!fila || fila.leaseOwner !== estado.owner) return false;
                fila.cursor = estado.cursor;
                fila.intraPageOffset = estado.intraPageOffset;
                fila.lastUserId = estado.lastUserId;
                fila.cycle = estado.cycle;
                fila.cursorResets = estado.cursorResets;
                fila.leaseExpiresAt = Date.now() + Math.max(estado.leaseMs ?? 0, config.pluginRotation.leaseMs);
                return true;
            };

            // Solo el lease, sin avance: lo que hace un trabajo estacionado.
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

            // Sin esto, el doble caeria en la implementacion real, que consulta
            // una base que en los tests no existe: devolveria "no se sabe" y la
            // espera se comportaria distinto de como se comporta en produccion.
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

        // Simula que OTRA REPLICA tiene el lease del grupo: la fila existe con
        // un dueño que no es el de este proceso y con caducidad en el futuro.
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

        // La otra replica termina y suelta, dejando el cursor mas adelante.
        otraInstanciaSuelta(groupId, avance = {}) {
            const fila = rotaciones.get(String(groupId));
            if (!fila) return;
            Object.assign(fila, avance);
            fila.leaseOwner = null;
            fila.leaseExpiresAt = null;
        },

        // Simula la MUERTE de la instancia que tiene un trabajo: la fila queda
        // con un dueño que ya no existe y un latido viejo. Es exactamente lo
        // que ve la siguiente instancia al arrancar.
        instanciaMuereCon(searchId) {
            const fila = trabajosPersistidos.get(searchId);
            if (!fila) return null;
            fila.instanceId = 'instancia-muerta';
            fila.heartbeatAt = 0;
            return fila;
        },

        limpiar() {
            rotaciones.clear();
            estadisticas.clear();
            trabajosPersistidos.clear();
            disponible = true;
            fallarAdquirir = false;
            operaciones.renew = 0;
            operaciones.snapshot = 0;
            operaciones.adopt = 0;
        },
    };
}

module.exports = { crearBaseFalsa, ESTA_INSTANCIA };
