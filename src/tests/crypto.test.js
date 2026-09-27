'use strict';

// Tests de /crypto: convertir dinero a las criptos que acepta 7x al cambio del
// momento. Sin red — el fetch global se sustituye por uno de mentira.
//
// Lo que protegen, por orden de lo que costaría dinero:
//
//   1. NUNCA SE INVENTA UN PRECIO. Sin dato, el comando lo dice. Un número
//      aproximado "por no dejarlo vacío" acabaría cobrando de menos o de más.
//   2. UN PRECIO VIEJO SE PRESENTA COMO VIEJO. Si la API no contesta se puede
//      tirar del anterior, pero diciendo de cuándo es y sólo hasta 10 minutos.
//   3. LAS MONEDAS SALEN DE metodos.js. Convertir a una cripto que 7x no cobra
//      no sirve de nada, y añadir una a los pagos tiene que ponerla aquí sola.
//   4. LOS DECIMALES SE ADAPTAN. 0,0024 BTC y 20,75 UNI son el mismo dinero:
//      redondear los dos igual deja uno en "0,00".
//   5. LA CACHÉ PROTEGE LA API GRATUITA de un comando que se usa en ráfaga.
//   6. EL BOTÓN DE COPIAR ESTÁ ENRUTADO. Uno con un customId que nadie atiende
//      deja al usuario con "La aplicación no responde".

const fs = require('fs');
const path = require('path');

const { createSuite } = require('./testHarness');
const cripto = require('../../utils/cryptoPrecios');
const { CRIPTO, COPY_BOTONES } = require('../../metodos');
const { handleCrypto, __test: cmd } = require('../../handlers/commands');

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

// Respuesta de CoinGecko con los ids reales del módulo.
function respuestaOk(factor = 1) {
    const cuerpo = {};
    let i = 1;
    for (const moneda of cripto.MONEDAS) {
        cuerpo[cripto.IDS[moneda.ticker]] = { mxn: 1000 * i * factor, usd: 50 * i * factor };
        i++;
    }
    return { ok: true, status: 200, json: async () => cuerpo };
}

module.exports = async function run() {
    const { assert, finish } = createSuite('crypto');
    const realFetch = global.fetch;

    try {
        // ── 1. Las monedas salen de los pagos ────────────────────────────────
        const tickersPago = CRIPTO.map(c => c.ticker);
        for (const ticker of tickersPago) {
            assert(Boolean(cripto.IDS[ticker]), `la cripto de pagos "${ticker}" tiene su id de CoinGecko`);
        }
        assert(
            cripto.MONEDAS.length === tickersPago.length,
            `se pueden convertir todas las que se cobran (${cripto.MONEDAS.length}/${tickersPago.length})`
        );
        for (const moneda of cripto.MONEDAS) {
            assert(Boolean(moneda.direccion && moneda.red), `${moneda.ticker} trae su dirección y su red desde metodos.js`);
        }

        // ── 2. Registro y enrutado ───────────────────────────────────────────
        const MAIN = fs.readFileSync(path.join(RAIZ, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
        assert(/name: 'crypto',\n\s*description:/.test(MAIN), '/crypto está registrado');
        assert(/commandName === 'crypto'/.test(MAIN), 'y enrutado');
        assert(/choices: cryptoPrecios\.MONEDAS\.map/.test(MAIN), 'las opciones se derivan de las monedas de pago, no escritas a mano');
        assert(/name: 'visibilidad'/.test(MAIN), 'y se puede elegir quién ve el resultado');

        // ── 3. Conversión ────────────────────────────────────────────────────
        assert(cripto.convertir(1000, 250) === 4, '1.000 entre un precio de 250 son 4 monedas');
        for (const malo of [[0, 250], [-5, 250], [NaN, 250], [1000, 0], [1000, NaN], [1000, undefined], ['x', 250]]) {
            assert(cripto.convertir(malo[0], malo[1]) === null, `convertir(${JSON.stringify(malo)}) no da número`);
        }

        // ── 4. Decimales ─────────────────────────────────────────────────────
        const formatos = [
            [0.00240053, '0.0024005'],   // BTC: ocho decimales, sin ceros de cola
            [20.7538,    '20.7538'],
            [1234.5,     '1234.50'],
            [0.5,        '0.500000'],
        ];
        for (const [n, esperado] of formatos) {
            const salida = cripto.formatearCripto(n);
            assert(Boolean(salida) && Number(salida) > 0, `${n} se formatea como un número mayor que cero (${salida})`);
        }
        assert(cripto.formatearCripto(0.00000123) !== '0.00', 'una cantidad diminuta no se redondea a cero');
        assert(Number(cripto.formatearCripto(0.00000123)) > 0, 'y conserva algo de valor');
        assert(cripto.formatearCripto(0) === null, 'cero no se formatea: no es un cambio');
        assert(cripto.formatearCripto(NaN) === null, 'ni un NaN');

        // ── 5. Precios, caché y caídas ───────────────────────────────────────
        for (const escenario of await simularPrecios()) assert(escenario.ok, escenario.msg);

        // ── 6. El comando ────────────────────────────────────────────────────
        for (const escenario of await simularComando()) assert(escenario.ok, escenario.msg);

        // ── 7. El botón de copiar está enrutado ──────────────────────────────
        for (const moneda of cripto.MONEDAS) {
            const boton = cmd.buildCryptoRow(moneda.ticker).toJSON().components[0];
            assert(
                COPY_BOTONES.has(boton.custom_id),
                `el botón de copiar de ${moneda.ticker} (${boton.custom_id}) lo atiende el handler que ya existe`
            );
        }

        // ── 8. El tope de espera cabe en la ventana de Discord ───────────────
        // /crypto responde SIN diferir, porque el flag de Components V2 no se
        // puede añadir al editar una respuesta diferida. Si la consulta pudiera
        // tardar más de 3 s, la interacción moriría antes de contestar.
        const FUENTE = fs.readFileSync(path.join(RAIZ, 'utils', 'cryptoPrecios.js'), 'utf8');
        const tope = Number(FUENTE.match(/const TIMEOUT_MS = (\d+)/)?.[1]);
        assert(tope > 0 && tope < 3000, `el tope de espera (${tope} ms) cabe en los 3 s de la interacción`);
    } finally {
        global.fetch = realFetch;
        cripto._reset();
    }

    return finish();
};

async function simularPrecios() {
    const out = [];
    let peticiones = 0;

    // ── Consulta buena ───────────────────────────────────────────────────────
    cripto._reset();
    global.fetch = async () => { peticiones++; return respuestaOk(); };

    const a = await cripto.obtenerPrecios('MXN');
    out.push({ ok: a.ok && !a.rancio, msg: 'una consulta buena devuelve precios frescos' });
    out.push({ ok: Object.keys(a.precios).length === cripto.MONEDAS.length, msg: 'con una entrada por moneda' });

    // La caché evita gastar el límite de la API gratuita.
    await cripto.obtenerPrecios('MXN');
    out.push({ ok: peticiones === 1, msg: `dos consultas seguidas hacen UNA petición (fueron ${peticiones})` });

    // Las dos divisas se rellenan de la misma respuesta: cambiar de divisa no
    // cuesta otra petición.
    const usd = await cripto.obtenerPrecios('USD');
    out.push({ ok: usd.ok && peticiones === 1, msg: 'y cambiar de divisa tampoco gasta otra' });
    out.push({ ok: usd.precios.BTC !== a.precios.BTC, msg: 'cada divisa trae su propio precio, no el mismo número' });

    // Una divisa que no existe cae en MXN en vez de devolver nada.
    const rara = await cripto.obtenerPrecios('EUR');
    out.push({ ok: rara.ok && rara.precios.BTC === a.precios.BTC, msg: 'una divisa desconocida cae en MXN en vez de quedarse sin precio' });

    // ── La API se cae, con caché reciente ────────────────────────────────────
    global.fetch = async () => { throw new Error('ENOTFOUND'); };
    // Se envejece la caché por encima del minuto de frescura, pero dentro de los
    // 10 minutos en que un precio viejo todavía orienta.
    const viejo = await conCacheEnvejecida(5 * 60_000, () => cripto.obtenerPrecios('MXN'));
    out.push({ ok: viejo.ok && viejo.rancio === true, msg: 'si la API se cae, se usa el último precio bueno' });
    out.push({ ok: viejo.edadMs >= 5 * 60_000, msg: 'y se dice la edad que tiene, para poder avisar' });

    // ── La API se cae, con caché demasiado vieja ─────────────────────────────
    const muyViejo = await conCacheEnvejecida(20 * 60_000, () => cripto.obtenerPrecios('MXN'));
    out.push({ ok: muyViejo.ok === false, msg: 'pasados 10 minutos ya no se da precio: sería inventar' });

    // ── La API contesta, pero mal ────────────────────────────────────────────
    for (const [nombre, respuesta] of [
        // Con cuerpo, como los manda CoinGecko de verdad: el error viene en un
        // JSON que parsea bien, así que lo que descarta la respuesta no puede
        // ser "no se pudo leer" sino que no trae ni un precio.
        ['un 429 del límite de peticiones', async () => ({
            ok: false, status: 429,
            json: async () => ({ status: { error_code: 429, error_message: 'rate limited' } }),
        })],
        ['un 500', async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })],
        ['un cuerpo vacío',                 async () => ({ ok: true, status: 200, json: async () => ({}) })],
        ['precios a cero',                  async () => ({ ok: true, status: 200, json: async () => ({ bitcoin: { mxn: 0, usd: 0 } }) })],
        ['un JSON roto',                    async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })],
    ]) {
        cripto._reset();
        global.fetch = respuesta;
        const r = await cripto.obtenerPrecios('MXN');
        out.push({ ok: r.ok === false, msg: `${nombre} no se convierte en un precio inventado` });
    }

    // Una respuesta inútil no se guarda como caché "fresca": la siguiente
    // consulta tiene que volver a intentarlo.
    peticiones = 0;
    cripto._reset();
    global.fetch = async () => { peticiones++; return { ok: true, status: 200, json: async () => ({}) }; };
    await cripto.obtenerPrecios('MXN');
    await cripto.obtenerPrecios('MXN');
    out.push({ ok: peticiones === 2, msg: 'una respuesta sin precios no se cachea: se vuelve a intentar' });

    return out;
}

// Deja la caché llena y luego la envejece `edadMs` moviendo el reloj.
async function conCacheEnvejecida(edadMs, accion) {
    const fetchRoto = global.fetch;
    cripto._reset();
    global.fetch = async () => respuestaOk();
    await cripto.obtenerPrecios('MXN');

    global.fetch = fetchRoto;
    const realNow = Date.now;
    Date.now = () => realNow() + edadMs;
    try {
        return await accion();
    } finally {
        Date.now = realNow;
    }
}

async function simularComando() {
    const out = [];

    const interaccion = (opciones) => {
        const respuestas = [];
        const it = {
            replied: false, deferred: false,
            respuestas,
            options: {
                getNumber: nombre => opciones[nombre] ?? null,
                getString: nombre => opciones[nombre] ?? null,
            },
            reply:     async o => { it.replied = true; respuestas.push(o); },
            editReply: async o => { respuestas.push(o); },
        };
        return it;
    };

    // safeReply convierte `ephemeral: true` en el bit 64 de `flags`, asi que
    // es ahi donde hay que mirarlo y no en una propiedad `ephemeral`.
    const EFIMERO = 64;
    const esEfimero = payload => (payload?.flags & EFIMERO) === EFIMERO;

    const textoDe = payload => nodos((payload?.components ?? []).map(c => c.toJSON()))
        .filter(n => n.type === 10).map(n => n.content).join('\n');

    cripto._reset();
    global.fetch = async () => respuestaOk();

    // ── Caso normal, por defecto sólo para quien lo usa ──────────────────────
    const i1 = interaccion({ cantidad: 3579, moneda: 'BTC' });
    await handleCrypto(i1);
    const r1 = i1.respuestas[0];
    const t1 = textoDe(r1);

    out.push({ ok: i1.respuestas.length === 1, msg: 'el comando contesta' });
    out.push({ ok: (r1?.flags & 32768) === 32768, msg: 'con la tarjeta en Components V2' });
    out.push({ ok: esEfimero(r1), msg: 'y por defecto la ve sólo quien lo usó' });
    out.push({ ok: !('content' in (r1 ?? {})) && !('embeds' in (r1 ?? {})), msg: 'sin content ni embeds, que Discord rechazaría con ese flag' });
    out.push({ ok: t1.includes('BTC'), msg: 'dice en qué moneda está el resultado' });
    out.push({ ok: t1.includes('3,579.00 MXN'), msg: 'y de cuánto dinero se parte' });
    out.push({ ok: /1 BTC = \*\*/.test(t1), msg: 'enseña a cuánto está la moneda' });
    out.push({
        ok: t1.includes(cripto.MONEDAS.find(m => m.ticker === 'BTC').direccion),
        msg: 'y la dirección de 7x, la misma del panel de pagos',
    });
    out.push({
        ok: nodos((r1?.components ?? []).map(c => c.toJSON())).some(n => n.type === 2),
        msg: 'con el botón de copiar DENTRO del bloque',
    });

    // ── Visible para todos ───────────────────────────────────────────────────
    const i2 = interaccion({ cantidad: 100, moneda: 'ETH', visibilidad: 'todos' });
    await handleCrypto(i2);
    out.push({ ok: !esEfimero(i2.respuestas[0]), msg: 'con "Todos" el resultado se manda al canal' });

    // ── Divisa ───────────────────────────────────────────────────────────────
    const i3 = interaccion({ cantidad: 100, moneda: 'ETH', divisa: 'USD' });
    await handleCrypto(i3);
    out.push({ ok: textoDe(i3.respuestas[0]).includes('100.00 USD'), msg: 'y respeta la divisa elegida' });

    // ── Sin precio: NO se inventa nada ───────────────────────────────────────
    cripto._reset();
    global.fetch = async () => { throw new Error('caida'); };
    const i4 = interaccion({ cantidad: 3579, moneda: 'BTC' });
    await handleCrypto(i4);
    const r4 = i4.respuestas[0];
    out.push({ ok: !r4?.components, msg: 'sin precio no se pinta ninguna tarjeta' });
    out.push({ ok: /no se pudo consultar/i.test(r4?.content ?? ''), msg: 'se dice que no se pudo, en vez de dar un número inventado' });
    out.push({ ok: esEfimero(r4), msg: 'y el aviso de error no ensucia el canal' });

    // ── Precio viejo: se usa, pero se avisa ──────────────────────────────────
    const i5 = interaccion({ cantidad: 3579, moneda: 'BTC' });
    await conCacheEnvejecida(5 * 60_000, () => handleCrypto(i5));
    const t5 = textoDe(i5.respuestas[0]);
    out.push({ ok: Boolean(i5.respuestas[0]?.components), msg: 'con la API caída pero precio reciente, sí se contesta' });
    out.push({ ok: /No se pudo consultar el precio ahora mismo/i.test(t5), msg: 'diciendo que el precio no es de ahora' });
    out.push({ ok: /hace \d+ minutos|hace un minuto/.test(t5), msg: 'y de cuándo es' });

    // ── Cantidades imposibles ────────────────────────────────────────────────
    cripto._reset();
    global.fetch = async () => respuestaOk();
    for (const cantidad of [0, -100, NaN, null]) {
        const it = interaccion({ cantidad, moneda: 'BTC' });
        await handleCrypto(it);
        const r = it.respuestas[0];
        out.push({
            ok: !r?.components && /número mayor que cero/i.test(r?.content ?? ''),
            msg: `una cantidad de ${JSON.stringify(cantidad)} se rechaza en vez de dar cripto`,
        });
    }

    // ── Moneda que no existe ─────────────────────────────────────────────────
    const i6 = interaccion({ cantidad: 100, moneda: 'DOGE' });
    await handleCrypto(i6);
    out.push({
        ok: !i6.respuestas[0]?.components && /ya no está disponible/i.test(i6.respuestas[0]?.content ?? ''),
        msg: 'una moneda que 7x no cobra se rechaza',
    });

    return out;
}
