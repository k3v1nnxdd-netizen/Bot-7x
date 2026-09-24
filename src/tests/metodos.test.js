'use strict';

// Tests de los métodos de pago. Sin red y sin Discord.
//
// Aquí hay dinero de por medio, y eso decide qué se prueba:
//
//   1. LAS DIRECCIONES DE COBRO TIENEN EL FORMATO CORRECTO. Un carácter de más
//      o de menos en una dirección de cripto manda el pago de un cliente a la
//      nada, y en una blockchain eso no se deshace ni se reclama. Se comprueba
//      longitud exacta, alfabeto válido y que no haya dos iguales. No valida el
//      checksum —haría falta una librería— pero caza lo que de verdad pasa al
//      copiar y pegar: que se quede un carácter por el camino.
//   2. LOS DATOS DE PAGO SALEN SIEMPRE EN EFÍMERO. Una cuenta bancaria y cinco
//      direcciones de cobro escritas en un canal abierto las lee cualquiera,
//      para siempre. El botón responde sólo a quien lo pulsa.
//   3. HAY UN SOLO SITIO CON CADA DATO. El botón del panel y /pagos sacan el
//      contenido de la MISMA función: no puede haber dos versiones de una
//      cuenta bancaria, una actualizada y otra no.
//   4. LOS BOTONES VAN DENTRO DEL CONTENEDOR y todos están enrutados. Un botón
//      sin handler deja al cliente con "La aplicación no responde" justo cuando
//      iba a pagar.
//   5. EL TICKET NO RESUBE EL GIF. Son 6,5 MiB por ticket para una decoración
//      que el cliente ya vio en el canal.

const fs = require('fs');
const path = require('path');

const { MessageFlags } = require('discord.js');
const { createSuite } = require('./testHarness');
const metodos = require('../../metodos');
const { __test: t, CLAVES, BOTONES, buildDetallePayload, buildMetodosPayload } = metodos;

const RAIZ = path.join(__dirname, '..', '..');
const EPHEMERAL = MessageFlags.Ephemeral;

// Reglas por moneda. Bech32 (BTC/LTC) no usa 1, b, i ni o en su alfabeto.
const BECH32 = '[023456789acdefghjklmnpqrstuvwxyz]';
const REGLAS = {
    BTC:  { re: new RegExp(`^bc1q${BECH32}{38}$`),  largo: 42, red: 'Bitcoin' },
    LTC:  { re: new RegExp(`^ltc1q${BECH32}{38}$`), largo: 43, red: 'Litecoin' },
    ETH:  { re: /^0x[0-9a-fA-F]{40}$/,              largo: 42, red: 'Ethereum' },
    LINK: { re: /^0x[0-9a-fA-F]{40}$/,              largo: 42, red: 'Ethereum' },
    UNI:  { re: /^0x[0-9a-fA-F]{40}$/,              largo: 42, red: 'Ethereum' },
};

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
    const { assert, finish } = createSuite('metodos');

    // ── 1. Las direcciones de cobro ──────────────────────────────────────────
    assert(t.CRIPTO.length === 5, `hay cinco criptomonedas configuradas (${t.CRIPTO.length})`);

    for (const c of t.CRIPTO) {
        const regla = REGLAS[c.ticker];
        assert(Boolean(regla), `${c.ticker} tiene una regla de formato conocida`);
        if (!regla) continue;

        assert(
            c.direccion.length === regla.largo,
            `la dirección de ${c.ticker} mide ${regla.largo} caracteres (mide ${c.direccion.length}) — si no, falta o sobra algo`
        );
        assert(regla.re.test(c.direccion), `y usa el alfabeto válido de ${c.ticker}`);
        assert(c.red === regla.red, `${c.ticker} se anuncia en la red correcta (${regla.red})`);
        assert(c.direccion.trim() === c.direccion, `la dirección de ${c.ticker} no lleva espacios sueltos`);
    }

    const direcciones = t.CRIPTO.map(c => c.direccion.toLowerCase());
    assert(new Set(direcciones).size === direcciones.length, 'no hay dos monedas compartiendo la misma dirección');

    // La cuenta bancaria, igual: un dígito de menos es un pago que no llega.
    assert(/^\d{18}$/.test(t.CUENTA.numero), `la cuenta de Mercado Pago son 18 dígitos (${t.CUENTA.numero.length})`);
    assert(t.CUENTA.titular.trim().length > 0, 'y tiene titular');

    // ── 2. Los enlaces ───────────────────────────────────────────────────────
    assert(t.AMAZON_URL === 'https://www.amazon.com.mx/dp/B07PMMFSPC?th=1', 'el enlace de Amazon es el que se pidió');
    assert(t.ENEBA_URL.startsWith('https://www.eneba.com/'), 'y el de Eneba apunta a Eneba');
    for (const url of [t.AMAZON_URL, t.ENEBA_URL]) {
        assert(!url.includes(')'), 'ningún enlace lleva paréntesis, que romperían el markdown');
    }

    // ── 3. El detalle de cada método ─────────────────────────────────────────
    assert(CLAVES.length === 5, `hay cinco métodos de pago (${CLAVES.join(', ')})`);

    for (const clave of CLAVES) {
        const payload = buildDetallePayload(clave);
        assert(Boolean(payload?.embeds?.length), `${clave} tiene su mensaje de detalle`);

        const embed = payload.embeds[0].toJSON();
        assert(Boolean(embed.title), `${clave} lleva título`);
        assert(!embed.title.includes('<:'), `y sin emojis del servidor en él (Discord los imprime crudos)`);
        assert(embed.footer?.text === '7x Community • Métodos de Pago', `${clave} lleva el pie del sistema`);
        assert(JSON.stringify(payload).length < 6000, `${clave} cabe en el límite de un embed`);
    }

    assert(buildDetallePayload('inventado') === null, 'un método que no existe no devuelve nada que enviar');
    assert(buildDetallePayload(undefined) === null, 'y tampoco uno sin clave');

    // Las direcciones salen ENTERAS en el mensaje: si una se truncara al
    // pintarla, el cliente copiaría una dirección rota.
    const cripto = buildDetallePayload('cripto').embeds[0].toJSON().description;
    for (const c of t.CRIPTO) {
        assert(cripto.includes(c.direccion), `la dirección de ${c.ticker} sale completa en el mensaje`);
        assert(cripto.includes(`\`\`\`${c.direccion}\`\`\``), `y en un bloque de código, para poder copiarla de un toque`);
    }
    assert(cripto.includes('SU dirección y SU red'), 'con el aviso de no mezclar monedas ni redes');

    const transferencia = buildDetallePayload('transferencia').embeds[0].toJSON().description;
    assert(transferencia.includes(t.CUENTA.numero), 'la cuenta bancaria sale completa');
    assert(transferencia.includes(t.CUENTA.titular), 'y con su titular');

    assert(buildDetallePayload('amazon').embeds[0].toJSON().description.includes(t.AMAZON_URL), 'el de Amazon lleva su enlace');
    assert(buildDetallePayload('eneba').embeds[0].toJSON().description.includes(t.ENEBA_URL), 'y el de Eneba el suyo');

    // ── 3b. La respuesta del botón es EFÍMERA ────────────────────────────────
    // Lo más importante de todo el fichero. Una cuenta bancaria y cinco
    // direcciones de cobro publicadas en un canal abierto las lee cualquiera,
    // para siempre, y no se pueden "despublicar".
    //
    // Se comprueba a través del handler real, no mirando el objeto que se le
    // pasa: utils/safe.js traduce `ephemeral: true` al flag de Discord, así que
    // lo que hay que verificar es el flag que acaba saliendo.
    for (const clave of CLAVES) {
        let enviado = null;
        await metodos.handleMetodosButton({
            customId: `metodos_${clave}`,
            replied: false,
            deferred: false,
            user: { id: '123' },
            reply: async p => { enviado = p; },
        });

        assert(Boolean(enviado), `el botón de ${clave} responde algo`);
        assert(
            (enviado.flags & EPHEMERAL) === EPHEMERAL,
            `y lo hace en EFÍMERO: los datos de pago de ${clave} no se quedan escritos en el canal`
        );
        assert(enviado.embeds?.length === 1, `con su detalle (${clave})`);
    }

    // Un customId de un método que ya no existe no responde nada, en vez de
    // mandar un mensaje vacío.
    let respuestaFantasma = null;
    await metodos.handleMetodosButton({
        customId: 'metodos_loquesea', replied: false, deferred: false,
        user: { id: '1' }, reply: async p => { respuestaFantasma = p; },
    });
    assert(respuestaFantasma === null, 'un método inventado no responde nada');

    // El desplegable viejo sigue contestando en efímero: puede quedar abierto
    // en algún mensaje de antes del cambio.
    let viejo = null;
    await metodos.handleMetodosSelect({
        customId: 'metodos_select', values: ['giftcard'], replied: false, deferred: false,
        user: { id: '1' }, reply: async p => { viejo = p; },
    });
    assert((viejo?.flags & EPHEMERAL) === EPHEMERAL, 'el desplegable viejo también responde en efímero');
    assert(viejo.embeds[0].toJSON().title.includes('Eneba'), 'y su "giftcard" se traduce al método que ahora existe');

    // ── 4. El panel: botones dentro, uno por método ──────────────────────────
    const panel = t.buildMetodosContainer({ conBanner: true }).toJSON();
    const piezas = nodos([panel]);

    assert(panel.type === 17, 'el panel es un Container: los botones van DENTRO, no colgando debajo');
    assert(panel.accent_color === t.ACCENT, 'con su barra de color');

    const botones = piezas.filter(n => n.type === 2);
    assert(botones.length === CLAVES.length, `hay un botón por método (${botones.length} de ${CLAVES.length})`);
    for (const clave of CLAVES) {
        const b = botones.find(x => x.custom_id === `metodos_${clave}`);
        assert(Boolean(b), `existe el botón de ${clave}`);
        assert(Boolean(b.emoji?.id), `y lleva su emoji (${clave})`);
        assert(BOTONES.has(b.custom_id), `y está en el Set que usa el enrutado (${clave})`);
    }
    assert(botones.length <= 5, 'los cinco caben en una sola fila de Discord');

    // Enrutados de verdad: un botón sin handler deja al cliente con "La
    // aplicación no responde" justo cuando iba a pagar.
    const fuenteBotones = fs.readFileSync(path.join(RAIZ, 'handlers', 'buttons.js'), 'utf8').replace(/\r\n/g, '\n');
    assert(fuenteBotones.includes('handleMetodosButton'), 'handlers/buttons.js enruta los botones de métodos');
    assert(
        /METODOS_BUTTONS\].map\(id => \[id, handleMetodosButton\]\)/.test(fuenteBotones),
        'y lo hace derivándolo del Set, no escribiendo los cinco a mano'
    );

    if (t.BANNER.exists) {
        const imagen = piezas.find(n => n.type === 12);
        assert(Boolean(imagen), 'el panel del canal lleva el GIF');
        assert(imagen.items[0].media.url === `attachment://${t.BANNER.name}`, 'subido como adjunto');
        assert(t.BANNER.name.endsWith('.gif'), 'con extensión .gif, o Discord lo congelaría');
    }

    // ── 5. En un ticket, sin GIF ─────────────────────────────────────────────
    const enTicket = buildMetodosPayload();
    assert(!enTicket.files?.length, 'el bloque que va al ticket NO resube el GIF (6,5 MiB por ticket)');
    const textoTicket = nodos(enTicket.components.map(c => c.toJSON())).filter(n => n.type === 10).map(n => n.content).join('\n');
    const textoPanel = piezas.filter(n => n.type === 10).map(n => n.content).join('\n');
    assert(textoTicket === textoPanel, 'pero el texto es exactamente el mismo que el del panel');
    assert(
        nodos(enTicket.components.map(c => c.toJSON())).filter(n => n.type === 2).length === CLAVES.length,
        'y lleva los mismos cinco botones'
    );

    const conBanner = buildMetodosPayload({ conBanner: true });
    assert(Boolean(conBanner.files?.length) === t.BANNER.exists, 'y se puede pedir con GIF si alguna vez se quiere');

    // ── 6. Los tres tickets usan este bloque ─────────────────────────────────
    for (const fichero of ['handlers/modals.js', 'handlers/headlessFlow.js', 'handlers/seguidoresFlow.js']) {
        const src = fs.readFileSync(path.join(RAIZ, fichero), 'utf8');
        assert(src.includes('buildMetodosPayload'), `${fichero} manda el bloque nuevo de métodos de pago`);
        assert(!src.includes('buildMetodosEmbed'), `${fichero} ya no usa el panel viejo`);
    }

    // ── 7. /pagos saca el contenido del MISMO sitio ──────────────────────────
    const fuenteComandos = fs.readFileSync(path.join(RAIZ, 'handlers', 'commands.js'), 'utf8');
    assert(fuenteComandos.includes('buildDetallePayload'), '/pagos reutiliza el detalle del botón, no una copia');
    assert(
        !/buildTransferenciaEmbed|buildGiftCardEmbed/.test(fuenteComandos),
        'y no arrastra los constructores viejos, que serían una segunda versión de los mismos datos'
    );

    const fuenteMain = fs.readFileSync(path.join(RAIZ, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
    assert(
        /choices: Object\.entries\(METODOS\)/.test(fuenteMain),
        'las opciones de /pagos se derivan de METODOS: añadir un método las actualiza solo'
    );

    return finish();
};
