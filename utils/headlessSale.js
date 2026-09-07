'use strict';

const fs = require('fs');
const { dataPath, ensureDataDir } = require('./dataDir');

// ── Interruptor de la venta del Headless ──────────────────────────────────────
// Un único booleano: si la venta está abierta o cerrada. Lo mueve /headless on|
// off y lo consultan el panel (para pintar el estado) y el botón de Comprar
// (para dejar abrir el ticket o no).
//
// Va a disco, no a memoria, por una razón concreta: un reinicio del bot no
// puede abrir una venta que el owner había cerrado. Si el proceso se reinicia
// solo a las 4 de la mañana, el estado que había es el que sigue habiendo.
//
// Por defecto CERRADA. Un fichero que no existe todavía —primer arranque, o un
// DATA_DIR nuevo— significa "aún no se ha abierto la venta", nunca "ábrela":
// el owner tiene que decir que sí de forma explícita al menos una vez.

const FILE = dataPath('headlessSale.json');
const TMP  = FILE + '.tmp';

const CERRADA = { open: false, updatedAt: null, updatedBy: null };

function load() {
    try {
        const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        // Sólo se confía en un true explícito. Un JSON corrupto, a medias o con
        // otra forma cae en la venta cerrada, que es el lado seguro: como mucho
        // obliga al owner a volver a abrirla, nunca vende algo sin permiso.
        return { ...CERRADA, ...data, open: data?.open === true };
    } catch {
        return { ...CERRADA };
    }
}

function save(state) {
    ensureDataDir();
    fs.writeFileSync(TMP, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(TMP, FILE);
}

function isOpen() {
    return load().open;
}

function getState() {
    return load();
}

// Devuelve { state, changed }: `changed` en false significa que ya estaba así,
// para que el comando pueda decirlo en vez de fingir que hizo algo.
function setOpen(open, actorId = null) {
    const anterior = load();
    const abierta  = open === true;

    if (anterior.open === abierta) return { state: anterior, changed: false };

    const state = {
        open:      abierta,
        updatedAt: new Date().toISOString(),
        updatedBy: actorId,
    };
    save(state);
    return { state, changed: true };
}

module.exports = { isOpen, getState, setOpen };
