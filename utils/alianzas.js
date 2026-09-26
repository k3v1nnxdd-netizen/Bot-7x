'use strict';

const fs = require('fs');
const { dataPath, ensureDataDir } = require('./dataDir');

// ── Lo que lleva rellenado cada ticket de alianza ─────────────────────────────
//
// Un ticket de alianza no se contesta de una vez: el dueño del servidor va
// rellenando tres campos a su ritmo, con un botón cada uno, y al final pulsa
// "Completado". Esto es lo que guarda ese progreso.
//
// Va a DISCO y no a memoria porque el bot se reinicia en cada despliegue y los
// tickets duran días. Perder lo escrito obligaría a la persona a rellenarlo
// todo otra vez sin que nadie le avise de por qué, y el panel del ticket
// volvería a decir "pendiente" sobre algo que ya estaba hecho.
//
// La clave es el id del canal del ticket. Los ids de Discord no se reciclan,
// así que una entrada vieja nunca puede confundirse con un ticket nuevo.

const FILE = dataPath('alianzas.json');
const TMP  = FILE + '.tmp';

// Los campos que rellena la persona, en el orden en que se piden. Esta lista es
// la ÚNICA fuente de verdad de cuáles son: el panel del ticket, el aviso de
// "te falta esto" y la tarjeta de revisión salen todos de aquí, así que añadir
// un campo cuarto no puede quedarse a medias en uno de los tres.
const CAMPOS = ['mensaje', 'link', 'descripcion'];

function load() {
    try {
        const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
        return data;
    } catch {
        return {};
    }
}

function save(data) {
    ensureDataDir();
    fs.writeFileSync(TMP, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(TMP, FILE);
}

// Lo guardado de un ticket, siempre un objeto: un fichero perdido o corrupto
// deja el ticket vacío —todo pendiente— en vez de reventar al pintar el panel.
function get(channelId) {
    const entrada = load()[channelId];
    return entrada && typeof entrada === 'object' && !Array.isArray(entrada) ? entrada : {};
}

function set(channelId, parcial) {
    const data = load();
    data[channelId] = { ...get(channelId), ...parcial };
    save(data);
    return data[channelId];
}

// Un campo de los de CAMPOS. Devuelve false si la clave no es una de ellas:
// el customId del botón viaja por Discord, y no se escribe en el fichero nada
// que no esté en la lista.
function setCampo(channelId, campo, valor) {
    if (!CAMPOS.includes(campo)) return false;
    const texto = typeof valor === 'string' ? valor.trim() : '';
    if (!texto) return false;
    set(channelId, { [campo]: texto });
    return true;
}

// Los campos que siguen sin rellenar, en el orden de CAMPOS.
function faltantes(channelId) {
    const datos = get(channelId);
    return CAMPOS.filter(campo => !datos[campo]);
}

function estaCompleto(channelId) {
    return faltantes(channelId).length === 0;
}

function borrar(channelId) {
    const data = load();
    if (!(channelId in data)) return false;
    delete data[channelId];
    save(data);
    return true;
}

module.exports = { CAMPOS, get, set, setCampo, faltantes, estaCompleto, borrar };
