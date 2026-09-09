'use strict';

// Tests del panel de estado de entrega y del interruptor que lo mueve.
// Sin red y sin Discord.
//
// Lo que protegen:
//
//   1. SALEN TODAS LAS COMUNIDADES DE config, ni una menos. Una comunidad que
//      falte en este panel es una comunidad por la que un cliente no sabe si le
//      pueden enviar.
//   2. POR DEFECTO, APAGADA. Sólo un `true` explícito enciende una comunidad.
//      Dar por buena una entrega que nadie ha confirmado —porque el fichero se
//      perdió, se corrompió o la comunidad es nueva— manda clientes a un grupo
//      que quizá no está enviando.
//   3. EL ESTADO SOBREVIVE AL REINICIO. Si el owner enciende una comunidad y el
//      bot se reinicia solo de madrugada, tiene que seguir encendida: lo
//      contrario cambia lo que se le dice al cliente sin que nadie lo decida.
//   4. EL EMOJI DEL TÍTULO VA EN LA DESCRIPCIÓN. Discord NO renderiza emojis
//      del servidor en el título de un embed: ahí se imprime el texto crudo
//      `<a:active:1529…>`. En la descripción sí.
//   5. CON TODO APAGADO NO SE ENSEÑA UN PANEL VERDE. Un "se están enviando
//      desde estos grupos" en verde seguido de cinco cruces es lo contrario de
//      informar.
//   6. EL TIMESTAMP NO CUENTA PARA COMPARAR. Si contara, el panel se reeditaría
//      en cada arranque; dejándolo fuera, la hora que enseña es la del último
//      cambio de verdad.

const fs = require('fs');
const path = require('path');

const { createSuite } = require('./testHarness');
const config = require('../../config');
const { dataPath } = require('../../utils/dataDir');
const groupActive = require('../../utils/groupActive');
const { __test: panel } = require('../../groupStatus');

const ESTADO_FILE = dataPath('groupActive.json');
const claves = Object.keys(config.CHECK_GROUPS);

module.exports = async function run() {
    const { assert, finish } = createSuite('groupStatus');

    // Salvaguarda: run.js redirige DATA_DIR a un temporal. Este bloque escribe
    // estado, así que si corriera contra el ./data real dejaría el panel del
    // bot de esta máquina como lo dejara la última aserción.
    assert(
        !path.resolve(ESTADO_FILE).startsWith(path.resolve(__dirname, '..', '..', 'data')),
        'el estado de prueba va a un DATA_DIR temporal, nunca al ./data del proyecto'
    );
    if (fs.existsSync(ESTADO_FILE)) fs.unlinkSync(ESTADO_FILE);

    // ── 1. Por defecto, todas apagadas ───────────────────────────────────────
    let estado = groupActive.getState();
    assert(estado.length === claves.length, `salen las ${claves.length} comunidades de config (${estado.length})`);
    assert(estado.every(g => !g.activa), 'sin fichero de estado, ninguna se da por activa: el owner las enciende');
    assert(
        estado.map(g => g.clave).join(',') === claves.join(','),
        'y en el mismo orden que config, no en el que las guardó el fichero'
    );

    // Un fichero corrupto o con otra forma no puede encender nada.
    fs.writeFileSync(ESTADO_FILE, '{ esto no es json', 'utf8');
    assert(groupActive.getState().every(g => !g.activa), 'con el fichero corrupto siguen todas apagadas');
    fs.writeFileSync(ESTADO_FILE, JSON.stringify({ grupos: [1, 2, 3] }), 'utf8');
    assert(groupActive.getState().every(g => !g.activa), 'y con un formato inesperado, igual');
    fs.writeFileSync(ESTADO_FILE, JSON.stringify({ grupos: { [claves[0]]: 'sí' } }), 'utf8');
    assert(groupActive.isActive(claves[0]) === false, 'un valor que no es exactamente true tampoco enciende');
    fs.unlinkSync(ESTADO_FILE);

    // ── 2. Encender y apagar ─────────────────────────────────────────────────
    const primera = claves[0];

    const encendida = groupActive.setActive(primera, true, '123');
    assert(encendida.ok && encendida.changed, 'encender una comunidad la marca como activa');
    assert(groupActive.isActive(primera) === true, 'y queda guardado');
    assert(groupActive.setActive(primera, true, '123').changed === false, 'volver a encenderla avisa de que no cambió nada');
    assert(groupActive.getState().filter(g => g.activa).length === 1, 'y no arrastra a las demás');

    assert(groupActive.setActive('grupo-inventado', true).ok === false, 'una comunidad que no existe se rechaza');
    assert(groupActive.getState().length === claves.length, 'y no se cuela en el panel');

    // Sobrevive a un reinicio: se lee del fichero, no de memoria.
    delete require.cache[require.resolve('../../utils/groupActive')];
    const recargado = require('../../utils/groupActive');
    assert(recargado.isActive(primera) === true, 'tras un reinicio del bot, la comunidad sigue encendida');

    const apagada = groupActive.setActive(primera, false, '123');
    assert(apagada.ok && apagada.changed && groupActive.isActive(primera) === false, 'y se puede volver a apagar');

    // ── 3. El panel ──────────────────────────────────────────────────────────
    // Con algo encendido, para poder comprobar el caso normal.
    for (const clave of claves) groupActive.setActive(clave, true, '123');
    estado = groupActive.getState();
    const embed = panel.buildEmbed(estado).toJSON();

    assert(embed.color === panel.VERDE, 'con alguna comunidad activa, el embed es verde');
    assert(!embed.title, 'no se usa setTitle()...');
    assert(
        embed.description.startsWith(`## ${panel.E.activo} ${panel.TITULO}`),
        '...el título va en la descripción, que es donde Discord SÍ pinta los emojis del servidor'
    );
    assert(embed.footer?.text === '7x Community • Estado de entrega', 'lleva su pie');
    assert(Boolean(embed.timestamp), 'y la hora del último cambio');

    for (const g of estado) {
        assert(embed.description.includes(`**${g.label}**`), `sale la comunidad ${g.label}`);
    }

    // El emoji correcto junto a cada una.
    const conUnaCaida = groupActive.getState().map((g, i) => ({ ...g, activa: i !== 1 }));
    const desc = panel.buildDescripcion(conUnaCaida);
    for (const g of conUnaCaida) {
        const linea = desc.split('\n').find(l => l.includes(`**${g.label}**`));
        assert(
            linea.startsWith(g.activa ? panel.E.working : panel.E.down),
            `${g.label} lleva el emoji de ${g.activa ? 'activa' : 'caída'}`
        );
    }

    // ── 4. Con todo apagado, ni verde ni silencio ────────────────────────────
    // Es además el estado con el que arranca el panel el primer día, antes de
    // que el owner encienda ninguna.
    const todasCaidas = groupActive.getState().map(g => ({ ...g, activa: false }));
    const apagado = panel.buildEmbed(todasCaidas).toJSON();
    assert(apagado.color === panel.ROJO, 'sin ninguna activa, el panel deja de ser verde');
    assert(
        apagado.description.includes('Ninguna comunidad está enviando Robux ahora mismo'),
        'y lo dice con todas las letras, en vez de dejar cinco cruces sin explicación'
    );
    for (const g of todasCaidas) {
        assert(apagado.description.includes(`${panel.E.down} **${g.label}**`), `${g.label} sale igual, marcada como caída`);
    }

    // ── 5. Comparación sin timestamp ─────────────────────────────────────────
    // Si el timestamp contara, el panel se reeditaría en cada arranque.
    const publicado = { embeds: [panel.buildEmbed(estado).toJSON()] };
    assert(panel.estaAlDia(publicado, panel.buildEmbed(estado)), 'un panel sin cambios no se reedita, aunque la hora sea otra');
    assert(!panel.estaAlDia(publicado, panel.buildEmbed(todasCaidas)), 'y uno con otro estado sí');
    assert(!panel.estaAlDia({ embeds: [] }, panel.buildEmbed(estado)), 'un mensaje sin embed no se da por bueno');

    // ── 6. Se reconoce el panel para reeditarlo, no duplicarlo ───────────────
    const mio = { author: { id: 'bot' }, embeds: [panel.buildEmbed(estado).toJSON()] };
    assert(panel.isStatusMsg(mio, 'bot'), 'el bot reconoce su propio panel');
    assert(!panel.isStatusMsg(mio, 'otro-bot'), 'y no confunde el de otro bot con el suyo');
    assert(
        !panel.isStatusMsg({ author: { id: 'bot' }, embeds: [{ description: 'hola' }] }, 'bot'),
        'ni un embed cualquiera suyo con el panel'
    );

    // ── 7. El comando ofrece exactamente las comunidades de config ───────────
    const fuenteMain = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
    assert(fuenteMain.includes("name: 'groupactive'"), 'el comando /groupactive está registrado');
    assert(
        /choices:\s*Object\.entries\(config\.CHECK_GROUPS\)/.test(fuenteMain),
        'y sus opciones se derivan de config.CHECK_GROUPS, no están escritas a mano'
    );

    if (fs.existsSync(ESTADO_FILE)) fs.unlinkSync(ESTADO_FILE);
    return finish();
};
