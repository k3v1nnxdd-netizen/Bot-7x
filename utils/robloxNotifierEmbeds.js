'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');

// ── Los mensajes del notificador de Roblox ───────────────────────────────────
//
// Funciones puras: reciben un evento (lo que detectó utils/robloxNotifier.js) y
// devuelven el payload de Discord. Nada aquí habla con Roblox ni con Discord,
// así que se prueba sin red.

const C = () => config.ROBLOX_NOTIFIER;

// Emoji de la aplicación si está configurado; si no, el unicode de reserva. Un
// id que falte no puede dejar un ":rn_x:" roto en el mensaje.
const RESERVA = {
    nuevo: '✨', limited: '🟡', limitedu: '🟠', venta: '🏷️', update: '🔄', oferta: '🔥',
    id: '🆔', precio: '💵', fecha: '📅', props: '🔍', tipo: '👕', stock: '📦',
    rap: '📈', baja: '📉', sube: '💰', limite: '👤', link: '🔗',
};

function emoji(clave) {
    const id = C().ICONOS?.[clave];
    return id ? `<:rn_${clave}:${id}>` : RESERVA[clave];
}

// Para los botones: discord.js quiere { id, name } o el unicode.
function emojiBoton(clave) {
    const id = C().ICONOS?.[clave];
    return id ? { id, name: `rn_${clave}` } : { name: RESERVA[clave] };
}

// ── Tipos de aviso ───────────────────────────────────────────────────────────

const TIPOS = {
    nuevo:        { titulo: 'Nuevo Item',         color: 0x3B82F6, icono: 'nuevo'   },
    nuevoLimited: { titulo: 'Nuevo Limited',      color: 0xEAAA08, icono: 'limited' },
    enVenta:      { titulo: 'Ya a la venta',      color: 0x22C55E, icono: 'venta'   },
    precio:       { titulo: 'Cambio de precio',   color: 0x8B5CF6, icono: 'update'  },
    oferta:       { titulo: 'Limited en oferta',  color: 0xEF4444, icono: 'oferta'  },
};

// ── Datos del item ───────────────────────────────────────────────────────────

const robux = n => `R$ ${Math.round(n).toLocaleString('en-US')}`;

function esLimited(item) {
    const r = item.itemRestrictions ?? [];
    return r.includes('Limited') || r.includes('LimitedUnique') || r.includes('Collectible');
}

function esOffsale(item) {
    return item.isOffSale === true || item.priceStatus === 'Off Sale';
}

function urlItem(item) {
    return item.itemType === 'Bundle'
        ? `https://www.roblox.com/bundles/${item.id}`
        : `https://www.roblox.com/catalog/${item.id}`;
}

function textoPrecio(item) {
    if (esOffsale(item)) {
        // Un Limited offsale se sigue pudiendo comprar en reventa.
        return item.lowestResalePrice > 0 ? `Offsale · reventa desde ${robux(item.lowestResalePrice)}` : 'Offsale';
    }
    if (item.priceStatus === 'Free' || item.price === 0) return 'Gratis';
    if (typeof item.price === 'number') return robux(item.price);
    return 'No disponible';
}

function propiedades(item) {
    const r = item.itemRestrictions ?? [];
    const p = [];
    if (r.includes('LimitedUnique')) p.push(`${emoji('limitedu')} Limited U`);
    else if (r.includes('Limited') || r.includes('Collectible')) p.push(`${emoji('limited')} Limited`);
    if (item.itemType === 'Bundle') p.push('Bundle');
    if (r.includes('Live')) p.push('Cabeza animada');
    if (item.saleLocationType === 'ShopOnly') p.push('Sólo en tienda');
    if (item.saleLocationType === 'ExperiencesDevApiOnly' || item.saleLocationType === 'ExperiencesById') p.push('Sólo en experiencias');
    if (esOffsale(item)) p.push('Offsale');
    return p.length ? p.join(' · ') : 'Estándar';
}

function tipoItem(item) {
    return item.taxonomy?.[0]?.taxonomyName ?? (item.itemType === 'Bundle' ? 'Bundle' : 'Accesorio');
}

function fecha(item) {
    const t = Date.parse(item.itemCreatedUtc);
    if (!Number.isFinite(t)) return 'Desconocida';
    const s = Math.floor(t / 1000);
    return `<t:${s}:f>\n<t:${s}:R>`;
}

function stock(item) {
    const total = item.totalQuantity;
    if (!total) return null;
    const quedan = item.unitsAvailableForConsumption ?? 0;
    return quedan > 0 ? `${quedan.toLocaleString('en-US')} / ${total.toLocaleString('en-US')}` : `Agotado · ${total.toLocaleString('en-US')} en total`;
}

function cortar(texto, max) {
    const t = String(texto ?? '').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ── El mensaje ───────────────────────────────────────────────────────────────
//
// evento = { tipo, item, imagen?, antes? (precio anterior), rap?, ventasUltimoDia? }

function construirMensaje(evento, { prueba = false } = {}) {
    const { tipo, item } = evento;
    const def = TIPOS[tipo];
    if (!def) throw new Error(`Tipo de aviso desconocido: ${tipo}`);
    const f = (icono, nombre, valor, inline = true) => ({ name: `${emoji(icono)} ${nombre}`, value: String(valor), inline });

    const campos = [f('id', 'ID', `\`${item.id}\``), f('precio', 'Precio', textoPrecio(item))];

    if (tipo === 'precio' && typeof evento.antes === 'number') {
        const dif = item.price - evento.antes;
        campos[1] = f('precio', 'Precio', `~~${robux(evento.antes)}~~ → **${robux(item.price)}**`);
        campos.push(f(dif < 0 ? 'baja' : 'sube', dif < 0 ? 'Bajó' : 'Subió', robux(Math.abs(dif))));
    }

    if (tipo === 'oferta') {
        const precio = item.lowestResalePrice;
        const rap = evento.rap;
        const desc = Math.round((1 - precio / rap) * 100);
        campos[1] = f('precio', 'Reventa más barata', `**${robux(precio)}**`);
        campos.push(f('rap', 'RAP', robux(rap)));
        campos.push(f('baja', 'Por debajo del RAP', `**-${desc}%**`));
        campos.push(f('sube', 'Margen vs RAP', `+${robux(rap - precio)}`));
        if (evento.ventasUltimoDia != null) campos.push(f('stock', 'Ventas (último día)', evento.ventasUltimoDia.toLocaleString('en-US')));
    }

    campos.push(f('fecha', 'Creado', fecha(item)));
    campos.push(f('tipo', 'Tipo', tipoItem(item)));
    campos.push(f('props', 'Propiedades', propiedades(item)));

    const st = stock(item);
    if (st && tipo !== 'oferta') campos.push(f('stock', 'Stock', st));
    if (item.quantityLimitPerUser) campos.push(f('limite', 'Límite por usuario', item.quantityLimitPerUser));

    const embed = new EmbedBuilder()
        .setColor(def.color)
        .setAuthor({ name: 'Catálogo oficial de Roblox', url: 'https://www.roblox.com/catalog?CreatorName=Roblox&SortType=3' })
        .setTitle(cortar(`${def.titulo} — ${item.name}`, 256))
        .setURL(urlItem(item))
        .addFields(campos)
        .setFooter({ text: prueba ? '7x Roblox Notifier · Mensaje de prueba' : '7x Roblox Notifier · Datos oficiales de Roblox' })
        .setTimestamp(new Date());

    if (item.description) embed.setDescription(`>>> ${cortar(item.description, 600)}`);
    if (evento.imagen) embed.setImage(evento.imagen);

    const botones = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Ver en Roblox').setURL(urlItem(item)).setEmoji(emojiBoton('link')),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Catálogo oficial')
            .setURL(tipo === 'oferta' || esLimited(item)
                ? 'https://www.roblox.com/catalog?CreatorName=Roblox&salesTypeFilter=2&SortType=3'
                : 'https://www.roblox.com/catalog?CreatorName=Roblox&SortType=3&IncludeNotForSale=true')
            .setEmoji(emojiBoton(def.icono)),
    );

    const mencion = C().MENCION_USER_ID;
    return {
        content: `${emoji(def.icono)} **${def.titulo}**${mencion ? ` · <@${mencion}>` : ''}`,
        embeds: [embed],
        components: [botones],
        allowedMentions: { users: mencion ? [mencion] : [], parse: [] },
    };
}

module.exports = { construirMensaje, esLimited, esOffsale, urlItem, textoPrecio, TIPOS, emoji };
