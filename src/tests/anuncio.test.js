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
//   3. LA VERSIÓN PORTABLE NO LLEVA EMOJIS DEL SERVIDOR NI ENLACES OCULTOS. Es
//      la razón de que exista: pegados por una PERSONA, Discord imprime los dos
//      en crudo. "Simplificar" esto a un solo texto rompe justo lo que el botón
//      promete, y en silencio: aquí se ve bien, y mal en el servidor ajeno.
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

    // ── 4. La versión portable es realmente portable ──────────────────────────
    // Los emojis del servidor sólo se ven para quien tenga Nitro Y esté en el
    // servidor de origen: en un mensaje pegado por una persona, para el resto
    // quedan como `<:sale:1501…>` en crudo.
    assert(!/<a?:\w+:\d+>/.test(portable), 'la versión portable no lleva emojis del servidor (se verían en crudo fuera)');
    assert(/<a?:\w+:\d+>/.test(texto), 'el panel sí los lleva: ahí los publica el bot y se ven');

    // Los enlaces enmascarados son cosa de bots y webhooks. Pegado por una
    // persona, `[texto](url)` se imprime con los corchetes a la vista.
    assert(!/\[[^\]]+\]\(https?:/.test(portable), 'la versión portable no lleva enlaces ocultos (una persona no puede)');
    assert(portable.includes(config.INVITE_URL), 'lleva la invitación a la vista, que es lo que sí funciona');

    // Que no arrastre la explicación: el aviso va en OTRO mensaje para que el
    // "Copiar texto" de Discord entregue el anuncio y nada más.
    assert(!portable.includes(anuncio.AVISO_COPIAR), 'el texto a reenviar no incluye el aviso de cómo usarlo');

    // Los emojis Unicode sustituyen a los del servidor uno a uno.
    for (const v of anuncio.VENTAJAS) {
        assert(Boolean(v.unicode) && !/<a?:/.test(v.unicode), `"${v.texto.slice(0, 24)}…" tiene su emoji Unicode de repuesto`);
    }

    // ── 5. El bloque: color, GIF dentro y botón debajo del GIF ───────────────
    assert(json.type === 17, 'el anuncio es un Container (Components V2), no un embed');
    assert(json.accent_color === anuncio.ACCENT, 'conserva el morado de 7x');

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
    const llamadas = [];
    const interaction = {
        replied: false,
        deferred: false,
        deferReply: async opciones => { interaction.deferred = true; llamadas.push({ tipo: 'defer', opciones }); },
        editReply: async opciones => { llamadas.push({ tipo: 'edit', opciones }); },
        followUp: async opciones => { llamadas.push({ tipo: 'followUp', opciones }); },
        reply: async opciones => { interaction.replied = true; llamadas.push({ tipo: 'reply', opciones }); },
    };

    await require('../../anuncio').handleCopiarAnuncio(interaction);

    const out = [];
    const EFIMERO = 64;

    // Subir 9 MB no cabe en los 3 segundos que da Discord antes de invalidar el
    // token: sin diferir, la respuesta se pierde con "Unknown interaction".
    out.push({ ok: llamadas[0]?.tipo === 'defer', msg: 'el botón difiere antes de subir el GIF (9 MB no caben en 3 s)' });
    // El efímero se decide al diferir y al hacer followUp; el editReply de en
    // medio hereda el del defer y no vuelve a pedirlo.
    out.push({
        ok: llamadas
            .filter(l => l.tipo === 'defer' || l.tipo === 'followUp')
            .every(l => (l.opciones?.flags & EFIMERO) === EFIMERO),
        msg: 'todo lo que entrega es efímero: no vuelve a llenar el canal',
    });

    const primero = llamadas.find(l => l.tipo === 'edit');
    out.push({ ok: primero?.opciones?.content === anuncio.buildPortable(), msg: 'el primer mensaje es EXACTAMENTE el anuncio a reenviar' });
    out.push({ ok: !primero?.opciones?.files, msg: 'y sin adjuntos, para que "Copiar texto" entregue sólo el texto' });

    const segundo = llamadas.find(l => l.tipo === 'followUp');
    out.push({ ok: segundo?.opciones?.content === anuncio.AVISO_COPIAR, msg: 'el segundo lleva el aviso de cómo usarlo' });
    out.push({
        ok: !anuncio.BANNER.exists || Boolean(segundo?.opciones?.files?.length),
        msg: 'y el GIF adjunto, no una URL de la CDN que caduca',
    });

    // Interacción ya caducada: ni un throw, y no se intenta responder igual.
    const muerta = { replied: true, deferred: false, deferReply: async () => { throw new Error('no debería'); } };
    let exploto = false;
    try { await require('../../anuncio').handleCopiarAnuncio(muerta); } catch { exploto = true; }
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
