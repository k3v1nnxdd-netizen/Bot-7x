'use strict';

// El panel de gamepasses y objetos de juegos: su texto, el GIF y el botón que
// lleva al canal de tickets.

const { MessageFlags, ButtonStyle } = require('discord.js');
const { createSuite } = require('./testHarness');
const config = require('../../config');
const { __test: p } = require('../../gamepassJuegos');

module.exports = async function run() {
    const { assert, finish } = createSuite('gamepassJuegos');

    const texto = p.buildTexto();
    assert(/gamepasses de cualquier juego/i.test(texto) && /regalar/i.test(texto), 'dice que vende gamepasses de juegos que se puedan regalar');
    assert(/tradear/i.test(texto) && /armas/i.test(texto), 'y objetos/armas de juegos con trading');
    assert(/Entrega rápida/.test(texto), 'con entrega rápida');
    assert(texto.length < 4000, 'cabe en un bloque de texto');

    assert(config.CHANNELS.GAMEPASS_JUEGOS === '1562045353669427260', 'se publica en el canal pedido');
    assert(p.BANNER.exists, 'el GIF está en el repo');

    const json = p.buildContainer().toJSON();
    const boton = p.buildRow().toJSON().components[0];
    assert(boton.style === ButtonStyle.Link && boton.url === `https://discord.com/channels/${config.GUILD_ID}/1442456304420524146`,
        'el botón lleva al canal de tickets');
    assert(JSON.stringify(json).includes(`attachment://${p.BANNER.name}`), 'el GIF va dentro del bloque');
    assert(p.buildPayload().flags === MessageFlags.IsComponentsV2, 'es un mensaje de Components V2');

    const msg = { author: { id: 'bot' }, components: [{ toJSON: () => json }], embeds: [] };
    assert(p.isPanelMsg({ ...msg, components: [json] }, 'bot'), 'se reconoce su propio panel (para no duplicarlo)');
    assert(!p.isPanelMsg({ ...msg, author: { id: 'otro' } }, 'bot'), 'pero no el de otro');

    return finish();
};
