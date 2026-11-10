'use strict';

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, UserFlags, PermissionFlagsBits } = require('discord.js');
const { safeReply, safeDeferReply, safeEditReply } = require('../utils/safe');
const { esAdmin } = require('../utils/permisos');
const { ui, uiBoton, insignia } = require('../utils/uiIconos');
const config = require('../config');

// ── /userinfo ────────────────────────────────────────────────────────────────
//
// La ficha de un miembro: perfil, insignias, Nitro, boost, roles, su historial
// en 7x y un nivel de confianza calculado. Lo puede usar cualquiera, sobre
// cualquiera MENOS sobre los owners (config.ADMIN_IDS): su información es
// privada. Un owner sí puede verse a sí mismo. La ficha se ve en el canal
// para todos.
//
// Lo que Discord NO da a los bots, y por eso no se inventa:
//   · Si alguien tiene Nitro, ni de qué tipo, ni desde cuándo. Se DEDUCE de lo
//     que sólo se puede tener con Nitro (avatar animado, banner, avatar o
//     banner propio en el servidor) y se dice que es deducido.
//   · Cuántas mejoras pone cada persona: sólo desde cuándo está boosteando.

const DIA = 86_400_000;
const s = ms => Math.floor(ms / 1000);

// Insignias públicas del perfil (public_flags).
// [flag, clave de la insignia oficial (config.INSIGNIAS_EMOJIS), reserva, nombre]
const INSIGNIAS = [
    [UserFlags.Staff, 'staff', '🛠️', 'Staff de Discord'],
    [UserFlags.Partner, 'partner', '🤝', 'Partner de Discord'],
    [UserFlags.CertifiedModerator, 'moderador', '🎓', 'Moderador certificado'],
    [UserFlags.Hypesquad, 'hypesquad', '🎉', 'HypeSquad Events'],
    [UserFlags.HypeSquadOnlineHouse1, 'bravery', '🟣', 'HypeSquad Bravery'],
    [UserFlags.HypeSquadOnlineHouse2, 'brilliance', '🟠', 'HypeSquad Brilliance'],
    [UserFlags.HypeSquadOnlineHouse3, 'balance', '🟢', 'HypeSquad Balance'],
    [UserFlags.BugHunterLevel1, 'bughunter', '🐛', 'Bug Hunter'],
    [UserFlags.BugHunterLevel2, 'bughunter2', '🐞', 'Bug Hunter (oro)'],
    [UserFlags.PremiumEarlySupporter, 'earlysupporter', '💠', 'Early Supporter'],
    [UserFlags.VerifiedDeveloper, 'verifdev', '⚙️', 'Desarrollador de bots verificado'],
    [UserFlags.ActiveDeveloper, 'activedev', '💻', 'Desarrollador activo'],
    [UserFlags.VerifiedBot, null, '✅', 'Bot verificado'],
];

// Insignia de booster de Discord: la de "1 mes" sale EL PRIMER DÍA de boost, y
// cambia a los 2, 3, 6, 9, 12, 15, 18 y 24 meses boosteando sin parar.
const NIVELES_BOOST = [1, 2, 3, 6, 9, 12, 15, 18, 24];
const umbralBoost = n => (n === 1 ? 0 : n);

function sumarMeses(ms, meses) {
    const d = new Date(ms);
    d.setUTCMonth(d.getUTCMonth() + meses);
    return d.getTime();
}

function mesesEntre(desde, hasta) {
    let n = 0;
    while (sumarMeses(desde, n + 1) <= hasta) n++;
    return n;
}

function infoBoost(desde, ahora) {
    if (!desde) return null;
    const meses = mesesEntre(desde, ahora);
    const actual = [...NIVELES_BOOST].reverse().find(n => meses >= umbralBoost(n));
    const siguiente = NIVELES_BOOST.find(n => n > actual) ?? null;
    return { meses, actual, siguiente, siguienteEn: siguiente ? sumarMeses(desde, siguiente) : null };
}

function duracion(ms) {
    const d = Math.floor(ms / DIA);
    if (d >= 365) {
        const a = Math.floor(d / 365), m = Math.floor((d % 365) / 30);
        return `${a} año${a === 1 ? '' : 's'}${m ? ` y ${m} mes${m === 1 ? '' : 'es'}` : ''}`;
    }
    if (d >= 30) { const m = Math.floor(d / 30); return `${m} mes${m === 1 ? '' : 'es'}`; }
    if (d >= 1) return `${d} día${d === 1 ? '' : 's'}`;
    const h = Math.floor(ms / 3_600_000);
    return h >= 1 ? `${h} hora${h === 1 ? '' : 's'}` : 'menos de una hora';
}

// Nitro deducido de lo que SÓLO se puede tener con Nitro. `raw` son los objetos
// crudos de la API (usuario y miembro): traen campos que discord.js todavía no
// expone, como el estilo del nombre.
//
// Lo que NO cuenta, aunque parezca: placas de nombre y decoraciones de avatar
// se pueden comprar en la tienda sin Nitro, y el tag de servidor lo puede
// llevar cualquiera.
function senalesNitro(user, member, raw = {}) {
    const senales = [];
    if (user.avatar?.startsWith('a_')) senales.push('avatar animado');
    if (user.banner) senales.push(user.banner.startsWith('a_') ? 'banner animado' : 'banner de perfil');
    if (member?.avatar) senales.push('avatar propio en este servidor');
    if (member?.banner) senales.push('banner propio en este servidor');
    if (raw.usuario?.display_name_styles || raw.miembro?.display_name_styles) senales.push('estilo de nombre');
    return senales;
}

// "nameplates/nameplates/cherry_blossoms/" → "Cherry Blossoms"
function nombreColeccionable(asset) {
    const ultimo = String(asset ?? '').split('/').filter(Boolean).pop() ?? '';
    return ultimo.split('_').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

// Lo que la persona lleva puesto: placa de nombre, decoración de avatar y tag
// de servidor. Cosmético: no prueba Nitro, pero sí que la cuenta está cuidada.
function personalizacion(raw = {}) {
    const u = raw.usuario ?? {}, m = raw.miembro ?? {};
    const out = [];
    const placa = m.collectibles?.nameplate ?? u.collectibles?.nameplate;
    if (placa?.asset) out.push(`**Placa de nombre:** ${nombreColeccionable(placa.asset)}`);
    const deco = m.avatar_decoration_data ?? u.avatar_decoration_data;
    if (deco?.asset) out.push('**Decoración de avatar:** sí');
    const tag = u.primary_guild ?? u.clan;
    if (tag?.identity_enabled && tag.tag) out.push(`**Tag de servidor:** \`${tag.tag}\``);
    return out;
}

// Confianza: una puntuación con sus razones, para que se vea POR QUÉ.
function confianza({ user, member, compras, boostDesde, alertaSuplantacion, ahora }) {
    let p = 0;
    const r = [];
    const edad = ahora - user.createdTimestamp;
    if (edad < 7 * DIA) { p -= 3; r.push('cuenta de menos de 7 días'); }
    else if (edad < 30 * DIA) { p -= 1; r.push('cuenta de menos de un mes'); }
    else if (edad > 365 * DIA) { p += 3; r.push('cuenta de más de un año'); }
    else if (edad > 90 * DIA) { p += 2; r.push('cuenta de más de 3 meses'); }
    else p += 1;

    if (member?.joinedTimestamp) {
        const t = ahora - member.joinedTimestamp;
        if (t > 90 * DIA) { p += 2; r.push('más de 3 meses en el servidor'); }
        else if (t > 30 * DIA) p += 1;
        else if (t < DIA) { p -= 1; r.push('entró hace menos de un día'); }
    } else { p -= 1; r.push('no está en el servidor'); }

    if (compras >= 5) { p += 3; r.push(`${compras} compras en 7x`); }
    else if (compras >= 1) { p += 2; r.push(`${compras} compra${compras === 1 ? '' : 's'} en 7x`); }
    if (boostDesde) { p += 2; r.push('tiene insignia de booster'); }
    if (!user.avatar) { p -= 1; r.push('sin foto de perfil'); }
    if (user.flags?.has?.(UserFlags.Spammer)) { p -= 5; r.push('Discord lo marcó como spammer'); }
    if (alertaSuplantacion) { p -= 3; r.push('aviso de suplantación abierto'); }
    if (member?.isCommunicationDisabled?.()) { p -= 2; r.push('aislado (timeout) ahora mismo'); }

    const nivel = p >= 6 ? ['🟢', 'Alta'] : p >= 2 ? ['🟡', 'Media'] : ['🔴', 'Baja'];
    return { puntos: p, icono: nivel[0], nivel: nivel[1], razones: r };
}

// ── Construcción (pura) ──────────────────────────────────────────────────────

// `boosts` = [{ servidor, desde }]: dónde boostea entre los servidores en los
// que está el bot (incluido este). Es lo único que Discord deja ver a un bot:
// el perfil, que es donde sale la insignia, está vetado a los bots ("Bots
// cannot use this endpoint"). La insignia de booster del perfil cuenta desde el
// boost activo MÁS ANTIGUO, así que si se ve aquí, el nivel coincide con el del
// perfil.
function construirUserinfo({ user, member, guild, datos7x = {}, boosts = null, servidoresRevisados = 1, raw = {}, alertaSuplantacion = false, ahora = Date.now() }) {
    const campos = [];
    const f = (name, value, inline = true) => campos.push({ name, value: String(value).slice(0, 1024) || '—', inline });

    // Perfil
    f(`${ui('perfil')} Perfil`, [
        `**Usuario:** ${user.username}`,
        user.globalName ? `**Nombre:** ${user.globalName}` : null,
        member?.nickname ? `**Apodo:** ${member.nickname}` : null,
        `**ID:** \`${user.id}\``,
        user.bot ? '**Tipo:** Bot' : null,
    ].filter(Boolean).join('\n'));
    f(`${ui('reloj')} Cuenta creada`, `<t:${s(user.createdTimestamp)}:D>\n${duracion(ahora - user.createdTimestamp)}`);
    if (member?.joinedTimestamp) {
        const orden = datos7x.posicionEntrada ? `\nMiembro #${datos7x.posicionEntrada.toLocaleString('en-US')}` : '';
        f(`${ui('server')} En el servidor`, `<t:${s(member.joinedTimestamp)}:D>\n${duracion(ahora - member.joinedTimestamp)}${orden}`);
    } else {
        f(`${ui('server')} En el servidor`, 'No es miembro');
    }

    // Insignias
    const insignias = INSIGNIAS.filter(([flag]) => user.flags?.has?.(flag)).map(([, clave, reserva, n]) => `${insignia(clave, reserva)} ${n}`);
    const nitro = senalesNitro(user, member, raw);
    const lista = (boosts ?? (member?.premiumSinceTimestamp ? [{ servidor: guild?.name ?? 'este servidor', desde: member.premiumSinceTimestamp, aqui: true }] : []))
        .filter(x => x.desde).sort((a, z) => a.desde - z.desde);
    const boostDesde = lista[0]?.desde ?? null;
    const boosteaAqui = lista.some(x => x.aqui);
    const b = infoBoost(boostDesde, ahora);
    if (nitro.length || boostDesde) insignias.push(`${insignia('nitro', ui('nitro'))} Nitro${nitro.length ? '' : ' (probable)'}`);
    if (b) insignias.push(`${insignia(`boost${b.actual}`, ui('boost'))} Server Booster · ${b.actual} mes${b.actual === 1 ? '' : 'es'}`);
    if (user.flags?.has?.(UserFlags.Spammer)) insignias.push(`${ui('alerta')} **Marcado como spammer por Discord**`);
    // Nunca "Ninguna": que el bot no vea una insignia no significa que no la
    // tenga (Nitro, booster de otros servidores, Quests y Orbs no se ven).
    f(`${ui('insignia')} Insignias`, [
        insignias.length ? insignias.join('\n') : 'Ninguna de las que Discord muestra a los bots',
        '-# Las de Nitro (bronce…diamante), Quests, Orbs y booster de otros servidores sólo se ven en el perfil: Discord no las comparte con bots.',
    ].join('\n'), false);

    const extra = personalizacion(raw);
    if (extra.length) f(`${ui('perfil')} Personalización`, extra.join('\n'));

    // Nitro
    f(`${insignia('nitro', ui('nitro'))} Nitro`, nitro.length
        ? `**Sí** — ${nitro.join(', ')}${boostDesde ? `\nActivo al menos desde <t:${s(boostDesde)}:D>` : ''}\n-# Discord no comparte el tipo ni la antigüedad exacta`
        : boostDesde
            ? `**Probable** — está boosteando\nAl menos desde <t:${s(boostDesde)}:D>\n-# Discord no comparte el tipo ni la antigüedad exacta`
            : '**No se puede comprobar**\n-# Discord no le dice a los bots quién tiene Nitro ni su nivel. Sólo se ve si usa algo exclusivo: avatar animado, banner o estilo de nombre.');

    // Insignia de booster (la del perfil)
    if (b) {
        f(`${insignia(`boost${b.actual}`, ui('boost'))} Insignia de booster`, [
            `${insignia(`boost${b.actual}`)} **${b.actual} mes${b.actual === 1 ? '' : 'es'}** · boosteando desde <t:${s(boostDesde)}:D> (${duracion(ahora - boostDesde)})`,
            b.siguiente
                ? `Siguiente: ${insignia(`boost${b.siguiente}`)} **${b.siguiente} meses** <t:${s(b.siguienteEn)}:R>`
                : 'Ya tiene la insignia máxima (24 meses)',
            `Boostea ${boosteaAqui ? 'este servidor' : 'otro servidor'}${lista.length > 1 ? ` y ${lista.length - 1} más` : ''}`,
        ].join('\n'), false);
    } else {
        f(`${ui('boost')} Insignia de booster`, `**No se puede comprobar** · no boostea ninguno de los ${servidoresRevisados} servidor(es) donde está el bot\n-# Si boostea otro servidor, la insignia sólo se ve en su perfil: Discord no la comparte con bots.`, false);
    }

    // Roles
    if (member) {
        const roles = [...member.roles.cache.values()]
            .filter(r => r.id !== guild?.id)
            .sort((a, z) => z.position - a.position);
        const lista = roles.slice(0, 15).map(r => `<@&${r.id}>`).join(' ');
        const extra = roles.length > 15 ? ` y ${roles.length - 15} más` : '';
        const clave = [];
        if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) clave.push('Administrador');
        else if (member.permissions?.has?.(PermissionFlagsBits.ModerateMembers)) clave.push('Moderador');
        if (member.isCommunicationDisabled?.()) clave.push(`Aislado hasta <t:${s(member.communicationDisabledUntilTimestamp)}:R>`);
        if (member.pending) clave.push('Sin completar la verificación');
        f(`${ui('roles')} Roles (${roles.length})`, `${lista || 'Ninguno'}${extra}${clave.length ? `\n**Estado:** ${clave.join(' · ')}` : ''}`, false);
    }

    // 7x
    const compras = datos7x.compras ?? 0;
    f(`${ui('compras')} Compras en 7x`, compras
        ? `${compras} compra${compras === 1 ? '' : 's'}\n${Math.round(datos7x.robux ?? 0).toLocaleString('en-US')} Robux`
        : 'Ninguna todavía');
    f(`${ui('invita')} Invitaciones`, [
        `${datos7x.invitaciones ?? 0} válida${datos7x.invitaciones === 1 ? '' : 's'}`,
        datos7x.invitadoPor ? `Invitado por <@${datos7x.invitadoPor}>` : null,
    ].filter(Boolean).join('\n'));
    f(`${ui('ticket')} Ticket`, datos7x.ticket ? `Abierto: <#${datos7x.ticket}>` : 'Ninguno abierto');

    // Confianza
    const c = confianza({ user, member, compras, boostDesde, alertaSuplantacion, ahora });
    f(`${ui('escudo')} Confianza: ${c.icono} ${c.nivel}`, c.razones.length ? c.razones.map(x => `• ${x}`).join('\n') : 'Sin señales destacables', false);

    const color = user.accentColor ?? (member?.displayColor || null) ?? 0x5865F2;
    const nombre = member?.displayName ?? user.globalName ?? user.username;
    const embed = new EmbedBuilder()
        .setColor(color || 0x5865F2)
        .setAuthor({ name: `${nombre} · Ficha de usuario`, iconURL: user.displayAvatarURL({ size: 128 }) })
        .setThumbnail((member ?? user).displayAvatarURL({ size: 512 }))
        .addFields(campos)
        .setFooter({ text: `7x Community · ID ${user.id}` })
        .setTimestamp(ahora);
    const banner = user.bannerURL?.({ size: 1024 });
    if (banner) embed.setImage(banner);

    const fila = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Ver perfil').setURL(`https://discord.com/users/${user.id}`).setEmoji(uiBoton('perfil')),
        new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Avatar').setURL(user.displayAvatarURL({ size: 4096 })),
    );
    if (banner) fila.addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel('Banner').setURL(user.bannerURL({ size: 4096 })));

    return { embeds: [embed], components: [fila], allowedMentions: { parse: [] }, confianza: c };
}

// ── Datos de 7x ──────────────────────────────────────────────────────────────

function datosDe7x(userId, guild, member) {
    const out = {};
    try {
        const e = require('../utils/robuxLeaderboard').getEntry(userId);
        out.compras = e?.purchases ?? 0;
        out.robux = e?.totalRobux ?? 0;
    } catch { /* sin datos */ }
    try {
        const r = require('../utils/invitaciones').resumenDe(userId);
        out.invitaciones = r.validas;
        out.invitadoPor = r.invitadoPor;
    } catch { /* sin datos */ }
    try { out.ticket = require('../utils/tickets').getChannel(userId); } catch { /* sin datos */ }

    // Orden de llegada: sólo si la caché tiene a todos (la revisión de
    // suplantación los carga al arrancar); con una caché a medias el número
    // sería falso.
    if (member?.joinedTimestamp && guild && guild.members.cache.size >= (guild.memberCount ?? Infinity)) {
        out.posicionEntrada = 1 + guild.members.cache.filter(m => m.joinedTimestamp && m.joinedTimestamp < member.joinedTimestamp).size;
    }
    return out;
}

// Desde cuándo boostea en cada servidor donde está el bot. En paralelo y con
// tope de tiempo: un servidor lento no puede retrasar la ficha.
async function boostsEnComun(client, userId, guild, member) {
    const otros = [...(client?.guilds?.cache?.values?.() ?? [])].filter(g => g.id !== guild?.id);
    const conTope = p => Promise.race([p, new Promise(r => setTimeout(() => r(null), 2500))]);
    const resultados = await Promise.all(otros.map(g =>
        conTope(g.members.fetch(userId).catch(() => null)).then(m => ({ g, m }))));
    const boosts = [];
    if (member?.premiumSinceTimestamp) boosts.push({ servidor: guild.name, desde: member.premiumSinceTimestamp, aqui: true });
    for (const { g, m } of resultados) if (m?.premiumSinceTimestamp) boosts.push({ servidor: g.name, desde: m.premiumSinceTimestamp, aqui: false });
    return { boosts, revisados: otros.length + (guild ? 1 : 0) };
}

// El usuario y el miembro tal cual los da la API: traen el estilo de nombre,
// placas, decoraciones y tag de servidor, que discord.js aún no expone.
async function datosCrudos(client, userId, guild) {
    const { Routes } = require('discord.js');
    const pedir = ruta => client?.rest?.get(ruta).catch(() => null) ?? null;
    const [usuario, miembro] = await Promise.all([
        pedir(Routes.user(userId)),
        guild ? pedir(Routes.guildMember(guild.id, userId)) : null,
    ]);
    return { usuario, miembro };
}

// ── Comando ──────────────────────────────────────────────────────────────────

async function handleUserinfo(interaction) {
    const objetivo = interaction.options.getUser('usuario') ?? interaction.user;

    if (esAdmin(objetivo.id) && objetivo.id !== interaction.user.id) {
        return safeReply(interaction, { content: '🔒 La información de los owners es privada.', ephemeral: true });
    }

    // La ficha es SIEMPRE pública (decisión del owner). Sólo la negativa de
    // ver a un owner, arriba, es privada.
    const ok = await safeDeferReply(interaction);
    if (!ok) return;

    const guild = interaction.guild;
    const [user, member] = await Promise.all([
        interaction.client.users.fetch(objetivo.id, { force: true }).catch(() => objetivo),
        guild?.members.fetch(objetivo.id).catch(() => null),
    ]);
    if (user.flags == null) await user.fetchFlags?.().catch(() => {});

    let alerta = false;
    try {
        const sup = require('../utils/suplantacion').__test.load();
        alerta = Boolean(sup.alertas[user.id]) && sup.legitimos[user.id] !== sup.alertas[user.id];
    } catch { /* sin datos */ }

    const [{ boosts, revisados }, raw] = await Promise.all([
        boostsEnComun(interaction.client, user.id, guild, member),
        datosCrudos(interaction.client, user.id, guild),
    ]);
    const { confianza: _, ...payload } = construirUserinfo({
        user, member, guild, datos7x: datosDe7x(user.id, guild, member), alertaSuplantacion: alerta,
        boosts, servidoresRevisados: revisados, raw,
    });
    await safeEditReply(interaction, payload);
}

module.exports = { handleUserinfo, __test: { boostsEnComun, datosCrudos, personalizacion, nombreColeccionable, construirUserinfo, infoBoost, mesesEntre, confianza, senalesNitro, duracion } };
