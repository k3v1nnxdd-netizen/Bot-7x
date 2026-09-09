'use strict';

const crypto = require('crypto');
const roblox = require('../src/roblox/client');
const cache = require('../src/cache/memoryCache');
const config = require('../config');

// ── El icono de cada comunidad, como emoji ────────────────────────────────────
//
// POR QUÉ ESTO EXISTE, que si no parece un rodeo enorme para poner una foto:
// en Components V2 la imagen de una Section es su `accessory`, y el accessory
// SIEMPRE se pinta a la derecha del texto. No hay opción de alinearlo a la
// izquierda; no es que no la usemos, es que la API no la tiene.
//
// La única imagen que Discord pinta a la IZQUIERDA de un texto es un emoji. Así
// que para que el panel se lea "icono de la comunidad, y a su derecha el
// nombre", el icono tiene que ser un emoji. Y para que sea el icono REAL de la
// comunidad —no un dibujito genérico— hay que subirlo como emoji de la
// aplicación, que es lo que hace este módulo.
//
// Emojis de APLICACIÓN, no de servidor: pertenecen al bot, no gastan los 50
// huecos del servidor, funcionan en cualquier servidor donde esté el bot y no
// necesitan permisos de gestión de emojis.
//
// CONTRATO: esto es decoración. Nada de aquí lanza nunca. Si Roblox no da el
// icono, si Discord rechaza la subida o si la app ya no admite más emojis, se
// devuelve lo que se haya podido resolver y los paneles caen a su emoji
// genérico. Un panel sin iconos es peor que uno con ellos; un panel que no se
// publica porque una foto falló es MUCHO peor.

// 150x150 y no 420x420 a propósito: un emoji no puede pasar de 256 KB y el
// icono de 7x UGC en 420 pesa 218, demasiado cerca del techo. En 150 el mayor
// baja a 37 KB, y Discord pinta los emojis a ~48 px de todos modos.
const TAMANO_ICONO = '150x150';

// El nombre del emoji lleva un hash del icono, así que si el dueño de la
// comunidad cambia la foto, el nombre deseado cambia, no se encuentra el emoji
// y se sube el nuevo (borrando el viejo). Sin el hash no habría forma de
// enterarse de que la imagen ya no es la misma.
//
// Discord: 2-32 caracteres, letras, números y guion bajo. `cg_` + clave + `_` +
// 8 del hash cabe de sobra con las claves actuales, y la clave se recorta por
// si alguna vez se añade una muy larga.
const PREFIJO = 'cg';
const HASH_LEN = 8;
const CLAVE_MAX = 32 - PREFIJO.length - 1 - 1 - HASH_LEN;

function nombreEmoji(clave, iconUrl) {
    const hash = crypto.createHash('sha1').update(iconUrl).digest('hex').slice(0, HASH_LEN);
    const limpia = clave.replace(/[^A-Za-z0-9_]/g, '').slice(0, CLAVE_MAX);
    return `${PREFIJO}_${limpia}_${hash}`;
}

// Un emoji "de esta comunidad", sea cual sea su hash. Sirve para reconocer el
// que sobra cuando el icono ha cambiado.
function esDeLaComunidad(nombre, clave) {
    const limpia = clave.replace(/[^A-Za-z0-9_]/g, '').slice(0, CLAVE_MAX);
    return typeof nombre === 'string' && nombre.startsWith(`${PREFIJO}_${limpia}_`);
}

// El icono en tamaño de emoji. Cacheado 12 h igual que el grande — es la misma
// imagen, sólo que en otra resolución, y cambia igual de poco.
const ICONO_TTL_MS = 12 * 60 * 60_000;
const ICONO_FALTA_TTL_MS = 30 * 60_000;

async function iconoPequeno(groupId) {
    const key = `cg:icon150:${groupId}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    let url = null;
    try {
        url = await roblox.getGroupIcon(groupId, TAMANO_ICONO);
    } catch (err) {
        console.warn(`[groupEmojis] No se pudo obtener el icono ${TAMANO_ICONO} del grupo ${groupId}: ${err?.message ?? err}`);
        url = null;
    }

    cache.set(key, url, url ? ICONO_TTL_MS : ICONO_FALTA_TTL_MS);
    return url;
}

// El resultado se guarda aquí para toda la vida del proceso: los dos paneles
// (Check Group's y el de comunidades) lo piden al arrancar, y el segundo no
// tiene por qué volver a hablar ni con Roblox ni con Discord.
let resueltos = null;

async function listarEmojisApp(client) {
    try {
        const col = await client.application.emojis.fetch();
        return [...col.values()];
    } catch (err) {
        console.warn('[groupEmojis] No se pudieron listar los emojis de la aplicación:', err?.message ?? err);
        return null;
    }
}

// Devuelve { clave: '<:cg_noctra_ab12cd34:123…>' } sólo con las comunidades
// cuyo emoji se pudo resolver. Una comunidad ausente del mapa no es un error:
// el panel usa su emoji genérico y sigue.
async function ensureGroupEmojis(client, { refrescar = false } = {}) {
    if (resueltos && !refrescar) return resueltos;

    const mapa = {};
    const existentes = await listarEmojisApp(client);
    if (existentes === null) return (resueltos = mapa);

    for (const [clave, grupo] of Object.entries(config.CHECK_GROUPS)) {
        if (!grupo.groupId) continue;

        const iconUrl = await iconoPequeno(grupo.groupId);
        if (!iconUrl) {
            console.warn(`[groupEmojis] Roblox no dio icono para ${grupo.label}: irá con el emoji genérico.`);
            continue;
        }

        const deseado = nombreEmoji(clave, iconUrl);
        const yaEsta = existentes.find(e => e.name === deseado);
        if (yaEsta) {
            mapa[clave] = yaEsta.toString();
            continue;
        }

        // No está: o es la primera vez, o el icono cambió.
        let creado;
        try {
            creado = await client.application.emojis.create({ attachment: iconUrl, name: deseado });
        } catch (err) {
            console.warn(`[groupEmojis] No se pudo subir el emoji de ${grupo.label}: ${err?.message ?? err}`);
            continue;
        }

        mapa[clave] = creado.toString();
        existentes.push(creado);
        console.log(`[groupEmojis] Emoji subido para ${grupo.label} (${deseado}).`);

        // El anterior de esta MISMA comunidad ya no sirve. Se borra sólo ese —
        // nunca un emoji que no lleve el prefijo de esta comunidad, para no
        // tocar nada más de la aplicación.
        for (const viejo of existentes.filter(e => e.name !== deseado && esDeLaComunidad(e.name, clave))) {
            try {
                await client.application.emojis.delete(viejo.id);
                console.log(`[groupEmojis] Emoji viejo de ${grupo.label} borrado (${viejo.name}).`);
            } catch (err) {
                console.warn(`[groupEmojis] No se pudo borrar el emoji viejo ${viejo.name}: ${err?.message ?? err}`);
            }
        }
    }

    resueltos = mapa;
    return mapa;
}

// Sólo para los tests: olvida lo resuelto en este proceso.
function __reset() {
    resueltos = null;
}

// ¿Este texto ya publicado lleva iconos de comunidad de verdad? Los paneles lo
// usan para no reeditarse a peor: si ahora mismo no se pudo resolver algún
// emoji pero el mensaje publicado sí lo tiene, es mejor dejarlo como está.
const MENCION_ICONO = new RegExp(`<a?:${PREFIJO}_[A-Za-z0-9_]+:\\d+>`);

function mencionaIconos(texto) {
    return MENCION_ICONO.test(String(texto ?? ''));
}

module.exports = {
    ensureGroupEmojis,
    mencionaIconos,
    __test: { nombreEmoji, esDeLaComunidad, iconoPequeno, TAMANO_ICONO, __reset },
};
