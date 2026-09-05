'use strict';

const logger = require('../../observability/logger');
const jobsPorDefecto = require('./jobs');
const pluginSearch = require('../pluginSearchService');

// EL MOTOR COMUN de los dos modos del POST y de la REANUDACION tras un
// reinicio. Es el unico sitio que sabe convertir un trabajo en una busqueda
// corriendo, y por eso vive aparte de la ruta: una busqueda adoptada de una
// instancia caida no tiene ninguna peticion HTTP detras.
//
// `crearRunner(registro)` existe para que las pruebas puedan levantar dos
// instancias en el mismo proceso, cada una con su registro de trabajos y su
// runner. En produccion hay uno: el de este proceso, exportado abajo.
function crearRunner(jobs) {
    // NUNCA rechaza en modo asincrono: un fallo se registra en el trabajo y el
    // plugin lo ve como `failed`, en vez de convertirse en una promesa
    // rechazada sin dueño.
    async function arrancar(trabajo, peticion, { relanzar = false, checkpoint = null } = {}) {
        const id = trabajo.searchId;

        // Si al marcarlo en curso resulta que el trabajo NO es nuestro (otra
        // instancia lo tiene), NO SE ARRANCA. Antes este error se tragaba y la
        // busqueda arrancaba igual: gastaba cuota de Roblox y moria en su
        // primer checkpoint, dejando el trabajo sin ejecutor en ninguna parte.
        try {
            await jobs.marcarEnCurso(id);
        } catch (err) {
            if (err instanceof jobsPorDefecto.TrabajoAdoptadoError) {
                logger.info('Busqueda no arrancada: el trabajo es de otra instancia', {
                    searchId: id, owner: err.dueño ?? null, instance: jobs.instancia,
                });
                return null;
            }
            throw err;
        }

        // Cada gancho esta VALLADO POR EJECUCION, no solo por searchId: si
        // este proceso pierde el trabajo y mas tarde lo readopta (nueva copia
        // en el registro, nueva busqueda), la busqueda vieja que aun estuviera
        // acabando su ola NO puede escribir su checkpoint encima del de la
        // nueva. Sin esto, un poll veia found 4 y el siguiente found 3.
        const propio = () => {
            if (trabajo.adoptado || !jobs.esVigente(trabajo)) {
                throw new jobsPorDefecto.TrabajoAdoptadoError(id, trabajo.adoptadoPor ?? 'otra ejecucion de esta instancia');
            }
        };
        try {
            const resultado = await pluginSearch.searchOutfits(peticion, {
                requestId: trabajo.requestId,
                searchId: id,
                checkpoint,
                onProgress: progreso => { propio(); return jobs.actualizarProgreso(id, progreso); },
                onEncolado: posicion => { propio(); return jobs.marcarEnCola(id, posicion); },
                onParquear: info => { propio(); return jobs.parquear(id, info); },
                onLatido: progreso => { propio(); return jobs.latir(id, progreso); },
                onReanudar: progreso => { propio(); return jobs.reanudar(id, progreso); },
                onCheckpoint: cp => { propio(); jobs.guardarCheckpoint(id, cp); },
                // La busqueda pregunta esto antes de gastar nada: si el latido
                // descubrio que el trabajo ya no es nuestro, para en seco.
                esDueño: () => !trabajo.adoptado && jobs.esVigente(trabajo),
            });

            propio();
            jobs.terminar(id, resultado);
            return resultado;
        } catch (err) {
            // Otra instancia se llevo el trabajo mientras este proceso lo tenia
            // (nuestro latido se quedo viejo, o lo soltamos al apagar). NO es un
            // fallo del trabajo — sigue vivo en otra parte — asi que no se
            // marca como tal: este proceso simplemente lo suelta.
            if (err instanceof jobsPorDefecto.TrabajoAdoptadoError || err?.code === 'job_adopted') {
                logger.info('Busqueda soltada: el trabajo lo continua otra instancia', {
                    searchId: id, owner: err.dueño ?? null, instance: jobs.instancia,
                });
                return null;
            }

            if (jobs.esVigente(trabajo)) jobs.fallar(id, err);

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

    // Reanudacion de un trabajo adoptado: misma maquinaria, con el checkpoint
    // que dejo la instancia anterior.
    jobs.registrarEjecutor(trabajo => arrancar(trabajo, trabajo.params, { checkpoint: trabajo.checkpoint }));

    return { arrancar };
}

const porDefecto = crearRunner(jobsPorDefecto);

module.exports = { arrancar: porDefecto.arrancar, crearRunner };
