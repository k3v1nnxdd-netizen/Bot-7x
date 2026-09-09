'use strict';

const fs = require('fs');
const { dataPath, ensureDataDir } = require('./dataDir');
const config = require('./../config');

// ── Qué comunidades están enviando Robux ahora mismo ─────────────────────────
//
// Un booleano por comunidad, movido a mano por el owner con /groupactive. Lo
// lee el panel de estado (groupStatus.js) para pintar cada comunidad como
// activa o caída.
//
// Va a disco, no a memoria: si el owner enciende una comunidad y el bot se
// reinicia a las 4 de la mañana, tiene que seguir encendida. Lo contrario
// —volver sola al valor por defecto— cambiaría lo que se le está diciendo al
// cliente sin que nadie lo haya decidido.
//
// POR DEFECTO, APAGADA. Sólo un `true` explícito enciende una comunidad, así
// que el panel arranca con todas en "no está enviando" y el owner enciende las
// que de verdad estén enviando. Es lo contrario de dar por buena una entrega
// que nadie ha confirmado: si el fichero se pierde, se corrompe o llega una
// comunidad nueva, el panel se queda callado en vez de prometer envíos.

const FILE = dataPath('groupActive.json');
const TMP  = FILE + '.tmp';

const POR_DEFECTO = false;

// El fichero guarda { grupos: { clave: bool }, updatedAt, updatedBy }. Los
// metadatos van en su propia rama y no mezclados con las claves de grupo: si
// alguna vez existiera una comunidad llamada `updatedAt`, mezclarlos la
// convertiria en un booleano corrupto.
function load() {
    try {
        const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
        const grupos = data.grupos;
        return grupos && typeof grupos === 'object' && !Array.isArray(grupos) ? grupos : {};
    } catch {
        return {};
    }
}

function save(data) {
    ensureDataDir();
    fs.writeFileSync(TMP, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(TMP, FILE);
}

function claves() {
    return Object.keys(config.CHECK_GROUPS);
}

function existe(clave) {
    return Object.prototype.hasOwnProperty.call(config.CHECK_GROUPS, clave);
}

// Sólo un `true` explícito enciende una comunidad. Un fichero a medias, un
// valor que no es booleano o una comunidad recién añadida a config caen en el
// lado seguro: apagada, que es no prometer un envío que nadie ha confirmado.
function isActive(clave) {
    return load()[clave] === true;
}

// El estado de TODAS las comunidades configuradas, en el orden de config. Se
// construye desde config y no desde el fichero a propósito: una comunidad nueva
// aparece sola, y una que se quitó de config desaparece aunque siga en el JSON.
function getState() {
    const guardado = load();
    return claves().map(clave => ({
        clave,
        label:  config.CHECK_GROUPS[clave].label,
        activa: guardado[clave] === true,
    }));
}

function activas() {
    return getState().filter(g => g.activa);
}

// Devuelve { ok, changed }: `ok` en false = esa comunidad no existe en config
// (opción manipulada o grupo retirado); `changed` en false = ya estaba así, y
// el comando lo dice en vez de fingir que hizo algo.
function setActive(clave, activa, actorId = null) {
    if (!existe(clave)) return { ok: false, changed: false };

    const data = load();
    const antes = data[clave] === true;
    const nuevo = activa === true;

    if (antes === nuevo) return { ok: true, changed: false };

    // Se guarda el valor explícito, incluido el `true`: así el fichero refleja
    // lo que el owner decidió y no depende de cuál sea el valor por defecto.
    data[clave] = nuevo;
    save({ grupos: data, updatedAt: new Date().toISOString(), updatedBy: actorId, ultima: clave });

    return { ok: true, changed: true };
}

module.exports = { isActive, getState, activas, setActive, POR_DEFECTO };
