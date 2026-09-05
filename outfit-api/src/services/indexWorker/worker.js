'use strict';

const config = require('../../config');
const logger = require('../../observability/logger');
const roblox = require('../../roblox/client');
const rateLimiter = require('../../roblox/rateLimiter');
const crawlRepo = require('../../db/indexCrawlRepo');
const memberRepo = require('../../db/groupMemberRepo');
const avatarRepo = require('../../db/avatarIndexRepo');
const cola = require('../pluginSearch/groupQueue');
const { resolverUsuario, crearContador, MOTIVO } = require('./resolver');

// EL WORKER DEL INDICE.
//
// Recorre comunidades despacio y llena el indice. Es la pieza que hace que una
// busqueda deje de necesitar 335 llamadas vivas a Roblox, y su virtud principal
// es que NO TIENE PRISA: nadie espera su respuesta, asi que un cooldown de una
// hora es para el una hora de sueño, no un fallo.
//
// Cuatro decisiones que lo definen:
//
//   POR DEMANDA. No recorre la whitelist entera por orden alfabetico. Va al
//   grupo que mas se ha buscado y no se ha podido servir (`priority`), y en su
//   defecto al que lleva mas sin refrescarse. Indexar comunidades que nadie
//   busca es gastar la cuota que necesitan las que si.
//
//   CEDE EL PASO. El limitador es del proceso: cada llamada que hace el worker
//   es cuota que no tiene una busqueda con alguien delante. Si hay una busqueda
//   viva, el worker se aparta.
//
//   UN 429 NO ESCRIBE. Ni degrada, ni marca, ni borra. Corta el ciclo, suelta
//   el lease y se va. Lo que ya estaba en el indice sigue exactamente igual.
//
//   REANUDABLE. El cursor esta en Postgres y se guarda al cerrar cada tramo. Un
//   redeploy a mitad de comunidad continua por donde iba, no por el principio.

const RUTA_AVATAR = 'userAvatar';

function crearWorker({ instancia, repos = {} } = {}) {
    const crawl = repos.crawl ?? crawlRepo;
    const miembros = repos.miembros ?? memberRepo;
    const avatares = repos.avatares ?? avatarRepo;

    const id = instancia ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

    // ── Metricas, en memoria y agregadas ────────────────────────────────────
    // Cobertura y frescura salen de la base (una consulta por ciclo, ya hecha);
    // el resto se cuenta aqui. Todo esto sale por /v1/metrics.
    const metricas = {
        instance: id,
        cycles: 0,
        groupsVisited: 0,
        membersSeen: 0,
        usersResolved: 0,
        usersWritten: 0,
        notFound: 0,
        emptyAvatar: 0,
        unpriceable: 0,
        errors: 0,
        rateLimitHits: 0,        // cuantas veces Roblox corto un ciclo
        rateLimitedMs: 0,        // cuanto se pidio esperar en total
        yieldedToSearch: 0,      // ciclos que cedieron el paso a una busqueda
        leaseLost: 0,
        lastCycleAt: null,
        lastCycleMs: null,
        lastGroupId: null,
        lastError: null,
        usersPerMinute: 0,       // velocidad observada
        coverage: null,          // {groupId, members, indexed, valid, fresh, ...}
    };

    let corriendo = false;
    let temporizador = null;
    let parado = false;

    const ttl = () => ({
        ttlAvatarMs: config.indexWorker.avatarTtlMs,
        ttlPrecioMs: config.indexWorker.priceTtlMs,
        pricingVersion: config.indexWorker.pricingVersion,
    });

    // ¿Hay alguien esperando? Si una busqueda tiene turno en cualquier grupo,
    // la cuota es suya. El worker vuelve en el siguiente tick.
    function hayBusquedasVivas() {
        return cola.grupos > 0;
    }

    // ¿Esta Roblox frenando la ruta del avatar? Se pregunta ANTES de cada
    // llamada, no despues del error: mandar peticiones contra una ruta cerrada
    // solo alarga el cooldown de todo el servicio.
    function rutaFrenada() {
        const estado = rateLimiter.getThrottleState(RUTA_AVATAR);
        return estado.throttled ? estado : null;
    }

    // ── UN CICLO ────────────────────────────────────────────────────────────
    //
    // Coge un grupo, pide UNA pagina de miembros, resuelve un puñado y guarda.
    // Deliberadamente pequeño: cada ciclo empieza y termina con el estado en
    // Postgres, asi que morir entre dos ciclos no pierde nada mas que el ciclo.
    //
    // Devuelve un resumen, siempre. No lanza salvo que la propia base falle.
    async function ciclo() {
        if (!crawl.disponible()) return { hecho: false, motivo: 'sin_base' };
        if (hayBusquedasVivas()) {
            metricas.yieldedToSearch++;
            return { hecho: false, motivo: 'cede_a_busqueda' };
        }

        const freno = rutaFrenada();
        if (freno) {
            metricas.rateLimitHits++;
            metricas.rateLimitedMs += freno.cooldownRemainingMs;
            return { hecho: false, motivo: 'roblox_limitado', esperaMs: freno.cooldownRemainingMs };
        }

        const leaseMs = config.indexWorker.leaseMs;
        const grupo = await crawl.tomar(id, {
            leaseMs,
            refrescarCadaMs: config.indexWorker.fullPassEveryMs,
        });
        if (!grupo) return { hecho: false, motivo: 'sin_trabajo' };

        const arranque = Date.now();
        const resumen = {
            hecho: true, groupId: grupo.groupId,
            paginaPedida: false, miembrosVistos: 0,
            resueltos: 0, escritos: 0, limitado: false, errores: 0,
            vueltaCompleta: false, cursorAntes: grupo.cursor, cursorDespues: grupo.cursor,
        };

        try {
            // ── 1. Una pagina de miembros ───────────────────────────────────
            // Barata: no gasta la cuota de avatares, que es la escasa.
            const pagina = await roblox.listGroupMembers(grupo.groupId, {
                cursor: grupo.cursor,
                sortOrder: grupo.sortOrder,
            });
            resumen.paginaPedida = true;

            const listados = Array.isArray(pagina?.members) ? pagina.members : [];
            resumen.miembrosVistos = listados.length;
            metricas.membersSeen += listados.length;

            if (listados.length > 0) await miembros.registrarPagina(grupo.groupId, listados);

            // ── 2. A quien le toca ──────────────────────────────────────────
            // No se resuelve "la pagina": se le pregunta al indice quien
            // necesita trabajo en este grupo, que puede ser gente de paginas
            // anteriores cuyo TTL vencio. Asi el refresco no espera a dar la
            // vuelta entera.
            const pendientes = await avatares.pendientes(grupo.groupId, {
                limite: config.indexWorker.usersPerCycle,
                ...ttl(),
            });

            for (const pendiente of pendientes) {
                if (hayBusquedasVivas()) { metricas.yieldedToSearch++; break; }

                const frenoAhora = rutaFrenada();
                if (frenoAhora) {
                    // Roblox cerro la puerta a mitad. NO se escribe nada de lo
                    // que no se sepa, y sobre todo no se toca nada de lo que ya
                    // habia: el ciclo termina aqui y se reintenta luego.
                    resumen.limitado = true;
                    metricas.rateLimitHits++;
                    metricas.rateLimitedMs += frenoAhora.cooldownRemainingMs;
                    break;
                }

                const contador = crearContador();
                const desenlace = await resolverUsuario(pendiente, { contador });
                resumen.resueltos++;
                metricas.usersResolved++;

                if (!desenlace.ok) {
                    if (desenlace.motivo === MOTIVO.LIMITADO) {
                        resumen.limitado = true;
                        metricas.rateLimitHits++;
                        break;      // sin escribir: un limite no es un dato
                    }
                    resumen.errores++;
                    metricas.errors++;
                    metricas.lastError = desenlace.detalle ?? 'error';
                    await avatares.anotarError(pendiente.userId, desenlace.detalle);
                    continue;
                }

                const escrito = await avatares.upsert({
                    ...desenlace.registro,
                    pricingVersion: config.indexWorker.pricingVersion,
                });
                if (escrito) {
                    resumen.escritos++;
                    metricas.usersWritten++;
                    if (desenlace.registro.state === avatarRepo.ESTADO.NO_EXISTE) metricas.notFound++;
                    if (desenlace.registro.state === avatarRepo.ESTADO.AVATAR_VACIO) metricas.emptyAvatar++;
                    if (desenlace.registro.state === avatarRepo.ESTADO.SIN_PRECIO) metricas.unpriceable++;
                }
            }

            // ── 3. El avance ────────────────────────────────────────────────
            // El cursor SOLO avanza si la pagina se pidió y se registró entera.
            // Si el ciclo se corto por un limite, el cursor se queda donde
            // estaba: los miembros de esta pagina ya estan en la tabla de
            // pertenencia, y sus avatares se resolveran en el siguiente ciclo.
            const siguiente = pagina?.nextCursor ?? null;
            const cierraVuelta = siguiente === null;
            resumen.vueltaCompleta = cierraVuelta;
            resumen.cursorDespues = cierraVuelta ? null : siguiente;

            const guardado = await crawl.guardarCursor(grupo.groupId, id, {
                cursor: resumen.cursorDespues,
                intraPageOffset: 0,
                cycle: cierraVuelta ? grupo.cycle + 1 : grupo.cycle,
                membersSeen: resumen.miembrosVistos,
                usersIndexed: resumen.escritos,
                vueltaCompleta: cierraVuelta,
                // La demanda se consume con el trabajo hecho: un grupo muy
                // pedido conserva prioridad hasta que se ha recorrido de veras.
                prioridadConsumida: resumen.escritos > 0 ? 1 : 0,
                leaseMs,
            });
            if (!guardado) {
                // Otra instancia tiene el lease: nuestro avance no vale y no se
                // impone. Lo indexado NO se pierde — ya esta escrito y es
                // idempotente — solo se descarta el movimiento del cursor.
                metricas.leaseLost++;
                resumen.leasePerdido = true;
            }

            // ── 4. Cobertura, una vez por ciclo ─────────────────────────────
            metricas.coverage = await avatares.cobertura(grupo.groupId, ttl());

            metricas.groupsVisited++;
            return resumen;
        } catch (err) {
            metricas.errors++;
            metricas.lastError = err?.message ?? String(err);
            logger.warn('Ciclo del worker de indexado fallido', {
                groupId: grupo.groupId, instance: id, code: err?.code ?? null, detail: err?.message,
            });
            resumen.errores++;
            return resumen;
        } finally {
            // SIEMPRE. Un lease sin soltar deja el grupo congelado hasta que
            // caduque, y con el la comunidad que mas se busca.
            await crawl.soltar(grupo.groupId, id, { error: metricas.lastError });

            const duracion = Date.now() - arranque;
            metricas.cycles++;
            metricas.lastCycleAt = Date.now();
            metricas.lastCycleMs = duracion;
            metricas.lastGroupId = grupo.groupId;
            // Velocidad observada. El divisor tiene suelo de 1 ms porque un
            // ciclo puede completarse dentro del mismo milisegundo (todo en
            // cache, o un doble en las pruebas) y dividir por cero convertiria
            // la metrica en un cero engañoso justo cuando mas rapido va.
            if (resumen.resueltos > 0) {
                metricas.usersPerMinute = Math.round((resumen.resueltos / Math.max(1, duracion)) * 60_000);
            }
        }
    }

    // ── El bucle ────────────────────────────────────────────────────────────
    //
    // Un ciclo cada `tickMs`. No encadena ciclos sin pausa a proposito: el
    // objetivo es un goteo sostenido que no compita con las busquedas, no
    // llenar el indice cuanto antes.
    function arrancar() {
        if (temporizador || parado) return false;
        if (!config.indexWorker.enabled) {
            logger.info('Worker de indexado desactivado por configuracion', { instance: id });
            return false;
        }

        temporizador = setInterval(() => {
            if (corriendo) return;      // un ciclo lento no solapa con el siguiente
            corriendo = true;
            ciclo()
                .catch(err => {
                    metricas.errors++;
                    metricas.lastError = err?.message ?? String(err);
                })
                .finally(() => { corriendo = false; });
        }, config.indexWorker.tickMs);

        // El worker no puede impedir que el proceso se apague.
        temporizador.unref();
        logger.info('Worker de indexado arrancado', {
            instance: id, tickMs: config.indexWorker.tickMs,
            usersPerCycle: config.indexWorker.usersPerCycle,
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
        // Solo para pruebas: reinicia los contadores en memoria sin tocar la
        // base, que es justo lo que hace un redeploy.
        __reiniciarMetricas() {
            for (const clave of ['cycles', 'groupsVisited', 'membersSeen', 'usersResolved',
                'usersWritten', 'notFound', 'emptyAvatar', 'unpriceable', 'errors',
                'rateLimitHits', 'rateLimitedMs', 'yieldedToSearch', 'leaseLost']) {
                metricas[clave] = 0;
            }
        },
    };
}

// El worker de ESTE proceso. `crearWorker` existe aparte para que las pruebas
// puedan levantar dos instancias sobre la misma base, que es como se comprueba
// que el lease hace su trabajo.
const porDefecto = crearWorker({});

// Los accesores se reenvian a mano y NO con un spread: `metricas` es un getter
// que tiene que leerse en cada consulta, y un spread lo congelaria en la foto
// del momento de cargar el modulo.
module.exports = {
    crearWorker,
    porDefecto,
    ciclo: () => porDefecto.ciclo(),
    arrancar: () => porDefecto.arrancar(),
    parar: () => porDefecto.parar(),
    get instancia() { return porDefecto.instancia; },
    get metricas() { return porDefecto.metricas; },
};
