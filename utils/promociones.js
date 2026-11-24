'use strict';

const fs = require('fs');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const { dataPath, ensureDataDir } = require('./dataDir');
const leaderboard = require('./robuxLeaderboard');
const { fechaPedido } = require('./fidelidad');
const v2 = require('./panelV2');
const precios = require('../data/prices');
const gp = require('./gamepassPrecios');
const plus = require('./plusPrecios');
const apartados = require('./apartadosTicket');
const logCanales = require('./logCanales');

// ── Promociones por MD ────────────────────────────────────────────────────────
//
// Dos mensajes automáticos a quien ya compró (ver config.PROMOS):
//
//   - RESUMEN, un día después de cada compra: lo que se ahorró en ella frente
//     al precio de Roblox, y lo que lleva ahorrado en total.
//   - INACTIVO, tras 14 días sin comprar: los precios de hoy y su ahorro
//     acumulado. Como mucho uno cada 14 días mientras siga sin comprar.
//
// Todos llevan un botón que lleva al panel de compra y otro para no recibir
// más. Cada envío, cada fallo y cada baja quedan en el registro de
// promociones: el owner tiene que poder ver a quién se le escribe.
//
// De dónde salen los datos: del ranking de compradores, que se reconstruye
// desde el registro de pedidos en cada arranque. Las fechas salen del id de
// cada pedido (un snowflake), así que nada de esto depende de la memoria.
//
// Lo que se guarda aquí es sólo lo propio: quién se dio de baja y qué se le
// mandó a quién y cuándo, para no repetir.

const FILE = dataPath('promociones.json');
const TMP = FILE + '.tmp';

const DIA = 86_400_000;
// Un resumen que no se pudo mandar a tiempo (el bot apagado, la ronda llena)
// no se manda pasada esta ventana: "ahorraste en tu compra" de hace un mes ya
// no es un resumen, es spam.
const VENTANA_RESUMEN_MS = 5 * DIA;

const P = () => config.PROMOS;

function load() {
    try {
        const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        return {
            inicio: d.inicio ?? null,
            bajas: d.bajas ?? {},
            avisos: d.avisos ?? {},
            resumenes: d.resumenes ?? {},
        };
    } catch {
        return { inicio: null, bajas: {}, avisos: {}, resumenes: {} };
    }
}

function save(d) {
    ensureDataDir();
    fs.writeFileSync(TMP, JSON.stringify(d, null, 2), 'utf8');
    fs.renameSync(TMP, FILE);
}

// ── Bajas ─────────────────────────────────────────────────────────────────────

function estaDeBaja(userId) {
    return Boolean(load().bajas[String(userId)]);
}

function setBaja(userId, deBaja, ahora = Date.now()) {
    const d = load();
    if (deBaja) d.bajas[String(userId)] = ahora;
    else delete d.bajas[String(userId)];
    save(d);
}

// ── Las cuentas ───────────────────────────────────────────────────────────────

const fmt = n => Number(n).toLocaleString('es-MX');

// Lo que habrían costado esos Robux en Roblox y cuánto se ahorró. null si no
// hay ahorro que contar: presumir de un ahorro de $0, o negativo, sería mentir.
function ahorro(robux, pagado) {
    if (!Number.isFinite(robux) || robux <= 0 || !Number.isFinite(pagado) || pagado < 0) return null;
    const roblox = Math.round((robux / 1000) * P().PRECIO_ROBLOX_POR_1K);
    const ahorrado = roblox - pagado;
    if (ahorrado <= 0) return null;
    return { roblox, pagado, ahorrado, pct: Math.round((ahorrado / roblox) * 100) };
}

// Las compras con fecha de un cliente, de la más vieja a la más nueva.
function pedidosDe(entry) {
    return (entry.ordenes ?? [])
        .map(id => ({ id, fecha: fechaPedido(id), ...(entry.detalle?.[id] ?? {}) }))
        .filter(p => p.fecha !== null)
        .sort((a, b) => a.fecha - b.fecha);
}

// ── Qué toca mandar ───────────────────────────────────────────────────────────
//
// Devuelve la lista de envíos pendientes, el más atrasado primero. Como mucho
// uno por persona y ronda: el resumen tiene prioridad (es de una compra
// concreta y caduca), y el aviso de inactividad espera a la siguiente.
function pendientes(ahora = Date.now(), datos = load(), compradores = leaderboard.getRanked()) {
    const p = P();
    const out = [];

    for (const entry of compradores) {
        const userId = String(entry.userId);
        if (datos.bajas[userId]) continue;

        const pedidos = pedidosDe(entry);
        if (!pedidos.length) continue;

        // Resumen: sólo de compras hechas desde que existe el sistema. Sin
        // esto, el primer arranque le mandaría a cada cliente el resumen de
        // compras que ya ni recuerda.
        const resumen = pedidos.find(o =>
            datos.inicio !== null && o.fecha >= datos.inicio &&
            !datos.resumenes[o.id] &&
            ahora - o.fecha >= p.DIAS_RESUMEN * DIA &&
            ahora - o.fecha < p.DIAS_RESUMEN * DIA + VENTANA_RESUMEN_MS
        );
        if (resumen) {
            out.push({ tipo: 'resumen', userId, entry, pedido: resumen, debido: resumen.fecha + p.DIAS_RESUMEN * DIA });
            continue;
        }

        // Inactivo: desde la última compra o el último aviso, lo más reciente.
        const ultima = pedidos[pedidos.length - 1].fecha;
        const ultimoAviso = datos.avisos[userId] ?? 0;
        const desde = Math.max(ultima + p.DIAS_INACTIVO * DIA, ultimoAviso + p.DIAS_ENTRE_AVISOS * DIA);
        if (ahora >= desde) {
            out.push({ tipo: 'inactivo', userId, entry, ultima, debido: desde });
        }
    }

    return out.sort((a, b) => a.debido - b.debido);
}

// ── Los mensajes ──────────────────────────────────────────────────────────────

const E = {
    buy:      '<:buy:1501212698556371004>',
    gamepass: '<:roblox:1525317838938701967>',
    plus:     config.ROBLOX_PLUS_EMOJI || '💎',
    point:    '<:point:1501212595464700104>',
    money:    '<:money:1544123920897019906>',
    si:       '<:true:1501213776878501899>',
};

// Los precios de hoy, sólo de lo que se puede comprar ahora mismo: un
// apartado apagado con /ticketactive no se anuncia.
function lineasPrecios() {
    const comunidad = precios.lookup(1000);
    const lineas = [];
    if (apartados.disponible('comprar') && comunidad) {
        lineas.push(`${E.buy} **Comunidad** · 1,000 Robux = **${comunidad.price} MXN**`);
    }
    if (apartados.disponible('comprar_gamepass')) {
        lineas.push(`${E.gamepass} **Gamepass** · 1,000 Robux = **$${fmt(gp.G.PRECIO_POR_1K)} MXN** · con tax cubierto **$${fmt(gp.G.PRECIO_CUBIERTO_POR_1K)}**`);
    }
    if (apartados.disponible('comprar_plus')) {
        lineas.push(`${E.plus} **Roblox Plus** · 1,000 Robux = **$${fmt(plus.P.PRECIO_POR_1K)} MXN** · llegan completos`);
    }
    return lineas;
}

function lineasAhorroTotal(entry) {
    const a = ahorro(entry.totalRobux, entry.totalSpent);
    if (!a) return [];
    return [
        `### ${E.money} Tu ahorro con 7x`,
        `Has comprado **${fmt(entry.totalRobux)} Robux** con nosotros por **$${fmt(a.pagado)} MXN**.`,
        `En Roblox te habrían costado **$${fmt(a.roblox)} MXN**: llevas **$${fmt(a.ahorrado)} MXN ahorrados** (${a.pct}%).`,
    ];
}

const pieReferencia = () => `-# Comparado con el precio de Roblox en tarjeta: $${fmt(P().PRECIO_ROBLOX_POR_1K)} MXN por 1,000 Robux.`;

function textoInactivo(entry, ultima, ahora = Date.now()) {
    const dias = Math.max(1, Math.floor((ahora - ultima) / DIA));
    const total = lineasAhorroTotal(entry);
    return [
        '## 👋 ¡Te extrañamos en 7x Community!',
        `Hace **${dias} días** de tu última compra. Así están los precios hoy:`,
        '',
        ...lineasPrecios(),
        ...(total.length ? ['', ...total, pieReferencia()] : []),
        '',
        'Cuando quieras más Robux, pulsa el botón y abre tu ticket. Entrega rápida y segura.',
    ].join('\n');
}

function textoResumen(entry, pedido) {
    const esta = ahorro(pedido.robux, pedido.precio);
    const total = lineasAhorroTotal(entry);
    const lineas = [
        '## 🎉 ¡Gracias por tu compra!',
        pedido.robux ? `Tu pedido de **${fmt(pedido.robux)} Robux** ya está completado.` : 'Tu pedido ya está completado.',
    ];
    if (esta) {
        lineas.push(
            '',
            `### ${E.si} Lo que ahorraste en esta compra`,
            `Pagaste **$${fmt(esta.pagado)} MXN**. En Roblox te habrían costado **$${fmt(esta.roblox)} MXN**: ` +
            `ahorraste **$${fmt(esta.ahorrado)} MXN** (${esta.pct}%).`,
        );
    }
    if (total.length && (entry.purchases ?? 0) > 1) lineas.push('', ...total);
    if (esta || total.length) lineas.push(pieReferencia());
    lineas.push('', 'Cuando quieras más, aquí estamos.');
    return lineas.join('\n');
}

// El botón al servidor: al panel de compra si sigue dentro; si se fue, a la
// invitación (un enlace a un canal de un servidor en el que no estás no abre).
function filaBotones(enServidor) {
    const url = enServidor
        ? `https://discord.com/channels/${config.GUILD_ID}/${config.CHANNELS.PANEL}`
        : config.INVITE_URL;
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('Comprar en 7x')
            .setEmoji('🛒')
            .setStyle(ButtonStyle.Link)
            .setURL(url),
        new ButtonBuilder()
            .setCustomId('promo_baja')
            .setLabel('No recibir promociones')
            .setStyle(ButtonStyle.Secondary),
    );
}

function payload(texto, enServidor) {
    return v2.tarjetaPayload({
        color: 0x2B2D31,
        texto,
        pie: '7x Community',
        filas: [filaBotones(enServidor)],
    });
}

// ── El registro ───────────────────────────────────────────────────────────────

const NOMBRE_TIPO = { resumen: 'Resumen de compra', inactivo: 'Recordatorio (sin comprar)' };

async function registrar(client, texto) {
    const guild = client.guilds.cache.get(config.GUILD_ID);
    if (!guild) return;
    await logCanales.enviar(guild, 'promociones', {
        content: texto,
        allowedMentions: { parse: [] },
    }).catch(() => {});
}

function lineaRegistro(envio, ok, detalle = '') {
    const a = ahorro(envio.entry.totalRobux, envio.entry.totalSpent);
    return `${ok ? '📨' : '⚠️'} **${NOMBRE_TIPO[envio.tipo]}** → <@${envio.userId}> (\`${envio.userId}\`)` +
        (ok ? '' : ' · **no se pudo entregar**') +
        ` · ${fmt(envio.entry.purchases ?? 0)} compra${envio.entry.purchases === 1 ? '' : 's'}` +
        (a ? ` · ahorro total $${fmt(a.ahorrado)} MXN` : '') +
        (detalle ? ` · ${detalle}` : '');
}

// ── Enviar ────────────────────────────────────────────────────────────────────

async function enviar(client, envio, ahora = Date.now()) {
    const guild = client.guilds.cache.get(config.GUILD_ID);
    const miembro = guild ? await guild.members.fetch(envio.userId).catch(() => null) : null;

    const texto = envio.tipo === 'resumen'
        ? textoResumen(envio.entry, envio.pedido)
        : textoInactivo(envio.entry, envio.ultima, ahora);

    let ok = false;
    let motivo = '';
    try {
        const user = miembro?.user ?? await client.users.fetch(envio.userId);
        await user.send(payload(texto, Boolean(miembro)));
        ok = true;
    } catch (err) {
        // 50007: MDs cerrados o sin servidor en común. Es lo normal, no un error.
        motivo = err?.code === 50007 ? 'MDs cerrados' : (err?.message ?? 'error');
    }

    // Se apunta también el fallo: si no, se reintentaría en cada ronda.
    const d = load();
    if (envio.tipo === 'resumen') d.resumenes[envio.pedido.id] = ahora;
    else d.avisos[envio.userId] = ahora;
    save(d);

    await registrar(client, lineaRegistro(envio, ok, ok ? (miembro ? '' : 'ya no está en el servidor') : motivo));
    return ok;
}

let corriendo = false;

// Una ronda: lo que toque, hasta MAX_POR_RONDA envíos. Lo que no entre espera
// a la siguiente, así un día con muchos pendientes no es una ráfaga de MDs.
async function revisar(client, ahora = Date.now()) {
    if (!P().ACTIVO || corriendo) return { enviados: 0, pendientes: 0 };
    corriendo = true;
    try {
        const d = load();
        if (d.inicio === null) {
            d.inicio = ahora;
            save(d);
        }
        const lista = pendientes(ahora, load());
        let enviados = 0;
        for (const envio of lista.slice(0, P().MAX_POR_RONDA)) {
            if (await enviar(client, envio, ahora)) enviados++;
        }
        return { enviados, pendientes: lista.length };
    } catch (err) {
        console.error('[promos] Error en la ronda:', err);
        return { enviados: 0, pendientes: 0 };
    } finally {
        corriendo = false;
    }
}

function iniciar(client) {
    if (!P().ACTIVO) {
        console.log('[promos] Desactivadas en config.');
        return null;
    }
    // La primera ronda con un pequeño margen tras el arranque: deja que el
    // ranking termine de reconstruirse desde el registro de pedidos.
    setTimeout(() => revisar(client), 2 * 60_000).unref?.();
    const t = setInterval(() => revisar(client), P().REVISION_MIN * 60_000);
    t.unref?.();
    console.log(`[promos] Activas: revisión cada ${P().REVISION_MIN} min.`);
    return t;
}

// ── Botones de baja y alta ────────────────────────────────────────────────────

async function alBoton(interaction) {
    const userId = interaction.user.id;
    const baja = interaction.customId === 'promo_baja';
    setBaja(userId, baja);

    const fila = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(baja ? 'promo_alta' : 'promo_baja')
            .setLabel(baja ? 'Volver a recibir promociones' : 'No recibir promociones')
            .setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({
        content: baja
            ? '🔕 Listo, ya no te mandaremos promociones. Si cambias de opinión, pulsa el botón.'
            : '🔔 Listo, volverás a recibir nuestras promociones.',
        components: [fila],
    }).catch(() => {});

    await registrar(interaction.client, baja
        ? `🔕 <@${userId}> (\`${userId}\`) **se dio de baja** de las promociones.`
        : `🔔 <@${userId}> (\`${userId}\`) **volvió a darse de alta** en las promociones.`);
}

// /promos prueba: el recordatorio tal cual, al propio owner. Con sus datos de
// comprador si los tiene y, si no, con unos de ejemplo. No apunta nada ni sale
// en el registro: es para ver cómo se ve.
async function enviarPrueba(client, userId, ahora = Date.now()) {
    const real = leaderboard.getEntry(userId);
    const entry = real?.totalRobux ? real : { totalRobux: 5000, totalSpent: 597, purchases: 3 };
    const ultima = pedidosDe(entry).at(-1)?.fecha ?? ahora - P().DIAS_INACTIVO * DIA;
    try {
        const user = await client.users.fetch(userId);
        await user.send(payload(textoInactivo(entry, ultima, ahora), true));
        return true;
    } catch {
        return false;
    }
}

function resumenEstado(ahora = Date.now()) {
    const d = load();
    const compradores = leaderboard.getRanked();
    const hace = t => Object.values(t).filter(x => ahora - x < 7 * DIA).length;
    return {
        clientes: compradores.length,
        bajas: Object.keys(d.bajas).length,
        semana: hace(d.avisos) + hace(d.resumenes),
        pendientes: pendientes(ahora, d, compradores).length,
        inicio: d.inicio,
    };
}

module.exports = {
    iniciar, revisar, alBoton, estaDeBaja, setBaja, ahorro, resumenEstado,
    __test: { pendientes, textoInactivo, textoResumen, payload, lineaRegistro, enviar, load, save, FILE, DIA, VENTANA_RESUMEN_MS, _reset: () => { corriendo = false; } },
};
