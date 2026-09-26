'use strict';

// Tests del ticket de alianza: el botón del panel, el ticket que abre, los
// tres campos que se rellenan y el "Completado" que lo manda a revisión. Sin
// red y sin cliente de Discord.
//
// Lo que protegen es lo que costaría caro y no se ve mirando el canal:
//
//   1. EL TIPO DE TICKET ES 'alianza', NO 'comprar'. De 'comprar' cuelga TODO
//      el flujo de pago: el botón de "PAGO REALIZADO" del owner, el registro de
//      pedidos y el ranking de compradores. Un ticket de alianza marcado como
//      compra se colaría en el ranking con 0 Robux y le ofrecería pagar a
//      alguien que no compra nada.
//   2. EL MÍNIMO DE MIEMBROS SALE DE config. Se dice en tres sitios (el panel,
//      la respuesta al pegar el enlace y la tarjeta del staff) y tiene que
//      cambiar en los tres a la vez.
//   3. NADA SE RECHAZA SOLO. Un servidor por debajo del mínimo, una invitación
//      que Discord no contesta o un fallo de red NO pueden convertirse en un
//      "no": quien acepta una alianza es una persona.
//   4. LOS CAMPOS DEL ALMACÉN Y LOS BOTONES SON LOS MISMOS. Añadir un campo y
//      olvidar su botón lo dejaría imposible de rellenar, y "Completado" lo
//      pediría para siempre.
//   5. COMPLETADO EXIGE LOS TRES CAMPOS Y LA CAPTURA, y no se envía dos veces.
//   6. LA CAPTURA SE RESUBE. Las URLs de adjuntos de Discord van firmadas y
//      caducan: enlazarla dejaría al staff sin imagen justo al revisarla.
//   7. EL MENSAJE NO LLEVA content NI embeds. Con el flag de Components V2,
//      Discord rechaza el mensaje entero — ya pasó con los tickets de compra.

const fs = require('fs');
const path = require('path');

const { createSuite } = require('./testHarness');
const config = require('../../config');
const { dataPath } = require('../../utils/dataDir');
const alianzas = require('../../utils/alianzas');
const { extraerCodigo, fetchInvite } = require('../../utils/discordInvite');
const { __test: flujo, handleAlianzaModal, handleAlianzaButton, startAlianzaTicket } = require('../../handlers/alianzaFlow');

const RAIZ = path.join(__dirname, '..', '..');
const ESTADO_FILE = dataPath('alianzas.json');

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
    const { assert, finish } = createSuite('alianza');

    // Salvaguarda: run.js redirige DATA_DIR a un temporal. Este bloque escribe
    // estado, y contra el ./data real dejaría tickets inventados en el bot de
    // esta máquina.
    assert(
        !path.resolve(ESTADO_FILE).startsWith(path.resolve(RAIZ, 'data')),
        'el estado de prueba va a un DATA_DIR temporal, nunca al ./data del proyecto'
    );
    if (fs.existsSync(ESTADO_FILE)) fs.unlinkSync(ESTADO_FILE);

    // ── 1. El botón del panel ────────────────────────────────────────────────
    const PANEL = fs.readFileSync(path.join(RAIZ, 'panel.js'), 'utf8');
    const orden = [...PANEL.matchAll(/setCustomId\('([a-z_]+)'\)/g)].map(m => m[1]);
    assert(orden.includes('alianza'), 'el panel de tickets tiene el botón de Alianza');
    assert(
        orden.indexOf('alianza') === orden.indexOf('comprar') + 1,
        `el botón va justo después de Comprar (orden: ${orden.join(', ')})`
    );
    // Discord no admite más de 5 botones por fila: el sexto haría que el panel
    // entero dejara de publicarse.
    assert(orden.length <= 5, `caben en una fila de Discord (${orden.length}/5)`);
    assert(PANEL.includes('1553269490748366928'), 'usa el emoji de alianza que se pidió');

    // ── 2. Enrutado y guardas ────────────────────────────────────────────────
    const BOTONES = fs.readFileSync(path.join(RAIZ, 'handlers', 'buttons.js'), 'utf8');
    const MODALES = fs.readFileSync(path.join(RAIZ, 'handlers', 'modals.js'), 'utf8');

    assert(/alianza:\s*startAlianzaTicket/.test(BOTONES), 'el botón del panel está enrutado');
    assert(/isAli\s*\?\s*handleAlianzaButton/.test(BOTONES), 'los botones ali_* están enrutados');
    assert(/isAli\s*\?\s*handleAlianzaModal/.test(MODALES), 'los modales ali_modal_* están enrutados');
    assert(/PANEL_BUTTONS\s*=\s*new Set\(\[[^\]]*'alianza'/.test(BOTONES), 'el botón solo abre ticket desde el panel oficial');
    assert(
        /startsWith\('ali_'\) && !isTicketChannel/.test(BOTONES),
        'los botones ali_* solo funcionan dentro de un ticket'
    );

    // El tipo de ticket: lo que impide que se cuele en el flujo de pago.
    const FLUJO = fs.readFileSync(path.join(RAIZ, 'handlers', 'alianzaFlow.js'), 'utf8');
    assert(/createTicket\([^)]*'alianza'/.test(FLUJO), "el ticket se crea con tipo 'alianza', no 'comprar'");
    assert(
        /getType\(interaction\.channel\) !== 'comprar'/.test(BOTONES),
        'y el botón de confirmar pago sigue rechazando cualquier tipo que no sea compra'
    );

    // ── 3. Lo que dice el panel del ticket ───────────────────────────────────
    const texto = flujo.buildTexto({});
    const pide = [
        [/gaming/i,                        'pide comunidad de gaming'],
        [/1\.000|1,000/,                   'pide más de 1.000 miembros'],
        [/enlace/i,                        'pide el enlace de su comunidad'],
        [/vendan Robux/i,                  'deja claro que no entran servidores que vendan Robux'],
        [/pornograf/i,                     'deja claro que no entra pornografía'],
        [/ilícit/i,                        'ni actividades ilícitas'],
        [/subido de tono/i,                'ni contenido subido de tono'],
        [/socializaci/i,                   'sí entran comunidades de socialización'],
        [/ambiente/i,                      'y de ambiente'],
        [/roleplay/i,                      'y de roleplay'],
        [/otros productos/i,               'y de venta de otros productos'],
        [/captura/i,                       'pide la captura de dónde publicaron nuestro anuncio'],
    ];
    for (const [re, msg] of pide) assert(re.test(texto), msg);

    assert(texto.includes(`<#${config.CHANNELS.ALIANZA}>`), 'enlaza el canal donde se publicará su mensaje');
    assert(texto.includes(`<#${config.CHANNELS.ANUNCIO}>`), 'y el canal de donde tienen que copiar nuestro anuncio');

    // El mínimo sale de config: escrito a mano en el texto, cambiarlo en config
    // dejaría el panel pidiendo otra cosa que la que comprueba el bot.
    assert(flujo.MIN_MIEMBROS === config.ALIANZA.MIN_MIEMBROS, 'el mínimo de miembros sale de config');
    assert(
        texto.includes(config.ALIANZA.MIN_MIEMBROS.toLocaleString('es-MX')),
        'y es el que se anuncia en el panel'
    );

    // ── 4. Campos y botones, la misma lista ──────────────────────────────────
    assert(alianzas.CAMPOS.length === 3, `hay tres campos que rellenar (${alianzas.CAMPOS.join(', ')})`);
    for (const campo of alianzas.CAMPOS) {
        assert(Boolean(flujo.PRESENTACION[campo]), `el campo "${campo}" tiene botón y modal`);
    }
    assert(
        Object.keys(flujo.PRESENTACION).length === alianzas.CAMPOS.length,
        'y no hay botones de campos que el almacén no conozca'
    );

    const filas = flujo.buildFilas({}).map(f => f.toJSON().components);
    const ids = filas.flat().map(b => b.custom_id);
    for (const campo of alianzas.CAMPOS) assert(ids.includes(`ali_${campo}`), `botón ali_${campo} presente`);
    assert(ids.includes('ali_completado'), 'botón de Completado presente');
    // Reutiliza el customId de siempre: así lo atiende el cierre con
    // confirmación que ya existe, en vez de un cierre paralelo sin confirmar.
    assert(ids.includes('cerrar_ticket'), 'botón de cerrar ticket, con el customId que ya usa el resto del bot');
    for (const fila of filas) assert(fila.length <= 5, 'ninguna fila pasa de 5 botones');

    const emojis = filas.flat().map(b => b.emoji?.id).filter(Boolean);
    for (const id of ['1553269490748366928', '1544121889629405224', '1544121575752728631', '1547108520669741157']) {
        assert(emojis.includes(id), `usa el emoji ${id} que se pidió`);
    }

    // ── 5. El panel es un bloque V2 con los botones dentro ───────────────────
    const json = flujo.buildPanel('123', {}).toJSON();
    const planos = nodos(json);
    assert(json.type === 17, 'el panel del ticket es un Container, no un embed');
    assert(json.accent_color === flujo.ACCENT, 'con la barra gris del resto de paneles');
    assert(planos.some(n => n.type === 2 && n.custom_id === 'ali_completado'), 'los botones van DENTRO del bloque');
    assert(
        planos.some(n => n.type === 10 && n.content.includes('<@123>')),
        'la mención va dentro del texto, no como content (Discord rechaza content con el flag V2)'
    );

    // ── 6. Marcas de pendiente / listo ───────────────────────────────────────
    const lleno = flujo.buildTexto({ mensaje: 'x', link: 'y', descripcion: 'z' });
    assert((texto.match(/pendiente/g) ?? []).length >= 3, 'un ticket recién abierto marca los tres campos como pendientes');
    assert(!/— pendiente/.test(lleno), 'y con todo relleno no queda ninguno pendiente');
    assert(lleno.includes('1547108520669741157'), 'lo hecho se marca con el emoji que se pidió');

    // El botón cambia de estilo cuando su campo ya está: Primary (azul) llama a
    // rellenarlo, Secondary dice que ya está hecho.
    const relleno = flujo.buildFilas({ mensaje: 'x' })[0].toJSON().components;
    const btnMensaje = relleno.find(b => b.custom_id === 'ali_mensaje');
    const btnLink    = relleno.find(b => b.custom_id === 'ali_link');
    assert(btnMensaje.style !== btnLink.style, 'un campo ya relleno se distingue del que falta por el color del botón');

    // ── 7. El almacén ────────────────────────────────────────────────────────
    const CH = '999000111222333444';
    assert(alianzas.faltantes(CH).length === 3, 'un ticket nuevo tiene los tres campos pendientes');
    assert(!alianzas.estaCompleto(CH), 'y no está completo');

    assert(alianzas.setCampo(CH, 'mensaje', '  Somos gaming  '), 'se guarda un campo');
    assert(alianzas.get(CH).mensaje === 'Somos gaming', 'y se guarda recortado');
    assert(!alianzas.setCampo(CH, 'mensaje', '   '), 'un campo en blanco no se guarda');
    assert(alianzas.get(CH).mensaje === 'Somos gaming', 'y no pisa lo que ya había');
    // El customId viaja por Discord: nada que no esté en CAMPOS entra al fichero.
    assert(!alianzas.setCampo(CH, 'admin', 'true'), 'un campo inventado no se guarda');
    assert(alianzas.get(CH).admin === undefined, 'y no aparece en el fichero');

    assert(alianzas.faltantes(CH).join(',') === 'link,descripcion', 'faltantes respeta el orden en que se piden');
    alianzas.setCampo(CH, 'link', 'https://discord.gg/x');
    alianzas.setCampo(CH, 'descripcion', 'roleplay');
    assert(alianzas.estaCompleto(CH), 'con los tres, el ticket está completo');

    // Persiste de verdad: el bot se reinicia en cada despliegue y los tickets
    // duran días.
    assert(fs.existsSync(ESTADO_FILE), 'lo rellenado va a disco');
    delete require.cache[require.resolve('../../utils/alianzas')];
    const recargado = require('../../utils/alianzas');
    assert(recargado.estaCompleto(CH), 'y sigue ahí tras reiniciar el proceso');

    assert(recargado.borrar(CH), 'cerrar el ticket borra lo suyo');
    assert(recargado.faltantes(CH).length === 3, 'y no deja rastro');
    assert(!recargado.borrar(CH), 'borrar dos veces no miente diciendo que borró algo');

    // Fichero corrupto: el ticket sale vacío, no revienta al pintar el panel.
    fs.writeFileSync(ESTADO_FILE, '{no soy json', 'utf8');
    assert(recargado.get(CH) && Object.keys(recargado.get(CH)).length === 0, 'un fichero corrupto deja el ticket vacío en vez de romperse');
    fs.unlinkSync(ESTADO_FILE);

    // ── 8. El enlace de invitación ───────────────────────────────────────────
    const formas = [
        ['https://discord.gg/abc123',            'abc123'],
        ['discord.gg/abc123',                    'abc123'],
        ['https://discord.com/invite/abc123',    'abc123'],
        ['https://discordapp.com/invite/abc123', 'abc123'],
        ['  abc123  ',                           'abc123'],
        ['no es un link !!',                     null],
        ['',                                     null],
        [null,                                   null],
    ];
    for (const [entrada, esperado] of formas) {
        assert(extraerCodigo(entrada) === esperado, `extraerCodigo(${JSON.stringify(entrada)}) = ${esperado}`);
    }

    for (const escenario of await simularInvitaciones()) assert(escenario.ok, escenario.msg);

    // Nada se rechaza solo: por debajo del mínimo se dice, pero se deja seguir.
    const pequeno = flujo.textoLink({ ok: true, nombre: 'Chico', miembros: 300 });
    assert(pequeno.includes('300'), 'un servidor pequeño ve su número real');
    assert(/revisa una persona/i.test(pequeno), 'y se le dice que decide una persona, no el bot');
    const caido = flujo.textoLink({ ok: false, error: 'desconocido' });
    assert(/no se pudo comprobar/i.test(caido), 'un fallo de red queda en "no se pudo comprobar"');
    assert(!/no cumple|rechaz/i.test(caido), 'y nunca en un rechazo');

    // ── 9. Los modales ───────────────────────────────────────────────────────
    for (const campo of alianzas.CAMPOS) {
        const modal = flujo.buildCampoModal(campo).toJSON();
        assert(modal.custom_id === `ali_modal_${campo}`, `el modal de ${campo} tiene su customId`);
        const input = modal.components[0].components[0];
        assert(input.custom_id === 'valor', 'el campo de texto siempre se llama igual');
        assert(input.label.length <= 45, `la etiqueta cabe en el límite de Discord (${input.label.length}/45)`);
        assert(input.placeholder.length <= 100, 'y el placeholder también');
        assert(input.required === true, 'y es obligatorio');
    }

    // ── 10. El flujo completo ────────────────────────────────────────────────
    for (const escenario of await simularFlujo()) assert(escenario.ok, escenario.msg);

    // ── 11. Aceptar la alianza (solo owner) ──────────────────────────────────
    for (const escenario of await simularAceptacion()) assert(escenario.ok, escenario.msg);

    if (fs.existsSync(ESTADO_FILE)) fs.unlinkSync(ESTADO_FILE);
    return finish();
};

// ── fetchInvite con la red simulada ──────────────────────────────────────────
// fetchInvite usa el fetch global, así que se sustituye por uno de mentira: los
// tests no tocan la red.

async function simularInvitaciones() {
    const real = global.fetch;
    const out = [];

    const con = async respuesta => {
        global.fetch = async () => respuesta();
        return fetchInvite('https://discord.gg/abc123');
    };

    try {
        const ok = await con(() => ({
            ok: true, status: 200,
            json: async () => ({ approximate_member_count: 4200, approximate_presence_count: 130, guild: { id: '7', name: 'Mi Server' } }),
        }));
        out.push({ ok: ok.ok && ok.miembros === 4200 && ok.nombre === 'Mi Server', msg: 'una invitación buena devuelve nombre y miembros' });

        const noExiste = await con(() => ({ ok: false, status: 404 }));
        out.push({ ok: noExiste.error === 'invalida', msg: 'una invitación caducada o mal escrita sale como inválida' });

        const limite = await con(() => ({ ok: false, status: 429 }));
        out.push({ ok: limite.error === 'desconocido', msg: 'un límite de peticiones NO es una invitación inválida' });

        const explota = await con(() => { throw new Error('ENOTFOUND'); });
        out.push({ ok: explota.error === 'desconocido' && explota.ok !== true, msg: 'un fallo de red no lanza: sale como "no se pudo comprobar"' });

        const sinCuenta = await con(() => ({ ok: true, status: 200, json: async () => ({ guild: { name: 'X' } }) }));
        out.push({ ok: sinCuenta.ok && sinCuenta.miembros === null, msg: 'sin recuento, miembros es null y no 0 (que diría "servidor vacío")' });
    } finally {
        global.fetch = real;
    }

    return out;
}

// ── El ticket, de principio a fin ────────────────────────────────────────────

function canalFalso(userId, { mensajes = [], id = '555000111222333444' } = {}) {
    const enviados = [];
    const canal = {
        id,
        parentId: config.CATEGORIES.TICKETS,
        topic: config.TOPIC_PREFIX + JSON.stringify({ userId, type: 'alianza', ts: Date.now() }),
        enviados,
        editados: [],
        messages: {
            fetch: async arg => {
                if (typeof arg === 'string') {
                    const m = mensajes.find(x => x.id === arg);
                    if (!m) throw new Error('Unknown Message');
                    return m;
                }
                return new Map(mensajes.map(m => [m.id, m]));
            },
        },
        send: async payload => {
            enviados.push(payload);
            const n = enviados.length;
            return { id: `env${n}`, url: `https://discord.com/channels/1/${id}/env${n}` };
        },
    };
    return canal;
}

function interaccionFalsa(canal, userId, extra = {}) {
    const respuestas = [];
    const it = {
        replied: false,
        deferred: false,
        user: { id: userId },
        channel: canal,
        channelId: canal.id,
        respuestas,
        reply:     async o => { it.replied = true;  respuestas.push({ tipo: 'reply', ...o }); },
        editReply: async o => { respuestas.push({ tipo: 'edit', ...o }); },
        deferReply: async o => { it.deferred = true; respuestas.push({ tipo: 'defer', ...o }); },
        ...extra,
    };
    return it;
}

function mensajeConImagen(id, autorId, tipo = 'image/png') {
    return {
        id,
        author: { id: autorId },
        attachments: new Map([['a', { url: 'https://cdn.discordapp.com/attachments/1/2/foto.png?ex=abc', contentType: tipo }]]),
    };
}

async function simularFlujo() {
    const out = [];
    const USER = '620310742138224661';   // un id real de admin, sirve igual
    const CH = '555000111222333444';
    const real = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ approximate_member_count: 5000, guild: { name: 'Aliado' } }) });

    try {
        alianzas.borrar(CH);

        // Completado sin nada relleno: no se envía, y dice QUÉ falta.
        const canal1 = canalFalso(USER);
        const i1 = interaccionFalsa(canal1, USER, { customId: 'ali_completado' });
        await handleAlianzaButton(i1);
        const r1 = i1.respuestas[0];
        out.push({ ok: canal1.enviados.length === 0, msg: 'Completado sin rellenar nada no manda la solicitud' });
        out.push({
            ok: /Mensaje de alianza/.test(r1?.content ?? '') && /Link del servidor/.test(r1?.content ?? ''),
            msg: 'y dice exactamente qué campos faltan',
        });

        // Se rellena todo por modal.
        for (const [campo, valor] of [['mensaje', 'Somos una comunidad gaming'], ['descripcion', 'Roleplay y torneos'], ['link', 'https://discord.gg/aliado']]) {
            const canal = canalFalso(USER, { mensajes: [] });
            const it = interaccionFalsa(canal, USER, {
                customId: `ali_modal_${campo}`,
                fields: { getTextInputValue: () => valor },
            });
            await handleAlianzaModal(it);
        }
        out.push({ ok: alianzas.estaCompleto(CH), msg: 'los tres modales dejan el ticket completo' });

        // Completado sin captura: sigue sin enviarse.
        const canal2 = canalFalso(USER, { mensajes: [] });
        const i2 = interaccionFalsa(canal2, USER, { customId: 'ali_completado' });
        await handleAlianzaButton(i2);
        out.push({ ok: canal2.enviados.length === 0, msg: 'sin la captura del paso 2 tampoco se manda' });
        out.push({
            ok: /captura/i.test(i2.respuestas.map(r => r.content ?? '').join(' ')),
            msg: 'y se le pide la captura, no un error genérico',
        });

        // Con captura: se manda la tarjeta de revisión.
        const foto = mensajeConImagen('m1', USER);
        const canal3 = canalFalso(USER, { mensajes: [foto] });
        const i3 = interaccionFalsa(canal3, USER, { customId: 'ali_completado' });
        await handleAlianzaButton(i3);

        const tarjeta = canal3.enviados[0];
        out.push({ ok: canal3.enviados.length === 1, msg: 'con todo relleno y la captura, se manda la solicitud a revisión' });
        out.push({ ok: !('content' in (tarjeta ?? {})) && !('embeds' in (tarjeta ?? {})), msg: 'y sin content ni embeds, que Discord rechazaría con el flag V2' });

        const planos = nodos((tarjeta?.components ?? []).map(c => c.toJSON()));
        const textoTarjeta = planos.filter(n => n.type === 10).map(n => n.content).join('\n');
        out.push({ ok: /REVISI/i.test(textoTarjeta), msg: 'la tarjeta dice que está en revisión' });
        out.push({ ok: textoTarjeta.includes('Roleplay y torneos'), msg: 'y enseña de qué trata su servidor' });
        out.push({ ok: textoTarjeta.includes('Somos una comunidad gaming'), msg: 'y el mensaje que publicaríamos' });
        out.push({ ok: textoTarjeta.includes('5,000'), msg: 'y los miembros que tiene de verdad, sacados de la invitación' });
        out.push({ ok: textoTarjeta.includes(`<@${config.OWNER_ID}>`), msg: 'y avisa al staff' });

        // La captura se RESUBE: las URLs de adjuntos caducan.
        const galeria = planos.find(n => n.type === 12);
        const url = galeria?.items?.[0]?.media?.url ?? '';
        out.push({ ok: url.startsWith('attachment://'), msg: 'la captura se resube como adjunto, no se enlaza a una URL que caduca' });
        out.push({ ok: Boolean(tarjeta?.files?.length), msg: 'y el fichero viaja con el mensaje' });

        // Segundo clic: no se manda otra vez.
        const canal4 = canalFalso(USER, { mensajes: [foto] });
        const i4 = interaccionFalsa(canal4, USER, { customId: 'ali_completado' });
        await handleAlianzaButton(i4);
        out.push({ ok: canal4.enviados.length === 0, msg: 'pulsar Completado dos veces no manda dos solicitudes' });
        out.push({
            ok: /revisi/i.test(i4.respuestas.map(r => r.content ?? '').join(' ')),
            msg: 'y se le dice que ya está en revisión',
        });

        // Alguien que no es el dueño del ticket no puede tocarlo.
        const canal5 = canalFalso(USER, { mensajes: [foto] });
        const i5 = interaccionFalsa(canal5, '111111111111111111', { customId: 'ali_mensaje' });
        await handleAlianzaButton(i5);
        out.push({
            ok: /Solo quien abrió el ticket/.test(i5.respuestas[0]?.content ?? ''),
            msg: 'un tercero no puede rellenar el ticket de otro',
        });

        alianzas.borrar(CH);
    } finally {
        global.fetch = real;
    }

    return out;
}

// ── Aceptar la alianza ───────────────────────────────────────────────────────
// Lo que se protege aquí es lo que sale del ticket y llega al servidor entero:
// quién puede publicar, qué se publica y que no se publique dos veces.

function tarjetaDeRevisionFalsa() {
    // Como la que deja onCompletado: texto, la captura en una galería y la fila
    // con el botón de aceptar.
    const contenedor = {
        type: 17,
        accent_color: 0x2B2D31,
        components: [
            { type: 10, content: '## SOLICITUD DE ALIANZA — EN REVISIÓN\nDe: <@1>' },
            { type: 12, items: [{ media: { url: 'https://cdn.discordapp.com/attachments/1/2/captura.png' } }] },
            { type: 1, components: [{ type: 2, custom_id: 'ali_aceptar', label: 'Aceptar alianza', style: 3 }] },
        ],
    };
    const msg = {
        id: 'rev1',
        editado: null,
        components: [contenedor],
        content: '',
        embeds: [],
        edit: async payload => { msg.editado = payload; return msg; },
        delete: async () => {},
    };
    return msg;
}

async function simularAceptacion() {
    const { __test: flujo, handleAlianzaButton } = require('../../handlers/alianzaFlow');
    const OWNER = config.OWNER_ID;
    const AJENO = '111111111111111111';
    const SOLICITANTE = '222222222222222222';
    const out = [];

    const real = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ approximate_member_count: 5000, guild: { name: 'Aliado RP' } }) });

    // El canal de aliados y el cliente que lo devuelve.
    const nuevoEntorno = (chId, { conCanalAlly = true } = {}) => {
        const ally = canalFalso('bot', { id: config.CHANNELS.ALIANZA });
        const ticket = canalFalso(SOLICITANTE, { id: chId });
        const client = {
            channels: {
                cache: new Map(conCanalAlly ? [[config.CHANNELS.ALIANZA, ally]] : []),
                fetch: async () => { if (!conCanalAlly) throw new Error('404'); return ally; },
            },
        };
        return { ally, ticket, client };
    };

    const clic = (ticket, client, userId, customId, message) => interaccionFalsa(ticket, userId, {
        customId,
        client,
        message: message ?? tarjetaDeRevisionFalsa(),
    });

    try {
        // ── El botón está en la tarjeta de revisión ──────────────────────────
        const fila = flujo.buildAceptarRow().toJSON().components;
        out.push({ ok: fila[0]?.custom_id === 'ali_aceptar', msg: 'la tarjeta de revisión lleva el botón de aceptar' });

        // ── Un tercero no puede aceptar ──────────────────────────────────────
        const a = nuevoEntorno('700000000000000001');
        alianzas.set(a.ticket.id, { userId: SOLICITANTE, mensaje: 'Ven a nuestro RP', link: 'https://discord.gg/aliado', descripcion: 'rp' });
        const iAjeno = clic(a.ticket, a.client, AJENO, 'ali_aceptar');
        await handleAlianzaButton(iAjeno);
        out.push({ ok: /Solo el owner/.test(iAjeno.respuestas[0]?.content ?? ''), msg: 'quien no es owner no puede aceptar una alianza' });
        out.push({ ok: a.ally.enviados.length === 0, msg: 'y no se publica nada' });

        // El segundo paso se comprueba aparte, y no por gusto: el customId
        // `ali_confirmar_aceptar` viaja por Discord, y fiarlo de que su botón
        // sólo exista en un mensaje efímero del owner es fiarlo de dónde está
        // el botón, no de quién lo pulsa.
        const iAjenoConf = clic(a.ticket, a.client, AJENO, 'ali_confirmar_aceptar');
        await handleAlianzaButton(iAjenoConf);
        out.push({ ok: /Solo el owner/.test(iAjenoConf.respuestas[0]?.content ?? ''), msg: 'quien no es owner tampoco puede confirmar la publicación' });
        out.push({ ok: a.ally.enviados.length === 0, msg: 'y por ahí tampoco se publica nada' });

        // ── El owner: primero confirmación, sin publicar todavía ─────────────
        const iOwner = clic(a.ticket, a.client, OWNER, 'ali_aceptar');
        await handleAlianzaButton(iOwner);
        const confirmacion = iOwner.respuestas[0];
        const botonesConf = nodos((confirmacion?.components ?? []).map(c => c.toJSON()))
            .filter(n => n.type === 2).map(n => n.custom_id);
        out.push({ ok: a.ally.enviados.length === 0, msg: 'pulsar Aceptar no publica todavía: primero pide confirmación' });
        out.push({ ok: botonesConf.includes('ali_confirmar_aceptar') && botonesConf.includes('ali_cancelar_aceptar'), msg: 'la confirmación trae "Sí, publicar" y "Cancelar"' });
        out.push({ ok: (confirmacion?.flags & 64) === 64, msg: 'y es efímera: la ve solo el owner' });
        out.push({
            ok: nodos((confirmacion?.components ?? []).map(c => c.toJSON()))
                .some(n => n.type === 10 && n.content.includes('Ven a nuestro RP')),
            msg: 'y enseña el mensaje exacto que se va a publicar',
        });

        // ── Cancelar no publica ──────────────────────────────────────────────
        const iCancel = clic(a.ticket, a.client, OWNER, 'ali_cancelar_aceptar');
        await handleAlianzaButton(iCancel);
        out.push({ ok: a.ally.enviados.length === 0, msg: 'cancelar no publica nada' });
        out.push({ ok: !alianzas.get(a.ticket.id).aceptadoEn, msg: 'y la alianza sigue sin aceptar' });

        // ── Confirmar: se publica ────────────────────────────────────────────
        const b = nuevoEntorno('700000000000000002');
        alianzas.set(b.ticket.id, { userId: SOLICITANTE, mensaje: 'Ven a nuestro RP', link: 'https://discord.gg/aliado', descripcion: 'rp' });
        const tarjeta = tarjetaDeRevisionFalsa();
        const iOk = clic(b.ticket, b.client, OWNER, 'ali_confirmar_aceptar', tarjeta);
        await handleAlianzaButton(iOk);

        const publicado = b.ally.enviados[0];
        out.push({ ok: b.ally.enviados.length === 1, msg: 'confirmar publica en el canal de aliados' });
        const textoPublicado = nodos((publicado?.components ?? []).map(c => c.toJSON()))
            .filter(n => n.type === 10).map(n => n.content).join('\n');
        out.push({ ok: textoPublicado.includes('Ven a nuestro RP'), msg: 'y publica el mensaje que escribió el solicitante' });
        out.push({ ok: textoPublicado.includes('https://discord.gg/aliado'), msg: 'con el enlace de su servidor' });

        // LO MÁS IMPORTANTE: el texto lo escribió otra persona. Sin esto, un
        // @everyone metido en su mensaje haría que el bot mencionara al
        // servidor entero justo al aceptar la alianza.
        out.push({
            ok: Array.isArray(publicado?.allowedMentions?.parse) && publicado.allowedMentions.parse.length === 0,
            msg: 'el mensaje se publica SIN permitir menciones (un @everyone del solicitante no puede pingar al servidor)',
        });

        // El solicitante se entera, en público y dentro de su ticket.
        const aviso = b.ticket.enviados[0];
        const textoAviso = nodos((aviso?.components ?? []).map(c => c.toJSON()))
            .filter(n => n.type === 10).map(n => n.content).join('\n');
        out.push({ ok: b.ticket.enviados.length === 1, msg: 'y se avisa en el ticket' });
        out.push({ ok: textoAviso.includes(`<@${SOLICITANTE}>`), msg: 'mencionando al solicitante' });
        out.push({ ok: !('flags' in (aviso ?? {})) || (aviso.flags & 64) !== 64, msg: 'el aviso es público en el ticket, no efímero' });
        out.push({ ok: /ACEPTADA/.test(textoAviso), msg: 'y le dice que su mensaje ya está publicado' });

        // La tarjeta de revisión pierde el botón y conserva la captura.
        const editado = tarjeta.editado;
        const restantes = nodos(editado?.components ?? []).filter(n => n.type === 2);
        out.push({ ok: restantes.length === 0, msg: 'la tarjeta de revisión se queda sin botón: no se publica dos veces' });
        out.push({
            ok: nodos(editado?.components ?? []).some(n => n.type === 12),
            msg: 'y conserva la captura, que es la prueba que el staff querría volver a mirar',
        });
        out.push({
            ok: nodos(editado?.components ?? []).some(n => n.type === 10 && /ALIANZA ACEPTADA/.test(n.content)),
            msg: 'y pasa a decir ALIANZA ACEPTADA',
        });

        // ── Segunda vez: no se publica otra ──────────────────────────────────
        const iOtra = clic(b.ticket, b.client, OWNER, 'ali_confirmar_aceptar', tarjetaDeRevisionFalsa());
        await handleAlianzaButton(iOtra);
        out.push({ ok: b.ally.enviados.length === 1, msg: 'aceptar dos veces seguidas no publica la alianza dos veces' });

        // Y pasado el antispam tampoco: lo que lo impide de verdad es el
        // `aceptadoEn` guardado, no el candado de 10 s. Se comprueba en un canal
        // distinto —sin candado— con la alianza ya marcada como aceptada.
        const d = nuevoEntorno('700000000000000004');
        alianzas.set(d.ticket.id, {
            userId: SOLICITANTE, mensaje: 'Ven a nuestro RP', link: 'https://discord.gg/aliado',
            descripcion: 'rp', aceptadoEn: new Date().toISOString(),
        });
        for (const id of ['ali_aceptar', 'ali_confirmar_aceptar']) {
            const iTarde = clic(d.ticket, d.client, OWNER, id);
            await handleAlianzaButton(iTarde);
            out.push({
                ok: d.ally.enviados.length === 0,
                msg: `una alianza ya aceptada no se vuelve a publicar con ${id}, aunque haya pasado el antispam`,
            });
            out.push({
                ok: /ya (está|estaba)/i.test(iTarde.respuestas.map(r => r.content ?? '').join(' ')),
                msg: `y ${id} lo dice en vez de quedarse callado`,
            });
        }
        alianzas.borrar(d.ticket.id);

        // ── Sin canal de aliados: no se da por publicado ─────────────────────
        const c = nuevoEntorno('700000000000000003', { conCanalAlly: false });
        alianzas.set(c.ticket.id, { userId: SOLICITANTE, mensaje: 'Hola', link: 'https://discord.gg/x', descripcion: 'y' });
        const iSinCanal = clic(c.ticket, c.client, OWNER, 'ali_confirmar_aceptar');
        await handleAlianzaButton(iSinCanal);
        out.push({ ok: !alianzas.get(c.ticket.id).aceptadoEn, msg: 'si el canal de aliados no se puede abrir, la alianza NO queda marcada como aceptada' });
        out.push({
            ok: /no se pudo/i.test(iSinCanal.respuestas.map(r => r.content ?? '').join(' ')),
            msg: 'y se dice, en vez de fingir que se publicó',
        });

        for (const id of ['700000000000000001', '700000000000000002', '700000000000000003']) alianzas.borrar(id);
    } finally {
        global.fetch = real;
    }

    return out;
}
