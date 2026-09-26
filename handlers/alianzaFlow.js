'use strict';

const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { safeReply, safeEditReply, safeDeferReply, safeShowModal } = require('../utils/safe');
const { isLocked, lock } = require('../utils/spam');
const { puedeGestionarTicket } = require('../utils/permisos');
const { fetchInvite } = require('../utils/discordInvite');
const alianzas = require('../utils/alianzas');
const tickets = require('../utils/tickets');
const config = require('../config');
const v2 = require('../utils/panelV2');

// ── Ticket de alianza ─────────────────────────────────────────────────────────
//
// No es una compra: nadie paga nada y no hay nada que entregar. Es una
// solicitud que se rellena por partes —el anuncio que quieren que publiquemos,
// el enlace de su servidor y de qué va— y que acaba en manos del staff.
//
// El tipo de ticket que se guarda es 'alianza', a diferencia del Headless (que
// se guarda como 'comprar' para heredar el flujo de pago). Aquí es al revés:
// NO tiene que heredar nada de las compras. El botón de "PAGO REALIZADO" del
// owner rechaza cualquier tipo que no sea 'comprar', el registro de pedidos
// sólo mira los de compra y el ranking cuenta Robux — con el tipo propio, un
// ticket de alianza no se cuela en ninguno de los tres.

const ACCENT = 0x2B2D31;

const E = {
    alianza:  '<:Proyectonuevo20260925T225153319:1553269490748366928>',
    link:     '<a:link:1544121889629405224>',
    coment:   '<:coment:1544121575752728631>',
    hecho:    '<:working:1547108520669741157>',
    pendiente:'<a:remove:1540604743234228364>',
    si:       '<a:add:1540603311890104321>',
    no:       '<a:remove:1540604743234228364>',
    alert:    '<:alert:1501220021035204658>',
    point:    '<:point:1501212595464700104>',
    member:   '<:member:1501261625523699892>',
};

let alianzaN = 1;
function pad(n) { return String(n).padStart(4, '0'); }

const fmt = n => n.toLocaleString('es-MX');

// Cómo se presenta cada campo de utils/alianzas.js. Las claves son LAS MISMAS
// que CAMPOS, y un test lo comprueba: si alguien añade un campo al almacén y se
// olvida de aquí, el panel se quedaría sin su botón en silencio.
const PRESENTACION = {
    mensaje: {
        label:  'Agregar mensaje de alianza',
        emoji:  E.alianza,
        titulo: 'Mensaje de alianza',
        pregunta: '¿Qué mensaje publicamos de tu servidor?',
        placeholder: 'El anuncio de tu comunidad, tal y como quieres que salga.',
        estilo: TextInputStyle.Paragraph,
        max: 1000,
    },
    link: {
        label:  'Agregar link del servidor',
        emoji:  E.link,
        titulo: 'Link del servidor',
        pregunta: 'Enlace de invitación de tu servidor',
        placeholder: 'https://discord.gg/tuservidor',
        estilo: TextInputStyle.Short,
        max: 200,
    },
    descripcion: {
        label:  'De qué trata tu servidor',
        emoji:  E.coment,
        titulo: 'De qué trata tu servidor',
        pregunta: '¿De qué trata tu servidor?',
        placeholder: 'Temática, a qué se dedica la comunidad y qué hacéis dentro.',
        estilo: TextInputStyle.Paragraph,
        max: 500,
    },
};

// ── Texto del panel del ticket ────────────────────────────────────────────────

const MIN_MIEMBROS = config.ALIANZA.MIN_MIEMBROS;

function buildTexto(datos) {
    const canalAlly    = `<#${config.CHANNELS.ALIANZA}>`;
    const canalAnuncio = `<#${config.CHANNELS.ANUNCIO}>`;

    return [
        `## ${E.alianza} ALIANZAS — 7x COMMUNITY`,
        'En **7x** hacemos alianzas con otros servidores. Esto es lo que pedimos, ' +
        'lo que no aceptamos y los pasos exactos para conseguirla.',
        '',
        `### ${E.si} Requisitos`,
        `${E.point} Comunidad de **gaming**`,
        `${E.point} Más de **${fmt(MIN_MIEMBROS)} miembros**`,
        `${E.point} El **enlace** de tu comunidad`,
        `${E.point} El **mensaje** que publicaremos de ti en ${canalAlly}`,
        '',
        `### ${E.no} No aceptamos`,
        `${E.point} Servidores que **vendan Robux**`,
        `${E.point} Pornografía, contenido subido de tono o actividades ilícitas`,
        '',
        'Sí entran comunidades de **socialización**, **ambiente**, **roleplay** y ' +
        'venta de **otros productos** que no sean Robux.',
        '',
        `### ${E.point} Pasos`,
        `**1.** Publica nuestro anuncio de ${canalAnuncio} en tu servidor.`,
        '**2.** Envía **aquí** una captura donde se vea **en qué canal** lo publicaste.',
        '**3.** Rellena los tres botones de abajo.',
        `**4.** Pulsa **Completado** y tu solicitud pasa a revisión.`,
        '',
        `### ${E.member} Lo que llevas`,
        ...alianzas.CAMPOS.map(campo => {
            const p = PRESENTACION[campo];
            const hecho = Boolean(datos[campo]);
            return `${hecho ? E.hecho : E.pendiente} ${p.emoji} **${p.titulo}** — ${hecho ? 'listo' : 'pendiente'}`;
        }),
        '',
        `-# ${E.alert} La captura del paso 2 se comprueba al pulsar Completado. ` +
        'Puedes cerrar el ticket cuando quieras con el botón de abajo.',
    ].join('\n');
}

// ── Botones ───────────────────────────────────────────────────────────────────
// Dos filas dentro del bloque: arriba lo que hay que rellenar, abajo lo que
// cierra el ticket de una forma o de otra.

function buildFilas(datos) {
    const relleno = new ActionRowBuilder().addComponents(
        ...alianzas.CAMPOS.map(campo => {
            const p = PRESENTACION[campo];
            return new ButtonBuilder()
                .setCustomId(`ali_${campo}`)
                .setLabel(p.label)
                .setStyle(datos[campo] ? ButtonStyle.Secondary : ButtonStyle.Primary)
                .setEmoji(p.emoji);
        })
    );

    const cierre = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('ali_completado')
            .setLabel('Completado')
            .setStyle(ButtonStyle.Success)
            .setEmoji(E.hecho),
        new ButtonBuilder()
            .setCustomId('cerrar_ticket')
            .setLabel('Cerrar Ticket')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🔒'),
    );

    return [relleno, cierre];
}

// Las opciones salen de UN sitio: el panel que se envía al crear el ticket y el
// que se repinta después tienen que ser el mismo, o el repintado se comería la
// mención o cambiaría el color sin que nadie lo pidiera.
function opcionesPanel(userId, datos) {
    return {
        color: ACCENT,
        // La mención va DENTRO del texto y no como `content`: un mensaje con el
        // flag de Components V2 que lleve `content` lo rechaza Discord entero.
        mencion: userId ? `<@${userId}>` : null,
        texto: buildTexto(datos),
        filas: buildFilas(datos),
    };
}

function buildPanel(userId, datos) {
    return v2.tarjeta(opcionesPanel(userId, datos));
}

function buildPanelPayload(userId, datos) {
    return v2.tarjetaPayload(opcionesPanel(userId, datos));
}

// Repinta el panel del ticket para que las marcas de "listo/pendiente" digan la
// verdad. Nunca lanza: que no se pueda repintar (mensaje borrado, permisos) no
// puede tirar el guardado de lo que la persona acaba de escribir.
async function repintarPanel(channel, channelId) {
    const datos = alianzas.get(channelId);
    if (!datos.panelId) return;

    try {
        const msg = await channel.messages.fetch(datos.panelId);
        // `content: null` y `embeds: []` limpian lo que pudiera quedar de un
        // mensaje clásico; el resto sale del mismo payload con el que se envió,
        // flag de Components V2 incluido.
        await msg.edit({ ...buildPanelPayload(datos.userId, datos), content: null, embeds: [] });
    } catch (err) {
        console.warn('[alianza] No se pudo repintar el panel:', err.message);
    }
}

// ── Paso 1: botón del panel → crear el ticket ────────────────────────────────

async function startAlianzaTicket(interaction) {
    if (interaction.replied || interaction.deferred) return;

    const userId = interaction.user.id;

    if (isLocked(`btn:alianza:${userId}`)) {
        return safeReply(interaction, { content: '⏳ Espera un momento antes de intentar de nuevo.', ephemeral: true });
    }
    lock(`btn:alianza:${userId}`, config.TIMEOUTS.LOCK_MS);

    if (await tickets.hasActiveTicket(interaction.guild, userId)) {
        return safeReply(interaction, { content: '❌ Ya tienes un ticket abierto. Cierra el anterior antes de crear otro.', ephemeral: true });
    }

    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    try {
        const channel = await tickets.createTicket(interaction.guild, userId, 'alianza', `alianza-${pad(alianzaN++)}`);

        const panel = await channel.send(buildPanelPayload(userId, {}));

        // El id del panel se guarda para poder repintarlo después. Va junto al
        // userId porque el que rellena es quien abrió el ticket, y eso hay que
        // seguir sabiéndolo tras un reinicio.
        alianzas.set(channel.id, { userId, panelId: panel.id, creadoEn: new Date().toISOString() });

        await safeEditReply(interaction, { content: `✅ Ticket de alianza creado: ${channel}` });
    } catch (err) {
        console.error('[alianza] ticket creation error:', err);
        const msg = err?.code === 'TICKET_EXISTS'
            ? '❌ Ya tienes un ticket abierto o se está creando uno.'
            : `❌ Error al crear el ticket: ${err.message}`;
        await safeEditReply(interaction, { content: msg });
    }
}

// ── Paso 2: los tres botones de rellenar ─────────────────────────────────────

function buildCampoModal(campo) {
    const p = PRESENTACION[campo];

    return new ModalBuilder()
        .setCustomId(`ali_modal_${campo}`)
        .setTitle(p.titulo)
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('valor')
                    .setLabel(p.pregunta.slice(0, 45))
                    .setPlaceholder(p.placeholder.slice(0, 100))
                    .setStyle(p.estilo)
                    .setMaxLength(p.max)
                    .setRequired(true)
            )
        );
}

// Quién puede tocar los botones del ticket: quien lo abrió, y el staff. Se
// pregunta a utils/permisos.js, que es el único que decide eso en todo el bot.
function puedeUsar(interaction) {
    const ownerId = tickets.getOwner(interaction.channel);
    return puedeGestionarTicket(interaction.user.id, ownerId);
}

async function onCampo(interaction, campo) {
    if (!puedeUsar(interaction)) {
        return safeReply(interaction, { content: '❌ Solo quien abrió el ticket puede rellenarlo.', ephemeral: true });
    }

    const ok = await safeShowModal(interaction, buildCampoModal(campo));
    if (!ok) await safeReply(interaction, { content: '❌ No se pudo abrir el formulario. Intenta de nuevo.', ephemeral: true });
}

// ── Paso 3: el modal enviado ─────────────────────────────────────────────────

async function handleAlianzaModal(interaction) {
    const campo = interaction.customId.replace('ali_modal_', '');
    if (!alianzas.CAMPOS.includes(campo)) return;

    const valor = interaction.fields.getTextInputValue('valor');
    if (!alianzas.setCampo(interaction.channelId, campo, valor)) {
        return safeReply(interaction, { content: '❌ No se guardó nada. Escribe algo e inténtalo de nuevo.', ephemeral: true });
    }

    await repintarPanel(interaction.channel, interaction.channelId);

    // El enlace se comprueba al vuelo: es el único campo del que Discord sabe
    // algo. Un fallo aquí NO invalida el enlace ni bloquea nada — sólo se deja
    // de decir cuántos miembros tiene.
    if (campo === 'link') {
        const info = await fetchInvite(valor);
        return safeReply(interaction, { content: textoLink(info), ephemeral: true });
    }

    const faltan = alianzas.faltantes(interaction.channelId);
    return safeReply(interaction, {
        content: faltan.length
            ? `${E.hecho} Guardado. Te falta: **${faltan.map(c => PRESENTACION[c].titulo).join('**, **')}**.`
            : `${E.hecho} Guardado. Ya lo tienes todo — pulsa **Completado** cuando hayas enviado la captura.`,
        ephemeral: true,
    });
}

function textoLink(info) {
    if (info.error === 'formato') {
        return `${E.alert} Guardado, pero eso no parece un enlace de Discord. Debería ser algo como \`https://discord.gg/tuservidor\`.`;
    }
    if (info.error === 'invalida') {
        return `${E.alert} Guardado, pero Discord no reconoce esa invitación: puede estar **caducada** o mal escrita. Revísala y vuelve a enviarla.`;
    }
    if (!info.ok || info.miembros === null) {
        return `${E.hecho} Enlace guardado. No se pudo comprobar el servidor ahora mismo — lo revisará el staff.`;
    }

    const cumple = info.miembros >= MIN_MIEMBROS;
    return [
        `${E.hecho} Enlace guardado.`,
        `${E.point} Servidor: **${info.nombre ?? 'sin nombre'}**`,
        `${cumple ? E.si : E.no} Miembros: **${fmt(info.miembros)}** ` +
        `(pedimos más de ${fmt(MIN_MIEMBROS)})`,
        cumple ? '' : `-# Por debajo del mínimo. Puedes enviarlo igual: lo revisa una persona, no el bot.`,
    ].filter(Boolean).join('\n');
}

// ── Paso 4: Completado ───────────────────────────────────────────────────────

// La captura del paso 2: la imagen más reciente que haya subido quien abrió el
// ticket. Se busca cuando hace falta en vez de guardarla al vuelo — así no hay
// un escuchador más por el que pase cada mensaje del servidor, y no puede
// quedarse desincronizada si alguien borra su captura.
async function buscarCaptura(channel, userId) {
    const mensajes = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (!mensajes) return null;

    for (const [, msg] of mensajes) {
        if (msg.author?.id !== userId) continue;
        const imagen = [...(msg.attachments?.values?.() ?? [])]
            .find(a => (a.contentType ?? '').startsWith('image/'));
        if (imagen) return { url: imagen.url, nombre: nombreCaptura(imagen) };
    }
    return null;
}

// La captura se vuelve a subir con la tarjeta de revisión, y para eso hace
// falta un nombre con la extensión correcta. Sale del tipo que declara Discord
// y no del nombre original, que lo pone quien sube el fichero.
function nombreCaptura(adjunto) {
    const tipo = (adjunto.contentType ?? '').split(';')[0].trim();
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[tipo] ?? 'png';
    return `captura.${ext}`;
}

async function onCompletado(interaction) {
    if (!puedeUsar(interaction)) {
        return safeReply(interaction, { content: '❌ Solo quien abrió el ticket puede enviarlo a revisión.', ephemeral: true });
    }

    const channelId = interaction.channelId;
    const datos = alianzas.get(channelId);

    const faltan = alianzas.faltantes(channelId);
    if (faltan.length) {
        return safeReply(interaction, {
            content: `${E.alert} Antes de enviarlo te falta rellenar: **${faltan.map(c => PRESENTACION[c].titulo).join('**, **')}**.`,
            ephemeral: true,
        });
    }

    if (datos.enviadoEn) {
        return safeReply(interaction, {
            content: `${E.hecho} Tu solicitud ya está en revisión. El staff te contestará por aquí.`,
            ephemeral: true,
        });
    }

    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    const userId   = datos.userId ?? tickets.getOwner(interaction.channel);
    const captura  = await buscarCaptura(interaction.channel, userId);

    if (!captura) {
        return safeEditReply(interaction, {
            content: `${E.alert} Falta la **captura** del paso 2: súbela aquí como imagen —donde se vea en qué canal publicaste nuestro anuncio— y vuelve a pulsar **Completado**.`,
        });
    }

    const info = await fetchInvite(datos.link);

    alianzas.set(channelId, { enviadoEn: new Date().toISOString(), captura: captura.url });

    const opciones = {
        color: ACCENT,
        mencion: config.ADMIN_IDS.map(id => `<@${id}>`).join(' '),
        texto: buildRevisionTexto(userId, datos, info),
        imagen: `attachment://${captura.nombre}`,
    };

    // La captura se RESUBE, no se enlaza: las URLs de adjuntos de Discord van
    // firmadas y caducan en horas, así que una tarjeta de revisión que la
    // enlazara se quedaría sin imagen justo cuando el staff volviera a mirarla.
    // Si la resubida falla (fichero borrado, red), la tarjeta sale igual con el
    // enlace en el texto: lo que no puede pasar es que no salga nada.
    try {
        await interaction.channel.send(
            v2.tarjetaPayload(opciones, [{ attachment: captura.url, name: captura.nombre }])
        );
    } catch (err) {
        console.warn('[alianza] No se pudo resubir la captura:', err.message);
        await interaction.channel.send(v2.tarjetaPayload({
            ...opciones,
            imagen: null,
            texto: `${opciones.texto}\n${captura.url}`,
        }));
    }

    await repintarPanel(interaction.channel, channelId);

    await safeEditReply(interaction, {
        content: `${E.hecho} Enviado. Tu solicitud está en revisión — el staff te contestará por aquí.`,
    });
}

function buildRevisionTexto(userId, datos, info) {
    const miembros = info.ok && info.miembros !== null
        ? `**${fmt(info.miembros)}** ${info.miembros >= MIN_MIEMBROS ? E.si : E.no}`
        : '*no se pudo comprobar*';

    return [
        `## ${E.hecho} SOLICITUD DE ALIANZA — EN REVISIÓN`,
        `${E.member} De: <@${userId}>`,
        '',
        `### ${E.link} Su servidor`,
        `${E.point} Enlace: ${datos.link}`,
        `${E.point} Nombre: ${info.ok && info.nombre ? `**${info.nombre}**` : '*no se pudo comprobar*'}`,
        `${E.point} Miembros: ${miembros} · pedimos más de ${fmt(MIN_MIEMBROS)}`,
        '',
        `### ${E.coment} De qué trata`,
        datos.descripcion,
        '',
        `### ${E.alianza} Mensaje que publicaríamos en <#${config.CHANNELS.ALIANZA}>`,
        datos.mensaje,
        '',
        `### ${E.point} Captura de nuestro anuncio publicado`,
        `-# Enviada por el solicitante. Se ve abajo.`,
    ].join('\n');
}

// ── Enrutado ─────────────────────────────────────────────────────────────────
// Un solo punto de entrada para todo lo que empieza por `ali_`, igual que el
// flujo de seguidores: handlers/buttons.js no tiene que saber qué campos hay.

async function handleAlianzaButton(interaction) {
    const id = interaction.customId;

    if (id === 'ali_completado') return onCompletado(interaction);

    const campo = id.replace('ali_', '');
    if (alianzas.CAMPOS.includes(campo)) return onCampo(interaction, campo);
}

module.exports = {
    startAlianzaTicket,
    handleAlianzaButton,
    handleAlianzaModal,
    __test: {
        buildTexto, buildFilas, buildPanel, buildCampoModal, buildRevisionTexto,
        textoLink, buscarCaptura, PRESENTACION, E, ACCENT, MIN_MIEMBROS,
    },
};
