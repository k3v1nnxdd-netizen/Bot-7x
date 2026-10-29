'use strict';

const fs = require('fs');
const { dataPath, ensureDataDir } = require('./dataDir');

// ── Qué apartados del panel de tickets se pueden abrir ───────────────────────
//
// Un interruptor por botón del panel (comprar, comprar_gamepass, alianza…),
// movido por el owner con /ticketactive, y la razón que se le enseña a quien
// intenta abrirlo mientras está apagado.
//
// El botón NO desaparece del panel al apagarlo: quien lo pulsa tiene que leer
// POR QUÉ no puede, que es justo lo que pidió el owner. El panel sólo lo marca
// como no disponible.
//
// POR DEFECTO, ENCENDIDO: sólo un `activo: false` explícito lo apaga. Si el
// fichero se pierde o se añade un apartado nuevo, se puede abrir, como siempre.
//
// Va a disco (el volumen): un reinicio no puede volver a abrir un apartado que
// el owner cerró.

const FILE = dataPath('apartadosTicket.json');
const TMP  = FILE + '.tmp';

const RAZON_POR_DEFECTO = 'Este apartado está pausado temporalmente.';
const MAX_RAZON = 300;

function load() {
    try {
        const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        const a = data?.apartados;
        return a && typeof a === 'object' && !Array.isArray(a) ? a : {};
    } catch {
        return {};
    }
}

function estado(id) {
    const rec = load()[id];
    const activo = rec?.activo !== false;
    return { activo, razon: activo ? null : (rec.razon || RAZON_POR_DEFECTO) };
}

function disponible(id) {
    return estado(id).activo;
}

// Devuelve { changed }. La razón sólo se guarda al apagar; al encender se borra
// para que la próxima vez no salga una vieja.
function setEstado(id, activo, razon = null, userId = null) {
    const apartados = load();
    const antes = estado(id);
    const limpia = String(razon ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_RAZON) || null;
    apartados[id] = activo
        ? { activo: true, updatedAt: new Date().toISOString(), updatedBy: userId }
        : { activo: false, razon: limpia, updatedAt: new Date().toISOString(), updatedBy: userId };
    ensureDataDir();
    fs.writeFileSync(TMP, JSON.stringify({ apartados }, null, 2), 'utf8');
    fs.renameSync(TMP, FILE);
    const despues = estado(id);
    return { changed: antes.activo !== despues.activo || antes.razon !== despues.razon };
}

// Lo que ve quien pulsa un apartado apagado. `soporteAbierto`: si el de
// "Otra cosa" sigue abierto, se le ofrece como salida.
function mensajeNoDisponible(label, razon, soporteAbierto = true) {
    return [
        `<:alert:1501220021035204658> **Los tickets de ${label} no están disponibles en este momento.**`,
        '',
        `**Motivo:** ${razon || RAZON_POR_DEFECTO}`,
        '',
        soporteAbierto
            ? '-# Vuelve a intentarlo más tarde. Si tienes una duda, puedes abrir un ticket en **Otra cosa**.'
            : '-# Vuelve a intentarlo más tarde. Gracias por tu paciencia.',
    ].join('\n');
}

module.exports = { estado, disponible, setEstado, mensajeNoDisponible, RAZON_POR_DEFECTO, MAX_RAZON };
