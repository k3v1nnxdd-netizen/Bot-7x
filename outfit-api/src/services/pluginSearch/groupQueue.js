'use strict';

const config = require('../../config');
const logger = require('../../observability/logger');

// Cola de turno POR COMUNIDAD. Garantiza que un groupId lo recorre UNA sola
// busqueda a la vez, y que la siguiente arranca exactamente donde termino la
// anterior.
//
// POR QUE NO VALIA DEJARLAS CORRER A LA VEZ. Dos busquedas simultaneas sobre el
// mismo grupo o pisan el mismo cursor (y la rotacion deja de significar nada) o
// recorren por sitios distintos (y entonces "continuar donde lo dejaste" es
// mentira). La unica semantica que se sostiene es la de una sola rotacion por
// comunidad, y eso es una cola.
//
// SIN SONDEO Y SIN SLEEPS. Quien espera se queda colgado de una promesa que
// resuelve el que va delante al soltar el turno. No hay temporizadores
// comprobando si ya toca: el unico temporizador que existe es el del plazo
// maximo de espera, y se cancela en cuanto llega el turno.
//
// NADA DE BLOQUEO GLOBAL: la cola es un Map por groupId. El grupo A esperando
// no roza al grupo B, que corre en paralelo con normalidad.
//
// SIN INANICION: la cola es FIFO estricta. Quien llega antes entra antes, y un
// grupo muy solicitado no puede dejar a nadie esperando indefinidamente porque
// el plazo maximo lo saca de la cola con un motivo claro.

// groupId -> { ocupado, esperando: [ {resolver, rechazar, temporizador} ] }
const colas = new Map();

class ColaLlenaError extends Error {
    constructor(groupId, tamano) {
        super(`Ya hay ${tamano} busquedas esperando turno para este grupo`);
        this.name = 'ColaLlenaError';
        this.code = 'queue_full';
        this.groupId = groupId;
    }
}

class EsperaAgotadaError extends Error {
    constructor(groupId, esperaMs) {
        super(`Se agoto la espera de turno tras ${esperaMs} ms`);
        this.name = 'EsperaAgotadaError';
        this.code = 'queue_timeout';
        this.groupId = groupId;
    }
}

function estadoDe(groupId) {
    const clave = String(groupId);
    let estado = colas.get(clave);
    if (!estado) {
        estado = { ocupado: false, esperando: [] };
        colas.set(clave, estado);
    }
    return estado;
}

// Cuantos hay por delante. Es lo que el plugin enseña como `queuePosition`, y
// por eso se cuenta desde 1: "eres el siguiente" es 1, no 0.
function posicionEnCola(groupId) {
    const estado = colas.get(String(groupId));
    return estado ? estado.esperando.length : 0;
}

function estaOcupado(groupId) {
    return colas.get(String(groupId))?.ocupado === true;
}

// Pide el turno del grupo. Devuelve una funcion `soltar()` que HAY QUE LLAMAR
// siempre — en un finally — para que pase el siguiente.
//
// `onEncolado` se llama si hay que esperar, con la posicion. Sirve para que el
// trabajo pase a `queued` y el plugin pueda decir "esperando turno" en vez de
// fingir que ya esta buscando.
async function tomarTurno(groupId, { onEncolado = null } = {}) {
    const clave = String(groupId);
    const estado = estadoDe(clave);

    if (!estado.ocupado) {
        estado.ocupado = true;
        return crearLiberador(clave);
    }

    if (estado.esperando.length >= config.pluginQueue.maxWaiting) {
        throw new ColaLlenaError(clave, estado.esperando.length);
    }

    const posicion = estado.esperando.length + 1;
    onEncolado?.(posicion);

    logger.info('Busqueda en cola: el grupo lo esta recorriendo otra', {
        groupId: clave, queuePosition: posicion, esperando: estado.esperando.length + 1,
    });

    return new Promise((resolve, reject) => {
        const entrada = { resolve, reject, temporizador: null };

        // El UNICO temporizador de todo esto, y no es un sondeo: dispara una
        // vez, al vencer el plazo. Si el turno llega antes, se cancela.
        entrada.temporizador = setTimeout(() => {
            const indice = estado.esperando.indexOf(entrada);
            if (indice !== -1) estado.esperando.splice(indice, 1);
            reject(new EsperaAgotadaError(clave, config.pluginQueue.waitTimeoutMs));
        }, config.pluginQueue.waitTimeoutMs);

        // No debe mantener vivo el proceso: si no queda nada mas que hacer, que
        // el servicio pueda apagarse limpiamente.
        entrada.temporizador.unref?.();

        estado.esperando.push(entrada);
    });
}

function crearLiberador(clave) {
    let soltado = false;

    // Idempotente: soltar dos veces (un finally anidado, un camino de error)
    // dejaria pasar a dos busquedas a la vez, que es exactamente lo que esta
    // cola existe para impedir.
    return function soltar() {
        if (soltado) return;
        soltado = true;

        const estado = colas.get(clave);
        if (!estado) return;

        const siguiente = estado.esperando.shift();
        if (!siguiente) {
            // Nadie esperando: se libera el grupo y se borra la entrada para que
            // el Map no crezca con un grupo por cada comunidad consultada.
            estado.ocupado = false;
            colas.delete(clave);
            return;
        }

        clearTimeout(siguiente.temporizador);
        // El turno se TRASPASA sin pasar por libre: si `ocupado` bajara a false
        // aunque fuera un instante, una busqueda nueva podria colarse entre
        // medias y adelantar a quien llevaba esperando.
        siguiente.resolve(crearLiberador(clave));
    };
}

// Solo para los tests: vacia todas las colas rechazando a quien espere.
function reset() {
    for (const estado of colas.values()) {
        for (const entrada of estado.esperando) {
            clearTimeout(entrada.temporizador);
            entrada.reject(new EsperaAgotadaError('reset', 0));
        }
    }
    colas.clear();
}

module.exports = {
    tomarTurno, posicionEnCola, estaOcupado, reset,
    ColaLlenaError, EsperaAgotadaError,
    get grupos() { return colas.size; },
};
