'use strict';

const {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const { safeReply, safeEditReply, safeDeferReply, safeDeferUpdate, safeShowModal, safeFollowUp } = require('../utils/safe');
const { isLocked, lock } = require('../utils/spam');
const { puedeGestionarTicket } = require('../utils/permisos');
const tickets = require('../utils/tickets');
const config = require('../config');
const v2 = require('../utils/panelV2');
const roblox = require('../src/roblox/client');
const { lookup, extractNumber, MIN, MAX } = require('../data/prices');
const { getCoupon, isValid: isCouponValid, useCoupon } = require('../utils/coupons');
const { refreshCouponEmbed } = require('./commands');
// Como módulo y no desestructurado: así los tests pueden sustituirlo sin red.
const communityStatus = require('../utils/communityStatus');
const { buildMetodosPayload } = require('../metodos');
const gp = require('../utils/gamepassPrecios');
const gpInfo = require('../utils/gamepassInfo');
const pendientes = require('../utils/pedidosPendientes');
const fidelidad = require('../utils/fidelidad');

// ── Compra de Robux: comunidad y gamepass ─────────────────────────────────────
//
// Dos formas de entrega con el MISMO camino hasta el ticket:
//
//   1. El formulario: usuario de Roblox y cantidad.
//   2. La CONFIRMACIÓN: se busca esa cuenta en Roblox y se le enseña, con su
//      foto, su nombre y —por comunidad— en qué comunidades está y si ya puede
//      recibir. Sólo si pulsa "Continuar" se abre el ticket.
//   3. El ticket.
//
// El paso 2 existe para que un usuario mal escrito no acabe en un ticket. Antes
// se abría directamente con lo que se tecleara, y un error de una letra no se
// veía hasta que el owner iba a enviar los Robux a una cuenta que no existía —
// o que existía y era de otra persona.
//
// Las dos formas se guardan con el tipo de ticket 'comprar', igual que el
// Headless: de ese tipo cuelga TODO lo de después —el botón de "PAGO REALIZADO"
// del owner, el "PAGO EXITOSO" del cliente, el registro de pedidos y el ranking
// de compradores—. Lo que las distingue es el nombre del canal y `pedido.modo`
// en el topic.
//
// Las etiquetas del resumen ("Usuario de Roblox", "Robux a recibir", "Precio a
// pagar") son las que lee utils/orderNotify.js para el registro y el ranking:
// NO se cambian, ni en una forma ni en la otra.

const ACCENT = 0x2B2D31;

const E = {
    buy:       '<:buy:1501212698556371004>',
    roblox:    '<:roblox:1525317838938701967>',
    member:    '<:member:1501261625523699892>',
    robux:     '<a:robuxxx:1510070809366892604>',
    money:     '<:money:1544123920897019906>',
    alert:     '<:alert:1501220021035204658>',
    point:     '<:point:1501212595464700104>',
    si:        '<:true:1501213776878501899>',
    no:        '<a:remove:1540604743234228364>',
    hecho:     '<:working:1547108520669741157>',
};

// Las dos formas de compra. Lo que cambia de una a otra está aquí y en ningún
// otro sitio.
const TIPOS = {
    comunidad: {
        modalId: 'comprar_modal',
        titulo: 'Robux por comunidad',
        canal: 'robux-comunidad',
        etiquetaCantidad: 'Cantidad de Robux',
        placeholderCantidad: `Entre ${MIN.toLocaleString('es-MX')} y ${MAX.toLocaleString('es-MX')}`,
        cupon: true,
    },
    gamepass: {
        modalId: 'gamepass_compra_modal',
        titulo: 'Robux por gamepass',
        canal: 'robux-gamepass',
        etiquetaCantidad: 'Valor del gamepass (Robux)',
        placeholderCantidad: `Entre ${gp.G.MIN_ROBUX.toLocaleString('es-MX')} y ${gp.G.MAX_ROBUX.toLocaleString('es-MX')}`,
        // Los cupones se pensaron para la tabla de precios por comunidad. Sobre
        // el precio de gamepass, que ya es otro, un 20% podría dejar la venta
        // por debajo de lo que cuesta: fuera hasta que se decida lo contrario.
        cupon: false,
    },
};

function tipoDeModal(customId) {
    return Object.keys(TIPOS).find(k => TIPOS[k].modalId === customId) ?? null;
}

const fmt = n => Number(n).toLocaleString('es-MX');

// Los contadores del nombre de canal empiezan de cero en cada arranque, como el
// resto de tickets: Discord permite nombres repetidos y lo que identifica un
// ticket es su topic, no su nombre.
const contador = { comunidad: 1, gamepass: 1 };
const pad = n => String(n).padStart(4, '0');

// ── 1. El formulario ──────────────────────────────────────────────────────────

function buildCompraModal(tipo) {
    const t = TIPOS[tipo];
    const modal = new ModalBuilder().setCustomId(t.modalId).setTitle(t.titulo);

    const filas = [
        new TextInputBuilder()
            .setCustomId('usuario_roblox')
            .setLabel('Usuario de Roblox')
            .setPlaceholder('Tu usuario, no tu nombre visible')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(20)
            .setRequired(true),
        new TextInputBuilder()
            .setCustomId('cantidad_robux')
            .setLabel(t.etiquetaCantidad)
            .setPlaceholder(t.placeholderCantidad)
            .setStyle(TextInputStyle.Short)
            .setMaxLength(9)
            .setRequired(true),
    ];

    if (t.cupon) {
        filas.push(
            new TextInputBuilder()
                .setCustomId('codigo_descuento')
                .setLabel('Código de descuento (solo si tienes uno)')
                .setPlaceholder('Ej: PROMO20')
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
        );
    }

    modal.addComponents(...filas.map(f => new ActionRowBuilder().addComponents(f)));
    return modal;
}

// Un campo que puede no estar en el formulario. discord.js LANZA si se le pide
// uno que no existe, y eso pasa de verdad: alguien con el formulario viejo
// abierto desde antes de un despliegue lo envía después.
function campo(interaction, id) {
    try { return (interaction.fields.getTextInputValue(id) ?? '').trim(); }
    catch { return ''; }
}

// ── 2. La confirmación ────────────────────────────────────────────────────────

async function handleCompraModal(interaction) {
    if (interaction.replied || interaction.deferred) return;

    const tipo = tipoDeModal(interaction.customId);
    if (!tipo) return;

    // Las consultas a Roblox pueden pasar de los 3 segundos que da Discord.
    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    const userId = interaction.user.id;

    if (isLocked(`modal:${userId}`)) {
        return safeEditReply(interaction, { content: '⏳ Espera un momento antes de intentar de nuevo.' });
    }
    lock(`modal:${userId}`, config.TIMEOUTS.LOCK_MS);

    try {
        if (await tickets.hasActiveTicket(interaction.guild, userId)) {
            return safeEditReply(interaction, { content: '❌ Ya tienes un ticket abierto. Cierra el anterior antes de crear otro.' });
        }

        const escrito = campo(interaction, 'usuario_roblox');
        const amount = extractNumber(campo(interaction, 'cantidad_robux'));
        if (!escrito) {
            return safeEditReply(interaction, { content: '❌ Escribe tu usuario de Roblox.' });
        }
        if (!amount) {
            return safeEditReply(interaction, { content: '❌ Escribe un número válido para la cantidad de Robux. (Ejemplo: 1500)' });
        }

        const precio = calcularPrecio(tipo, amount);
        if (!precio.ok) return safeEditReply(interaction, { content: precio.error });

        // La cuenta de Roblox. Sin ella no hay nada que confirmar: un usuario
        // que no existe no se puede convertir en ticket.
        let usuario;
        try {
            usuario = await roblox.getUserByUsername(escrito);
        } catch (err) {
            const noExiste = err?.message === 'not_found' || err?.response?.status === 404;
            return safeEditReply(interaction, {
                content: noExiste
                    ? `${E.alert} No existe ningún usuario de Roblox llamado **${escrito}**. Revisa cómo se escribe —es tu usuario, no tu nombre visible— y vuelve a intentarlo.`
                    : `${E.alert} No se pudo consultar Roblox ahora mismo. Inténtalo en un momento.`,
            });
        }

        // La foto y, por comunidad, dónde está. Se pide con el nombre que
        // devuelve Roblox, con sus mayúsculas reales, y no con lo tecleado.
        const [foto, comunidades] = await Promise.all([
            roblox.getHeadshot(usuario.id).catch(() => null),
            tipo === 'comunidad' ? communityStatus.buildCommunitySummary(interaction.client, usuario.name) : null,
        ]);

        const cupon = tipo === 'comunidad' ? revisarCupon(campo(interaction, 'codigo_descuento'), precio) : null;

        // El descuento de fidelidad se OFRECE aquí y el cliente decide si lo
        // usa en esta compra o lo guarda. No se combina con un cupón: los dos
        // juntos podrían dejar la venta por debajo de coste.
        const fid = fidelidad.estado(userId);
        // Y sólo en compras de hasta FIDELIDAD.MAX_ROBUX.
        const ofrecerFidelidad = fid.disponibles > 0 && !cupon?.valido && fidelidad.valeParaRobux(precio.datos.robux);

        const pedido = {
            tipo,
            robloxUserId: String(usuario.id),
            robloxName: usuario.name,
            displayName: usuario.displayName || usuario.name,
            foto,
            ...precio.datos,
            cuponCodigo: cupon?.codigo ?? null,
            comunidadesTexto: comunidades?.texto ?? '',
            comunidades: (comunidades?.comunidades ?? []).map(c => ({ clave: c.clave, estado: c.estado })),
        };

        const token = pendientes.guardar(userId, pedido);

        await editarTarjeta(interaction, {
            color: ACCENT,
            texto: buildTextoConfirmacion(pedido, cupon, fid),
            thumbnail: foto,
            filas: [buildConfirmarRow(token, ofrecerFidelidad)],
        });
    } catch (err) {
        console.error('[compra] Error preparando la confirmación:', err);
        await safeEditReply(interaction, { content: '❌ Ocurrió un error. Intenta de nuevo.' });
    }
}

// El precio de cada forma, con su validación. { ok, datos } | { ok:false, error }.
function calcularPrecio(tipo, amount) {
    if (tipo === 'gamepass') {
        if (!gp.enRango(amount)) {
            return {
                ok: false,
                error: `❌ Por gamepass vendemos entre **${fmt(gp.G.MIN_ROBUX)}** y **${fmt(gp.G.MAX_ROBUX)}** Robux.`,
            };
        }
        return {
            ok: true,
            datos: {
                robux: amount,
                recibe: gp.recibe(amount),
                precio: gp.precioDe(amount),
                redondeado: false,
            },
        };
    }

    const p = lookup(amount);
    if (!p) {
        return { ok: false, error: `❌ Monto no disponible. Elige una cantidad entre **${fmt(MIN)}** y **${fmt(MAX)}** Robux.` };
    }
    return {
        ok: true,
        datos: {
            robux: p.amount,
            recibe: p.amount,
            precio: parseFloat(p.price.replace(/[$,]/g, '')),
            redondeado: p.rounded,
        },
    };
}

// El cupón se REVISA aquí para enseñarlo, pero no se gasta: si la persona
// cancela, no puede haberse quedado sin un uso. Se vuelve a comprobar y se
// gasta al abrir el ticket.
function revisarCupon(codigo, precio) {
    if (!codigo) return null;
    const c = getCoupon(codigo);
    if (!isCouponValid(codigo, precio.datos.robux)) return { codigo, valido: false };
    return {
        codigo,
        valido: true,
        descuento: c.discount,
        final: Math.round(precio.datos.precio * (1 - c.discount / 100)),
    };
}

function buildTextoConfirmacion(pedido, cupon, fid = null) {
    const perfil = `https://www.roblox.com/users/${pedido.robloxUserId}/profile`;

    const lineas = [
        `## ${E.buy} Confirma tu compra`,
        'Revisa que esta sea **tu cuenta de Roblox** antes de abrir el ticket.',
        '',
        `### ${E.member} Tu cuenta`,
        `**${pedido.displayName}** · @${pedido.robloxName}`,
        `-# ID \`${pedido.robloxUserId}\` · [Ver perfil](${perfil})`,
        '',
        `### ${E.robux} Tu pedido`,
    ];

    if (pedido.tipo === 'gamepass') {
        lineas.push(
            `Gamepass de **${fmt(pedido.robux)} Robux** por **$${fmt(pedido.precio)} MXN**`,
            `${E.point} Recibes **${fmt(pedido.recibe)} Robux** en tu cuenta`,
            `-# Roblox se queda el ${Math.round(gp.G.TASA_ROBLOX * 100)}% de la venta del gamepass y no lo cubrimos.`,
        );
    } else {
        if (cupon?.valido) {
            lineas.push(
                `**${fmt(pedido.robux)} Robux** por ~~$${fmt(pedido.precio)}~~ **$${fmt(cupon.final)} MXN**`,
                `${E.si} Cupón **${cupon.codigo.toUpperCase()}** · ${cupon.descuento}% de descuento`,
            );
        } else {
            lineas.push(`**${fmt(pedido.robux)} Robux** por **$${fmt(pedido.precio)} MXN** · entrega por comunidad`);
            if (cupon && !cupon.valido) {
                lineas.push(`${E.alert} El código **${cupon.codigo.toUpperCase()}** no es válido o ya no le quedan usos.`);
            }
        }
        if (pedido.redondeado) {
            lineas.push(`-# Tu cantidad se ajustó al paquete más cercano: **${fmt(pedido.robux)} Robux**.`);
        }
    }

    if (pedido.tipo === 'comunidad' && pedido.comunidadesTexto) {
        lineas.push(pedido.comunidadesTexto);
    }

    if (fid) lineas.push('', ...lineasFidelidadConfirmacion(pedido, cupon, fid));

    lineas.push('', '-# ¿No es tu cuenta? Pulsa **Cancelar** y vuelve a escribir tu usuario.');
    return lineas.join('\n');
}

// Con un descuento de fidelidad guardado hay dos formas de continuar, y es el
// cliente quien elige: usarlo en esta compra o guardarlo para otra.
function buildConfirmarRow(token, conFidelidad = false) {
    const cancelar = new ButtonBuilder()
        .setCustomId(`compra_no:${token}`)
        .setLabel('Cancelar')
        .setStyle(ButtonStyle.Secondary);

    if (!conFidelidad) {
        return new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`compra_ok:${token}`)
                .setLabel('Continuar')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅'),
            cancelar,
        );
    }

    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`compra_desc:${token}`)
            .setLabel(`Usar mi ${fidelidad.F.DESCUENTO}% y continuar`)
            .setStyle(ButtonStyle.Success)
            .setEmoji('🎁'),
        new ButtonBuilder()
            .setCustomId(`compra_ok:${token}`)
            .setLabel('Continuar sin descuento')
            .setStyle(ButtonStyle.Primary),
        cancelar,
    );
}

// El bloque de fidelidad de la confirmación: el progreso y, si tiene uno
// guardado, la oferta de usarlo.
function lineasFidelidadConfirmacion(pedido, cupon, fid) {
    const F = fidelidad.F;
    const lineas = [];

    if (fid.disponibles > 0 && !cupon?.valido && !fidelidad.valeParaRobux(pedido.robux)) {
        lineas.push(`-# 🎁 Tu ${F.DESCUENTO}% de fidelidad es válido en compras de hasta **${fmt(F.MAX_ROBUX)} Robux**: se queda guardado para otra compra.`);
    } else if (fid.disponibles > 0 && !cupon?.valido) {
        const conDescuento = fidelidad.aplicar(pedido.precio);
        lineas.push(
            `### 🎁 Tienes un descuento de fidelidad`,
            `Tienes **${fid.disponibles}** descuento${fid.disponibles === 1 ? '' : 's'} del **${F.DESCUENTO}%** guardado${fid.disponibles === 1 ? '' : 's'}. ¿Lo usas en esta compra?`,
            `Con él pagarías **$${fmt(conDescuento)} MXN** en vez de $${fmt(pedido.precio)}.`,
            '-# Si no lo usas ahora, se queda guardado para otra compra.',
        );
    } else if (fid.disponibles > 0 && cupon?.valido) {
        lineas.push(`-# 🎁 Tu descuento de fidelidad no se combina con cupones: se queda guardado para otra compra.`);
    } else {
        const despues = fid.progreso + 1;
        lineas.push(
            `${fidelidad.barra(fid.progreso)} **${fid.progreso}/${F.CADA}** compras de fidelidad`,
            despues >= F.CADA
                ? `-# Al completar esta compra ganas un **${F.DESCUENTO}% de descuento** para la que tú elijas.`
                : `-# Al completar esta compra llegarás a ${despues}/${F.CADA}.`,
        );
    }
    return lineas;
}

// Edita la respuesta de la interacción con una tarjeta (botones DENTRO del
// bloque) y, si Discord la rechaza, con un embed clásico de los mismos datos.
//
// Hace falta el respaldo porque esto es la entrada al flujo de compra: si un
// día la tarjeta falla al editar una respuesta diferida, sin él nadie podría
// abrir un ticket. Con él, en el peor caso los botones salen debajo del bloque.
async function editarTarjeta(interaction, { color, texto, thumbnail = null, filas = [] }) {
    const okV2 = await safeEditReply(interaction, {
        ...v2.tarjetaPayload({ color, texto, thumbnail, filas }),
        content: null,
        embeds: [],
    });
    if (okV2) return true;

    console.warn('[compra] La tarjeta V2 no se pudo editar — se usa el embed clásico.');
    const embed = new EmbedBuilder().setColor(color).setDescription(texto.slice(0, 4096));
    if (thumbnail) embed.setThumbnail(thumbnail);
    return safeEditReply(interaction, { content: null, embeds: [embed], components: filas });
}

// ── 3. Continuar / Cancelar ───────────────────────────────────────────────────

async function handleCompraButton(interaction) {
    const [accion, token] = interaction.customId.split(':');
    if (accion === 'compra_no') return onCancelar(interaction, token);
    if (accion === 'compra_ok') return onContinuar(interaction, token, false);
    if (accion === 'compra_desc') return onContinuar(interaction, token, true);
}

async function onCancelar(interaction, token) {
    if (!await safeDeferUpdate(interaction)) return;
    pendientes.consumir(token, interaction.user.id);
    await editarTarjeta(interaction, {
        color: ACCENT,
        texto: `${E.alert} **Compra cancelada.** No se ha abierto ningún ticket.\n-# Puedes volver a empezar desde el panel cuando quieras.`,
    });
}

async function onContinuar(interaction, token, conDescuento = false) {
    if (!await safeDeferUpdate(interaction)) return;

    const userId = interaction.user.id;

    // consumir() lo saca en el mismo paso: dos clics seguidos no pueden abrir
    // dos tickets con el mismo pedido.
    const r = pendientes.consumir(token, userId);
    if (!r.ok) {
        return editarTarjeta(interaction, {
            color: ACCENT,
            texto: r.motivo === 'ajeno'
                ? `${E.alert} Esta confirmación no es tuya.`
                : `${E.alert} **Esta confirmación caducó.** Vuelve a empezar desde el panel.`,
        });
    }

    const pedido = r.pedido;

    // El descuento se vuelve a comprobar AL ABRIR: manda lo que hay ahora, no
    // lo que se vio en la confirmación. Sólo se marca en el pedido; se gasta
    // cuando el owner confirma el pago (ver onConfirmarPago), para que un
    // ticket cerrado sin pagar no le cueste el descuento a nadie.
    let avisoFidelidad = '';
    if (conDescuento) {
        if (!fidelidad.valeParaRobux(pedido.robux)) {
            avisoFidelidad = `\n-# Tu descuento de fidelidad sólo vale en compras de hasta ${fmt(fidelidad.F.MAX_ROBUX)} Robux: el ticket se abrió sin él y sigue guardado.`;
        } else if (fidelidad.tieneDescuento(userId)) {
            pedido.descuentoFidelidad = true;
        } else {
            avisoFidelidad = '\n-# Tu descuento de fidelidad ya no estaba disponible: el ticket se abrió sin él.';
        }
    }

    await editarTarjeta(interaction, {
        color: ACCENT,
        texto: `${E.hecho} Abriendo tu ticket…`,
        thumbnail: pedido.foto,
    });

    try {
        const channel = pedido.tipo === 'gamepass'
            ? await crearTicketGamepass(interaction, pedido)
            : await crearTicketComunidad(interaction, pedido);

        const editado = await editarTarjeta(interaction, {
            color: ACCENT,
            texto: `${E.si} **Ticket creado:** ${channel}\n-# Sigue los pasos que hay dentro.${avisoFidelidad}`,
            thumbnail: pedido.foto,
        });
        // Si ni la tarjeta ni el embed pudieron editarse, que al menos sepa
        // dónde está su ticket.
        if (!editado) await safeFollowUp(interaction, { content: `✅ Ticket creado: ${channel}`, ephemeral: true });
    } catch (err) {
        console.error('[compra] Error abriendo el ticket:', err);
        const msg = err?.code === 'TICKET_EXISTS'
            ? '❌ Ya tienes un ticket abierto o se está creando uno. Cierra el anterior antes de crear otro.'
            : `❌ No se pudo abrir el ticket: ${err.message}`;
        await editarTarjeta(interaction, { color: ACCENT, texto: msg });
    }
}

// ── 4. Los tickets ────────────────────────────────────────────────────────────

function closeBtnRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('cerrar_ticket')
            .setLabel('Cerrar Ticket')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🔒')
    );
}

function confirmBtnRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('confirmar_pago')
            .setLabel('✅ PAGO REALIZADO (SOLO OWNER)')
            .setStyle(ButtonStyle.Success)
    );
}

// Los pasos del pago y el botón del owner, iguales en las dos formas.
function buildPagoPendiente(extra = []) {
    return v2.tarjetaPayload({
        color: 0xFFA500,
        texto: [
            '## Pago Pendiente',
            '',
            ...extra,
            'Selecciona tu método de pago en el menú de arriba.',
            '',
            'Realiza el pago por el monto exacto.',
            '',
            'Envía la **foto del comprobante** en este ticket.',
            '',
            'Escribe **PAGO EXITOSO** para que procesemos tu orden.',
        ].join('\n'),
        pie: '7x Community • Proceso automático',
        filas: [confirmBtnRow()],
    });
}

// Lo que se guarda en el topic del canal: lo que hará falta DENTRO del ticket
// más tarde, y que tiene que sobrevivir a un reinicio.
function pedidoTopic(pedido) {
    return {
        modo: pedido.tipo,
        robux: pedido.robux,
        robloxUserId: pedido.robloxUserId,
        robloxName: pedido.robloxName,
        // Lo lee el botón de PAGO REALIZADO para gastar el descuento en ese
        // momento, y no antes.
        ...(pedido.descuentoFidelidad ? { descuentoFidelidad: true } : {}),
    };
}

// Las líneas de precio del resumen. Las etiquetas son las que lee
// utils/orderNotify.js: "Precio final a pagar" cuando hay descuento y "Precio a
// pagar" cuando no. Así el registro de pedidos y el ranking apuntan lo que de
// verdad se paga, y no el precio de lista.
function lineasPrecio(pedido, cupon) {
    if (pedido.descuentoFidelidad) {
        const final = fidelidad.aplicar(pedido.precio);
        return `${E.money} **Precio original**\n\`\`\`$${fmt(pedido.precio)} MXN\`\`\`\n` +
            `🎁 **Descuento de fidelidad (${fidelidad.F.DESCUENTO}%)**\n\`\`\`Ahorras $${fmt(pedido.precio - final)} MXN\`\`\`\n` +
            `${E.money} **Precio final a pagar**\n\`\`\`$${fmt(final)} MXN\`\`\`\n`;
    }

    if (cupon?.valido) {
        return `${E.money} **Precio original**\n\`\`\`$${fmt(pedido.precio)} MXN\`\`\`\n` +
            `${E.si} **Descuento aplicado — ${cupon.codigo.toUpperCase()} (${cupon.descuento}%)**\n\`\`\`Ahorras $${fmt(pedido.precio - cupon.final)} MXN\`\`\`\n` +
            `${E.money} **Precio final a pagar**\n\`\`\`$${fmt(cupon.final)} MXN\`\`\`\n`;
    }

    let out = '';
    if (cupon && !cupon.valido) {
        out += `${E.alert} **Código usado: ${cupon.codigo.toUpperCase()}**\n\`\`\`Inválido o sin usos disponibles\`\`\`\n`;
    }
    return out + `${E.money} **Precio a pagar**\n\`\`\`$${fmt(pedido.precio)} MXN\`\`\`\n`;
}

// La barra verde de fidelidad en el ticket: cuántas lleva y qué pasa cuando se
// complete ESTA. Cuenta al confirmarse el pago, no al abrir el ticket, y por
// eso el texto habla de "al completar".
function bloqueFidelidad(userId, pedido) {
    const F = fidelidad.F;
    const e = fidelidad.estado(userId);
    const despues = e.progreso + 1;

    const lineas = [
        '### Tu fidelidad',
        `${fidelidad.barra(e.progreso)} **${e.progreso}/${F.CADA}** compras`,
    ];

    if (pedido.descuentoFidelidad) {
        lineas.push(`🎁 Estás usando tu **${F.DESCUENTO}% de descuento** en esta compra.`);
    }

    lineas.push(despues >= F.CADA
        ? `Al completar esta compra ganas un **${F.DESCUENTO}% de descuento** para la compra que tú elijas.`
        : `Al completar esta compra llegarás a **${despues}/${F.CADA}**. Te ${F.CADA - despues === 1 ? 'falta' : 'faltan'} **${F.CADA - despues}** para un **${F.DESCUENTO}% de descuento**.`);

    // El que está usando ahora todavía cuenta como disponible —se gasta al
    // confirmarse el pago—, así que se descuenta aquí para no prometer uno
    // de más.
    const guardados = e.disponibles - (pedido.descuentoFidelidad ? 1 : 0);
    if (guardados > 0) {
        lineas.push(`-# Tienes ${guardados} descuento${guardados === 1 ? '' : 's'} más guardado${guardados === 1 ? '' : 's'} para otra compra.`);
    }

    return lineas.join('\n');
}

async function crearTicketComunidad(interaction, pedido) {
    const userId = interaction.user.id;

    // El cupón se vuelve a mirar AHORA: entre la confirmación y este clic
    // alguien más pudo gastar el último uso.
    // Con el descuento de fidelidad no se aplica cupón: no se combinan.
    const cupon = pedido.descuentoFidelidad ? null : revisarCupon(pedido.cuponCodigo, { datos: pedido });

    const channel = await tickets.createTicket(
        interaction.guild, userId, 'comprar',
        `${TIPOS.comunidad.canal}-${pad(contador.comunidad++)}`,
        pedidoTopic(pedido),
    );

    // Se gasta después de crear el canal: si crearlo falla, no se ha perdido.
    if (cupon?.valido) {
        useCoupon(cupon.codigo);
        refreshCouponEmbed(interaction.client, cupon.codigo).catch(() => {});
    }

    let desc =
        `${E.member} **Usuario de Roblox**\n\`\`\`${pedido.robloxName}\`\`\`\n` +
        `${E.robux} **Robux a recibir**\n\`\`\`${fmt(pedido.robux)} Robux\`\`\`\n` +
        lineasPrecio(pedido, cupon);

    if (pedido.redondeado) {
        desc += `\n${E.alert} Tu monto fue redondeado a **${fmt(pedido.robux)} Robux**.`;
    }

    await channel.send(v2.tarjetaPayload({
        color: ACCENT,
        mencion: `<@${userId}>`,
        texto: `## Resumen de tu compra\n-# Entrega por **comunidad**\n\n${desc}${pedido.comunidadesTexto}\n${bloqueFidelidad(userId, pedido)}`,
        pie: '7x Community • Proceso automático',
        thumbnail: pedido.foto,
        filas: [closeBtnRow()],
    }));

    // El bloque de métodos de pago, sin el GIF: el cliente ya lo vio en el
    // panel, y aquí sólo añadiría segundos de espera a cada ticket.
    await channel.send(buildMetodosPayload());
    await channel.send(buildPagoPendiente());

    return channel;
}

async function crearTicketGamepass(interaction, pedido) {
    const userId = interaction.user.id;

    const channel = await tickets.createTicket(
        interaction.guild, userId, 'comprar',
        `${TIPOS.gamepass.canal}-${pad(contador.gamepass++)}`,
        pedidoTopic(pedido),
    );

    // "Robux a recibir" es lo que de verdad llega a su cuenta, no el valor del
    // gamepass: es lo que dice la etiqueta, y es lo que cuenta el ranking. El
    // valor del gamepass va en su propia línea, justo encima.
    const desc =
        `${E.member} **Usuario de Roblox**\n\`\`\`${pedido.robloxName}\`\`\`\n` +
        `${E.roblox} **Valor del gamepass**\n\`\`\`${fmt(pedido.robux)} Robux\`\`\`\n` +
        `${E.robux} **Robux a recibir**\n\`\`\`${fmt(pedido.recibe)} Robux\`\`\`\n` +
        lineasPrecio(pedido, null) +
        `-# Roblox se queda el ${Math.round(gp.G.TASA_ROBLOX * 100)}% de la venta del gamepass y no lo cubrimos.`;

    await channel.send(v2.tarjetaPayload({
        color: ACCENT,
        mencion: `<@${userId}>`,
        texto: `## Resumen de tu compra\n-# Entrega por **gamepass**\n\n${desc}\n${bloqueFidelidad(userId, pedido)}`,
        pie: '7x Community • Proceso automático',
        thumbnail: pedido.foto,
        filas: [closeBtnRow()],
    }));

    await channel.send(buildGamepassPaso(pedido));
    await channel.send(buildMetodosPayload());
    await channel.send(buildPagoPendiente([
        `Crea tu gamepass de **${fmt(pedido.robux)} Robux** y pega su enlace arriba.`,
        '',
    ]));

    return channel;
}

// El paso propio del gamepass: crearlo por la cantidad exacta y mandar el
// enlace, que se comprueba contra Roblox.
function buildGamepassPaso(pedido) {
    return v2.tarjetaPayload({
        color: ACCENT,
        texto: [
            `## ${E.roblox} Tu gamepass`,
            '',
            `**1.** Crea un gamepass en tu juego de **exactamente ${fmt(pedido.robux)} Robux**.`,
            '**2.** Ponlo **a la venta**.',
            '**3.** Pulsa el botón de abajo y pega su enlace.',
            '',
            `-# Lo comprobamos contra Roblox: que cueste ${fmt(pedido.robux)}, que esté a la venta y que sea de **@${pedido.robloxName}**.`,
        ].join('\n'),
        filas: [buildGpLinkRow()],
    });
}

function buildGpLinkRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('gp_link')
            .setLabel('Agregar link del gamepass')
            .setStyle(ButtonStyle.Primary)
            .setEmoji({ id: '1525317838938701967', name: 'roblox' }),
    );
}

// ── 5. El enlace del gamepass ─────────────────────────────────────────────────

function buildGpLinkModal() {
    return new ModalBuilder()
        .setCustomId('gp_link_modal')
        .setTitle('Enlace de tu gamepass')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('enlace')
                    .setLabel('Enlace del gamepass')
                    .setPlaceholder('https://www.roblox.com/game-pass/123456789/...')
                    .setStyle(TextInputStyle.Short)
                    .setMaxLength(300)
                    .setRequired(true)
            )
        );
}

async function onGpLink(interaction) {
    const ownerId = tickets.getOwner(interaction.channel);
    if (!puedeGestionarTicket(interaction.user.id, ownerId)) {
        return safeReply(interaction, { content: '❌ Solo quien abrió el ticket puede agregar el gamepass.', ephemeral: true });
    }
    const ok = await safeShowModal(interaction, buildGpLinkModal());
    if (!ok) await safeReply(interaction, { content: '❌ No se pudo abrir el formulario. Intenta de nuevo.', ephemeral: true });
}

async function handleGpLinkModal(interaction) {
    if (interaction.replied || interaction.deferred) return;
    if (!await safeDeferReply(interaction, { ephemeral: true })) return;

    // Lo que se pidió sale del topic del canal, no de la memoria: sobrevive a
    // los reinicios, y un ticket de gamepass dura horas.
    const pedido = tickets.getTicketData(interaction.channel)?.pedido;
    if (pedido?.modo !== 'gamepass') {
        return safeEditReply(interaction, { content: '❌ Este ticket no es de compra por gamepass.' });
    }

    const id = gpInfo.extraerIdGamepass(campo(interaction, 'enlace'));
    if (!id) {
        return safeEditReply(interaction, {
            content: `${E.alert} Eso no parece un enlace de gamepass. Debería ser algo como \`https://www.roblox.com/game-pass/123456789\`.`,
        });
    }

    const info = await gpInfo.fetchGamepass(id);
    if (!info.ok) {
        return safeEditReply(interaction, {
            content: info.error === 'no_existe'
                ? `${E.alert} Ese gamepass no existe. Revisa el enlace y vuelve a enviarlo.`
                : `${E.alert} No se pudo comprobar el gamepass ahora mismo. Inténtalo en un momento.`,
        });
    }

    const r = gpInfo.revisarGamepass(info, {
        robux: Number(pedido.robux),
        robloxUserId: pedido.robloxUserId,
        robloxName: pedido.robloxName,
    });

    // Público en el ticket: lo tiene que ver también el owner, que es quien
    // va a comprarlo.
    await interaction.channel.send(v2.tarjetaPayload({
        color: r.listo ? 0x57F287 : 0xFFA500,
        texto: buildTextoRevision(info, r),
    })).catch(err => console.warn('[compra] No se pudo publicar la revisión del gamepass:', err.message));

    await safeEditReply(interaction, {
        content: r.listo
            ? `${E.si} Gamepass correcto. Ya está en el ticket.`
            : `${E.alert} Hay algo que corregir en tu gamepass: míralo en el ticket, arréglalo en Roblox y vuelve a enviar el enlace.`,
    });
}

function buildTextoRevision(info, r) {
    return [
        r.listo
            ? `## ${E.si} Gamepass listo para comprar`
            : `## ${E.alert} Revisa tu gamepass`,
        `**[${info.nombre}](${gpInfo.enlaceGamepass(info.id)})**`,
        '',
        ...r.checks.map(c => `${c.ok ? E.si : E.no} ${c.texto}`),
        '',
        r.listo
            ? '-# Todo cuadra. Cuando confirmemos tu pago, lo compramos.'
            : '-# Corrígelo en Roblox y pulsa de nuevo **Agregar link del gamepass**.',
    ].join('\n');
}

module.exports = {
    buildCompraModal,
    handleCompraModal,
    handleCompraButton,
    handleGpLinkModal,
    onGpLink,
    TIPOS,
    __test: {
        tipoDeModal, calcularPrecio, revisarCupon, buildTextoConfirmacion, buildConfirmarRow,
        buildGamepassPaso, buildTextoRevision, pedidoTopic, editarTarjeta, E,
        lineasPrecio, bloqueFidelidad, lineasFidelidadConfirmacion,
    },
};
