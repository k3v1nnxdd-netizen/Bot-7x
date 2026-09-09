'use strict';

// Tests del icono de cada comunidad convertido en emoji de la aplicación.
// Sin red y sin Discord: el cliente va simulado.
//
// Por qué esto tiene tests propios, siendo "una foto": es el único código del
// bot que CREA Y BORRA cosas en la aplicación de Discord. Lo que se protege:
//
//   1. NO SE RESUBE EN CADA ARRANQUE. El emoji se busca por nombre y se
//      reutiliza. Sin esto, cada reinicio dejaría un emoji nuevo y en unas
//      semanas la app llegaría a su tope de 2000.
//   2. SI EL ICONO CAMBIA, SE SUSTITUYE. El nombre lleva el hash del icono, así
//      que un cambio de foto en Roblox se nota; si no, el panel enseñaría para
//      siempre el logo viejo de una comunidad.
//   3. AL SUSTITUIR SÓLO SE BORRA EL DE ESA COMUNIDAD. Borrar de más significa
//      cargarse emojis de la aplicación que no son nuestros.
//   4. NADA DE ESTO LANZA NUNCA. Es decoración: si Roblox no da el icono o
//      Discord rechaza la subida, el panel sale con el emoji genérico. Un panel
//      sin fotos es peor; un panel que no se publica porque una foto falló es
//      MUCHO peor.

const { createSuite } = require('./testHarness');
const config = require('../../config');
const roblox = require('../roblox/client');
const cache = require('../cache/memoryCache');
const { ensureGroupEmojis, mencionaIconos, __test } = require('../../utils/groupEmojis');

const claves = Object.keys(config.CHECK_GROUPS);

// Cada caso empieza limpio: sin lo resuelto en el proceso y sin iconos en caché
// (se guardan 12 h, así que sin esto el segundo caso vería los del primero).
function reiniciar() {
    __test.__reset();
    for (const clave of claves) cache.invalidate(`cg:icon150:${config.CHECK_GROUPS[clave].groupId}`);
}

// Cliente de Discord falso: sólo la parte de emojis de la aplicación.
function clienteFalso(emojisIniciales = []) {
    let n = 0;
    // Los ids son numéricos como los snowflakes de Discord: la mención que
    // reconocen los paneles (<:nombre:123>) exige dígitos.
    const emojis = emojisIniciales.map(name => ({ id: String(1000 + ++n), name, toString() { return `<:${this.name}:${this.id}>`; } }));

    const client = {
        creados: [], borrados: [], fallaFetch: false, fallaCreate: false,
        application: {
            emojis: {
                fetch: async () => {
                    if (client.fallaFetch) throw new Error('401 Unauthorized');
                    return new Map(emojis.map(e => [e.id, e]));
                },
                create: async ({ attachment, name }) => {
                    if (client.fallaCreate) throw new Error('50035: Invalid image');
                    const e = { id: String(1000 + ++n), name, attachment, toString() { return `<:${this.name}:${this.id}>`; } };
                    emojis.push(e);
                    client.creados.push({ name, attachment });
                    return e;
                },
                delete: async id => {
                    client.borrados.push(emojis.find(e => e.id === id)?.name ?? id);
                    const i = emojis.findIndex(e => e.id === id);
                    if (i >= 0) emojis.splice(i, 1);
                },
            },
        },
        vivos: () => emojis.map(e => e.name),
    };
    return client;
}

const iconoDe = (groupId, version = 'v1') => `https://tr.rbxcdn.com/${version}-${groupId}/150/150/`;

module.exports = async function run() {
    const { assert, finish } = createSuite('groupEmojis');

    const originalGetGroupIcon = roblox.getGroupIcon;

    try {
        // ── 1. Primera vez: se sube uno por comunidad ────────────────────────
        reiniciar();
        let tamanoPedido = null;
        roblox.getGroupIcon = async (groupId, size) => { tamanoPedido = size; return iconoDe(groupId); };

        const c1 = clienteFalso();
        const mapa1 = await ensureGroupEmojis(c1);

        assert(Object.keys(mapa1).length === claves.length, `se resuelve un emoji por comunidad (${Object.keys(mapa1).length} de ${claves.length})`);
        assert(c1.creados.length === claves.length, 'y se suben todos la primera vez');
        assert(tamanoPedido === __test.TAMANO_ICONO, `el icono se pide en ${__test.TAMANO_ICONO} (un emoji no puede pasar de 256 KB)`);
        assert(
            c1.creados.every(e => /^[A-Za-z0-9_]{2,32}$/.test(e.name)),
            'los nombres cumplen lo que exige Discord: 2-32 caracteres alfanuméricos'
        );
        assert(
            c1.creados.every(e => e.attachment.startsWith('https://tr.rbxcdn.com/')),
            'y la imagen sale de Roblox, no de un fichero del repo'
        );
        assert(
            claves.every(clave => mencionaIconos(mapa1[clave])),
            'lo devuelto son menciones de emoji que los paneles reconocen como icono propio'
        );

        // ── 2. Reinicio sin cambios: no se sube nada ─────────────────────────
        // Es LO importante de todo esto: sin ello, cada arranque dejaría cinco
        // emojis nuevos y la app llegaría a su tope de 2000.
        reiniciar();
        const c2 = clienteFalso(c1.vivos());
        const mapa2 = await ensureGroupEmojis(c2);

        assert(c2.creados.length === 0, 'un reinicio sin cambios no sube ningún emoji nuevo');
        assert(c2.borrados.length === 0, 'ni borra ninguno');
        assert(Object.keys(mapa2).length === claves.length, 'y las comunidades siguen teniendo su icono');

        // Y dentro del mismo proceso, la segunda llamada no vuelve ni a mirar:
        // los dos paneles la piden al arrancar.
        const c2b = clienteFalso(c1.vivos());
        c2b.fallaFetch = true;   // si mirara, fallaría
        const mapa2b = await ensureGroupEmojis(c2b);
        assert(Object.keys(mapa2b).length === claves.length, 'el segundo panel reutiliza lo ya resuelto sin volver a preguntar');

        // ── 3. El icono cambia en Roblox: se sustituye ───────────────────────
        reiniciar();
        const cambiada = claves[0];
        roblox.getGroupIcon = async groupId =>
            iconoDe(groupId, groupId === config.CHECK_GROUPS[cambiada].groupId ? 'v2' : 'v1');

        // Un emoji ajeno, para comprobar que no se toca nada que no sea nuestro.
        const c3 = clienteFalso([...c1.vivos(), 'emoji_de_otra_cosa']);
        await ensureGroupEmojis(c3);

        assert(c3.creados.length === 1, 'sólo se resube la comunidad cuyo icono cambió');
        assert(c3.borrados.length === 1, 'y se borra exactamente un emoji viejo');
        assert(c3.borrados[0].startsWith(`cg_${cambiada}_`), `el borrado es el viejo de esa comunidad (${c3.borrados[0]})`);
        assert(c3.vivos().includes('emoji_de_otra_cosa'), 'un emoji ajeno de la aplicación no se toca');
        assert(
            claves.slice(1).every(clave => c3.vivos().some(n => n.startsWith(`cg_${clave}_`))),
            'y las demás comunidades conservan el suyo'
        );

        // ── 4. Roblox no da el icono ─────────────────────────────────────────
        reiniciar();
        roblox.getGroupIcon = async () => null;
        const c4 = clienteFalso();
        const mapa4 = await ensureGroupEmojis(c4);

        assert(Object.keys(mapa4).length === 0, 'sin icono de Roblox no se inventa ninguno');
        assert(c4.creados.length === 0, 'ni se sube nada');

        // ── 5. Roblox falla del todo, y Discord también ──────────────────────
        reiniciar();
        roblox.getGroupIcon = async () => { throw new Error('ECONNRESET'); };
        const c5 = clienteFalso();
        const mapa5 = await ensureGroupEmojis(c5);
        assert(Object.keys(mapa5).length === 0, 'un fallo de red de Roblox no lanza: devuelve el mapa vacío');

        reiniciar();
        roblox.getGroupIcon = async groupId => iconoDe(groupId);
        const c6 = clienteFalso();
        c6.fallaCreate = true;
        const mapa6 = await ensureGroupEmojis(c6);
        assert(Object.keys(mapa6).length === 0, 'si Discord rechaza la subida, tampoco lanza');

        reiniciar();
        const c7 = clienteFalso();
        c7.fallaFetch = true;
        const mapa7 = await ensureGroupEmojis(c7);
        assert(Object.keys(mapa7).length === 0, 'y si ni siquiera se pueden listar los emojis, tampoco');

        // ── 6. mencionaIconos distingue el icono propio del genérico ─────────
        assert(!mencionaIconos('<:followers7x:1525326777071960124> **7x UGC**'), 'el emoji genérico no cuenta como icono propio');
        assert(mencionaIconos('<:cg_ugc_ab12cd34:123> **7x UGC**'), 'y el de una comunidad sí');
        assert(!mencionaIconos(''), 'un texto vacío no tiene iconos');

        // ── 7. El nombre depende del icono, no del momento ───────────────────
        const a = __test.nombreEmoji('ugc', iconoDe(1, 'v1'));
        const b = __test.nombreEmoji('ugc', iconoDe(1, 'v1'));
        const c = __test.nombreEmoji('ugc', iconoDe(1, 'v2'));
        assert(a === b, 'el mismo icono da siempre el mismo nombre (por eso se reutiliza)');
        assert(a !== c, 'y un icono distinto da otro nombre (por eso se sustituye)');
        assert(__test.esDeLaComunidad(a, 'ugc') && !__test.esDeLaComunidad(a, 'noctra'), 'un nombre pertenece a una sola comunidad');

        // Una clave larguísima no puede pasarse de los 32 caracteres de Discord.
        const largo = __test.nombreEmoji('comunidad_con_un_nombre_larguisimo', iconoDe(1));
        assert(largo.length <= 32, `una clave larga se recorta para caber en 32 caracteres (${largo.length})`);
        assert(/^[A-Za-z0-9_]+$/.test(largo), 'y sigue siendo un nombre válido');
    } finally {
        roblox.getGroupIcon = originalGetGroupIcon;
        __test.__reset();
        for (const clave of claves) cache.invalidate(`cg:icon150:${config.CHECK_GROUPS[clave].groupId}`);
    }

    return finish();
};
