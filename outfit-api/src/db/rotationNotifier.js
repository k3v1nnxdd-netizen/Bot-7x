'use strict';

const db = require('./pool');
const logger = require('../observability/logger');

// Aviso GLOBAL de "este grupo ha quedado libre", sobre LISTEN/NOTIFY de
// Postgres.
//
// EL PROBLEMA QUE RESUELVE. Con varias replicas, la instancia B puede estar
// esperando el turno de un grupo que tiene la instancia A. B no puede enterarse
// de que A ha terminado con una promesa local — A vive en otro proceso — y
// preguntarlo cada poco seria exactamente el sondeo que no queremos. Postgres
// ya tiene el mecanismo: A hace NOTIFY al soltar y todas las instancias que
// escuchan despiertan en el acto.
//
// COSTE EN REPOSO: CERO CONSULTAS. Una suscripcion LISTEN no consume nada
// mientras no llega un aviso; no hay temporizador ni bucle detras. Una sola
// conexion dedicada para todo el proceso, no una por espera.
//
// POR QUE UNA CONEXION DEDICADA. LISTEN vive en la CONEXION, no en la sesion
// logica: montado sobre el pool, `query()` devolveria el cliente y con el se
// iria la suscripcion. Por eso `db.conexionDedicada()`.
//
// ESTO ES UNA OPTIMIZACION DE LATENCIA, NO LA GARANTIA. La correccion la da el
// lease con caducidad en la tabla: si el aviso se pierde (conexion caida,
// replica que muere sin soltar), quien espera despierta igualmente cuando el
// lease vence. NOTIFY solo hace que, en el caso normal, despierte en
// milisegundos en vez de esperar a la caducidad.

const CANAL = 'plugin_rotation_free';

// groupId -> Set<callback>
const suscriptores = new Map();

let cliente = null;
let conectando = null;
let reconexiones = 0;

function disponible() {
    return db.isConfigured();
}

async function asegurarEscucha() {
    if (!disponible()) return false;
    if (cliente) return true;
    if (conectando) return conectando;

    conectando = (async () => {
        try {
            const nuevo = await db.conexionDedicada();

            nuevo.on('notification', mensaje => {
                if (mensaje.channel !== CANAL) return;
                despertar(mensaje.payload);
            });

            // Si la conexion se cae (redeploy de la base, corte del proxy), se
            // suelta y se volvera a montar en la siguiente espera. No se
            // reconecta en bucle: sin nadie esperando no hace falta, y con
            // alguien esperando el lease sigue garantizando el despertar.
            nuevo.on('error', err => {
                logger.warn('Conexion de avisos de rotacion caida', { detail: err?.message });
                soltarCliente();
            });
            nuevo.on('end', () => soltarCliente());

            await nuevo.query(`LISTEN ${CANAL}`);
            cliente = nuevo;
            logger.info('Escuchando avisos de liberacion de rotacion', { canal: CANAL, reconexiones });
            return true;
        } catch (err) {
            logger.warn('No se pudo escuchar los avisos de rotacion', { detail: err?.message });
            return false;
        } finally {
            conectando = null;
        }
    })();

    return conectando;
}

function soltarCliente() {
    if (!cliente) return;
    const anterior = cliente;
    cliente = null;
    reconexiones++;
    try { anterior.release(true); } catch { /* ya estaba rota */ }
}

function despertar(groupId) {
    const oyentes = suscriptores.get(String(groupId));
    if (!oyentes) return;
    // Copia antes de recorrer: los callbacks se dan de baja a si mismos.
    for (const oyente of [...oyentes]) {
        try { oyente(); } catch { /* un oyente roto no puede tumbar a los demas */ }
    }
}

// Suscribe a "este grupo ha quedado libre". Devuelve la funcion de baja, que
// HAY QUE llamar siempre — en un finally — o el Map crecera con oyentes
// muertos.
async function alLiberarse(groupId, callback) {
    const clave = String(groupId);

    let oyentes = suscriptores.get(clave);
    if (!oyentes) {
        oyentes = new Set();
        suscriptores.set(clave, oyentes);
    }
    oyentes.add(callback);

    // Se monta la escucha AL SUSCRIBIRSE y no al arrancar el proceso: una
    // instancia que nunca tenga contencion no gasta una conexion para nada.
    await asegurarEscucha();

    return function darDeBaja() {
        oyentes.delete(callback);
        if (oyentes.size === 0) suscriptores.delete(clave);
    };
}

// Avisa de que un grupo queda libre. Va por `query()` normal (no necesita la
// conexion dedicada) y NUNCA lanza: si el aviso se pierde, quien espera
// despertara igual al vencer el lease. Es latencia, no correccion.
async function anunciarLiberacion(groupId) {
    // Primero, EN LOCAL. Postgres entrega el NOTIFY tambien a la conexion que
    // lo emite, asi que despertar aqui no es un atajo: es lo mismo que va a
    // ocurrir, sin pagar el viaje de ida y vuelta. Ademas mantiene el
    // comportamiento intacto cuando no hay base de datos.
    despertar(groupId);

    if (!disponible()) return;
    try {
        await db.query(`SELECT pg_notify($1, $2)`, [CANAL, String(groupId)], 'rotation.notify');
    } catch (err) {
        logger.debug('No se pudo anunciar la liberacion del grupo', {
            groupId: String(groupId), detail: err?.message,
        });
    }
}

async function cerrar() {
    suscriptores.clear();
    soltarCliente();
}

// Solo para los tests: permite inyectar un aviso sin pasar por Postgres.
function __despertar(groupId) {
    despertar(groupId);
}

module.exports = {
    CANAL, alLiberarse, anunciarLiberacion, cerrar, __despertar,
    get escuchando() { return cliente !== null; },
    get oyentes() { return suscriptores.size; },
};
