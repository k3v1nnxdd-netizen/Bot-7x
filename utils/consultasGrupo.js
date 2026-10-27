'use strict';

const fs = require('fs');
const { dataPath, ensureDataDir } = require('./dataDir');
const config = require('../config');

// ── Qué comunidades se pueden consultar en Check Group's ─────────────────────
//
// Un interruptor por comunidad, movido por el owner con /gactive. Con una
// comunidad apagada, nadie puede consultar cuántos días lleva en ella: el
// botón responde que no está disponible en este momento.
//
// NO es lo mismo que groupActive.js (/groupactive), que dice si una comunidad
// está ENVIANDO Robux en el panel de estado. Son dos cosas distintas y por eso
// van en dos ficheros: apagar las consultas no puede cambiar lo que dice el
// panel de envíos, ni al revés.
//
// POR DEFECTO, ENCENDIDA — al revés que groupActive, y a propósito: las
// consultas ya funcionaban antes de existir este interruptor, así que sólo un
// `false` explícito las apaga. Si el fichero se pierde o llega una comunidad
// nueva, se puede consultar, que es como siempre ha funcionado.
//
// Va a disco (el volumen): un reinicio no puede volver a abrir una comunidad
// que el owner cerró.

const FILE = dataPath('consultasGrupo.json');
const TMP  = FILE + '.tmp';

function load() {
    try {
        const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        const g = data?.grupos;
        return g && typeof g === 'object' && !Array.isArray(g) ? g : {};
    } catch {
        return {};
    }
}

function existe(clave) {
    return Object.prototype.hasOwnProperty.call(config.CHECK_GROUPS, clave);
}

function disponible(clave) {
    return load()[clave] !== false;
}

// El estado de todas las comunidades, en el orden de config.
function getState() {
    const g = load();
    return Object.entries(config.CHECK_GROUPS).map(([clave, grupo]) => ({
        clave, label: grupo.label, disponible: g[clave] !== false,
    }));
}

// Devuelve { ok, changed }. ok=false si la comunidad no existe en config.
function setDisponible(clave, valor, userId = null) {
    if (!existe(clave)) return { ok: false, changed: false };
    const grupos = load();
    const antes = grupos[clave] !== false;
    grupos[clave] = !!valor;
    ensureDataDir();
    fs.writeFileSync(TMP, JSON.stringify({ grupos, updatedAt: new Date().toISOString(), updatedBy: userId }, null, 2), 'utf8');
    fs.renameSync(TMP, FILE);
    return { ok: true, changed: antes !== !!valor };
}

// Lo que se le dice a quien intenta consultar una comunidad apagada.
function mensajeNoDisponible(label) {
    return [
        `<:alert:1501220021035204658> **La consulta de ${label} no está disponible en este momento.**`,
        'Estamos teniendo un inconveniente para verificar esta comunidad. Por favor, inténtalo de nuevo más tarde.',
        '-# Si necesitas ayuda, abre un ticket y el staff te atenderá.',
    ].join('\n');
}

module.exports = { disponible, getState, setDisponible, mensajeNoDisponible };
