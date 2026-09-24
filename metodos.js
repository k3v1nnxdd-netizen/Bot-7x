'use strict';

const fs = require('fs');
const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    EmbedBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    TextDisplayBuilder,
} = require('discord.js');
const config = require('./config');
const v2 = require('./utils/panelV2');
const { safeReply } = require('./utils/safe');

const OXXO_PATH   = './oxxo.jpg';
const OXXO_NAME   = 'oxxo.jpg';
const OXXO_EXISTS = fs.existsSync(OXXO_PATH);

// El banner del panel. Pesa 6,5 MiB (1078x412, 123 frames) y el límite de
// subida de Discord son 10 MiB.
const BANNER = v2.pickBanner(['./metodos.gif', './image-1790220140151.gif'], 'metodos.gif');

const ACCENT = 0x2B2D31;
const TITULO = '7x — Métodos de Pago';

// ── Direcciones de cobro ──────────────────────────────────────────────────────
//
// ESTO ES DINERO. Un carácter de más o de menos en cualquiera de estas cadenas
// manda el pago de un cliente a una dirección que no existe o que no es
// nuestra, y en una blockchain eso no se deshace ni se reclama.
//
// Por eso viven aquí, juntas y en un solo sitio, y por eso src/tests/
// metodos.test.js comprueba su FORMATO en cada `npm test`: longitud exacta,
// alfabeto válido y que no haya dos iguales. No valida el checksum —para eso
// haría falta una librería—, pero caza lo que de verdad pasa al copiar y pegar:
// que se quede un carácter por el camino.
//
// ETH, LINK y UNI son direcciones EVM distintas ENTRE SÍ a propósito: no se
// pueden intercambiar.
const CRIPTO = [
    { nombre: 'Bitcoin',   ticker: 'BTC',  red: 'Bitcoin',  direccion: 'bc1q773m4saxplpe5k78u7vq3kz77cpe6c2hlkgl7p' },
    { nombre: 'Ethereum',  ticker: 'ETH',  red: 'Ethereum', direccion: '0xD809d17D8d79BE72275dA4C890329db42F3Ad29c' },
    { nombre: 'ChainLink', ticker: 'LINK', red: 'Ethereum', direccion: '0x5fc7db0b4ec709AA1eB095b52BA5504Cb6790C1F' },
    { nombre: 'Litecoin',  ticker: 'LTC',  red: 'Litecoin', direccion: 'ltc1qg3wcsdpqsxfhuxd94uajq9qvdg93d55ssqkxth' },
    { nombre: 'Uniswap',   ticker: 'UNI',  red: 'Ethereum', direccion: '0xc8DDcc118fb962dC49927054371E557F4E3870DB' },
];

const CUENTA = {
    numero: '722969040869278041',
    titular: 'VICENTA MARIANO VALDOVINOS',
    banco: 'Mercado Pago',
};

const ENEBA_URL  = 'https://www.eneba.com/eneba-eneba-gift-card-5-eur-global';
const AMAZON_URL = 'https://www.amazon.com.mx/dp/B07PMMFSPC?th=1';

const E = {
    cripto:        { id: '1552521783406497822', name: 'cripto' },
    transferencia: { id: '1510169188373758166', name: 'transferencia' },
    oxxo:          { id: '1510195718231429180', name: 'oxxo' },
    eneba:         { id: '1182891011064729610', name: 'eneba' },
    amazon:        { id: '1552522741586984972', name: 'amazon' },
};

// Los emojis, ya escritos como los pinta Discord dentro de un texto. Los cinco
// son estáticos, así que van sin la `a:` de animado.
const emoji = clave => `<:${E[clave].name}:${E[clave].id}>`;

const PUNTO = '<:point:1501212595464700104>';
const ALERTA = '<:alert:1501220021035204658>';
const PIE = '7x Community • Métodos de Pago';

// ── Detalle de cada método ────────────────────────────────────────────────────
// Cada uno devuelve lo que se envía EN EFÍMERO al pulsar su botón: sólo lo ve
// quien lo pulsó. Es lo que hace que estos datos —una cuenta bancaria, cinco
// direcciones de cobro— no se queden escritos en el canal para cualquiera.

function buildCriptoEmbed() {
    const lineas = CRIPTO.map(c =>
        `**${c.nombre} (${c.ticker})** · red ${c.red}\n\`\`\`${c.direccion}\`\`\``
    );

    return new EmbedBuilder()
        .setColor(ACCENT)
        .setTitle('Pago con criptomonedas')
        .setDescription(
            `${PUNTO} Envía el importe exacto a la dirección de la moneda que vayas a usar.\n\n` +
            `${lineas.join('\n')}\n\n` +
            `${ALERTA} **Cada moneda tiene SU dirección y SU red.** Enviar una moneda a la dirección de otra, o por una red distinta, hace que el pago se pierda y no se pueda recuperar.\n\n` +
            `${PUNTO} Cuando lo envíes, pega el **hash de la transacción** en tu ticket para que podamos verificarlo.`
        )
        .setFooter({ text: PIE })
        .setTimestamp();
}

function buildTransferenciaEmbed() {
    return new EmbedBuilder()
        .setColor(ACCENT)
        .setTitle('Transferencia — Mercado Pago')
        .setDescription(
            `${PUNTO} Transfiere el importe exacto a esta cuenta:\n\n` +
            `**Número de cuenta (CLABE)**\n\`\`\`${CUENTA.numero}\`\`\`\n` +
            `**Titular**\n\`\`\`${CUENTA.titular}\`\`\`\n` +
            `**Banco**\n\`\`\`${CUENTA.banco}\`\`\`\n` +
            `${PUNTO} Una vez enviado, sube el **comprobante** a tu ticket para que podamos verificar tu pago.`
        )
        .setFooter({ text: PIE })
        .setTimestamp();
}

// ── Botones de copiar ─────────────────────────────────────────────────────────
//
// En el móvil, seleccionar una dirección de cripto dentro de un embed es
// incómodo y fácil de hacer mal — y media dirección copiada es un pago perdido.
// Estos botones responden con el dato PELADO, sin markdown ni nada alrededor,
// que es lo que el móvil deja copiar de un toque.
//
// Todo lo copiable sale de un solo sitio. Antes la cuenta de Mercado Pago
// estaba escrita DOS veces —aquí y otra vez a mano en handlers/buttons.js—, así
// que cambiarla en un sitio dejaba al botón de copiar entregando la vieja.

const COPIAR_EMOJI = { id: '1527509149758259371', name: 'copiar' };
const COPY_PREFIJO = 'metodos_copy_';
const COPY_ID = clave => `${COPY_PREFIJO}${clave}`;

const COPIABLES = {
    cuenta: CUENTA.numero,
    nombre: CUENTA.titular,
    amazon: AMAZON_URL,
    eneba:  ENEBA_URL,
    // Una entrada por moneda, con su ticker en minúsculas como clave.
    ...Object.fromEntries(CRIPTO.map(c => [c.ticker.toLowerCase(), c.direccion])),
};

const COPY_BOTONES = new Set(Object.keys(COPIABLES).map(COPY_ID));

function botonCopiar(clave, label) {
    return new ButtonBuilder()
        .setCustomId(COPY_ID(clave))
        .setLabel(label)
        .setEmoji(COPIAR_EMOJI)
        .setStyle(ButtonStyle.Secondary);
}

function buildTransferenciaRow() {
    return new ActionRowBuilder().addComponents(
        botonCopiar('cuenta', 'Copiar Cuenta'),
        botonCopiar('nombre', 'Copiar Nombre'),
    );
}

// Una fila con un botón por moneda, etiquetado con su nombre. Son cinco, que es
// justo el máximo de una fila de Discord.
function buildCriptoRow() {
    return new ActionRowBuilder().addComponents(
        CRIPTO.map(c => botonCopiar(c.ticker.toLowerCase(), c.nombre))
    );
}

function buildEnlaceRow(clave) {
    return new ActionRowBuilder().addComponents(botonCopiar(clave, 'Copiar enlace'));
}

function buildOxxoEmbed() {
    const embed = new EmbedBuilder()
        .setColor(ACCENT)
        .setTitle('Depósito en OXXO')
        .setDescription(
            `${PUNTO} Puedes depositar en cualquier tienda OXXO con el código de abajo.\n\n` +
            `${PUNTO} **Conserva el ticket del depósito** y súbelo a tu ticket de Discord: es el comprobante con el que se valida tu compra.`
        )
        .setFooter({ text: PIE })
        .setTimestamp();

    if (OXXO_EXISTS) embed.setImage(`attachment://${OXXO_NAME}`);
    return embed;
}

function buildEnebaEmbed() {
    return new EmbedBuilder()
        .setColor(ACCENT)
        .setTitle('Gift Card — Eneba')
        .setDescription(
            `${PUNTO} Compra la gift card por el importe que corresponda a tu pedido.\n\n` +
            `${PUNTO} Cuando la tengas, envía el **código** en tu ticket. No lo publiques en ningún canal abierto: quien lo lea puede canjearlo.\n\n` +
            `${PUNTO} [Comprar en Eneba](${ENEBA_URL})`
        )
        .setFooter({ text: PIE })
        .setTimestamp();
}

function buildAmazonEmbed() {
    return new EmbedBuilder()
        .setColor(ACCENT)
        .setTitle('Gift Card — Amazon México')
        .setDescription(
            `${PUNTO} Compra la gift card por el importe que corresponda a tu pedido.\n\n` +
            `${PUNTO} Cuando la tengas, envía el **código** en tu ticket. No lo publiques en ningún canal abierto: quien lo lea puede canjearlo.\n\n` +
            `${PUNTO} [Comprar en Amazon México](${AMAZON_URL})`
        )
        .setFooter({ text: PIE })
        .setTimestamp();
}

// ── Los métodos, en un solo sitio ─────────────────────────────────────────────
// De aquí salen los botones del panel, el enrutado de cada pulsación y las
// opciones de /pagos. Añadir un método es escribirlo aquí y en ningún otro
// sitio: no se puede quedar a medias.
const METODOS = {
    cripto: {
        label: 'Cripto',
        descripcion: 'BTC, ETH, LINK, LTC y UNI',
        emoji: E.cripto,
        embed: buildCriptoEmbed,
        row: buildCriptoRow,
    },
    transferencia: {
        label: 'Transferencia',
        descripcion: 'Mercado Pago MX',
        emoji: E.transferencia,
        embed: buildTransferenciaEmbed,
        row: buildTransferenciaRow,
    },
    oxxo: {
        label: 'Depósito OXXO',
        descripcion: 'En cualquier tienda OXXO',
        emoji: E.oxxo,
        embed: buildOxxoEmbed,
        adjunto: OXXO_EXISTS ? { attachment: OXXO_PATH, name: OXXO_NAME } : null,
    },
    eneba: {
        label: 'Gift Card Eneba',
        descripcion: 'Compras internacionales',
        emoji: E.eneba,
        embed: buildEnebaEmbed,
        row: () => buildEnlaceRow('eneba'),
    },
    amazon: {
        label: 'Gift Card Amazon',
        descripcion: 'Amazon México',
        emoji: E.amazon,
        embed: buildAmazonEmbed,
        row: () => buildEnlaceRow('amazon'),
    },
};

const CLAVES = Object.keys(METODOS);
const CUSTOM_ID = clave => `metodos_${clave}`;
const BOTONES = new Set(CLAVES.map(CUSTOM_ID));

// Lo que se envía al pulsar un botón o ejecutar /pagos. Siempre el mismo
// contenido, venga de donde venga.
function buildDetallePayload(clave) {
    const metodo = METODOS[clave];
    if (!metodo) return null;

    return {
        embeds: [metodo.embed()],
        ...(metodo.row && { components: [metodo.row()] }),
        ...(metodo.adjunto && { files: [metodo.adjunto] }),
    };
}

// ── El panel ──────────────────────────────────────────────────────────────────
// Un Container de Components V2: el GIF, el texto y los BOTONES dentro del
// mismo bloque. Un embed clásico no admite botones — quedarían colgando debajo,
// fuera del marco.

// El emoji del título es el de dinero, no el de ningún método concreto: el
// panel es de todos.
const MONEDA = '<:money:1544123920897019906>';

function buildTexto() {
    return [
        `## ${MONEDA} ${TITULO}`,
        '',
        'Pulsa el método con el que quieras pagar y te enseñaré los datos.',
        `-# Sólo tú verás la respuesta.`,
    ].join('\n');
}

function buildAviso() {
    return [
        `${PUNTO} Paga siempre el **importe exacto** de tu pedido.`,
        `${PUNTO} Guarda el **comprobante** y súbelo a tu ticket: es lo que valida tu compra.`,
        `${PUNTO} Los métodos disponibles pueden cambiar; revisa este panel antes de pagar.`,
        `${ALERTA} Nadie de 7x te pedirá el pago por privado. Si alguien lo hace, es una estafa.`,
    ].join('\n');
}

function buildRow() {
    return new ActionRowBuilder().addComponents(
        CLAVES.map(clave =>
            new ButtonBuilder()
                .setCustomId(CUSTOM_ID(clave))
                .setLabel(METODOS[clave].label)
                .setStyle(ButtonStyle.Secondary)
                .setEmoji(METODOS[clave].emoji)
        )
    );
}

// `conBanner` existe por el peso: el GIF son 6,5 MiB, y los tickets mandan este
// mismo bloque cada vez que se abre uno. En el panel del canal se sube UNA vez
// y se queda; en un ticket serían 6,5 MiB de subida y varios segundos de espera
// por cada cliente, para una decoración que ya vieron en el canal. El texto y
// los botones son idénticos en los dos casos.
function buildMetodosContainer({ conBanner = true } = {}) {
    const container = new ContainerBuilder().setAccentColor(ACCENT);

    if (conBanner && BANNER.exists) {
        container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(
                new MediaGalleryItemBuilder().setURL(`attachment://${BANNER.name}`)
            )
        );
    }

    return container
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(buildTexto()))
        .addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(buildAviso()))
        .addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small))
        .addActionRowComponents(buildRow());
}

const SIN_ADJUNTO = { exists: false, path: null, name: '' };

// Lo que mandan los tickets: el mismo bloque, sin el banner.
function buildMetodosPayload({ conBanner = false } = {}) {
    const container = buildMetodosContainer({ conBanner });
    return v2.payload(container, conBanner ? BANNER : SIN_ADJUNTO);
}

// ── Handlers ──────────────────────────────────────────────────────────────────

// Siempre efímero: la cuenta bancaria y las direcciones de cobro se le enseñan
// a quien va a pagar, no al canal entero.
async function handleMetodosButton(interaction) {
    const clave = interaction.customId.slice('metodos_'.length);
    const payload = buildDetallePayload(clave);
    if (!payload) return;

    await safeReply(interaction, { ...payload, ephemeral: true });
}

// Responde con el dato pelado: sin markdown, sin embed y sin nada alrededor,
// que es lo unico que el movil deja copiar de un toque. Siempre efimero.
async function handleCopiarButton(interaction) {
    const clave = interaction.customId.slice(COPY_PREFIJO.length);
    const valor = COPIABLES[clave];
    if (!valor) return;

    await safeReply(interaction, { content: valor, ephemeral: true });
}

// El panel viejo era un desplegable. Sigue existiendo en mensajes efímeros que
// alguien tenga abiertos, así que se le contesta en vez de dejarlo colgado.
// Sus tres valores son claves válidas menos "giftcard", que ahora son dos.
async function handleMetodosSelect(interaction) {
    if (interaction.customId !== 'metodos_select') return;

    const valor = interaction.values?.[0];
    const clave = valor === 'giftcard' ? 'eneba' : valor;
    const payload = buildDetallePayload(clave);

    await safeReply(interaction, payload
        ? { ...payload, ephemeral: true }
        : { content: 'Ese método ya no está disponible. Usa los botones del panel de métodos de pago.', ephemeral: true });
}

// ── Identificación y publicación del panel ────────────────────────────────────

function isMetodosMsg(msg, botId) {
    if (msg.author.id !== botId) return false;
    if (v2.collectButtons(msg).some(b => BOTONES.has(b.custom_id) || b.custom_id === 'metodos_select')) return true;
    return v2.panelText(msg).includes('Métodos de Pago');
}

async function ensureMetodosPanel(client) {
    const channel = client.channels.cache.get(config.CHANNELS.METODOS)
        ?? await client.channels.fetch(config.CHANNELS.METODOS).catch(() => null);
    if (!channel) {
        console.warn('[metodos] Metodos channel not found — skipping.');
        return null;
    }

    if (!BANNER.exists) {
        console.warn('[metodos] Banner no encontrado (metodos.gif / image-1790220140151.gif) — el panel irá sin GIF.');
    }

    const container = buildMetodosContainer({ conBanner: true });

    const aplicar = async (msg, comoLlego) => {
        if (v2.isUpToDate(msg, container)) {
            console.log(`[metodos] Panel ${comoLlego} ya actualizado — nada que hacer.`);
            return msg;
        }
        // editOrRecreate y no msg.edit: el panel publicado hoy es un embed
        // clásico, y Discord NO deja añadirle el flag de Components V2 en un
        // edit. En ese caso se sustituye —y se vuelve a fijar— en vez de fallar.
        const editado = await v2.editOrRecreate(msg, container, BANNER, 'metodos');
        console.log(`[metodos] Panel ${comoLlego} actualizado.`);
        return editado;
    };

    // Los FIJADOS primero: no dependen de cuántos mensajes haya por encima.
    const fijados = await v2.fetchPinnedMessages(channel);
    const pinned = fijados.find(m => isMetodosMsg(m, client.user.id));
    if (pinned) return aplicar(pinned, 'fijado');

    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const existing = messages?.find(m => isMetodosMsg(m, client.user.id));
    if (existing) {
        const msg = await aplicar(existing, 'del historial');
        await msg.pin().catch(err => console.warn('[metodos] Could not pin:', err.message));
        return msg;
    }

    await new Promise(r => setTimeout(r, 3000));

    const recheck = await channel.messages.fetch({ limit: 20 }).catch(() => null);
    const aparecido = recheck?.find(m => isMetodosMsg(m, client.user.id));
    if (aparecido) {
        console.log('[metodos] Metodos appeared while waiting — skipping send.');
        return aparecido;
    }

    const msg = await channel.send(v2.payload(container, BANNER));
    await msg.pin().catch(err => console.warn('[metodos] Could not pin:', err.message));
    console.log('[metodos] Metodos sent and pinned.');
    return msg;
}

module.exports = {
    ensureMetodosPanel,
    handleMetodosButton,
    handleCopiarButton,
    COPY_BOTONES,
    handleMetodosSelect,
    buildMetodosPayload,
    buildDetallePayload,
    BOTONES,
    METODOS,
    CLAVES,
    OXXO_PATH,
    OXXO_NAME,
    OXXO_EXISTS,
    __test: { buildMetodosContainer, buildTexto, buildAviso, buildRow, buildCriptoRow, isMetodosMsg, COPIABLES, COPY_ID, CRIPTO, CUENTA, ENEBA_URL, AMAZON_URL, BANNER, ACCENT, TITULO },
};
