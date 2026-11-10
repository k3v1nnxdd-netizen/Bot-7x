'use strict';

const fs = require('fs');
const { dataPath, ensureDataDir } = require('./dataDir');
const config = require('../config');
const roblox = require('../src/roblox/client');
const { construirMensaje, esLimited, esOffsale } = require('./robloxNotifierEmbeds');

// ── Notificador del catálogo oficial de Roblox ───────────────────────────────
//
// Dos bucles independientes, los dos contra APIs oficiales de Roblox:
//
//   FEED (cada INTERVALO_FEED_SEG): la búsqueda del catálogo con creador Roblox,
//   ordenada por actualización reciente e INCLUYENDO lo offsale. De ahí salen:
//     · nuevo / nuevoLimited — un item que no habíamos visto, creado hace poco
//     · enVenta              — estaba offsale y ahora se puede comprar
//     · precio               — a la venta antes y ahora, con otro precio
//
//   OFERTAS (cada INTERVALO_OFERTAS_SEG): barre los Limiteds oficiales y apunta
//   la reventa más barata de cada uno. Sólo cuando ese precio BAJA respecto al
//   barrido anterior se consulta el RAP (marketplace-sales); si queda al menos
//   OFERTA_DESCUENTO_MIN por debajo, es una ganga y se avisa. Consultar el RAP
//   sólo de lo que baja es lo que hace que esto quepa en la cuota de Roblox:
//   una ganga aparece exactamente cuando alguien pone algo barato.
//
// PRIMERA VEZ, SIN AVISOS: el primer ciclo de cada bucle sólo memoriza lo que
// hay. Sin eso, el arranque anunciaría 120 "items nuevos" que no lo son.
//
// El estado va a disco (data/robloxNotifier.json): un reinicio no puede volver
// a anunciar lo ya anunciado, y lo que salió mientras el bot estaba apagado se
// anuncia al volver si sigue dentro de EDAD_MAX_NUEVO_HORAS.

const FILE = dataPath('robloxNotifier.json');
const TMP = FILE + '.tmp';
const MAX_ITEMS_RECORDADOS = 4000;

const C = () => config.ROBLOX_NOTIFIER;

// ── Estado ───────────────────────────────────────────────────────────────────

function estadoVacio() {
    return {
        canal: null, activo: true,
        feedIniciado: false, items: {},
        ofertasIniciado: false, limiteds: {}, avisadas: {},
    };
}

function load() {
    try {
        const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        if (!d || typeof d !== 'object' || Array.isArray(d)) return estadoVacio();
        const base = estadoVacio();
        for (const k of Object.keys(base)) if (d[k] !== undefined) base[k] = d[k];
        return base;
    } catch {
        return estadoVacio();
    }
}

function save(estado) {
    ensureDataDir();
    fs.writeFileSync(TMP, JSON.stringify(estado), 'utf8');
    fs.renameSync(TMP, FILE);
}

const clave = item => `${item.itemType}:${item.id}`;

// Oficial = creado por la cuenta Roblox (User 1). La búsqueda ya filtra por
// creador, pero se comprueba igual: un UGC con el nombre de un item famoso no
// puede colarse nunca como "oficial".
const esOficial = item => item?.creatorType === 'User' && Number(item.creatorTargetId) === 1;

// ── Detección (puro) ─────────────────────────────────────────────────────────

function detectarFeed(estado, items, ahora = Date.now(), cfg = C()) {
    const eventos = [];
    const edadMax = cfg.EDAD_MAX_NUEVO_HORAS * 3_600_000;

    for (const item of items) {
        if (!esOficial(item)) continue;
        const k = clave(item);
        const antes = estado.items[k];
        const off = esOffsale(item);
        const precio = typeof item.price === 'number' ? item.price : null;

        if (!antes) {
            const creado = Date.parse(item.itemCreatedUtc);
            const reciente = Number.isFinite(creado) && ahora - creado <= edadMax;
            if (estado.feedIniciado && reciente) {
                eventos.push({ tipo: esLimited(item) ? 'nuevoLimited' : 'nuevo', item });
            }
        } else if (antes.off && !off) {
            eventos.push({ tipo: 'enVenta', item });
        } else if (!antes.off && !off && antes.p != null && precio != null && antes.p !== precio) {
            eventos.push({ tipo: 'precio', item, antes: antes.p });
        }

        estado.items[k] = { p: precio, off, v: ahora };
    }

    estado.feedIniciado = true;
    podar(estado);

    // Lo más antiguo primero: en el canal quedan en orden de publicación.
    eventos.sort((a, b) => String(a.item.itemCreatedUtc).localeCompare(String(b.item.itemCreatedUtc)));
    return eventos;
}

function podar(estado) {
    const entradas = Object.entries(estado.items);
    if (entradas.length <= MAX_ITEMS_RECORDADOS) return;
    entradas.sort((a, b) => b[1].v - a[1].v);
    estado.items = Object.fromEntries(entradas.slice(0, MAX_ITEMS_RECORDADOS));
}

// Apunta la reventa más barata de cada Limited y devuelve los que BAJARON de
// precio desde el barrido anterior, los que más bajaron primero.
function candidatosOferta(estado, items) {
    const bajadas = [];
    for (const item of items) {
        if (!esOficial(item) || !esLimited(item) || !item.collectibleItemId) continue;
        const precio = item.lowestResalePrice;
        if (!(precio > 0)) continue;
        const k = clave(item);
        const antes = estado.limiteds[k];
        estado.limiteds[k] = precio;
        if (estado.ofertasIniciado && typeof antes === 'number' && precio < antes) {
            bajadas.push({ item, caida: 1 - precio / antes });
        }
    }
    return bajadas.sort((a, b) => b.caida - a.caida).map(b => b.item);
}

function esGanga(precio, rap, cfg = C()) {
    if (!(precio > 0) || !(rap >= cfg.OFERTA_RAP_MIN)) return false;
    return precio <= rap * (1 - cfg.OFERTA_DESCUENTO_MIN);
}

// No repetir la misma ganga: sólo si ha pasado OFERTA_REPETIR_HORAS o si ahora
// está todavía más barata que cuando se avisó.
function debeAvisar(estado, k, precio, ahora = Date.now(), cfg = C()) {
    const prev = estado.avisadas[k];
    if (!prev) return true;
    if (precio < prev.precio) return true;
    return ahora - prev.t >= cfg.OFERTA_REPETIR_HORAS * 3_600_000;
}

function marcarAvisada(estado, k, precio, ahora = Date.now()) {
    estado.avisadas[k] = { precio, t: ahora };
    // Lo avisado hace más de una semana ya no hace falta recordarlo.
    for (const [kk, v] of Object.entries(estado.avisadas)) {
        if (ahora - v.t > 7 * 86_400_000) delete estado.avisadas[kk];
    }
}

// ── Envío ────────────────────────────────────────────────────────────────────

function canalConfigurado(estado = load()) {
    return estado.canal || C().CANAL || null;
}

async function conImagenes(eventos) {
    if (!eventos.length) return eventos;
    try {
        const urls = await roblox.getCatalogThumbnails(eventos.map(e => e.item));
        for (const e of eventos) e.imagen = urls.get(clave(e.item)) ?? null;
    } catch (err) {
        console.warn('[notifier] Miniaturas fallaron, se envía sin imagen:', err.message);
    }
    return eventos;
}

async function enviar(client, eventos, opciones = {}) {
    const id = canalConfigurado();
    if (!id || !eventos.length) return 0;
    const canal = await client.channels.fetch(id).catch(() => null);
    if (!canal?.isTextBased?.()) {
        console.warn(`[notifier] El canal ${id} no existe o no es de texto.`);
        return 0;
    }

    const max = C().MAX_AVISOS_POR_CICLO;
    if (eventos.length > max) {
        console.warn(`[notifier] ${eventos.length} avisos en un ciclo; se envían ${max} y se descartan el resto.`);
    }
    const lote = await conImagenes(eventos.slice(-max));
    let enviados = 0;
    for (const e of lote) {
        try {
            await canal.send(construirMensaje(e, opciones));
            enviados++;
        } catch (err) {
            console.error(`[notifier] No se pudo enviar ${e.tipo} ${e.item.id}:`, err.message);
        }
    }
    return enviados;
}

// ── Ciclos ───────────────────────────────────────────────────────────────────

const PARAMS_FEED = {
    Category: 1, CreatorTargetId: 1, CreatorType: 1,
    SortType: 3, Limit: 120, IncludeNotForSale: true,
};

const PARAMS_LIMITEDS = {
    Category: 1, CreatorTargetId: 1, CreatorType: 1,
    salesTypeFilter: 2, SortType: 3, Limit: 120,
};

async function cicloFeed(client) {
    const estado = load();
    if (!estado.activo || !canalConfigurado(estado)) return;

    const { items } = await roblox.searchCatalog(PARAMS_FEED);
    if (!items.length) return;   // respuesta vacía: no se toca nada

    const primera = !estado.feedIniciado;
    const eventos = detectarFeed(estado, items);
    save(estado);   // ANTES de enviar: un fallo al enviar no puede re-anunciar
    if (primera) console.log(`[notifier] Feed iniciado: ${items.length} items memorizados.`);
    if (eventos.length) await enviar(client, eventos);
}

async function cicloOfertas(client) {
    const estado = load();
    if (!estado.activo || !canalConfigurado(estado)) return;
    const cfg = C();

    const todos = [];
    let cursor = null;
    for (let pag = 0; pag < cfg.PAGINAS_OFERTAS; pag++) {
        const { items, nextPageCursor } = await roblox.searchCatalog(cursor ? { ...PARAMS_LIMITEDS, Cursor: cursor } : PARAMS_LIMITEDS);
        todos.push(...items);
        if (!nextPageCursor) break;
        cursor = nextPageCursor;
    }
    if (!todos.length) return;

    const primera = !estado.ofertasIniciado;
    const candidatos = candidatosOferta(estado, todos).slice(0, cfg.RAP_CONSULTAS_POR_CICLO);
    estado.ofertasIniciado = true;

    const eventos = [];
    const ahora = Date.now();
    for (const item of candidatos) {
        const k = clave(item);
        if (!debeAvisar(estado, k, item.lowestResalePrice, ahora)) continue;
        try {
            const { rap, ventasUltimoDia } = await roblox.getCollectibleResaleData(item.collectibleItemId);
            if (!esGanga(item.lowestResalePrice, rap)) continue;
            eventos.push({ tipo: 'oferta', item, rap, ventasUltimoDia });
            marcarAvisada(estado, k, item.lowestResalePrice, ahora);
        } catch (err) {
            console.warn(`[notifier] RAP de ${item.id} falló:`, err.message);
        }
    }

    save(estado);
    if (primera) console.log(`[notifier] Ofertas iniciadas: ${Object.keys(estado.limiteds).length} Limiteds memorizados.`);
    if (eventos.length) await enviar(client, eventos);
}

// Un ciclo no arranca mientras el anterior del mismo tipo sigue en marcha
// (Roblox lento + 10 páginas pueden pasar del intervalo).
function bucle(nombre, fn, segundos) {
    let ocupado = false;
    const tick = async () => {
        if (ocupado) return;
        ocupado = true;
        try { await fn(); }
        catch (err) { console.warn(`[notifier] Ciclo ${nombre} falló:`, err.message); }
        finally { ocupado = false; }
    };
    tick();
    const t = setInterval(tick, segundos * 1000);
    t.unref?.();
    return t;
}

let timers = [];
function iniciar(client) {
    timers.forEach(clearInterval);
    timers = [
        bucle('feed', () => cicloFeed(client), C().INTERVALO_FEED_SEG),
        bucle('ofertas', () => cicloOfertas(client), C().INTERVALO_OFERTAS_SEG),
    ];
    const canal = canalConfigurado();
    console.log(canal
        ? `[notifier] Activo en el canal ${canal}.`
        : '[notifier] Sin canal: usa /notifier canal para activarlo.');
}

// ── Para /notifier ───────────────────────────────────────────────────────────

function setCanal(canalId) {
    const e = load();
    e.canal = canalId;
    e.activo = true;
    save(e);
}

function setActivo(activo) {
    const e = load();
    e.activo = activo;
    save(e);
}

function resumen() {
    const e = load();
    return {
        canal: canalConfigurado(e),
        activo: e.activo,
        itemsVistos: Object.keys(e.items).length,
        limitedsVigilados: Object.keys(e.limiteds).length,
        feedIniciado: e.feedIniciado,
        ofertasIniciado: e.ofertasIniciado,
    };
}

// Manda al canal el item oficial más reciente del catálogo, marcado como
// prueba. Sirve para ver el formato sin esperar a que Roblox publique algo.
async function enviarPrueba(client) {
    const { items } = await roblox.searchCatalog({ ...PARAMS_FEED, Limit: 30 });
    const item = items.filter(esOficial)
        .sort((a, b) => String(b.itemCreatedUtc).localeCompare(String(a.itemCreatedUtc)))[0];
    if (!item) return 0;
    return enviar(client, [{ tipo: esLimited(item) ? 'nuevoLimited' : 'nuevo', item }], { prueba: true });
}

module.exports = {
    iniciar, setCanal, setActivo, resumen, enviarPrueba, cicloFeed, cicloOfertas,
    __test: { detectarFeed, candidatosOferta, esGanga, debeAvisar, marcarAvisada, esOficial, estadoVacio, load, FILE },
};
