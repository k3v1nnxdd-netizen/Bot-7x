'use strict';

// Notificador del catálogo oficial de Roblox (utils/robloxNotifier.js).
//
// Lo que protegen:
//   1. EL PRIMER CICLO NO AVISA: sólo memoriza (si no, 120 "nuevos" falsos).
//   2. NUEVO = no visto + creado hace poco; Limited → "Nuevo Limited".
//   3. SÓLO OFICIAL: un UGC con el mismo nombre nunca se anuncia.
//   4. offsale → a la venta, y cambios de precio, se detectan.
//   5. OFERTAS: sólo lo que BAJA, sólo si está ≥X% bajo el RAP, sin repetir.
//   6. El mensaje menciona al usuario configurado y enlaza a Roblox.

const fs = require('fs');
const { createSuite } = require('./testHarness');
const config = require('../../config');
const notifier = require('../../utils/robloxNotifier');
const { construirMensaje } = require('../../utils/robloxNotifierEmbeds');

const { detectarFeed, candidatosOferta, esGanga, debeAvisar, marcarAvisada, estadoVacio, FILE } = notifier.__test;

const AHORA = Date.parse('2026-11-10T12:00:00Z');
const HACE = h => new Date(AHORA - h * 3_600_000).toISOString();

function item(extra = {}) {
    return {
        id: 1001, itemType: 'Asset', name: 'Ear Drumsticks', description: 'Stay warmer.',
        creatorType: 'User', creatorTargetId: 1, creatorName: 'Roblox',
        itemRestrictions: [], price: 100, isOffSale: false, itemCreatedUtc: HACE(1),
        taxonomy: [{ taxonomyName: 'Head Accessories' }],
        ...extra,
    };
}

module.exports = async function run() {
    const { assert, finish } = createSuite('robloxNotifier');
    const cfg = config.ROBLOX_NOTIFIER;

    // ── 1. Primer ciclo ──────────────────────────────────────────────────────
    let e = estadoVacio();
    let ev = detectarFeed(e, [item({ id: 1 }), item({ id: 2 })], AHORA);
    assert(ev.length === 0, 'el primer ciclo sólo memoriza, no avisa');
    assert(e.feedIniciado && Object.keys(e.items).length === 2, 'y queda iniciado con lo visto');

    // ── 2. Nuevos ────────────────────────────────────────────────────────────
    ev = detectarFeed(e, [item({ id: 1 }), item({ id: 3 }), item({ id: 4, itemRestrictions: ['LimitedUnique'], totalQuantity: 50 })], AHORA);
    assert(ev.length === 2, 'dos items no vistos y recientes → dos avisos');
    assert(ev.find(x => x.item.id === 3)?.tipo === 'nuevo', 'item normal → Nuevo Item');
    assert(ev.find(x => x.item.id === 4)?.tipo === 'nuevoLimited', 'Limited U → Nuevo Limited');

    ev = detectarFeed(e, [item({ id: 5, itemCreatedUtc: HACE(cfg.EDAD_MAX_NUEVO_HORAS + 5) })], AHORA);
    assert(ev.length === 0, 'un item viejo que aparece por actualización no es "nuevo"');

    // ── 3. Sólo oficial ──────────────────────────────────────────────────────
    ev = detectarFeed(e, [item({ id: 6, creatorType: 'Group', creatorTargetId: 1 }), item({ id: 7, creatorTargetId: 999 })], AHORA);
    assert(ev.length === 0, 'grupos y usuarios que no son Roblox se ignoran');

    // ── 4. A la venta y precio ───────────────────────────────────────────────
    e = estadoVacio();
    detectarFeed(e, [item({ id: 10, isOffSale: true, price: 1 }), item({ id: 11, price: 100 })], AHORA);
    ev = detectarFeed(e, [item({ id: 10, isOffSale: false, price: 75 }), item({ id: 11, price: 60 })], AHORA);
    assert(ev.find(x => x.item.id === 10)?.tipo === 'enVenta', 'offsale → a la venta');
    const p = ev.find(x => x.item.id === 11);
    assert(p?.tipo === 'precio' && p.antes === 100, 'cambio de precio con el precio anterior');
    ev = detectarFeed(e, [item({ id: 10, isOffSale: false, price: 75 }), item({ id: 11, price: 60 })], AHORA);
    assert(ev.length === 0, 'sin cambios, sin avisos');

    // ── 5. Ofertas ───────────────────────────────────────────────────────────
    const lim = (id, precio) => item({ id, itemRestrictions: ['Limited'], collectibleItemId: `g-${id}`, lowestResalePrice: precio });
    e = estadoVacio();
    assert(candidatosOferta(e, [lim(20, 5000), lim(21, 3000)]).length === 0, 'primer barrido de Limiteds: sin candidatos');
    e.ofertasIniciado = true;
    const cand = candidatosOferta(e, [lim(20, 2000), lim(21, 3500), item({ id: 22, lowestResalePrice: 1 })]);
    assert(cand.length === 1 && cand[0].id === 20, 'sólo es candidato el Limited cuyo precio BAJÓ');

    assert(esGanga(2000, 5000), '2000 con RAP 5000 (-60%) es ganga');
    assert(!esGanga(4000, 5000), '4000 con RAP 5000 (-20%) no lo es');
    assert(!esGanga(100, 500), 'RAP por debajo del mínimo nunca es ganga');
    assert(!esGanga(100, null), 'sin RAP no hay ganga');

    marcarAvisada(e, 'Asset:20', 2000, AHORA);
    assert(!debeAvisar(e, 'Asset:20', 2000, AHORA + 60_000), 'la misma ganga no se repite enseguida');
    assert(debeAvisar(e, 'Asset:20', 1500, AHORA + 60_000), 'pero sí si baja todavía más');
    assert(debeAvisar(e, 'Asset:20', 2000, AHORA + cfg.OFERTA_REPETIR_HORAS * 3_600_000), 'o cuando pasa el plazo');

    // ── 6. El mensaje ────────────────────────────────────────────────────────
    const m = construirMensaje({ tipo: 'nuevo', item: item({ id: 133224540588474, isOffSale: true }), imagen: 'https://tr.rbxcdn.com/x.png' });
    const emb = m.embeds[0].toJSON();
    assert(m.content.includes(`<@${cfg.MENCION_USER_ID}>`), 'menciona al usuario configurado');
    assert(m.allowedMentions.users.includes(cfg.MENCION_USER_ID) && m.allowedMentions.parse.length === 0, 'y sólo a él (sin @everyone ni roles)');
    assert(emb.url === 'https://www.roblox.com/catalog/133224540588474', 'el título enlaza al item en Roblox');
    assert(emb.fields.some(f => f.value.includes('Offsale')), 'muestra Offsale');
    assert(emb.image?.url === 'https://tr.rbxcdn.com/x.png', 'lleva la imagen del item');
    assert(m.components[0].toJSON().components[0].url === emb.url, 'el botón lleva a Roblox');

    const b = construirMensaje({ tipo: 'nuevo', item: item({ id: 55, itemType: 'Bundle' }) });
    assert(b.embeds[0].toJSON().url === 'https://www.roblox.com/bundles/55', 'los bundles enlazan a /bundles/');

    const o = construirMensaje({ tipo: 'oferta', item: lim(30, 2000), rap: 5000, ventasUltimoDia: 12 }).embeds[0].toJSON();
    assert(o.fields.some(f => f.value.includes('-60%')), 'la oferta muestra el % bajo el RAP');
    assert(o.fields.some(f => f.value.includes('R$ 5,000')), 'y el RAP');

    // El estado de prueba no se queda en disco.
    if (fs.existsSync(FILE)) fs.unlinkSync(FILE);

    return finish();
};
