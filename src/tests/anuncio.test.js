'use strict';

// Tests del anuncio del servidor: el panel morado del canal de anuncios y el
// botón "Copiar" que lo entrega listo para pegar en OTROS servidores. Sin red y
// sin cliente de Discord.
//
// Lo que protegen es lo que un vistazo al canal NO enseñaría:
//
//   1. EL PRECIO SALE DE data/prices. Es un anuncio: publicar un precio viejo
//      es peor que no publicarlo, y el precio se sube en la tabla, no aquí.
//   2. LAS DOS VERSIONES DICEN LO MISMO. Hay dos textos a propósito (ver 3), y
//      lo fácil es tocar uno y dejar el otro anunciando otra cosa. Los dos
//      salen de VENTAJAS, y esto lo comprueba.
//   3. LA VERSIÓN A REENVIAR NO LLEVA ENLACES OCULTOS. Es la única diferencia
//      real con el panel: `[texto](url)` sólo lo renderiza Discord en mensajes
//      de bot o webhook, y pegado por una persona se imprime con los corchetes
//      a la vista. Devolverle el enlace oculto rompe el anuncio en silencio —
//      aquí se vería bien, y mal en el servidor ajeno.
//   4. EL BOTÓN VA DENTRO DEL BLOQUE Y DEBAJO DEL GIF. Es lo que se pidió, y es
//      lo único que se pierde al volver a un embed clásico.
//   5. EL MENSAJE NO LLEVA content NI embeds. Un mensaje con el flag de
//      Components V2 que los lleve lo RECHAZA Discord entero
//      (MESSAGE_CANNOT_USE_LEGACY_FIELDS_WITH_COMPONENTS_V2) — ya pasó en
//      producción con los tickets, que salían vacíos.
//   6. EL GIF CABE EN EL LÍMITE DE DISCORD. Nueve megas y pico: un banner más
//      pesado deja el anuncio sin publicarse, y el único aviso es la consola.
//   7. REINICIAR NO REPUBLICA. Lo pidió expresamente, y el caso que se escapa
//      es el canal con más de 100 mensajes por encima del anuncio.
//   8. EL BOTÓN ESTÁ ENRUTADO. Un customId sin entrada en HANDLERS deja al
//      usuario con "La aplicación no responde".

const fs = require('fs');
const path = require('path');

const { createSuite } = require('./testHarness');
const config = require('../../config');
const precios = require('../../data/prices');
const v2 = require('../../utils/panelV2');
const { __test: anuncio, handleCopiarAnuncio, ensureAnuncioPanel } = require('../../anuncio');

const RAIZ = path.join(__dirname, '..', '..');

// Todos los nodos de un contenedor ya serializado, en plano y en orden. walk()
// no se exporta desde panelV2, así que se recorre aquí igual que hace él.
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
    const { assert, finish } = createSuite('anuncio');

    const texto    = anuncio.buildTexto();
    const portable = anuncio.buildPortable();
    const json     = anuncio.buildContainer().toJSON();
    const planos   = nodos(json);

    // ── 1. El precio sale de la tabla, no de aquí ────────────────────────────
    const precioReal = precios.lookup(anuncio.REF_ROBUX)?.price;
    assert(Boolean(precioReal), `data/prices tiene precio para ${anuncio.REF_ROBUX} Robux (${precioReal})`);
    assert(anuncio.PRECIO_REF === precioReal, 'el anuncio usa el precio de data/prices, no uno escrito a mano');
    assert(texto.includes(precioReal), `el panel anuncia el precio real (${precioReal})`);
    assert(portable.includes(precioReal), 'y la versión portable anuncia el mismo');

    // Un precio en dólares no sale de ningún sitio comprobable en este repo (no
    // hay tipo de cambio en ninguna parte), así que no puede aparecer inventado.
    assert(!/USD|US\$|d[óo]lar/i.test(texto + portable), 'no anuncia un precio en USD que el bot no sabe calcular');

    // ── 2. Lo que se pidió decir ─────────────────────────────────────────────
    const gancho = /robux\s+baratos/i;
    assert(gancho.test(texto), 'el panel dice que vendemos Robux baratos');
    assert(gancho.test(portable), 'y la versión portable también');

    // El título es un enlace enmascarado a la invitación: eso es lo que pidió,
    // y en un panel del bot Discord sí lo renderiza.
    assert(
        texto.includes(`[${anuncio.TITULO}](${config.INVITE_URL})`),
        'el título del panel es un enlace oculto a la invitación del servidor'
    );
    assert(
        texto.startsWith('# ['),
        'y va como encabezado, que es donde Discord sí pinta los emojis del servidor'
    );

    // ── 3. Las dos versiones no pueden divergir ──────────────────────────────
    assert(anuncio.VENTAJAS.length >= 5, `hay ventajas que anunciar (${anuncio.VENTAJAS.length})`);
    for (const v of anuncio.VENTAJAS) {
        assert(texto.includes(v.texto),    `el panel lista: ${v.texto.slice(0, 40)}…`);
        assert(portable.includes(v.texto), `la portable lista lo mismo: ${v.texto.slice(0, 40)}…`);
    }
    for (const parte of [anuncio.ENTRADA, anuncio.CIERRE]) {
        assert(texto.includes(parte) && portable.includes(parte), `las dos versiones comparten: ${parte.slice(0, 40)}…`);
    }

    // ── 4. La versión a reenviar ─────────────────────────────────────────────
    // Los emojis de 7x van en las DOS: Discord los pinta por id para cualquiera
    // que LEA el mensaje. Lo que pide Nitro es escribirlos fuera del servidor,
    // y eso ya es cosa de quien lo pegue.
    for (const v of anuncio.VENTAJAS) {
        assert(portable.includes(v.emoji), `el texto a reenviar lleva el emoji de 7x de "${v.texto.slice(0, 24)}…"`);
    }

    // Los enlaces enmascarados son cosa de bots y webhooks. Pegado por una
    // persona, `[texto](url)` se imprime con los corchetes a la vista, y no hay
    // Nitro que lo arregle: ésta es la única diferencia real con el panel.
    assert(!/\[[^\]]+\]\(https?:/.test(portable), 'el texto a reenviar no lleva enlaces ocultos (una persona no puede)');
    assert(/\[[^\]]+\]\(https?:/.test(texto), 'el panel sí: ahí lo publica el bot y se ve');
    assert(portable.includes(config.INVITE_URL), 'lleva la invitación a la vista, que es lo que sí funciona');

    // El GIF viaja como URL, y sólo si se le pasa una: es la del mensaje del
    // panel, que va firmada y caduca, así que no puede estar escrita en el
    // código ni inventarse cuando no la hay.
    const conGif = anuncio.buildPortable('https://cdn.discordapp.com/attachments/1/2/7xwidebanner.gif?ex=abc');
    assert(conGif.includes('?ex=abc'), 'si hay URL del GIF, va en el texto para que Discord lo pinte al pegarlo');
    assert(conGif.endsWith('?ex=abc'), 'y va al final, después de la invitación');
    assert(!/cdn\.discordapp/.test(portable), 'sin URL, el texto sale sin GIF en vez de con una caducada a mano');

    // ── 5. El bloque: color, GIF dentro y botón debajo del GIF ───────────────
    assert(json.type === 17, 'el anuncio es un Container (Components V2), no un embed');
    assert(json.accent_color === 0x2B2D31, 'la barra es gris, la misma del resto de paneles del bot');

    const iGaleria = planos.findIndex(n => n.type === 12);
    const iBoton   = planos.findIndex(n => n.type === 2 && n.custom_id === 'anuncio_copiar');
    assert(iBoton !== -1, 'el botón Copiar está DENTRO del bloque');
    if (anuncio.BANNER.exists) {
        assert(iGaleria !== -1, 'el GIF está DENTRO del bloque');
        assert(iGaleria < iBoton, 'y el botón queda debajo del GIF, no encima');
        const url = planos[iGaleria].items?.[0]?.media?.url ?? '';
        assert(url === `attachment://${anuncio.BANNER.name}`, 'el GIF se referencia como adjunto, no por una URL de la CDN que caduca');
    }

    const boton = planos[iBoton];
    assert(boton?.label === 'Copiar', 'el botón se llama Copiar');
    assert(boton?.emoji?.id === '1501213108935332013', 'y lleva el emoji que se pidió');

    // ── 6. El mensaje que se envía ───────────────────────────────────────────
    const payload = anuncio.buildPayload();
    assert((payload.flags & 32768) === 32768, 'el mensaje va con el flag de Components V2');
    // La causa exacta del incidente de los tickets vacíos: con el flag puesto,
    // Discord rechaza TODO el mensaje si lleva content o embeds.
    assert(!('content' in payload) && !('embeds' in payload), 'y sin content ni embeds, que Discord rechazaría');
    if (anuncio.BANNER.exists) {
        assert(payload.files?.[0]?.name === anuncio.BANNER.name, 'el adjunto se llama igual que lo que referencia la galería');
    }

    // ── 7. El GIF cabe en el límite de Discord ────────────────────────────────
    const LIMITE = 10 * 1024 * 1024;
    assert(anuncio.BANNER.exists, '7xwidebanner.gif está en el repo (si no, el anuncio se publica sin GIF)');
    if (anuncio.BANNER.exists) {
        const bytes = fs.statSync(path.join(RAIZ, '7xwidebanner.gif')).size;
        assert(bytes < LIMITE, `el GIF cabe en el límite de subida (${(bytes / 1048576).toFixed(2)} MB < 10 MB)`);
    }

    // ── 8. Reconocer el anuncio publicado ────────────────────────────────────
    const propio = {
        author: { id: 'bot' },
        content: '',
        embeds: [],
        components: [anuncio.buildContainer().toJSON()],
    };
    assert(anuncio.isAnuncioMsg(propio, 'bot'), 'el bot reconoce su propio anuncio al arrancar');
    assert(!anuncio.isAnuncioMsg(propio, 'otro-bot'), 'y no adopta el mensaje de otro autor');
    assert(v2.isUpToDate(propio, anuncio.buildContainer()), 'un anuncio recién publicado ya está al día: no se reedita');

    // ── 9. El botón entrega dos mensajes, y el primero es sólo el anuncio ────
    for (const escenario of await simularBoton()) assert(escenario.ok, escenario.msg);

    // ── 10. El botón está enrutado y atado a su canal ────────────────────────
    const BOTONES = fs.readFileSync(path.join(RAIZ, 'handlers', 'buttons.js'), 'utf8');
    assert(/anuncio_copiar:\s*handleCopiarAnuncio/.test(BOTONES), 'anuncio_copiar está en HANDLERS');
    assert(/ANUNCIO_BUTTONS/.test(BOTONES), 'y guardado para que sólo funcione en el canal del anuncio');
    assert(typeof handleCopiarAnuncio === 'function', 'handleCopiarAnuncio se exporta');

    // ── 11. Reiniciar el bot NO republica el anuncio ─────────────────────────
    for (const escenario of await simularReinicios()) assert(escenario.ok, escenario.msg);

    return finish();
};

// ── El botón ─────────────────────────────────────────────────────────────────
// Interacción falsa: lo justo para ver el orden de las llamadas.

async function simularBoton() {
    const anuncio = require('../../anuncio').__test;
    const { handleCopiarAnuncio } = require('../../anuncio');
    const out = [];
    const EFIMERO = 64;

    // El clic llega con el mensaje del panel dentro, y ahí van los adjuntos con
    // la URL recién firmada. De ahí sale la del GIF.
    const URL_GIF = 'https://cdn.discordapp.com/attachments/155/999/7xwidebanner-ab12cd34.gif?ex=68f&is=68e&hm=deadbeef';
    const clic = adjuntos => {
        const llamadas = [];
        const interaction = {
            replied: false,
            deferred: false,
            message: { attachments: { first: () => adjuntos } },
            reply: async opciones => { interaction.replied = true; llamadas.push(opciones); },
            editReply: async opciones => { llamadas.push(opciones); },
        };
        return { interaction, llamadas };
    };

    const a = clic({ url: URL_GIF });
    await handleCopiarAnuncio(a.interaction);

    out.push({ ok: a.llamadas.length === 1, msg: `el botón entrega UN solo mensaje (fueron ${a.llamadas.length})` });
    out.push({ ok: (a.llamadas[0]?.flags & EFIMERO) === EFIMERO, msg: 'y es efímero: no vuelve a llenar el canal' });
    out.push({ ok: !a.llamadas[0]?.files, msg: 'sin adjuntos: el GIF viaja como enlace, no como 9 MB por clic' });
    out.push({
        ok: a.llamadas[0]?.content === anuncio.buildPortable(URL_GIF),
        msg: 'el mensaje es EXACTAMENTE el anuncio a reenviar, con el enlace del GIF',
    });
    out.push({ ok: a.llamadas[0]?.content?.includes(URL_GIF), msg: 'y la URL del GIF sale del mensaje del panel, no escrita a mano' });

    // Panel sin adjunto (el GIF no estaba al publicarlo): el anuncio sale igual,
    // sin GIF, en vez de con un "undefined" pegado al final.
    const b = clic(undefined);
    await handleCopiarAnuncio(b.interaction);
    out.push({
        ok: b.llamadas[0]?.content === anuncio.buildPortable(),
        msg: 'sin adjunto en el panel, el anuncio sale sin GIF y sin romperse',
    });
    out.push({ ok: !/undefined|null/.test(b.llamadas[0]?.content ?? ''), msg: 'y sin un undefined pegado al final' });

    // Interacción ya caducada: ni un throw.
    let exploto = false;
    try { await handleCopiarAnuncio({ replied: true, reply: async () => { throw new Error('no debería'); } }); }
    catch { exploto = true; }
    out.push({ ok: !exploto, msg: 'una interacción ya respondida no revienta el handler' });

    return out;
}

// ── El arranque ──────────────────────────────────────────────────────────────
// Canal de Discord falso: lo justo para que ensureAnuncioPanel funcione.

function canalFalso(BOT_ID) {
    const mensajes = [];
    let n = 0;
    const canal = {
        id: config.CHANNELS.ANUNCIO,
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
    const BOT_ID = 'bot-de-prueba';
    const nuevo = () => {
        const canal = canalFalso(BOT_ID);
        const client = { user: { id: BOT_ID }, channels: { cache: new Map([[canal.id, canal]]), fetch: async () => canal } };
        return { canal, client };
    };

    const out = [];

    // Cuatro arranques seguidos sin cambiar nada: un anuncio y ni un edit (que
    // resubiría 9 MB de GIF en cada arranque para nada).
    const a = nuevo();
    for (let i = 0; i < 4; i++) await ensureAnuncioPanel(a.client);
    out.push({ ok: a.canal.enviados === 1, msg: `4 arranques seguidos publican UN anuncio (fueron ${a.canal.enviados})` });
    out.push({ ok: a.canal.editados === 0, msg: 'y no reeditan nada: el GIF no se resube en cada arranque' });
    out.push({ ok: a.canal.id === '1553268998765023293', msg: 'y va al canal de anuncios que se pidió' });

    // El anuncio enterrado bajo mensajes de gente. 150 y 400 son justo los casos
    // que se escapaban al mirar sólo los últimos 100 mensajes.
    for (const ruido of [99, 150, 400]) {
        const { canal, client } = nuevo();
        await ensureAnuncioPanel(client);
        canal.ruido(ruido);
        await ensureAnuncioPanel(client);
        out.push({ ok: canal.enviados === 1, msg: `con ${ruido} mensajes encima, el reinicio no duplica el anuncio` });
    }

    // Sin poder leer los fijados (permisos, versión de discord.js): tiene que
    // caer al barrido de los últimos 100 y seguir encontrándolo.
    const b = nuevo();
    await ensureAnuncioPanel(b.client);
    b.canal.sinFetchPins = true;
    b.canal.ruido(20);
    await ensureAnuncioPanel(b.client);
    out.push({ ok: b.canal.enviados === 1, msg: 'sin acceso a los fijados, el respaldo de 100 mensajes lo encuentra igual' });

    // Alguien lo desfija a mano: se reaprovecha y se vuelve a fijar.
    const c = nuevo();
    await ensureAnuncioPanel(c.client);
    c.canal.despinnear();
    await ensureAnuncioPanel(c.client);
    out.push({ ok: c.canal.enviados === 1, msg: 'un anuncio desfijado a mano se reaprovecha en vez de duplicarse' });

    // Canal que no existe (borrado, o el bot sin acceso): se omite y sigue.
    const sinCanal = { user: { id: BOT_ID }, channels: { cache: new Map(), fetch: async () => { throw new Error('404'); } } };
    let exploto = false;
    try { await ensureAnuncioPanel(sinCanal); } catch { exploto = true; }
    out.push({ ok: !exploto, msg: 'un canal inaccesible no tumba el arranque del bot' });

    return out;
}
