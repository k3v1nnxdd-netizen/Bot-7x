'use strict';

const config = require('../../config');
const logger = require('../../observability/logger');
const repo = require('../../db/pluginRotationRepo');
const { traerPaginaDeMiembros } = require('./memberPool');
const cola = require('./groupQueue');
const notificador = require('../../db/rotationNotifier');
const requestContext = require('../../observability/requestContext');

// ETAPA 0 — ROTACION. De un groupId a un flujo SECUENCIAL y PERSISTENTE de
// miembros: la busqueda de hoy empieza donde termino la de ayer, da la vuelta
// al llegar al final y sigue indefinidamente.
//
// POR QUE NO HAY UN INDICE NUMERICO EN NINGUNA PARTE. La API de grupos de
// Roblox pagina con cursores OPACOS. No existe "el miembro 437", no se puede
// saltar a el, y un contador propio dejaria de significar nada en cuanto una
// persona entre o salga del grupo. Lo que se guarda es exactamente lo que
// Roblox si define:
//
//   cursor            la pagina, en el lenguaje de Roblox
//   intraPageOffset   cuantos de ESA pagina ya se miraron
//   lastUserId        con quien se quedo (constancia y reanudacion inclusiva)
//   cycle             vueltas completas dadas a la comunidad
//
// Con eso se reanuda a mitad de pagina sin inventarse posiciones globales.
//
// UNA SOLA ROTACION POR COMUNIDAD, GLOBALMENTE. No "una por proceso": una en
// todo el sistema, aunque Railway levante seis replicas. Dos recorridos a la vez
// o pisan el mismo cursor o convierten "continuar donde lo dejaste" en una frase
// sin significado, asi que la exclusion es absoluta y se apoya en Postgres.
//
// DOS PUERTAS, en este orden:
//
//   1. LOCAL (groupQueue.js). Cola FIFO en memoria por groupId. Resuelve la
//      contencion dentro de un proceso al instante y sin tocar la base: dos
//      busquedas de la misma instancia no se pelean por el lease, hacen fila.
//
//   2. GLOBAL (lease en plugin_group_rotation). Una sentencia atomica decide
//      quien recorre el grupo en TODO el sistema. Quien no lo consigue espera a
//      que lo suelten, y despierta por LISTEN/NOTIFY — sin sondear.
//
// `ephemeral` NO ES UN FALLBACK DE CONTENCION. Existe unicamente cuando no hay
// DATABASE_URL (desarrollo local), donde no hay nada que coordinar porque no hay
// estado compartido. Con Postgres delante, una busqueda o consigue el turno o
// termina diciendolo: recorrer "por libre" mientras otra avanza el cursor es
// exactamente la corrupcion que todo esto existe para impedir.
const MODO = Object.freeze({
    LEASED: 'leased',
    EPHEMERAL: 'ephemeral',
});

const ORDENES = ['Asc', 'Desc'];
const ordenAleatorio = () => ORDENES[Math.floor(Math.random() * ORDENES.length)];

// Abre la rotacion de un grupo. TOMA TURNO primero: si otra busqueda esta
// recorriendo esa comunidad, esta espera (sin sondear) a que suelte.
//
// `onEncolado` se propaga tal cual a la cola, para que el trabajo pueda pasar a
// `queued` y el plugin diga "esperando turno" en vez de fingir que ya busca.
//
// Puede lanzar ColaLlenaError o EsperaAgotadaError; las dos son condiciones
// legitimas y la ruta las traduce a una respuesta clara. Cualquier otro fallo
// (la base) degrada a modo efimero, que es como funcionaba antes de existir la
// persistencia: la API de outfits nunca ha dependido de Postgres.
async function abrirRotacion(groupId, stats, {
    onEncolado = null,
    // Duracion del lease que pide ESTA busqueda: su presupuesto de tiempo mas
    // margen. Ver budget.duracionDelLease y el comentario de
    // config.pluginRotation.leaseMs.
    leaseMs = config.pluginRotation.leaseMs,
    // Techo de PAGINAS de miembros que puede llegar a pedir esta busqueda. Es
    // proteccion anti-bucle y vive aqui, y no en quien llama, porque un solo
    // `siguienteSegmento` puede recorrer muchas paginas sin devolver a nadie
    // (todas ya vistas): comprobarlo solo entre segmentos no cortaria nada.
    maxPaginas = config.pluginSearch.maxMemberPages,
    // userIds que ESTA busqueda ya tiene en la mano (reanudacion desde un
    // checkpoint: los outfits encontrados y los candidatos pendientes). Se
    // siembran como vistos para que la rotacion, que retoma desde la ultima
    // posicion PERSISTIDA, no los vuelva a entregar por segunda vez.
    yaVistos = [],
} = {}) {
    // Puerta 1: la cola local. Sin base de datos es la unica que hay.
    const soltarTurno = await cola.tomarTurno(groupId, { onEncolado });

    try {
        const inicial = ordenAleatorio();

        // Sin Postgres no hay estado compartido que proteger ni nada que
        // coordinar entre instancias: se recorre en efimero, que es como
        // funcionaba el servicio antes de que existiera la persistencia.
        if (!repo.disponible()) {
            return crear(groupId, {
                groupId, sortOrder: inicial, cursor: null, intraPageOffset: 0,
                lastUserId: null, cycle: 1, cursorResets: 0, owner: null,
            }, MODO.EPHEMERAL, stats, soltarTurno, { leaseMs, maxPaginas, yaVistos });
        }

        // Puerta 2: el lease global.
        const estado = await adquirirGlobal(groupId, inicial, onEncolado, leaseMs);
        return crear(groupId, estado, MODO.LEASED, stats, soltarTurno, { leaseMs, maxPaginas, yaVistos });
    } catch (err) {
        // Si algo revienta ANTES de que la rotacion exista, el turno local se
        // suelta aqui: si no, el grupo quedaria bloqueado para los que esperan.
        soltarTurno();
        throw err;
    }
}

// Espera al lease GLOBAL del grupo. Devuelve el estado con el lease cogido, o
// lanza EsperaAgotadaError. NUNCA devuelve algo que permita recorrer sin lease.
//
// COMO SE DESPIERTA, y por que no hay sondeo. Cada vuelta se queda esperando a
// que ocurra lo PRIMERO de tres cosas:
//
//   - un NOTIFY de la instancia que suelta el grupo (caso normal: llega en
//     milisegundos);
//   - la CADUCIDAD del lease actual, calculada una vez con una consulta — es la
//     red que cubre a la instancia que muere sin soltar y al aviso perdido;
//   - el plazo maximo de cola.
//
// Solo se consulta la base cuando de verdad ha pasado algo. Mientras nadie
// suelta y el lease sigue vivo, esto no hace ni una consulta.
async function adquirirGlobal(groupId, sortOrderInicial, onEncolado, leaseMs) {
    const limite = Date.now() + config.pluginQueue.waitTimeoutMs;

    const primero = await repo.adquirir(groupId, sortOrderInicial, leaseMs);
    if (primero) return primero;

    // Lo tiene otra instancia (o otra busqueda que aun no ha soltado). A partir
    // de aqui el trabajo esta EN COLA de verdad, y hay que decirlo.
    onEncolado?.(await repo.posicionGlobalEnCola(groupId));
    logger.info('Busqueda esperando el turno global del grupo', { groupId: String(groupId) });

    for (;;) {
        const restante = limite - Date.now();
        if (restante <= 0) {
            throw new cola.EsperaAgotadaError(String(groupId), config.pluginQueue.waitTimeoutMs);
        }

        await esperarSeñal(groupId, restante);

        const estado = await repo.adquirir(groupId, sortOrderInicial, leaseMs);
        if (estado) return estado;
    }
}

// Una sola espera, que termina con el primer evento util. Ni bucles ni
// temporizadores repetidos: un aviso, un temporizador y el plazo.
async function esperarSeñal(groupId, restanteMs) {
    // Cuanto le queda al lease de quien lo tiene.
    //   0    -> el grupo acaba de quedar libre: se vuelve ya a intentarlo.
    //   > 0  -> se duerme hasta que venza (o hasta que llegue el aviso).
    //   null -> la base no lo pudo decir. NO se reintenta al instante: eso seria
    //           un bucle ocupado martilleando una base que ya va mal. Se espera
    //           como si el lease durara lo normal, y el aviso sigue pudiendo
    //           despertar antes.
    const esperaLease = await repo.esperaDelLease(groupId);
    if (esperaLease === 0) return;

    const margen = esperaLease === null
        ? config.pluginRotation.leaseMs
        : esperaLease + config.pluginQueue.foreignLeaseGraceMs;

    const hastaCaducidad = Math.min(margen, restanteMs);

    let darDeBaja = null;
    let temporizador = null;

    try {
        await new Promise(resolve => {
            let resuelto = false;
            const terminar = () => {
                if (resuelto) return;
                resuelto = true;
                resolve();
            };

            // 1. Aviso de que el grupo quedo libre. Llega por LISTEN/NOTIFY
            //    desde CUALQUIER instancia, incluida esta.
            notificador.alLiberarse(groupId, terminar)
                .then(baja => {
                    darDeBaja = baja;
                    // Si el aviso llego mientras se montaba la suscripcion, la
                    // promesa ya esta resuelta y esto solo limpia.
                    if (resuelto) baja();
                })
                .catch(() => { /* sin avisos: queda el temporizador */ });

            // 2. Caducidad del lease. Es lo que cubre a una replica que muere
            //    sin soltar: nadie mandara NOTIFY, pero el lease vence igual.
            temporizador = setTimeout(terminar, Math.max(1, hastaCaducidad));
            temporizador.unref?.();
        });
    } finally {
        if (temporizador) clearTimeout(temporizador);
        if (darDeBaja) darDeBaja();
    }
}

function crear(groupId, estadoInicial, modo, stats, soltarTurno, { leaseMs, maxPaginas, yaVistos = [] } = {}) {
    const estado = { ...estadoInicial, groupId: String(groupId), leaseMs };
    const inicio = { cursor: estado.cursor, offset: estado.intraPageOffset, cycle: estado.cycle };

    // Miembros ya entregados EN ESTA busqueda. Es lo que impide evaluar dos
    // veces al mismo usuario cuando el wrap-around ocurre a mitad de peticion.
    // Al reanudar desde un checkpoint arranca sembrado con lo que la busqueda
    // ya tenia en la mano.
    const vistos = new Set(yaVistos.map(String));

    let wraps = 0;
    let agotado = false;
    let persistePendiente = false;

    // Paginas de miembros pedidas en ESTA busqueda, y si se llego al techo.
    // Son dos cosas distintas de `agotado`: agotado significa "no queda nadie
    // nuevo que mirar" y esto significa "queda gente, pero dejamos de pedir
    // paginas". Quien llama las distingue para dar el motivo de parada bueno.
    let paginas = 0;
    let topePaginas = false;

    // Pagina actual en memoria, para no volver a pedirla en cada segmento.
    let pagina = null; // { miembros, nextCursor, cursor }

    async function cargarPagina(cursor) {
        paginas++;
        try {
            const traida = await traerPaginaDeMiembros(groupId, estado.sortOrder, cursor, stats);
            return { ...traida, cursor };
        } catch (err) {
            // UN CURSOR GUARDADO PUEDE CADUCAR. Roblox no promete cuanto vive
            // un cursor, y entre dos busquedas pueden pasar dias. Si falla con
            // un cursor almacenado, se reinicia el ciclo desde el principio:
            // determinista, y repite trabajo en vez de saltarselo — que es la
            // direccion segura de equivocarse.
            //
            // Con cursor null el fallo NO es del cursor (el grupo no existe,
            // Roblox esta caido) y tiene que subir tal cual.
            if (cursor === null) throw err;

            estado.cursorResets++;
            estado.cursor = null;
            estado.intraPageOffset = 0;
            logger.warn('Cursor de rotacion invalido, se reinicia el ciclo del grupo', {
                groupId: estado.groupId,
                cycle: estado.cycle,
                cursorResets: estado.cursorResets,
                detail: err?.message,
            });
            const traida = await traerPaginaDeMiembros(groupId, estado.sortOrder, null, stats);
            return { ...traida, cursor: null };
        }
    }

    return {
        get modo() { return modo; },
        get cycle() { return estado.cycle; },
        get cursorResets() { return estado.cursorResets; },
        get wraps() { return wraps; },
        get agotado() { return agotado; },
        get paginas() { return paginas; },
        get topePaginas() { return topePaginas; },
        get inicio() { return inicio; },
        get posicion() { return { cursor: estado.cursor, offset: estado.intraPageOffset, cycle: estado.cycle }; },

        // Siguiente tanda de miembros NUEVOS, como mucho `cuantos`.
        //
        // Devuelve [] cuando la comunidad se ha dado la vuelta entera y todo lo
        // que aparece ya se miro en esta misma busqueda. Quien llama lo toma
        // como "no queda nadie util" y termina.
        async siguienteSegmento(cuantos) {
            const segmento = [];

            while (segmento.length < cuantos && !agotado) {
                if (pagina === null || pagina.cursor !== estado.cursor) {
                    // TECHO DE PAGINAS. Se comprueba justo antes de pedir una,
                    // que es el unico sitio donde puede cortar el bucle
                    // patologico: paginas que Roblox sirve indefinidamente y en
                    // las que no viene nadie nuevo. Ahi `examinados` no crece,
                    // asi que su techo no llegaria a dispararse jamas.
                    if (paginas >= maxPaginas) {
                        topePaginas = true;
                        agotado = true;
                        logger.warn('Busqueda del plugin detenida: techo de paginas de miembros', {
                            requestId: requestContext.requestId(),
                            searchId: requestContext.searchId(),
                            groupId: estado.groupId, paginas, maxPaginas, cycle: estado.cycle,
                        });
                        break;
                    }
                    pagina = await cargarPagina(estado.cursor);
                }

                const miembros = pagina.miembros;

                // Pagina consumida: se pasa a la siguiente, o se da la vuelta.
                if (estado.intraPageOffset >= miembros.length) {
                    if (pagina.nextCursor) {
                        estado.cursor = pagina.nextCursor;
                        estado.intraPageOffset = 0;
                        pagina = null;
                        continue;
                    }

                    // ── WRAP-AROUND ──────────────────────────────────────────
                    // Se acabo la comunidad: vuelta al principio y ciclo nuevo.
                    wraps++;
                    estado.cycle++;
                    estado.cursor = null;
                    estado.intraPageOffset = 0;
                    pagina = null;
                    persistePendiente = true;

                    // Dos vueltas en la MISMA busqueda significa que ya se vio
                    // todo lo que hay. Sin este corte, un grupo pequeño giraria
                    // en redondo hasta agotar el presupuesto sin aportar nada.
                    if (wraps > 1) { agotado = true; break; }
                    continue;
                }

                const miembro = miembros[estado.intraPageOffset];
                estado.intraPageOffset++;

                if (miembro && !vistos.has(String(miembro.userId))) {
                    vistos.add(String(miembro.userId));
                    segmento.push(miembro);
                    estado.lastUserId = String(miembro.userId);
                    persistePendiente = true;
                }
            }

            // Un segmento vacio con la comunidad ya recorrida entera: no hay
            // nadie nuevo que mirar.
            if (segmento.length === 0) agotado = true;
            return segmento;
        },

        // Guarda el avance. Se llama al final de cada segmento, no solo al
        // terminar: si el proceso muere a mitad, se pierde un segmento y no la
        // busqueda entera. En modo concurrente o efimero no hay nada que
        // guardar, y decirlo aqui evita que quien llama tenga que saberlo.
        async persistir() {
            if (modo !== MODO.LEASED || !persistePendiente) return false;

            // RESUME INCLUSIVO: se guarda la posicion del ultimo miembro
            // entregado, no la siguiente. La proxima busqueda vuelve a mirarlo
            // — un candidato repetido, despreciable — y a cambio nadie se
            // pierde si esta busqueda murio despues de procesarlo y antes de
            // guardar.
            const offset = config.pluginRotation.resumeInclusive
                ? Math.max(0, estado.intraPageOffset - 1)
                : estado.intraPageOffset;

            const guardado = await repo.guardar({ ...estado, intraPageOffset: offset });
            if (guardado) persistePendiente = false;
            return guardado;
        },

        // Renueva SOLO el lease, sin guardar avance. Es lo que un trabajo
        // ESTACIONADO hace en cada latido: no ha movido el cursor, pero el
        // grupo tiene que seguir reservado hasta que reanude. Devuelve false si
        // el lease ya no es nuestro — y entonces quien llama tiene que parar,
        // porque otra busqueda puede estar moviendo el mismo cursor.
        async renovar() {
            if (modo !== MODO.LEASED) return true;
            return repo.renovar(estado.groupId, estado.owner, estado.leaseMs);
        },

        // Cierra la rotacion: guarda lo que quede y suelta el lease. SIEMPRE se
        // llama, haya ido bien o mal — un lease sin soltar bloquea el grupo
        // hasta que caduque.
        //
        // `guardarAvance: false` cierra SIN persistir el ultimo tramo. Es lo
        // que hace la busqueda cuando termina con candidatos PENDIENTES (se le
        // entregaron, pero Roblox no dejo mirarlos): la posicion guardada se
        // queda en el ultimo tramo procesado entero, asi que la siguiente
        // busqueda los vuelve a entregar en vez de saltarselos. Repetir un
        // puñado es barato; perderlos es justo lo que un limite no puede
        // provocar.
        async cerrar({ guardarAvance = true } = {}) {
            try {
                if (guardarAvance) await this.persistir();
            } finally {
                try {
                    if (modo === MODO.LEASED) {
                        await repo.soltar(estado.groupId, estado.owner);
                        // AVISO GLOBAL: quien este esperando este grupo en
                        // cualquier instancia despierta ahora, en vez de esperar
                        // a que venza el lease. Si el aviso se pierde, la
                        // caducidad sigue cubriendolo — es latencia, no
                        // correccion.
                        await notificador.anunciarLiberacion(estado.groupId);
                    }
                } finally {
                    // SIEMPRE, pase lo que pase: si el turno no se suelta, el
                    // siguiente de la cola no arranca nunca. Va en el finally
                    // mas interno a proposito — ni un fallo al soltar el lease
                    // puede dejar la cola parada.
                    soltarTurno();
                }
            }
        },
    };
}

module.exports = { abrirRotacion, MODO };
