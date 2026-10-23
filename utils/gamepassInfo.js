'use strict';

// ── Comprobar el gamepass que manda un cliente ────────────────────────────────
//
// En una compra por gamepass, 7x compra un gamepass que crea el cliente, y lo
// que cuesta ese gamepass ES lo que se le envía. Así que antes de comprarlo hay
// que estar seguros de dos cosas, y las dos se pueden comprobar contra Roblox
// en vez de fiarse de un enlace:
//
//   1. QUE CUESTE LA CANTIDAD PEDIDA. Uno de 1.500 en un ticket de 1.000 es
//      regalar 500 Robux; uno de 500 es entregar la mitad de lo cobrado.
//   2. QUE SEA DE LA CUENTA DEL COMPRADOR. Si el gamepass es de otra cuenta, o
//      de un grupo, los Robux van ahí y no a quien pagó.
//
// Nada de esto decide por su cuenta: devuelve las comprobaciones con su
// resultado y quien compra el gamepass es una persona. Pero lo que no cuadra se
// ve antes de pagar, no después.

const TIMEOUT_MS = 8000;

// Acepta el enlace en cualquiera de sus formas —con idioma o sin él, con el
// nombre detrás o sin él— y también el número a secas, que es lo que mucha
// gente copia.
const ENLACE_RE = /roblox\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?game-pass(?:es)?\/(\d{1,15})/i;
const SOLO_ID_RE = /^\s*(\d{4,15})\s*$/;

function extraerIdGamepass(texto) {
    if (typeof texto !== 'string') return null;
    const m = texto.match(ENLACE_RE) ?? texto.match(SOLO_ID_RE);
    return m ? m[1] : null;
}

function enlaceGamepass(id) {
    return `https://www.roblox.com/game-pass/${id}`;
}

// { ok, id, nombre, precio, aLaVenta, creadorId, creadorTipo, creadorNombre }
// | { ok:false, error }. NUNCA lanza.
//
// `precio` va en null cuando no está a la venta: Roblox lo devuelve así, y un
// 0 diría que es gratis, que es otra cosa.
async function fetchGamepass(id) {
    if (!id || !/^\d+$/.test(String(id))) return { ok: false, error: 'formato' };

    try {
        const res = await fetch(
            `https://apis.roblox.com/game-passes/v1/game-passes/${encodeURIComponent(id)}/product-info`,
            { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) }
        );
        if (res.status === 404 || res.status === 400) return { ok: false, error: 'no_existe' };
        if (!res.ok) return { ok: false, error: 'desconocido' };

        const d = await res.json();

        // La API devuelve algo para casi cualquier número. Que sea de verdad un
        // gamepass es lo primero que hay que mirar.
        if (d?.ProductType !== 'Game Pass') return { ok: false, error: 'no_existe' };

        const precio = Number(d.PriceInRobux);
        return {
            ok: true,
            id: String(id),
            nombre: (d.Name ?? '').trim() || 'Sin nombre',
            precio: Number.isFinite(precio) && precio > 0 ? precio : null,
            aLaVenta: d.IsForSale === true,
            creadorId: d.Creator?.Id != null ? String(d.Creator.Id) : null,
            creadorTipo: d.Creator?.CreatorType ?? null,
            creadorNombre: d.Creator?.Name ?? null,
        };
    } catch {
        return { ok: false, error: 'desconocido' };
    }
}

// Las comprobaciones, en el orden en que tiene sentido arreglarlas. Cada una es
// { clave, ok, texto }, y `listo` es que pasen todas.
//
// `esperado` es lo que se guardó en el ticket al crearlo: la cantidad de Robux
// del pedido y la cuenta de Roblox del comprador.
function revisarGamepass(info, { robux, robloxUserId, robloxName = null }) {
    const quien = robloxName ? `@${robloxName}` : 'tu cuenta';
    const checks = [];

    checks.push({
        clave: 'venta',
        ok: info.aLaVenta,
        texto: info.aLaVenta
            ? 'Está a la venta'
            : 'No está a la venta: actívalo en Roblox para que se pueda comprar',
    });

    // El precio: tiene que ser EXACTAMENTE el del pedido. Ni más ni menos.
    let textoPrecio;
    if (info.precio === null) textoPrecio = 'Sin precio: pónle exactamente ' + fmt(robux) + ' Robux';
    else if (info.precio === robux) textoPrecio = `Cuesta **${fmt(robux)} Robux**, lo que pediste`;
    else textoPrecio = `Cuesta **${fmt(info.precio)} Robux** y tiene que costar **${fmt(robux)}**: cámbialo en Roblox`;
    checks.push({ clave: 'precio', ok: info.precio === robux, texto: textoPrecio });

    // De quién es: si es de otra cuenta o de un grupo, los Robux van ahí.
    let okCreador;
    let textoCreador;
    if (info.creadorTipo !== 'User') {
        okCreador = false;
        textoCreador = 'Es de un **grupo**, no de una cuenta: los Robux irían al grupo, no a ti';
    } else if (robloxUserId && info.creadorId !== String(robloxUserId)) {
        okCreador = false;
        textoCreador = `Es de **@${info.creadorNombre ?? info.creadorId}**, no de ${quien}: los Robux irían a esa cuenta`;
    } else {
        okCreador = true;
        textoCreador = `Es de ${quien}`;
    }
    checks.push({ clave: 'creador', ok: okCreador, texto: textoCreador });

    return { checks, listo: checks.every(c => c.ok) };
}

function fmt(n) {
    return Number(n).toLocaleString('es-MX');
}

module.exports = { extraerIdGamepass, enlaceGamepass, fetchGamepass, revisarGamepass, ENLACE_RE };
