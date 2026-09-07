'use strict';

// Tests de la venta del Headless Horseman: el panel naranja, el interruptor
// on/off y el ticket que sale del botón de comprar. Sin red y sin cliente de
// Discord.
//
// Lo que protegen es justo lo que costaría dinero o clientes y que un vistazo
// manual al panel no enseñaría:
//
//   1. EL PRECIO Y LOS ROBUX SALEN DE config.HEADLESS. Es lo que el dueño va a
//      querer cambiar, y tiene que cambiar en un solo sitio: el panel, el
//      resumen del ticket y el aviso de pago.
//   2. EL AHORRO SE CALCULA, NO SE ESCRIBE. Un porcentaje a mano sobrevive a un
//      cambio de precio y deja el panel anunciando un descuento que ya no es.
//   3. LA VENTA CERRADA ES EL ESTADO POR DEFECTO. Un fichero que no existe, uno
//      corrupto o uno a medias significan CERRADA: un reinicio no puede abrir
//      una venta que el owner había cerrado.
//   4. EL TICKET ES DE TIPO 'comprar'. De ese tipo cuelgan el botón de "PAGO
//      REALIZADO" del owner, el registro de pedidos y el ranking. Con cualquier
//      otro, el ticket se queda a medio funcionar sin que nada avise.
//   5. EL RESUMEN USA LAS ETIQUETAS QUE LEE orderNotify. Si cambian, la compra
//      deja de contar para el ranking de compradores, en silencio.
//   6. LOS BOTONES VAN DENTRO DEL CONTENEDOR, y el de comprar conserva su
//      customId: es lo único por lo que se reconoce el panel para reeditarlo en
//      vez de duplicarlo.

const fs = require('fs');
const os = require('os');
const path = require('path');

// El interruptor escribe en DATA_DIR al cargarse utils/dataDir.js, así que se
// redirige a un directorio temporal ANTES de requerir nada: un `npm test` no
// puede tocar el estado real de la venta.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bot7x-headless-'));

const { createSuite } = require('./testHarness');
const config = require('../../config');
const v2 = require('../../utils/panelV2');
const headlessSale = require('../../utils/headlessSale');
const { __test: panel } = require('../../headless');
const { __test: flujo } = require('../../handlers/headlessFlow');

const H = config.HEADLESS;
const ESTADO_FILE = path.join(process.env.DATA_DIR, 'headlessSale.json');

// Todos los nodos de un contenedor ya serializado, en plano. walk() no se
// exporta desde panelV2, así que se recorre aquí igual que hace él.
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

module.exports = async function run() {
    const { assert, finish } = createSuite('headless');

    // ── 1. Las cifras salen de config ────────────────────────────────────────
    const fuentePanel = fs.readFileSync(path.join(__dirname, '..', '..', 'headless.js'), 'utf8');
    const fuenteFlujo = fs.readFileSync(path.join(__dirname, '..', '..', 'handlers', 'headlessFlow.js'), 'utf8');

    assert(fuentePanel.includes('config.HEADLESS'), 'el panel lee las cifras de config.HEADLESS');
    assert(fuenteFlujo.includes('config.HEADLESS'), 'el flujo del ticket lee las cifras de config.HEADLESS');
    assert(!/3[.,]?579|31[.,]?000/.test(fuentePanel), 'el panel no tiene el precio ni los Robux escritos a mano');
    assert(!/3[.,]?579|31[.,]?000/.test(fuenteFlujo), 'el flujo no tiene el precio ni los Robux escritos a mano');

    // ── 2. El ahorro se calcula desde el precio ──────────────────────────────
    const esperado = (100 * (1 - H.PRECIO_MXN / H.PRECIO_ROBLOX_MXN)).toFixed(2);
    assert(panel.ahorroPct() === esperado, `el ahorro se calcula (${esperado}%) y no está escrito a mano`);

    const precioOriginal = H.PRECIO_MXN;
    try {
        H.PRECIO_MXN = 4000;
        assert(panel.ahorroPct() === '50.00', 'al cambiar el precio, el ahorro cambia con él');
    } finally {
        H.PRECIO_MXN = precioOriginal;
    }

    // ── 3. La venta empieza y falla en CERRADA ───────────────────────────────
    assert(headlessSale.isOpen() === false, 'sin fichero de estado, la venta está cerrada');

    fs.writeFileSync(ESTADO_FILE, '{ esto no es json', 'utf8');
    assert(headlessSale.isOpen() === false, 'con el fichero corrupto, la venta sigue cerrada');

    fs.writeFileSync(ESTADO_FILE, JSON.stringify({ open: 'sí' }), 'utf8');
    assert(headlessSale.isOpen() === false, 'un open que no es exactamente true no abre la venta');

    fs.unlinkSync(ESTADO_FILE);
    const abierta = headlessSale.setOpen(true, '123');
    assert(abierta.changed === true && headlessSale.isOpen() === true, '/headless on abre la venta y lo persiste');
    assert(headlessSale.setOpen(true, '123').changed === false, 'volver a abrirla avisa de que no cambió nada');
    assert(headlessSale.getState().updatedBy === '123', 'se guarda quién la movió');

    const cerrada = headlessSale.setOpen(false, '123');
    assert(cerrada.changed === true && headlessSale.isOpen() === false, '/headless off la cierra');

    // ── 4. El ticket es de tipo 'comprar' ────────────────────────────────────
    assert(
        /createTicket\([^)]*'comprar'/.test(fuenteFlujo),
        "el ticket del Headless se crea con tipo 'comprar' (de ahí cuelgan pago, pedidos y ranking)"
    );
    assert(/`headless-\$\{pad\(/.test(fuenteFlujo), 'y se distingue por el nombre del canal: headless-0001');

    // ── 5. El resumen usa las etiquetas que lee orderNotify ──────────────────
    const resumen = flujo.buildResumenEmbed('PlayerName123', null).toJSON();
    const desc = resumen.description;
    const orden = fs.readFileSync(path.join(__dirname, '..', '..', 'utils', 'orderNotify.js'), 'utf8');

    for (const etiqueta of ['Usuario de Roblox', 'Robux a recibir', 'Precio a pagar']) {
        assert(desc.includes(`**${etiqueta}**`), `el resumen lleva la etiqueta "${etiqueta}"`);
        assert(orden.includes(etiqueta), `y orderNotify sigue buscando "${etiqueta}"`);
    }

    // Las mismas expresiones regulares que usa orderNotify para el ranking.
    const robuxLeido = desc.match(/Robux a recibir\*\*\n```([^`]+)```/)?.[1];
    const precioLeido = desc.match(/Precio a pagar\*\*\n```\$([^`]+) MXN```/)?.[1];
    assert(parseInt((robuxLeido ?? '').replace(/[^\d]/g, ''), 10) === H.ROBUX, `orderNotify leería ${H.ROBUX} Robux del resumen`);
    assert(parseFloat((precioLeido ?? '').replace(/[^\d.]/g, '')) === H.PRECIO_MXN, `orderNotify leería $${H.PRECIO_MXN} del resumen`);

    // ── 6. El panel: botones dentro del contenedor, imagen y estado ──────────
    const json = panel.buildContainer(true).toJSON();
    const todos = nodos([json]);

    assert(json.type === 17, 'el panel es un Container (los botones van dentro, no colgando debajo)');
    assert(json.accent_color === panel.ACCENT, 'con la barra de color naranja');

    const botones = todos.filter(n => n.type === 2);
    assert(botones.length === 2, 'lleva exactamente dos botones');
    assert(botones.some(b => b.custom_id === 'headless_comprar'), 'el de Comprar conserva su customId');
    assert(
        botones.some(b => b.style === 5 && b.url === `https://discord.com/channels/${config.GUILD_ID}/${config.CHANNELS.CHECKGROUP}`),
        'el de Verificar es un enlace al canal de Check Group\'s'
    );

    if (panel.IMAGEN.exists) {
        const thumb = todos.find(n => n.type === 11);
        assert(Boolean(thumb), 'la imagen del Headless va como miniatura, arriba a la derecha');
        assert(thumb.media?.url === `attachment://${panel.IMAGEN.name}`, 'y se sube como adjunto, no como URL externa');
        // El nombre lleva el hash del contenido: si se cambia la imagen, la
        // firma cambia y el panel se reedita en vez de quedarse con la vieja.
        assert(v2.signature([json]).includes('thumb:'), 'la miniatura entra en la firma del panel');
    }

    const textoAbierta = panel.buildCabecera(true);
    const textoCerrada = panel.buildCabecera(false);
    assert(textoAbierta !== textoCerrada, 'el panel dice si la venta está abierta o cerrada');
    assert(
        v2.signature([panel.buildContainer(true).toJSON()]) !== v2.signature([panel.buildContainer(false).toJSON()]),
        'y ese estado entra en la firma, así que /headless on|off repinta el panel'
    );

    // El texto largo cabe: Discord corta un TextDisplay en 4000 caracteres.
    const totalTexto = todos.filter(n => n.type === 10).reduce((n, t) => n + t.content.length, 0);
    assert(totalTexto < 4000, `todo el texto del panel cabe en el límite de Discord (${totalTexto} caracteres)`);

    // ── 7. El modal pide sólo el usuario de Roblox ───────────────────────────
    const modal = flujo.buildHeadlessModal().toJSON();
    const inputs = nodos(modal.components).filter(n => n.type === 4);
    assert(inputs.length === 1, 'el formulario pide un único dato');
    assert(inputs[0].custom_id === 'usuario_roblox', 'y ese dato es el usuario de Roblox');

    return finish();
};
