'use strict';

const logger = require('../../observability/logger');
const jobs = require('./jobs');
const pluginSearch = require('../pluginSearchService');

// EL MOTOR COMUN de los dos modos del POST y de la REANUDACION tras un
// reinicio. Es el unico sitio que sabe convertir un trabajo en una busqueda
// corriendo, y por eso vive aparte de la ruta: la ruta atiende peticiones
// HTTP, y una busqueda adoptada de una instancia caida no tiene ninguna.
//
// NUNCA rechaza en modo asincrono: un fallo se registra en el trabajo y el
// plugin lo ve como `failed`, en vez de convertirse en una promesa rechazada
// sin dueño.
async function arrancar(trabajo, peticion, { relanzar = false, checkpoint = null } = {}) {
    const id = trabajo.searchId;
    await jobs.marcarEnCurso(id).catch(() => { /* fenced: se detecta abajo */ });

    try {
        const resultado = await pluginSearch.searchOutfits(peticion, {
            requestId: trabajo.requestId,
            // El searchId viaja al contexto de correlacion, no solo al log
            // final: en modo asincrono la peticion HTTP termina en
            // milisegundos y la busqueda sigue minutos, asi que todo lo que se
            // registre despues (un 429, un fallo de Postgres) solo se puede
            // atar a lo que el usuario tiene delante por este id.
            searchId: id,
            checkpoint,
            onProgress: progreso => jobs.actualizarProgreso(id, progreso),
            onEncolado: posicion => jobs.marcarEnCola(id, posicion),
            // Park / resume durable: cada gancho baja a Postgres lo que hace
            // falta para que otra instancia pueda seguir si esta muere.
            onParquear: info => jobs.parquear(id, info),
            onLatido: progreso => jobs.latir(id, progreso),
            onReanudar: progreso => jobs.reanudar(id, progreso),
            onCheckpoint: cp => jobs.guardarCheckpoint(id, cp),
        });

        jobs.terminar(id, resultado);
        return resultado;
    } catch (err) {
        // Otra instancia se llevo el trabajo mientras este proceso lo tenia
        // (nuestro latido se quedo viejo). NO es un fallo del trabajo — sigue
        // vivo en otra parte — asi que no se marca como tal: este proceso
        // simplemente lo suelta y calla.
        if (err instanceof jobs.TrabajoAdoptadoError) {
            logger.info('Busqueda soltada: el trabajo lo continua otra instancia', { searchId: id });
            return null;
        }

        jobs.fallar(id, err);

        // En sincrono el error sube al manejador central, que es el unico sitio
        // donde un error se traduce a HTTP (404 de grupo inexistente, 503 de
        // Roblox limitando, 429/503 de cola). En asincrono ya se respondio 202,
        // asi que lo unico que queda es dejarlo registrado y que el GET lo
        // cuente como `failed` con su codigo.
        if (relanzar) throw err;

        logger.warn('Busqueda asincrona del plugin fallida', {
            requestId: trabajo.requestId,
            searchId: id,
            code: err?.code ?? null,
            detail: err?.message,
        });
        return null;
    }
}

// Reanudacion de un trabajo adoptado: misma maquinaria, con el checkpoint que
// dejo la instancia anterior. Registrado en jobs para que la recuperacion al
// arrancar pueda invocarlo sin importar este modulo (evita el ciclo).
jobs.registrarEjecutor(trabajo => arrancar(trabajo, trabajo.params, { checkpoint: trabajo.checkpoint }));

module.exports = { arrancar };
