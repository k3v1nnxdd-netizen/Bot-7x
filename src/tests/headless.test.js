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
const path = require('path');

const { createSuite } = require('./testHarness');
const config = require('../../config');
const v2 = require('../../utils/panelV2');
const { dataPath } = require('../../utils/dataDir');
const headlessSale = require('../../utils/headlessSale');
const { __test: panel } = require('../../headless');
const { __test: flujo } = require('../../handlers/headlessFlow');

const H = config.HEADLESS;

// Quién redirige DATA_DIR a un temporal es run.js, no este fichero: dataDir.js
// lo lee UNA vez, al requerirse, así que ponerlo aquí llegaría tarde en cuanto
// otro test lo hubiera importado antes — y el test acabaría escribiendo en el
// ./data real. Por eso la ruta se pregunta, no se construye.
const ESTADO_FILE = dataPath('headlessSale.json');

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
    // Antes de nada, la salvaguarda: este bloque abre y cierra la venta, así
    // que si corriera contra el ./data real dejaría el interruptor del bot de
    // esta máquina donde lo dejara la última aserción. run.js redirige DATA_DIR
    // a un temporal; esto comprueba que de verdad lo hizo.
    const dataDelProyecto = path.resolve(__dirname, '..', '..', 'data');
    assert(
        !path.resolve(ESTADO_FILE).startsWith(dataDelProyecto),
        'el estado de prueba va a un DATA_DIR temporal, nunca al ./data del proyecto'
    );

    if (fs.existsSync(ESTADO_FILE)) fs.unlinkSync(ESTADO_FILE);
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

    // ── 8. Reiniciar el bot NO republica el panel ────────────────────────────
    // Lo que protege: cada arranque llama a ensureHeadlessPanel. Si la búsqueda
    // del panel existente falla, el canal se llena de paneles duplicados, cada
    // uno con su botón de comprar. El caso que se escapaba —y por el que la
    // búsqueda mira los FIJADOS y no sólo los últimos 100 mensajes— es el canal
    // con más de 100 mensajes por encima del panel.
    for (const escenario of await simularReinicios()) {
        assert(escenario.ok, escenario.msg);
    }

    return finish();
};

// Canal de Discord falso: lo justo para que ensureHeadlessPanel funcione.
function canalFalso(BOT_ID) {
    const mensajes = [];
    let n = 0;
    const canal = {
        id: config.CHANNELS.HEADLESS,
        enviados: 0,
        editados: 0,
        sinFetchPins: false,
        messages: {
            // Como Discord: los fijados no dependen de cuántos mensajes haya encima.
            fetchPins: async () => {
                if (canal.sinFetchPins) throw new Error('403 Missing Access');
                return { items: mensajes.filter(m => m.pinned).map(message => ({ message })), hasMore: false };
            },
            fetch: async ({ limit }) => {
                const recientes = mensajes.slice(-limit).reverse();  // más nuevos primero
                const col = new Map(recientes.map(m => [m.id, m]));
                col.find = fn => recientes.find(fn);
                return col;
            },
        },
        send: async payload => {
            canal.enviados++;
            const msg = {
                id: `m${++n}`,
                pinned: false,
                author: { id: BOT_ID },
                content: payload.content ?? '',
                embeds: [],
                components: payload.components.map(c => c.toJSON()),
                channel: canal,
                pin: async () => { msg.pinned = true; },
                edit: async p => { canal.editados++; msg.components = p.components.map(c => c.toJSON()); return msg; },
                delete: async () => {},
            };
            mensajes.push(msg);
            return msg;
        },
        ruido: cantidad => {
            for (let i = 0; i < cantidad; i++) {
                mensajes.push({ id: `r${++n}`, pinned: false, author: { id: 'humano' }, content: 'hola', embeds: [], components: [] });
            }
        },
        despinnear: () => mensajes.forEach(m => { m.pinned = false; }),
    };
    return canal;
}

async function simularReinicios() {
    const { ensureHeadlessPanel } = require('../../headless');
    const BOT_ID = 'bot-de-prueba';
    const nuevo = () => {
        const canal = canalFalso(BOT_ID);
        const client = { user: { id: BOT_ID }, channels: { cache: new Map([[canal.id, canal]]), fetch: async () => canal } };
        return { canal, client };
    };

    const out = [];

    // Cuatro arranques seguidos sin cambiar nada: un panel y ni un edit (que
    // resubiría la imagen en cada arranque para nada).
    const a = nuevo();
    for (let i = 0; i < 4; i++) await ensureHeadlessPanel(a.client);
    out.push({ ok: a.canal.enviados === 1, msg: `4 arranques seguidos publican UN panel (fueron ${a.canal.enviados})` });
    out.push({ ok: a.canal.editados === 0, msg: 'y no reeditan nada si el panel ya está al día' });

    // El panel enterrado bajo mensajes de gente. 150 y 400 son justo los casos
    // que se escapaban al mirar sólo los últimos 100 mensajes.
    for (const ruido of [99, 150, 400]) {
        const { canal, client } = nuevo();
        await ensureHeadlessPanel(client);
        canal.ruido(ruido);
        await ensureHeadlessPanel(client);
        out.push({ ok: canal.enviados === 1, msg: `con ${ruido} mensajes encima del panel, el reinicio no lo duplica` });
    }

    // Sin poder leer los fijados (permisos, versión de discord.js): tiene que
    // caer al barrido de los últimos 100 y seguir encontrándolo.
    const b = nuevo();
    await ensureHeadlessPanel(b.client);
    b.canal.sinFetchPins = true;
    b.canal.ruido(20);
    await ensureHeadlessPanel(b.client);
    out.push({ ok: b.canal.enviados === 1, msg: 'sin acceso a los fijados, el respaldo de 100 mensajes lo encuentra igual' });

    // Alguien desfija el panel a mano: se reaprovecha y se vuelve a fijar.
    const c = nuevo();
    await ensureHeadlessPanel(c.client);
    c.canal.despinnear();
    await ensureHeadlessPanel(c.client);
    out.push({ ok: c.canal.enviados === 1, msg: 'un panel desfijado a mano se reaprovecha en vez de duplicarse' });

    // Cambiar el estado de la venta edita el panel existente, no publica otro.
    const d = nuevo();
    headlessSale.setOpen(false);
    await ensureHeadlessPanel(d.client);
    headlessSale.setOpen(true);
    await ensureHeadlessPanel(d.client);
    out.push({ ok: d.canal.enviados === 1 && d.canal.editados === 1, msg: '/headless on edita el panel existente en vez de publicar otro' });

    return out;
}
