'use strict';

// LO QUE LE HA PASADO AL INDICE, en las ultimas N cosas.
//
// El panel del plugin necesita contar una historia —"empezo a indexar",
// "entro en cooldown", "cancelaron esta comunidad"— y ninguna de esas cosas
// se puede reconstruir mirando contadores. Un contador dice cuantos cooldowns
// hubo; no dice que el de hace treinta segundos fue en avatar y duro un
// minuto. Eso es un evento, y hay que anotarlo cuando ocurre o se pierde.
//
// ES UN ANILLO EN MEMORIA, a proposito:
//
//   - No es una auditoria. Si el proceso se reinicia, la historia empieza de
//     nuevo, y eso esta bien: lo que sobrevive a un redeploy vive en Postgres
//     (el cursor, la pausa, la pertenencia) y ya se consulta aparte.
//   - Escribir cada ciclo del worker en la base seria pagar una escritura por
//     cada cosa que pasa para alimentar un panel que nadie mira la mayor parte
//     del tiempo. La proporcion no sale.
//   - El limite es duro. Un anillo que crece "solo un poco" con cada ciclo es
//     una fuga de memoria con buenos modales.

const LIMITE = 40;

const anillo = [];
let siguienteId = 1;

// Los tipos que el panel sabe pintar. Se declaran para que un error de dedo
// en una llamada salte aqui y no acabe en la interfaz como un hueco en blanco.
const TIPO = {
    CICLO: 'cycle',
    COOLDOWN_ENTRA: 'cooldown_start',
    COOLDOWN_SALE: 'cooldown_end',
    GRUPO_CANCELADO: 'group_paused',
    GRUPO_REANUDADO: 'group_resumed',
    GRUPO_ELIMINADO: 'group_deleted',
    VUELTA_COMPLETA: 'lap_complete',
    ERROR: 'error',
};

const TIPOS = new Set(Object.values(TIPO));

// `at` se pasa desde fuera para que los tests puedan fijar el reloj. Sin eso,
// comprobar "el evento mas reciente es este" depende de la hora del sistema.
function registrar(tipo, detalle = {}, at = Date.now()) {
    if (!TIPOS.has(tipo)) return null;

    const evento = {
        id: siguienteId++,
        tipo,
        at,
        groupId: detalle.groupId != null ? String(detalle.groupId) : null,
        etapa: detalle.etapa ?? null,
        // Un texto corto y legible. El panel lo enseña tal cual, asi que se
        // recorta aqui: un mensaje de error de Postgres de dos mil caracteres
        // no cabe en una tarjeta y no aporta nada mas que el principio.
        detalle: detalle.detalle != null ? String(detalle.detalle).slice(0, 160) : null,
        datos: detalle.datos ?? null,
    };

    anillo.push(evento);
    while (anillo.length > LIMITE) anillo.shift();
    return evento;
}

// Los mas recientes primero: es el orden en que se leen.
function listar({ limite = 20 } = {}) {
    const n = Math.max(1, Math.min(limite, LIMITE));
    return anillo.slice(-n).reverse();
}

function reset() {
    anillo.length = 0;
    siguienteId = 1;
}

module.exports = { TIPO, registrar, listar, reset, LIMITE };
