'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { safeDeferReply, safeReply, safeEditReply, safeFollowUp } = require('../utils/safe');
const roblox = require('../src/roblox/client');
const config = require('../config');
const { esAdminDeInteraccion } = require('../utils/permisos');
const { createCoupon, getCoupon, setMessageRef } = require('../utils/coupons');
const { buildRefRow, sendPurchaseDM } = require('../utils/purchaseDm');
const tickets = require('../utils/tickets');
const { requestReview } = require('../utils/reviewFlow');
const { sendOrderCompletionSummary } = require('../utils/orderNotify');
const { buildLeaderboardEmbed } = require('../utils/robuxLeaderboardPanel');
const headlessSale = require('../utils/headlessSale');
const { ensureHeadlessPanel } = require('../headless');
const groupActive = require('../utils/groupActive');
const { ensureGroupStatusPanel } = require('../groupStatus');
const { buildDetallePayload, COPY_ID } = require('../metodos');
const cripto = require('../utils/cryptoPrecios');
const v2 = require('../utils/panelV2');

async function handleOutfit(interaction) {
    if (interaction.channelId !== config.CHANNELS.OUTFIT) {
        return safeReply(interaction, {
            content: `❌ Este comando solo puede usarse en <#${config.CHANNELS.OUTFIT}>.`,
            ephemeral: true,
        });
    }

    const ok = await safeDeferReply(interaction);
    if (!ok) return;

    const username = (interaction.options.getString('user') ?? '').trim();
    if (!username) {
        return safeEditReply(interaction, { content: '❌ Debes ingresar un nombre de usuario de Roblox.' });
    }

    try {
        const user = await roblox.getUserByUsername(username);
        const uid  = user.id;

        // All API calls in parallel; failures are tolerated
        const [profile, followers, friends, avatarUrl, headshotUrl] = await Promise.allSettled([
            roblox.getUserProfile(uid),
            roblox.getFollowerCount(uid),
            roblox.getFriendCount(uid),
            roblox.getAvatarImage(uid),
            roblox.getHeadshot(uid),
        ]).then(r => r.map(x => x.status === 'fulfilled' ? x.value : null));

        const created = profile?.created
            ? new Date(profile.created).toLocaleDateString('es-ES', { year: 'numeric', month: 'short', day: 'numeric' })
            : 'Desconocida';
        const bio = (profile?.description ?? '').trim() || 'Sin descripción';

        const embed = new EmbedBuilder()
            .setColor(0x0b1220)
            .setTitle(`${user.name} • ${user.displayName || user.name}`)
            .setURL(`https://www.roblox.com/users/${uid}/profile`)
            .setThumbnail(headshotUrl ?? undefined)
            .setImage(avatarUrl ?? undefined)
            .addFields(
                { name: 'Nombre',       value: user.name,                                           inline: true },
                { name: 'Display Name', value: user.displayName || '—',                             inline: true },
                { name: 'User ID',      value: String(uid),                                         inline: true },
                { name: 'Followers',    value: followers != null ? followers.toLocaleString() : 'N/A', inline: true },
                { name: 'Friends',      value: friends   != null ? friends.toLocaleString()   : 'N/A', inline: true },
                { name: 'Creado',       value: created,                                             inline: true },
                { name: 'Descripción',  value: bio.substring(0, 1024),                              inline: false }
            )
            .setFooter({ text: '7x Community • Roblox Profile' })
            .setTimestamp();

        await safeEditReply(interaction, { embeds: [embed] });
    } catch (err) {
        const status = err?.response?.status;
        console.error('[outfit] Error:', status, err?.message);
        const msg =
            (status === 404 || err?.message === 'not_found')
                ? '❌ Usuario no encontrado. Verifica el nombre e intenta de nuevo.'
            : status === 429
                ? '⏱️ Roblox está limitando las peticiones. Espera unos segundos e intenta de nuevo.'
                : '❌ No pude obtener la información. Verifica el nombre e intenta de nuevo.';
        await interaction.deleteReply().catch(() => {});
        await safeFollowUp(interaction, { content: msg, ephemeral: true });
    }
}

async function handlePagoVerified(interaction) {
    if (!esAdminDeInteraccion(interaction)) {
        return safeReply(interaction, { content: '❌ No tienes permiso para usar este comando.', ephemeral: true });
    }

    const mentionUser = interaction.options.getUser('usuario');

    // Sin diferir: es una tarjeta de Components V2 y ese flag hay que ponerlo
    // al CREAR el mensaje — un editReply sobre una respuesta ya diferida no
    // puede añadirlo. El contenido no espera a nada, así que diferir no
    // aportaba nada.
    const ok = await safeReply(interaction, v2.tarjetaPayload({
            color: 0x2B2D31,
            mencion: mentionUser ? `<@${mentionUser.id}>` : null,
            texto:
                '## <:truepurple:1501214679400190086> Pago Verificado — 7x Community\n\n' +
                '¡Gracias por tu compra con **7x Community**!\n\n' +
                '<:point:1501212595464700104> Ya sea que hayas adquirido **Robux** u otro tipo de producto, esperamos que lo disfrutes al máximo.\n\n' +
                '<:point:1501212595464700104> Si adquiriste Robux y aún no aparecen en tu balance, no te preocupes. Roblox puede colocarlos en estado **Pendiente** por motivos de seguridad.\n\n' +
                '<:alert:1501220021035204658> Normalmente se acreditan en **5 a 10 minutos**, aunque en casos poco comunes puede tomar hasta **6-7 días**. Como máximo, Roblox los libera dentro de **10 días**.\n\n' +
                '<:point:1501212595464700104> Puedes revisar el estado de tus transacciones aquí: [Ver Robux pendientes](<https://www.roblox.com/transactions>)\n\n' +
                '<:truepurple:1501214679400190086> ¡Gracias por confiar en nosotros y esperamos verte pronto!',
            pie: '7x Community • Compra verificada',
            filas: [buildRefRow()],
    }));
    if (!ok) return;

    if (mentionUser) {
        await sendPurchaseDM(interaction.client, mentionUser.id);
    }

    // ── Review request (ticket-scoped, so we need a buyer + an actual ticket) ──
    // No-op if onConfirmarPago already requested one for this ticket — requestReview is idempotent.
    const buyerId  = mentionUser?.id ?? tickets.getOwner(interaction.channel);
    const isTicket = interaction.channel?.parentId === config.CATEGORIES.TICKETS;

    if (isTicket && buyerId) {
        await requestReview(interaction.client, interaction.channel, interaction.channelId, buyerId);
        await sendOrderCompletionSummary(interaction.client, interaction.channel, buyerId);
    }
}

// Enseña el detalle de un método de pago. El contenido es EXACTAMENTE el mismo
// que sale al pulsar su botón en el panel: sale de buildDetallePayload, así que
// no hay dos versiones de una cuenta bancaria que puedan desincronizarse.
//
// La respuesta es pública a propósito, al revés que el botón: este comando lo
// usa el staff dentro de un ticket para enseñarle los datos al cliente, y un
// efímero sólo lo vería quien escribió el comando.
// Responde DIRECTAMENTE, sin diferir: el bloque de métodos de pago es un
// contenedor de Components V2, y ese flag hay que ponerlo al crear el mensaje —
// un editReply sobre una respuesta ya diferida no puede añadirlo. Como el
// contenido se construye sin esperar a nada, diferir no aportaba nada.
async function handlePagos(interaction) {
    const metodo = interaction.options.getString('metodo');
    const payload = buildDetallePayload(metodo);

    if (!payload) {
        return safeReply(interaction, { content: '❌ Ese método de pago ya no está disponible.', ephemeral: true });
    }
    return safeReply(interaction, payload);
}

function buildCouponEmbed(codigo, coupon) {
    const remaining = coupon.maxUses - coupon.uses;
    const fields = [
        { name: '<:sale:1501212817502502913> Código', value: `\`${codigo.toUpperCase()}\``,               inline: true },
        { name: 'Descuento',                          value: `${coupon.discount}%`,                       inline: true },
        { name: 'Máx. Robux',                         value: `${coupon.maxRobux.toLocaleString()} Robux`, inline: true },
        { name: 'Usos máximos',                       value: `${coupon.maxUses}`,                         inline: true },
        { name: 'Usos restantes',                     value: `${remaining}`,                              inline: true },
        { name: 'Creado por',                         value: `<@${coupon.creatorId}>`,                    inline: true },
    ];
    if (coupon.roleId) {
        fields.push({ name: 'Rol', value: `<@&${coupon.roleId}>`, inline: true });
    }
    return new EmbedBuilder()
        .setColor(0x5b5b5b)
        .setTitle('7x - Cupón')
        .addFields(...fields)
        .setFooter({ text: '7x Community • Sistema de cupones' })
        .setTimestamp();
}

function buildCouponRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setLabel('canjear')
            .setEmoji({ id: '1182888883344642180', name: 'rro', animated: true })
            .setStyle(ButtonStyle.Link)
            .setURL('https://discord.com/channels/1162602588328435802/1442456304420524146'),
    );
}

async function refreshCouponEmbed(client, code) {
    const coupon = getCoupon(code);
    if (!coupon?.messageRef) return;
    try {
        const ch  = await client.channels.fetch(coupon.messageRef.channelId);
        const msg = await ch.messages.fetch(coupon.messageRef.messageId);
        await msg.edit({ embeds: [buildCouponEmbed(code, coupon)], components: [buildCouponRow()] });
    } catch (err) {
        console.warn('[offer] Could not refresh coupon embed:', err.message);
    }
}

async function handleOffer(interaction) {
    if (!esAdminDeInteraccion(interaction)) {
        return safeReply(interaction, { content: '❌ No tienes permiso para usar este comando.', ephemeral: true });
    }

    const ok = await safeDeferReply(interaction); // público
    if (!ok) return;

    const codigo    = interaction.options.getString('codigo').trim().toUpperCase();
    const descuento = interaction.options.getInteger('descuento');
    const usos      = interaction.options.getInteger('usos');
    const maxRobux  = interaction.options.getInteger('maxrobux');
    const roleId    = interaction.options.getRole('rol')?.id ?? null;

    if (descuento < 1 || descuento > 99) {
        return safeEditReply(interaction, { content: '❌ El porcentaje debe estar entre 1 y 99.' });
    }
    if (usos < 1) {
        return safeEditReply(interaction, { content: '❌ La cantidad de usos debe ser al menos 1.' });
    }

    createCoupon(codigo, descuento, usos, maxRobux, interaction.user.id, roleId);
    const coupon = getCoupon(codigo);

    await safeEditReply(interaction, { embeds: [buildCouponEmbed(codigo, coupon)], components: [buildCouponRow()] });

    // Store message reference so it can be edited on each coupon use
    try {
        const msg = await interaction.fetchReply();
        setMessageRef(codigo, msg.channelId, msg.id);
    } catch (err) {
        console.warn('[offer] Could not store message ref:', err.message);
    }
}

async function handleClose(interaction) {
    if (!esAdminDeInteraccion(interaction)) {
        return safeReply(interaction, { content: '❌ No tienes permiso para usar este comando.', ephemeral: true });
    }

    const channel = interaction.channel;
    if (channel?.parentId !== config.CATEGORIES.TICKETS) {
        return safeReply(interaction, { content: '❌ Este comando solo puede usarse dentro de un ticket.', ephemeral: true });
    }

    const ok = await safeDeferReply(interaction, { ephemeral: true });
    if (!ok) return;
    await safeEditReply(interaction, { content: '🔒 Cierre automático iniciado. El ticket se eliminará en 10 minutos.' });

    const { startAutoClose } = require('./buttons');
    await startAutoClose(channel);
}

// ── /headless on|off ──────────────────────────────────────────────────────────
// Abre o cierra la venta del Headless. Sólo el owner, igual que /offer o
// /pagoverified: el gate real es este chequeo, no el registro del comando.
//
// Además de mover el interruptor, repinta el panel para que la línea de estado
// diga la verdad sin esperar a un reinicio. Si el repintado falla (canal
// borrado, permisos), el estado YA está guardado: se avisa en la respuesta en
// vez de dejar creer que no se aplicó nada.

async function handleHeadless(interaction) {
    if (!esAdminDeInteraccion(interaction)) {
        return safeReply(interaction, { content: '❌ No tienes permiso para usar este comando.', ephemeral: true });
    }

    const ok = await safeDeferReply(interaction, { ephemeral: true });
    if (!ok) return;

    const abrir = interaction.options.getSubcommand() === 'on';
    const { changed } = headlessSale.setOpen(abrir, interaction.user.id);

    // ensureHeadlessPanel devuelve el mensaje del panel, o null si no llegó a
    // tocarlo (canal sin configurar o inaccesible). Las dos cosas cuentan como
    // "no se repintó": no se le dice al owner que el panel está al día si no lo
    // está.
    let panelMsg = null;
    try {
        panelMsg = await ensureHeadlessPanel(interaction.client);
    } catch (err) {
        console.error('[headless] No se pudo repintar el panel tras el cambio de estado:', err);
    }
    const panelOk = Boolean(panelMsg);

    const estado = abrir
        ? '<a:add:1540603311890104321> **Venta ABIERTA** — cualquiera puede abrir su ticket del Headless.'
        : '<a:remove:1540604743234228364> **Venta CERRADA** — nadie puede abrir tickets del Headless.';

    const nota = changed ? '' : '\n-# Ya estaba así: no ha cambiado nada.';
    const aviso = panelOk
        ? `\n-# Panel actualizado en <#${config.CHANNELS.HEADLESS}>.`
        : `\n<:alert:1501220021035204658> El estado se guardó, pero no se pudo actualizar el panel de <#${config.CHANNELS.HEADLESS}>. Revisa la consola.`;

    await safeEditReply(interaction, { content: `${estado}${nota}${aviso}` });
}

// ── /groupactive <grupo> <estado> ─────────────────────────────────────────────
// Marca una comunidad como activa o caída y repinta el panel de estado. Sólo el
// owner, igual que /offer o /headless: el gate real es este chequeo, no el
// registro del comando.

async function handleGroupActive(interaction) {
    if (!esAdminDeInteraccion(interaction)) {
        return safeReply(interaction, { content: '❌ No tienes permiso para usar este comando.', ephemeral: true });
    }

    const ok = await safeDeferReply(interaction, { ephemeral: true });
    if (!ok) return;

    const clave  = interaction.options.getString('grupo');
    const activa = interaction.options.getString('estado') === 'on';

    const resultado = groupActive.setActive(clave, activa, interaction.user.id);
    if (!resultado.ok) {
        // Sólo se llega aquí con una opción manipulada o con un grupo retirado
        // de config entre que Discord cacheó el comando y llegó la ejecución.
        return safeEditReply(interaction, { content: '❌ Esa comunidad no existe en la configuración del bot.' });
    }

    // Igual que /headless: el panel devuelve el mensaje, o null si no llegó a
    // tocarlo. No se le dice al owner que el panel está al día si no lo está.
    let panelMsg = null;
    try {
        panelMsg = await ensureGroupStatusPanel(interaction.client);
    } catch (err) {
        console.error('[groupStatus] No se pudo repintar el panel tras el cambio:', err);
    }

    const label  = config.CHECK_GROUPS[clave].label;
    const estado = activa
        ? `<:working:1547108520669741157> **${label}** está ahora **ACTIVA** — se anuncia que envía Robux.`
        : `<:down:1547141212530679899> **${label}** está ahora **CAÍDA** — se anuncia que no envía Robux.`;

    const nota  = resultado.changed ? '' : '\n-# Ya estaba así: no ha cambiado nada.';
    const aviso = panelMsg
        ? `\n-# Panel actualizado en <#${config.CHANNELS.GROUP_STATUS}>.`
        : `\n<:alert:1501220021035204658> El estado se guardó, pero no se pudo actualizar el panel de <#${config.CHANNELS.GROUP_STATUS}>. Revisa la consola.`;

    await safeEditReply(interaction, { content: `${estado}${nota}${aviso}` });
}

async function handleTopCompradores(interaction) {
    const ok = await safeDeferReply(interaction);
    if (!ok) return;

    await safeEditReply(interaction, { embeds: [buildLeaderboardEmbed()] });
}

// ── /crypto ───────────────────────────────────────────────────────────────────
// Cuánta cripto son X pesos (o dólares) al cambio de ahora, con las MISMAS
// monedas que acepta el panel de pagos.
//
// NO difiere, y es deliberado: la tarjeta va en Components V2 y ese flag no se
// puede añadir al editar una respuesta ya diferida, así que hay que contestar
// dentro de los 3 s de Discord. Por eso la consulta de precios lleva un tope de
// 2,5 s y una caché de 60 s (ver utils/cryptoPrecios.js).

const CRYPTO_E = {
    cripto: '<:cripto:1552521783406497822>',
    point:  '<:point:1501212595464700104>',
    alert:  '<:alert:1501220021035204658>',
    copiar: { id: '1527509149758259371', name: 'copiar' },
};

function buildCryptoRow(ticker) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(COPY_ID(ticker.toLowerCase()))
            .setLabel(ticker)
            .setEmoji(CRYPTO_E.copiar)
            .setStyle(ButtonStyle.Secondary)
    );
}

function buildCryptoTexto({ moneda, cantidad, divisa, precioUnidad, monto, edadMs, rancio }) {
    const lineas = [
        `## ${CRYPTO_E.cripto} ${cripto.formatearDinero(cantidad, divisa)} EN ${moneda.ticker}`,
        '',
        `# ${cripto.formatearCripto(monto)} ${moneda.ticker}`,
        `-# ${moneda.nombre} · red ${moneda.red}`,
        '',
        `${CRYPTO_E.point} 1 ${moneda.ticker} = **${cripto.formatearDinero(precioUnidad, divisa)}**`,
        `${CRYPTO_E.point} Dirección de 7x: \`${moneda.direccion}\``,
        '',
    ];

    // Un precio viejo NUNCA se presenta como actual: si la API no contestó y se
    // está tirando de la última consulta buena, se dice de cuándo es.
    lineas.push(rancio
        ? `-# ${CRYPTO_E.alert} No se pudo consultar el precio ahora mismo: este es el de hace ${minutos(edadMs)}.`
        : `-# Precio de CoinGecko, de hace ${segundos(edadMs)}.`);

    lineas.push('-# El cambio se mueve a cada momento. Confirma el importe antes de enviar.');

    return lineas.join('\n');
}

function segundos(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 5 ? 'unos segundos' : `${s} s`;
}

function minutos(ms) {
    const m = Math.max(1, Math.round(ms / 60000));
    return m === 1 ? 'un minuto' : `${m} minutos`;
}

async function handleCrypto(interaction) {
    const cantidad = interaction.options.getNumber('cantidad');
    const ticker   = interaction.options.getString('moneda');
    const divisa   = interaction.options.getString('divisa') ?? 'MXN';
    const publico  = interaction.options.getString('visibilidad') === 'todos';

    const moneda = cripto.MONEDAS.find(m => m.ticker === ticker);
    if (!moneda) {
        return safeReply(interaction, { content: '❌ Esa moneda ya no está disponible.', ephemeral: true });
    }

    // La opción ya viene acotada por Discord (min/max), pero el número llega del
    // cliente: un NaN o un negativo aquí daría una cantidad de cripto absurda.
    if (!Number.isFinite(cantidad) || cantidad <= 0) {
        return safeReply(interaction, { content: '❌ La cantidad tiene que ser un número mayor que cero.', ephemeral: true });
    }

    const datos = await cripto.obtenerPrecios(divisa);
    const precioUnidad = datos.ok ? datos.precios[moneda.ticker] : null;
    const monto = cripto.convertir(cantidad, precioUnidad);

    // Sin precio no se inventa nada. Es dinero: un número aproximado "por no
    // dejar el comando vacío" es peor que decir que no se pudo.
    if (monto === null) {
        return safeReply(interaction, {
            content: `${CRYPTO_E.alert} No se pudo consultar el precio de **${moneda.nombre}** ahora mismo. Inténtalo en un momento.`,
            ephemeral: true,
        });
    }

    return safeReply(interaction, {
        ...v2.tarjetaPayload({
            color: 0x2B2D31,
            texto: buildCryptoTexto({
                moneda, cantidad, divisa, precioUnidad, monto,
                edadMs: datos.edadMs, rancio: datos.rancio,
            }),
            filas: [buildCryptoRow(moneda.ticker)],
        }),
        ...(publico ? {} : { ephemeral: true }),
    });
}

// ── /avatar ───────────────────────────────────────────────────────────────────
// La ficha de un usuario de Roblox: su avatar en grande, la insignia de Premium
// si la tiene y sus números de seguidores, amigos y seguidos.
//
// Va como embed clásico y no como tarjeta V2 por una razón concreta: el PIE de
// un embed ya se pinta pequeño y EN GRIS, y debajo de la imagen. Es exactamente
// donde tienen que ir los tres números, y en un contenedor habría que imitarlo
// a mano. El nombre va en la DESCRIPCIÓN como encabezado, no en `setTitle()`,
// porque Discord no pinta los emojis del servidor en el título de un embed —
// ahí la insignia de Premium saldría como `<:premium:123>` en crudo.

function buildAvatarEmbed({ user, uid, avatarUrl, premium, seguidores, amigos, siguiendo }) {
    const perfil = `https://www.roblox.com/users/${uid}/profile`;
    const mostrado = user.displayName || user.name;

    // La insignia sólo aparece con un `true` explícito. `null` es "no se pudo
    // comprobar", y eso NO es lo mismo que "no tiene Premium": sin el dato no
    // se afirma nada.
    const insignia = premium === true
        ? ` ${config.ROBLOX_PREMIUM_EMOJI ?? '`PREMIUM`'}`
        : '';

    const cabecera = [
        `## ${mostrado}${insignia}`,
        `-# @${user.name} · \`${uid}\` · [Ver perfil](${perfil})`,
    ];
    if (user.hasVerifiedBadge) cabecera.push('-# <:true:1501213776878501899> Cuenta verificada por Roblox');

    const embed = new EmbedBuilder()
        .setColor(0x2B2D31)
        .setDescription(cabecera.join('\n'))
        .setURL(perfil);

    if (avatarUrl) embed.setImage(avatarUrl);

    // El pie: pequeño, gris y bajo la imagen. Un número que no se pudo
    // consultar sale como "—" en vez de como 0, que sería decir que no tiene
    // ninguno.
    embed.setFooter({ text: buildAvatarPie({ seguidores, amigos, siguiendo }) });

    return embed;
}

function buildAvatarPie({ seguidores, amigos, siguiendo }) {
    const n = v => (typeof v === 'number' ? v.toLocaleString('es-MX') : '—');
    return `${n(seguidores)} seguidores · ${n(amigos)} amigos · ${n(siguiendo)} siguiendo`;
}

async function handleAvatar(interaction) {
    const ok = await safeDeferReply(interaction);
    if (!ok) return;

    const username = (interaction.options.getString('usuario') ?? '').trim();
    if (!username) {
        return safeEditReply(interaction, { content: '❌ Debes escribir un nombre de usuario de Roblox.' });
    }

    try {
        const user = await roblox.getUserByUsername(username);
        const uid  = user.id;

        // Todo en paralelo y tolerando fallos: la ficha se pinta con lo que
        // haya. Que Roblox no dé el número de amigos no puede dejar sin avatar.
        const [avatarUrl, seguidores, amigos, siguiendo, avanzado] = await Promise.allSettled([
            roblox.getAvatarImage(uid),
            roblox.getFollowerCount(uid),
            roblox.getFriendCount(uid),
            roblox.getFollowingCount(uid),
            roblox.getUserAdvanced(uid),
        ]).then(r => r.map(x => (x.status === 'fulfilled' ? x.value : null)));

        await safeEditReply(interaction, {
            embeds: [buildAvatarEmbed({
                user, uid, avatarUrl,
                premium: avanzado?.premium ?? null,
                seguidores, amigos, siguiendo,
            })],
        });
    } catch (err) {
        const status = err?.response?.status;
        console.error('[avatar] Error:', status, err?.message);
        const msg =
            (status === 404 || err?.message === 'not_found')
                ? '❌ Usuario no encontrado. Revisa el nombre e inténtalo de nuevo.'
            : status === 429
                ? '⏱️ Roblox está limitando las peticiones. Espera unos segundos e inténtalo de nuevo.'
                : '❌ No pude obtener la información. Revisa el nombre e inténtalo de nuevo.';
        await interaction.deleteReply().catch(() => {});
        await safeFollowUp(interaction, { content: msg, ephemeral: true });
    }
}

module.exports = {
    handleOutfit, handlePagos, handlePagoVerified, handleOffer, handleClose,
    handleHeadless, handleGroupActive, handleTopCompradores, handleCrypto, handleAvatar,
    refreshCouponEmbed,
    __test: { buildCryptoTexto, buildCryptoRow, segundos, minutos, buildAvatarEmbed, buildAvatarPie },
};
