'use strict';

const config = require('../config');

// ── Quién puede hacer cosas de owner ─────────────────────────────────────────
//
// El ÚNICO sitio que decide eso. Antes cada comando y cada botón comparaba a
// mano contra config.OWNER_ID, repetido en once archivos: dar permisos a una
// segunda persona significaba encontrar los once y no olvidarse de ninguno, y
// olvidarse de uno no da ningún error — simplemente esa acción sigue siendo
// sólo del dueño y nadie se entera hasta que alguien la necesita.
//
// Ahora todos preguntan aquí y la lista vive en config.ADMIN_IDS.
//
// Comparación en cadena a propósito, y siempre entre cadenas: los ids de
// Discord son snowflakes de 17-20 dígitos y NO caben exactos en un número de
// JavaScript (pasan de Number.MAX_SAFE_INTEGER).
//
// Ojo con lo que eso significa: si un id llegara aquí ya convertido a número,
// volverlo a cadena NO lo arregla — la precisión se perdió antes, al
// convertirlo. `620310742138224661` como número vale 620310742138224700. Este
// módulo no intenta recuperarlo: simplemente no coincidirá y se denegará el
// permiso, que es el lado correcto en el que equivocarse. Discord siempre
// entrega los ids como cadena, así que en la práctica no pasa.

function esAdmin(userId) {
    if (userId === null || userId === undefined) return false;
    return config.ADMIN_IDS.includes(String(userId));
}

// Atajo para lo más repetido: quien pulsa un botón o lanza un comando.
function esAdminDeInteraccion(interaction) {
    return esAdmin(interaction?.user?.id);
}

// El creador del ticket o un admin. Es la regla de cerrar, confirmar y cancelar
// el cierre: el cliente manda sobre SU ticket, y un admin sobre cualquiera.
function puedeGestionarTicket(userId, ownerDelTicket) {
    return esAdmin(userId) || (Boolean(ownerDelTicket) && String(userId) === String(ownerDelTicket));
}

module.exports = { esAdmin, esAdminDeInteraccion, puedeGestionarTicket };
