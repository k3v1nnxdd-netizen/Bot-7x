'use strict';

// Tests de las tarjetas: los mensajes que llevan sus botones DENTRO del bloque
// en vez de colgando debajo. Sin red y sin Discord.
//
// El motivo de este fichero no es la tarjeta en sí, que es cuatro líneas de
// builders. Es lo que se rompía al pasar un mensaje de embed a tarjeta:
//
//   1. UN MENSAJE V2 NO TIENE `embeds`. El resumen del ticket es el único sitio
//      donde existen los Robux y el precio de una compra —no se guardan en
//      ningún lado—, y utils/orderNotify.js y utils/reviewFlow.js los leen de
//      ahí para el registro de pedidos y el RANKING DE COMPRADORES. Leyéndolo
//      como antes (`embeds[0].description`), la tarjeta nueva devuelve vacío: se
//      dejarían de contar compras sin que nada fallara ni avisara.
//   2. LOS TICKETS YA ABIERTOS SIGUEN SIENDO EMBEDS. El cambio de formato no
//      reescribe lo ya enviado, así que los dos formatos tienen que leerse
//      igual — hoy y mientras quede un ticket viejo abierto.
//   3. AL DESHABILITAR EL BOTÓN DE RESEÑA HAY QUE MANDAR LA TARJETA ENTERA. En
//      un mensaje V2, editar sólo `components` con la fila borraría el texto.

const fs = require('fs');
const path = require('path');

const { MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { createSuite } = require('./testHarness');
const v2 = require('../../utils/panelV2');
const reviewFlow = require('../../utils/reviewFlow');

const RAIZ = path.join(__dirname, '..', '..');

function nodos(json) {
    const out = [];
    (function rec(n) {
        if (Array.isArray(n)) return n.forEach(rec);
        if (!n || typeof n !== 'object') return;
        out.push(n);
        rec(n.components);
        rec(n.accessory);
    })(json);
    return out;
}

const fila = (id = 'boton_x') => new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(id).setLabel('Pulsa').setStyle(ButtonStyle.Secondary)
);

// Las MISMAS expresiones con las que orderNotify y reviewFlow sacan los datos.
const RE = {
    usuario: /Usuario de Roblox\*\*\n```([^`]+)```/,
    robux:   /Robux a recibir\*\*\n```([^`]+)```/,
    precio:  /Precio a pagar\*\*\n```\$([^`]+) MXN```/,
};

const RESUMEN =
    '<:member:1> **Usuario de Roblox**\n```Anii_soff```\n' +
    '<a:robuxxx:2> **Robux a recibir**\n```3,200 Robux```\n' +
    '<:money:3> **Precio a pagar**\n```$376 MXN```';

module.exports = async function run() {
    const { assert, finish } = createSuite('tarjetas');

    // ── 1. La tarjeta mete los botones dentro ────────────────────────────────
    const conBoton = v2.tarjeta({
        color: 0x2B2D31,
        texto: '## Título\n\nCuerpo',
        pie: 'Un pie',
        filas: [fila('cerrar_ticket')],
    }).toJSON();
    const piezas = nodos([conBoton]);

    assert(conBoton.type === 17, 'la tarjeta es un Container');
    assert(conBoton.accent_color === 0x2B2D31, 'con su barra de color');
    assert(
        piezas.some(n => n.type === 2 && n.custom_id === 'cerrar_ticket'),
        'y el botón va DENTRO: es justo lo que un embed no permite'
    );

    const textos = piezas.filter(n => n.type === 10).map(n => n.content);
    assert(textos[0].startsWith('## Título'), 'el título va como encabezado del texto');
    assert(textos.some(t => t === '-# Un pie'), 'y el pie como subtexto');

    // Sin botones no se añade una fila vacía, que Discord rechazaría.
    const sinBotones = nodos([v2.tarjeta({ color: 1, texto: 'hola' }).toJSON()]);
    assert(!sinBotones.some(n => n.type === 1), 'sin filas no se crea ninguna fila vacía');
    assert(!sinBotones.some(n => n.type === 10 && n.content.startsWith('-#')), 'y sin pie, tampoco hay subtexto');

    // Miniatura e imagen.
    const conImagenes = nodos([v2.tarjeta({
        color: 1, texto: 'hola', thumbnail: 'https://x/t.png', imagen: 'attachment://i.gif',
    }).toJSON()]);
    assert(conImagenes.some(n => n.type === 11 && n.media.url === 'https://x/t.png'), 'la miniatura va a la derecha del texto');
    assert(conImagenes.some(n => n.type === 12), 'y la imagen grande, debajo');

    const payload = v2.tarjetaPayload({ color: 1, texto: 'hola' }, [{ attachment: './x.gif', name: 'x.gif' }]);
    assert(payload.flags === MessageFlags.IsComponentsV2, 'el payload lleva el flag de Components V2');
    assert(!payload.embeds, 'y ningún embed: un mensaje V2 no los admite');
    assert(payload.files.length === 1, 'los adjuntos se pasan tal cual');

    // ── 1b. Un mensaje V2 NO puede llevar `content` ni `embeds` ──────────────
    //
    // Discord lo rechaza de plano:
    //   MESSAGE_CANNOT_USE_LEGACY_FIELDS_WITH_COMPONENTS_V2
    //
    // Y eso llegó a producción: el resumen del ticket mandaba la mención del
    // comprador en `content` junto a la tarjeta, Discord devolvía 400 y el canal
    // del ticket se quedaba CREADO PERO VACÍO, con un "Error al crear el ticket"
    // para el cliente. Nada en el código lo delataba: se ve al enviarlo.
    //
    // Por eso la mención se pasa por `mencion` y acaba dentro del texto — donde
    // notifica igual — y por eso esto se comprueba en dos niveles: el payload
    // que se construye, y el código que lo envía.
    const conMencion = v2.tarjetaPayload({ color: 1, texto: 'Hola', mencion: '<@123>' });
    assert(!('content' in conMencion), 'el payload de una tarjeta NUNCA lleva content');
    assert(!('embeds' in conMencion), 'ni embeds');
    assert(
        nodos(conMencion.components.map(c => c.toJSON()))
            .some(n => n.type === 10 && n.content.startsWith('<@123>\n')),
        'la mención va dentro del texto, que es donde sí puede ir (y sigue notificando)'
    );
    assert(
        nodos(v2.tarjetaPayload({ color: 1, texto: 'Hola' }).components.map(c => c.toJSON()))
            .some(n => n.type === 10 && n.content === 'Hola'),
        'y sin mención el texto sale limpio, sin un salto de línea suelto delante'
    );

    // El otro nivel: que nadie vuelva a juntar `content` con una tarjeta al
    // enviarla. Se busca en el código, que es donde se cometió el error.
    const FUENTES = ['handlers/modals.js', 'handlers/headlessFlow.js', 'handlers/buttons.js', 'handlers/commands.js', 'metodos.js'];
    for (const fichero of FUENTES) {
        const src = fs.readFileSync(path.join(RAIZ, fichero), 'utf8').replace(/\r\n/g, '\n');

        // `content:` seguido, dentro del mismo objeto, de una tarjeta o del flag.
        const juntos = /content:[^\n]*\n(?:[^\n]*\n){0,3}?[^\n]*(?:tarjetaPayload|IsComponentsV2)/.test(src);
        assert(!juntos, `${fichero} no manda content junto a un mensaje de Components V2`);
    }

    // ── 2. Los dos formatos del resumen se leen IGUAL ────────────────────────
    // Esto es lo que evita que el ranking de compradores deje de contar.
    const viejo = { content: '', embeds: [{ title: null, description: RESUMEN }], components: [] };
    const nuevo = {
        content: '',
        embeds: [],
        components: [v2.tarjeta({ color: 1, texto: `## Resumen de tu compra\n\n${RESUMEN}`, filas: [fila()] }).toJSON()],
    };

    for (const [etiqueta, msg] of [['un ticket viejo (embed)', viejo], ['un ticket nuevo (tarjeta)', nuevo]]) {
        const texto = v2.panelText(msg);
        assert(texto.match(RE.usuario)?.[1] === 'Anii_soff', `se lee el usuario de Roblox en ${etiqueta}`);
        assert(texto.match(RE.robux)?.[1] === '3,200 Robux', `y los Robux en ${etiqueta}`);
        assert(texto.match(RE.precio)?.[1] === '376', `y el precio en ${etiqueta}`);

        const robuxAmount = parseInt((texto.match(RE.robux)?.[1] ?? '').replace(/[^\d]/g, ''), 10);
        assert(robuxAmount === 3200, `el ranking registraría 3200 Robux desde ${etiqueta}`);
    }

    // Y los lectores usan panelText, no embeds[0], que es lo que lo hace posible.
    for (const fichero of ['utils/orderNotify.js', 'utils/reviewFlow.js']) {
        const src = fs.readFileSync(path.join(RAIZ, fichero), 'utf8');
        assert(src.includes('panelText'), `${fichero} lee con panelText, que entiende los dos formatos`);
        assert(
            !/m\.embeds\[0\]\?\.description/.test(src),
            `${fichero} ya no lee embeds[0].description, que con una tarjeta devolvería vacío`
        );
    }

    // ── 3. La tarjeta de reseña, entera también al deshabilitarla ────────────
    const activa = reviewFlow.buildReviewPayload('555', 'canal-1', false);
    const usada  = reviewFlow.buildReviewPayload('555', 'canal-1', true);

    for (const [etiqueta, p] of [['activa', activa], ['ya calificada', usada]]) {
        assert(p.flags === MessageFlags.IsComponentsV2, `la tarjeta de reseña ${etiqueta} es un Container`);
        const piezasReseña = nodos(p.components.map(c => c.toJSON()));
        assert(
            piezasReseña.some(n => n.type === 10 && n.content.includes('evaluar la atención')),
            `la ${etiqueta} conserva su texto — editar sólo la fila lo habría borrado`
        );
        assert(
            piezasReseña.some(n => n.type === 2 && n.custom_id === 'review_rate:canal-1'),
            `y su botón dentro del bloque (${etiqueta})`
        );
    }

    const botonUsado = nodos(usada.components.map(c => c.toJSON())).find(n => n.type === 2);
    assert(botonUsado.disabled === true, 'al calificar, el botón queda deshabilitado');
    assert(botonUsado.label === 'Ya calificado', 'y lo dice');

    return finish();
};
