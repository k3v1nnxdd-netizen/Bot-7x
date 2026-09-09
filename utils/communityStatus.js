'use strict';

const config = require('../config');
const groupActive = require('./groupActive');
// Se requieren los MÓDULOS, no sus funciones sueltas: desestructurar aquí
// congelaría la referencia y los tests no podrían sustituir una consulta a
// Roblox por un doble. Es el mismo patrón con el que ya se prueban
// groupMembership y el cliente de Roblox.
const groupEmojis = require('./groupEmojis');
const groupMembership = require('./groupMembership');
const { GroupCheckError } = groupMembership;

// ── El estado del comprador en cada comunidad ────────────────────────────────
//
// Lo usa el resumen del ticket de Robux para responder, sin que el cliente
// tenga que preguntar, las tres cosas que de verdad le importan:
//
//   1. ¿Pertenece a cada comunidad y desde cuándo? (días)
//   2. ¿Es elegible ya, o le faltan días para los que exige Roblox?
//   3. De las comunidades que ESTÁN enviando ahora mismo, ¿puede recibir?
//
// CONTRATO: esto no puede impedir que se abra un ticket. Todas las consultas
// van con allSettled y cualquier fallo se convierte en un "no se pudo
// comprobar" para esa comunidad. Un cliente que no puede comprar porque Roblox
// tardó en contestar es mucho peor que un resumen incompleto.

const EMOJI = {
    generico: '<:followers7x:1525326777071960124>',
    si:       '<a:add:1540603311890104321>',
    no:       '<a:remove:1540604743234228364>',
    working:  '<:working:1547108520669741157>',
    down:     '<:down:1547141212530679899>',
    point:    '<:point:1501212595464700104>',
    alert:    '<:alert:1501220021035204658>',
};

// Nombre de field en blanco (espacio de ancho cero). Discord NO renderiza los
// emojis del servidor en el nombre de un field —ahí se imprimen crudos—, así
// que el icono de la comunidad y su nombre tienen que ir los dos en el value.
const NOMBRE_VACIO = '​';

// Una consulta por comunidad, TODAS a la vez. Comparten la caché de
// resolveRobloxUser, así que el username se resuelve una sola vez aunque haya
// cinco comprobaciones; lo que se paga son las membresías, cacheadas 5 min.
async function resolverComunidades(username) {
    const claves = Object.keys(config.CHECK_GROUPS);

    const resultados = await Promise.allSettled(
        claves.map(clave => groupMembership.checkMembership(clave, username))
    );

    return claves.map((clave, i) => {
        const r = resultados[i];
        const label = config.CHECK_GROUPS[clave].label;

        if (r.status === 'rejected') {
            const code = r.reason instanceof GroupCheckError ? r.reason.code : 'unexpected';
            console.warn(`[communityStatus] No se pudo comprobar ${clave} para "${username}": ${code}`);
            return { clave, label, estado: 'error', dias: null, robloxUserId: null };
        }

        const v = r.value;
        return {
            clave,
            label,
            estado: !v.isMember ? 'no_miembro' : v.eligible ? 'elegible' : 'no_elegible',
            dias: v.days,
            robloxUserId: v.robloxUserId,
        };
    });
}

// ── Textos ────────────────────────────────────────────────────────────────────

function textoDias(c) {
    if (c.estado === 'error')      return 'No se pudo comprobar';
    if (c.estado === 'no_miembro') return 'No perteneces';

    const dias = `${c.dias} día${c.dias === 1 ? '' : 's'}`;
    if (c.estado === 'elegible') return `${dias} · elegible`;

    const faltan = Math.max(0, config.MIN_GROUP_DAYS - c.dias);
    return `${dias} · faltan ${faltan}`;
}

function marca(c) {
    if (c.estado === 'error') return EMOJI.alert;
    return c.estado === 'elegible' ? EMOJI.si : EMOJI.no;
}

// La misma información que textoDias, pero en una sola frase con su marca
// dentro: en la lista de envío la línea ya es larga, y encadenar
// "No se pudo comprobar · no se pudo comprobar" era repetirse.
function resumenEnvio(c) {
    if (c.estado === 'error')      return `${EMOJI.alert} no se pudo comprobar`;
    if (c.estado === 'no_miembro') return `${EMOJI.no} no perteneces`;

    const dias = `**${c.dias}** día${c.dias === 1 ? '' : 's'}`;
    if (c.estado === 'elegible') return `${dias} · ${EMOJI.si} puedes recibir aquí`;

    const faltan = Math.max(0, config.MIN_GROUP_DAYS - c.dias);
    return `${dias} · ${EMOJI.no} te faltan ${faltan}`;
}

// Los fields horizontales: uno por comunidad, en línea, así que Discord los
// coloca en filas de tres. El nombre va vacío a propósito (ver NOMBRE_VACIO).
function buildFields(comunidades, emojis = {}) {
    return comunidades.map(c => ({
        name: NOMBRE_VACIO,
        value: `${emojis[c.clave] ?? EMOJI.generico} **${c.label}**\n${marca(c)} ${textoDias(c)}`,
        inline: true,
    }));
}

// El resumen de lo que de verdad decide si le llegan los Robux hoy: de las
// comunidades ENCENDIDAS por el owner, en cuáles puede recibir.
function buildEnvio(comunidades, emojis = {}) {
    const activas = comunidades.filter(c => groupActive.isActive(c.clave));

    if (!activas.length) {
        return {
            name: 'Envío de Robux',
            value: `${EMOJI.down} Ahora mismo no hay ninguna comunidad enviando. Tu pedido se entregará en cuanto se restablezca alguna.`,
            inline: false,
        };
    }

    const lineas = activas.map(c => `${EMOJI.working} ${emojis[c.clave] ?? EMOJI.generico} **${c.label}** — ${resumenEnvio(c)}`);

    // Si está enviando por varias pero no puede recibir en ninguna, el aviso es
    // lo único que evita que el cliente pague y luego se quede esperando.
    if (!activas.some(c => c.estado === 'elegible')) {
        lineas.push(
            '',
            `${EMOJI.alert} Aún no puedes recibir desde ninguna comunidad activa. Únete y espera los **${config.MIN_GROUP_DAYS} días** que exige Roblox.`
        );
    }

    return { name: 'Envío de Robux', value: lineas.join('\n').slice(0, 1024), inline: false };
}

// ── Lo que consume el ticket ─────────────────────────────────────────────────
// Devuelve los fields ya montados y el avatar de Roblox del comprador. Nunca
// lanza: si todo falla, `fields` sale vacío y el resumen se envía sin esta
// parte, igual que antes de que existiera.
async function buildCommunitySummary(client, username) {
    try {
        const [comunidades, emojis] = await Promise.all([
            resolverComunidades(username),
            groupEmojis.ensureGroupEmojis(client).catch(() => ({})),
        ]);

        // El id de Roblox sale de cualquiera de las consultas que funcionara:
        // es el mismo usuario en todas.
        const robloxUserId = comunidades.find(c => c.robloxUserId)?.robloxUserId ?? null;
        const avatarURL = robloxUserId ? await groupMembership.getPlayerAvatar(robloxUserId) : null;

        return {
            fields: [...buildFields(comunidades, emojis), buildEnvio(comunidades, emojis)],
            avatarURL,
            comunidades,
        };
    } catch (err) {
        console.error('[communityStatus] Fallo inesperado montando el resumen:', err);
        return { fields: [], avatarURL: null, comunidades: [] };
    }
}

module.exports = {
    buildCommunitySummary,
    __test: { resolverComunidades, buildFields, buildEnvio, textoDias, marca, resumenEnvio, EMOJI, NOMBRE_VACIO },
};
