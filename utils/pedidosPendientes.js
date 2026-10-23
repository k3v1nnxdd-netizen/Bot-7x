'use strict';

const crypto = require('crypto');

// ── Pedidos esperando confirmación ────────────────────────────────────────────
//
// Entre que alguien envía el formulario de compra y pulsa "Continuar" hay un
// paso de confirmación: se le enseña la cuenta de Roblox que escribió, con su
// foto y sus comunidades, para que vea si es la suya ANTES de abrir el ticket.
// Lo que escribió en el formulario tiene que esperar en algún sitio mientras
// tanto, y ese sitio es este.
//
// Va en MEMORIA y no a disco, a propósito. Es una ventana de minutos: si el bot
// se reinicia justo en medio, lo único que pasa es que el botón dice que la
// confirmación caducó y la persona vuelve a enviar el formulario. Guardarlo en
// disco sería conservar pedidos a medias que nadie va a terminar.

const TTL_MS = 10 * 60_000;

const pendientes = new Map();   // token -> { pedido, userId, expira }
const porUsuario = new Map();   // userId -> token

// Guarda el pedido y devuelve el token que viaja en los botones.
//
// Un pedido nuevo de la misma persona sustituye al anterior: si envió el
// formulario dos veces, la confirmación buena es la última, y la de antes no
// puede seguir abriendo un ticket con los datos viejos.
function guardar(userId, pedido) {
    limpiarCaducados();

    const anterior = porUsuario.get(userId);
    if (anterior) pendientes.delete(anterior);

    // 8 bytes en hex: cabe de sobra en el customId de un botón (máx. 100) y no
    // se adivina.
    const token = crypto.randomBytes(8).toString('hex');
    pendientes.set(token, { pedido, userId, expira: Date.now() + TTL_MS });
    porUsuario.set(userId, token);
    return token;
}

// El pedido de ese token, sólo si es de esa persona y no ha caducado.
//
// Comprobar el dueño no es redundante con que el mensaje sea efímero: el
// customId viaja por Discord, y un permiso no puede depender de dónde está el
// botón, sino de quién lo pulsa.
function obtener(token, userId) {
    const e = pendientes.get(token);
    if (!e) return { ok: false, motivo: 'caducado' };
    if (e.userId !== userId) return { ok: false, motivo: 'ajeno' };
    if (Date.now() > e.expira) {
        borrar(token);
        return { ok: false, motivo: 'caducado' };
    }
    return { ok: true, pedido: e.pedido };
}

// Lo saca y lo devuelve en una sola operación: así dos clics seguidos en
// "Continuar" no pueden abrir dos tickets con el mismo pedido.
function consumir(token, userId) {
    const r = obtener(token, userId);
    if (r.ok) borrar(token);
    return r;
}

function borrar(token) {
    const e = pendientes.get(token);
    if (!e) return;
    pendientes.delete(token);
    if (porUsuario.get(e.userId) === token) porUsuario.delete(e.userId);
}

function limpiarCaducados() {
    const ahora = Date.now();
    for (const [token, e] of pendientes) {
        if (ahora > e.expira) borrar(token);
    }
}

function _reset() {
    pendientes.clear();
    porUsuario.clear();
}

module.exports = { guardar, obtener, consumir, borrar, TTL_MS, _reset, _tamano: () => pendientes.size };
