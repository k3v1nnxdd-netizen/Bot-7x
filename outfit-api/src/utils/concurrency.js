'use strict';

// Utilidades de concurrencia. NEUTRALES: no saben nada de outfits, de plugins
// ni de Roblox, y por eso pueden usarlas tanto el camino del juego como el del
// trabajo de fondo sin que uno dependa del otro.
//
// Vivian dentro de services/pluginSearch/ porque ahi nacieron, pero cuando el
// lote de outfits —que es el camino del JUEGO— empezo a necesitarlas, eso dejo
// de ser aceptable: un servicio de produccion no puede colgar de un modulo del
// plugin de Studio. La dependencia habria sido invisible hasta el dia que
// alguien reorganice o retire la carpeta del plugin.

// Pool de trabajo con tope fijo de tareas en vuelo.
//
// POR QUE UN POOL Y NO TANDAS DE Promise.all: una tanda avanza al ritmo de su
// elemento mas lento — con cuatro llamadas de 80ms y una de 900ms, el gate de
// salida se queda ocioso 820ms esperando a la rezagada. El pool arranca la
// siguiente tarea en cuanto se libera un hueco, asi que mantiene EXACTAMENTE
// `limite` peticiones en vuelo de principio a fin. Ni una mas (no llena la
// cola del limitador) ni una menos (no desperdicia la ventana disponible).
//
// El orden de los resultados se conserva aunque terminen desordenadas: quien
// llama empareja resultado con entrada por indice, y depender del orden de
// llegada seria un error dificil de ver.
//
// No hay timeouts ni reintentos aqui a proposito. El timeout vive en el cliente
// HTTP y los reintentos en el limitador; anadirlos tambien en este nivel
// multiplicaria el trabajo sobre un Roblox que ya esta diciendo que no puede.
async function mapConLimite(items, limite, tarea) {
    if (items.length === 0) return [];

    const resultados = new Array(items.length);
    const trabajadores = Math.max(1, Math.min(limite, items.length));
    let siguiente = 0;

    async function trabajador() {
        for (;;) {
            const indice = siguiente++;
            if (indice >= items.length) return;
            resultados[indice] = await tarea(items[indice], indice);
        }
    }

    await Promise.all(Array.from({ length: trabajadores }, trabajador));
    return resultados;
}

// Trocea una lista en grupos de como mucho `tamano`. Se usa para los lotes de
// catalogo, donde el tope no es una preferencia nuestra sino un limite duro del
// endpoint de Roblox.
function trocear(lista, tamano) {
    const trozos = [];
    for (let i = 0; i < lista.length; i += tamano) {
        trozos.push(lista.slice(i, i + tamano));
    }
    return trozos;
}

module.exports = { mapConLimite, trocear };
