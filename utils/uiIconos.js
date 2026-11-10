'use strict';

const config = require('../config');

// Emoji de la aplicación (config.UI_ICONOS) o, si falta, un unicode de reserva:
// un id que no esté nunca puede dejar un ":ui_x:" roto en un mensaje.
const RESERVA = {
    perfil: '👤', insignia: '🏅', boost: '💎', nitro: '⭐', roles: '🛡️', compras: '🛍️',
    invita: '➕', alerta: '⚠️', ticket: '🎫', editado: '✏️', borrado: '🗑️', escudo: '✅',
    reloj: '🕒', server: '👥',
};

function ui(clave) {
    const id = config.UI_ICONOS?.[clave];
    return id ? `<:ui_${clave}:${id}>` : (RESERVA[clave] ?? '•');
}

function uiBoton(clave) {
    const id = config.UI_ICONOS?.[clave];
    return id ? { id, name: `ui_${clave}` } : { name: RESERVA[clave] ?? '•' };
}

module.exports = { ui, uiBoton };
