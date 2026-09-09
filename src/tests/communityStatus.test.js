'use strict';

// Tests del resumen de comunidades que sale en el ticket de Robux.
// Sin red: las consultas a Roblox van simuladas.
//
// Lo que protegen:
//
//   1. ESTO NO PUEDE IMPEDIR QUE SE ABRA UN TICKET. Es lo único de verdad
//      importante: un cliente que no puede comprar porque Roblox tardó en
//      contestar es mucho peor que un resumen incompleto. Todo va con
//      allSettled y cualquier fallo se degrada a "no se pudo comprobar".
//   2. UN FALLO NO ES UN "NO ELEGIBLE". Si la consulta de una comunidad falla,
//      se dice que no se pudo comprobar; decir "no eres elegible" le negaría a
//      un cliente algo que sí tenía, y en pantalla se vería igual que un no
//      legítimo.
//   3. SALEN LAS CINCO COMUNIDADES, en línea, para que Discord las ponga en
//      filas de tres.
//   4. EL ICONO Y EL NOMBRE VAN EN EL VALUE DEL FIELD, nunca en su nombre:
//      Discord no renderiza los emojis del servidor en el nombre de un field.
//   5. EL CAMPO DE ENVÍO SÓLO LISTA LAS COMUNIDADES ENCENDIDAS por el owner, y
//      avisa cuando el cliente no puede recibir por ninguna de ellas — que es
//      lo que evita que pague y se quede esperando.

const fs = require('fs');
const path = require('path');

const { createSuite } = require('./testHarness');
const config = require('../../config');
const { dataPath } = require('../../utils/dataDir');
const groupActive = require('../../utils/groupActive');
const groupEmojis = require('../../utils/groupEmojis');
const groupMembership = require('../../utils/groupMembership');
const { buildCommunitySummary, __test } = require('../../utils/communityStatus');

const claves = Object.keys(config.CHECK_GROUPS);
const ESTADO_FILE = dataPath('groupActive.json');
const USERNAME = 'Anii_soff';

// Un doble de checkMembership: `dias` por comunidad. null = no pertenece,
// 'error' = la consulta falla.
function simularRoblox(dias) {
    groupMembership.checkMembership = async (clave, username) => {
        const d = dias[clave];
        if (d === 'error') throw new groupMembership.GroupCheckError('rate_limited', 'Roblox limitando');
        const base = { groupKey: clave, groupLabel: config.CHECK_GROUPS[clave].label, robloxUserId: 55, robloxUsername: username };
        if (d === null || d === undefined) return { ...base, isMember: false, days: null, eligible: false };
        return { ...base, isMember: true, days: d, eligible: d >= config.MIN_GROUP_DAYS };
    };
}

const emojisFalsos = Object.fromEntries(claves.map(k => [k, `<:cg_${k}:1546000000000000001>`]));

module.exports = async function run() {
    const { assert, finish } = createSuite('communityStatus');

    const originalCheck  = groupMembership.checkMembership;
    const originalAvatar = groupMembership.getPlayerAvatar;
    const originalEmojis = groupEmojis.ensureGroupEmojis;

    try {
        assert(
            !path.resolve(ESTADO_FILE).startsWith(path.resolve(__dirname, '..', '..', 'data')),
            'el estado de prueba va a un DATA_DIR temporal, nunca al ./data del proyecto'
        );
        if (fs.existsSync(ESTADO_FILE)) fs.unlinkSync(ESTADO_FILE);

        groupMembership.getPlayerAvatar = async () => 'https://tr.rbxcdn.com/avatar/150/150/';
        groupEmojis.ensureGroupEmojis = async () => emojisFalsos;

        // Un caso con las cuatro situaciones posibles a la vez.
        const MIN = config.MIN_GROUP_DAYS;
        simularRoblox({
            [claves[0]]: 198,        // elegible de sobra
            [claves[1]]: 3,          // miembro, pero le faltan días
            [claves[2]]: MIN,        // justo en el mínimo: elegible
            [claves[3]]: null,       // no pertenece
            [claves[4]]: 'error',    // la consulta falla
        });

        // ── 1. Los fields ────────────────────────────────────────────────────
        const r = await buildCommunitySummary({}, USERNAME);
        const enLinea = r.fields.filter(f => f.inline);

        assert(enLinea.length === claves.length, `sale una tarjeta por comunidad (${enLinea.length} de ${claves.length})`);
        assert(enLinea.every(f => f.inline === true), 'todas en línea, para que Discord las ponga en filas de tres');
        assert(
            enLinea.every(f => f.name === __test.NOMBRE_VACIO),
            'el nombre del field va vacío: Discord no pinta los emojis del servidor ahí'
        );
        for (const clave of claves) {
            const f = enLinea.find(x => x.value.includes(config.CHECK_GROUPS[clave].label));
            assert(Boolean(f), `sale la comunidad ${clave}`);
            assert(f.value.startsWith(emojisFalsos[clave]), `y su icono abre la tarjeta (${clave})`);
        }

        // ── 2. Cada estado con su marca ──────────────────────────────────────
        const valorDe = clave => enLinea.find(f => f.value.includes(config.CHECK_GROUPS[clave].label)).value;

        assert(valorDe(claves[0]).includes(`${__test.EMOJI.si} 198 días · elegible`), 'un veterano sale como elegible con sus días');
        assert(valorDe(claves[1]).includes(`${__test.EMOJI.no} 3 días · faltan ${MIN - 3}`), 'a quien le faltan días se le dice cuántos');
        assert(valorDe(claves[2]).includes(__test.EMOJI.si), `justo en los ${MIN} días ya es elegible`);
        assert(valorDe(claves[3]).includes(`${__test.EMOJI.no} No perteneces`), 'a quien no pertenece se le dice eso, no un número');

        // El caso que más importa: un fallo NO es un "no elegible".
        assert(valorDe(claves[4]).includes(`${__test.EMOJI.alert} No se pudo comprobar`), 'una consulta fallida dice que no se pudo comprobar');
        assert(!valorDe(claves[4]).includes(__test.EMOJI.no), 'y NO se marca como no elegible');

        // ── 3. El avatar de Roblox ───────────────────────────────────────────
        assert(r.avatarURL === 'https://tr.rbxcdn.com/avatar/150/150/', 'se devuelve el avatar de la cuenta de Roblox para la línea de autor');

        // ── 4. El campo de envío: sólo las encendidas ────────────────────────
        let envio = r.fields.find(f => !f.inline);
        assert(envio.name === 'Envío de Robux', 'hay un campo de envío');
        assert(
            envio.value.includes('no hay ninguna comunidad enviando'),
            'sin ninguna encendida, se dice claramente en vez de dejar el campo vacío'
        );

        groupActive.setActive(claves[0], true, 'owner');   // elegible
        groupActive.setActive(claves[1], true, 'owner');   // le faltan días
        envio = (await buildCommunitySummary({}, USERNAME)).fields.find(f => !f.inline);

        assert(envio.value.includes(config.CHECK_GROUPS[claves[0]].label), 'una comunidad encendida sale en el envío');
        assert(!envio.value.includes(config.CHECK_GROUPS[claves[2]].label), 'y una apagada NO sale, aunque sea elegible en ella');
        assert(envio.value.includes(__test.EMOJI.working), 'con el emoji de que está enviando');
        assert(envio.value.includes(`${__test.EMOJI.si} puedes recibir aquí`), 'y se le dice dónde SÍ puede recibir');
        assert(envio.value.includes(`${__test.EMOJI.no} te faltan`), 'y dónde todavía no');
        assert(envio.value.length <= 1024, 'el campo respeta el límite de Discord');

        // Si está enviando pero el cliente no puede recibir por ninguna, hay
        // que avisarlo: es lo que evita que pague y se quede esperando.
        groupActive.setActive(claves[0], false, 'owner');
        const soloSinElegibles = (await buildCommunitySummary({}, USERNAME)).fields.find(f => !f.inline);
        assert(
            soloSinElegibles.value.includes('Aún no puedes recibir desde ninguna comunidad activa'),
            'si no puede recibir por ninguna de las activas, se le avisa'
        );

        // ── 5. Nada de esto puede tumbar el ticket ───────────────────────────
        simularRoblox(Object.fromEntries(claves.map(k => [k, 'error'])));
        const todoRoto = await buildCommunitySummary({}, USERNAME);
        assert(todoRoto.fields.length === claves.length + 1, 'con Roblox caído se siguen montando los campos');
        assert(
            todoRoto.fields.filter(f => f.inline).every(f => f.value.includes('No se pudo comprobar')),
            'y todas dicen que no se pudo comprobar'
        );
        assert(todoRoto.avatarURL === null, 'sin ninguna consulta buena, no hay avatar y no se inventa uno');

        // Un fallo que no es un GroupCheckError tampoco escapa.
        groupMembership.checkMembership = async () => { throw new Error('ECONNRESET'); };
        const reventado = await buildCommunitySummary({}, USERNAME);
        assert(reventado.fields.length === claves.length + 1, 'un error inesperado tampoco lanza');

        // Ni siquiera si falla el propio resolvedor de emojis.
        groupEmojis.ensureGroupEmojis = async () => { throw new Error('401'); };
        const sinEmojis = await buildCommunitySummary({}, USERNAME);
        assert(sinEmojis.fields.length === claves.length + 1, 'ni que fallen los iconos');
        assert(
            sinEmojis.fields[0].value.startsWith(__test.EMOJI.generico),
            'sin iconos propios se cae al genérico, pero la comunidad sale igual'
        );
    } finally {
        groupMembership.checkMembership  = originalCheck;
        groupMembership.getPlayerAvatar  = originalAvatar;
        groupEmojis.ensureGroupEmojis    = originalEmojis;
        if (fs.existsSync(ESTADO_FILE)) fs.unlinkSync(ESTADO_FILE);
    }

    return finish();
};
