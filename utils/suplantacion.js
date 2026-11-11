'use strict';

const fs = require('fs');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { dataPath, ensureDataDir } = require('./dataDir');
const config = require('../config');
const { esAdmin } = require('./permisos');
const logCanales = require('./logCanales');
const { ui, uiBoton } = require('./uiIconos');

// ── Anti-suplantación ────────────────────────────────────────────────────────
//
// La estafa número uno en una tienda de Robux: alguien se pone el nombre (o
// casi) de un owner, o "7x Soporte", y le escribe por MD a un cliente para
// cobrarle. Esto lo detecta y lo avisa en el registro de seguridad con botones
// para actuar; si la coincidencia es exacta con un owner o el bot y la cuenta
// es nueva, además lo aísla (timeout) sin esperar a nadie.
//
// CÓMO SE COMPARA. Los nombres se NORMALIZAN antes de compararlos, que es lo
// que hace que los trucos de siempre no funcionen:
//   · Unicode compatibilidad (NFKD): 𝐤𝐞𝐯, ｋｅｖ, ᵏᵉᵛ → kev
//   · Acentos y marcas combinadas fuera: kév → kev
//   · Cirílico/griego que parece latino: kеv (е cirílica) → kev
//   · Leet y confusiones: k3v → kev, I/l/1/| → i, 0 → o, $/5 → s, @/4 → a
//   · Sin espacios, puntos, guiones, emojis: "k.e_v" → kev
//   · Letras repetidas colapsadas: keeevvv → kev
// y luego se busca: igual, contenido dentro, o a 1-2 letras de distancia
// (Levenshtein, según lo largo que sea el nombre protegido).
//
// A quién se protege: los owners de config.ADMIN_IDS, el propio bot y los
// nombres de config.SUPLANTACION.NOMBRES_PROTEGIDOS. Más la regla de marca:
// "7x" + una palabra de staff (soporte, admin, ventas...).
//
// A quién NO se mira: a los protegidos, a los bots, a quien tenga permisos de
// moderación (staff real que puede llamarse "7x Staff") y a quien un admin ya
// marcó como legítimo CON ESE NOMBRE (si se lo cambia a otro sospechoso, se
// vuelve a avisar).

const S = () => config.SUPLANTACION;
const FILE = dataPath('suplantacion.json');
const TMP = FILE + '.tmp';

// ── Normalización ────────────────────────────────────────────────────────────

const CONFUSIBLES = {
    // cirílico / griego con forma latina
    'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c',
    'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ї': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h', 'ӏ': 'i',
    'ɡ': 'g', 'α': 'a', 'β': 'b', 'ε': 'e', 'η': 'n', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p',
    'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w', 'ǝ': 'e', 'ə': 'e', 'ɐ': 'a', 'ı': 'i', 'ø': 'o', 'đ': 'd', 'ł': 'i',
    // leet y confusiones visuales
    '0': 'o', '1': 'i', '!': 'i', '|': 'i', 'l': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', '$': 's',
    '8': 'b', '9': 'g', '€': 'e', '£': 'e',
};

function normalizar(texto) {
    if (!texto) return '';
    const base = String(texto).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
    let out = '';
    for (const ch of base) out += CONFUSIBLES[ch] ?? ch;
    return out.replace(/[^a-z0-9]/g, '').replace(/(.)\1+/g, '$1');
}

function levenshtein(a, b) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > 2) return 99;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        prev = cur;
    }
    return prev[b.length];
}

const tolerancia = largo => (largo >= 8 ? 2 : largo >= 5 ? 1 : 0);

// Compara UN nombre contra la lista de protegidos. Devuelve la coincidencia
// más grave o null. protegidos = [{ norm, original, userId|null }]
function compararNombre(nombre, protegidos, cfg = S()) {
    const n = normalizar(nombre);
    if (n.length < 3) return null;

    let mejor = null;
    const rango = { exacto: 3, parecido: 2, contiene: 1 };
    for (const p of protegidos) {
        if (p.norm.length < 3) continue;
        let tipo = null;
        if (n === p.norm) tipo = 'exacto';
        else if (levenshtein(n, p.norm) <= tolerancia(p.norm.length)) tipo = 'parecido';
        else if (p.norm.length >= 4 && n.includes(p.norm)) tipo = 'contiene';
        if (tipo && (!mejor || rango[tipo] > rango[mejor.tipo])) mejor = { tipo, protegido: p };
    }
    if (mejor) return mejor;

    const marcas = cfg.MARCAS.map(normalizar).filter(Boolean);
    const staff = cfg.PALABRAS_STAFF.map(normalizar).filter(Boolean);
    const marca = marcas.find(m => n.includes(m));
    const palabra = marca && staff.find(w => n.replace(marca, '').includes(w));
    if (marca && palabra) return { tipo: 'marca', protegido: { original: `marca "${marca}" + "${palabra}"`, userId: null } };
    return null;
}

// Los nombres visibles de alguien: usuario, nombre global y apodo.
function nombresDe(member) {
    const u = member.user ?? member;
    return [
        ['Usuario', u.username],
        ['Nombre visible', u.globalName],
        ['Apodo del servidor', member.nickname],
    ].filter(([, v]) => v);
}

function firma(member) {
    return nombresDe(member).map(([, v]) => normalizar(v)).join('|');
}

// ── Estado ───────────────────────────────────────────────────────────────────

function load() {
    try {
        const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        return { alertas: d.alertas ?? {}, legitimos: d.legitimos ?? {} };
    } catch { return { alertas: {}, legitimos: {} }; }
}

function save(d) {
    ensureDataDir();
    fs.writeFileSync(TMP, JSON.stringify(d, null, 2), 'utf8');
    fs.renameSync(TMP, FILE);
}

// ── Protegidos ───────────────────────────────────────────────────────────────

let protegidos = [];

async function refrescarProtegidos(guild) {
    const lista = [];
    // fuente 'usuario' = nombre de usuario de Discord, que es ÚNICO: copiarlo
    // (con trucos de letras) es la señal más fuerte que hay. Los nombres
    // visibles y apodos no son únicos ("nodms" lo puede llevar cualquiera), así
    // que sólo avisan, nunca aíslan solos.
    const add = (texto, userId, fuente) => {
        const norm = normalizar(texto);
        // Un nombre visible de 3 letras ("kev") lo lleva media humanidad: sólo
        // los nombres de usuario (únicos) se protegen desde 3.
        const minimo = fuente === 'usuario' ? 3 : 4;
        if (norm.length >= minimo && !lista.some(p => p.norm === norm)) lista.push({ norm, original: texto, userId, fuente });
    };
    const ids = [...config.ADMIN_IDS, guild.client.user.id];
    for (const id of ids) {
        const member = await guild.members.fetch(id).catch(() => null);
        const user = member?.user ?? await guild.client.users.fetch(id).catch(() => null);
        if (!user) continue;
        add(user.username, id, 'usuario');
        add(user.globalName, id, 'visible');
        add(member?.nickname, id, 'apodo');
    }
    for (const n of S().NOMBRES_PROTEGIDOS) add(n, null, 'marca');
    protegidos = lista;
    return lista;
}

function exento(member) {
    if (!member?.user || member.user.bot) return true;
    if (esAdmin(member.id) || member.id === member.client?.user?.id) return true;
    const p = member.permissions;
    return Boolean(p?.has?.(PermissionFlagsBits.Administrator) || p?.has?.(PermissionFlagsBits.ModerateMembers) || p?.has?.(PermissionFlagsBits.ManageMessages));
}

function evaluar(member, lista = protegidos) {
    const hallazgos = [];
    for (const [campo, valor] of nombresDe(member)) {
        const c = compararNombre(valor, lista);
        if (c) hallazgos.push({ campo, valor, ...c });
    }
    return hallazgos;
}

// ── Aviso ────────────────────────────────────────────────────────────────────

const TEXTO_TIPO = {
    exacto: 'Idéntico',
    parecido: 'Casi idéntico',
    contiene: 'Contiene el nombre',
    marca: 'Marca + palabra de staff',
};

function botones(userId, deshabilitar = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sup_ais:${userId}`).setLabel(`Aislar ${S().AISLAR_HORAS}h`).setStyle(ButtonStyle.Secondary).setEmoji(uiBoton('reloj')).setDisabled(deshabilitar),
        new ButtonBuilder().setCustomId(`sup_kick:${userId}`).setLabel('Expulsar').setStyle(ButtonStyle.Secondary).setDisabled(deshabilitar),
        new ButtonBuilder().setCustomId(`sup_ban:${userId}`).setLabel('Banear').setStyle(ButtonStyle.Danger).setDisabled(deshabilitar),
        new ButtonBuilder().setCustomId(`sup_ok:${userId}`).setLabel('Es legítimo').setStyle(ButtonStyle.Success).setEmoji(uiBoton('escudo')).setDisabled(deshabilitar),
    );
}

// `aislar: false` en la revisión de arranque: quien ya estaba en el servidor
// (puede ser una cuenta alternativa de un owner) sólo genera aviso. El
// aislamiento automático es para lo que pasa EN VIVO: entrar o renombrarse.
// La tarjeta del aviso. El ID va en la descripción, a todo el ancho: en una
// columna estrecha un id de 19 cifras se parte en dos líneas.
function tarjeta(member, hallazgos, { grave, origen, accion }) {
    const s = x => Math.floor(x / 1000);
    const u = member.user;
    const fuente = { usuario: 'su nombre de usuario', visible: 'su nombre visible', apodo: 'su apodo', marca: 'la marca' };
    const embed = new EmbedBuilder()
        .setColor(grave ? 0xDC2626 : 0xF59E0B)
        .setAuthor({ name: u.username, iconURL: u.displayAvatarURL({ size: 128 }) })
        .setTitle(`${ui('alerta')} Posible suplantación${grave ? ' · riesgo alto' : ''}`)
        .setThumbnail(u.displayAvatarURL({ size: 256 }))
        .setDescription(`<@${member.id}> · \`${member.id}\``)
        .addFields(
            { name: 'Cuenta creada', value: `<t:${s(u.createdTimestamp)}:D>\n<t:${s(u.createdTimestamp)}:R>`, inline: true },
            { name: 'En el servidor', value: member.joinedTimestamp ? `<t:${s(member.joinedTimestamp)}:D>\n<t:${s(member.joinedTimestamp)}:R>` : '—', inline: true },
            { name: 'Detectado', value: origen, inline: true },
            ...hallazgos.map(h => ({
                name: `${h.campo}: ${String(h.valor).slice(0, 80)}`,
                value: h.protegido.userId
                    ? `${TEXTO_TIPO[h.tipo]} a **${h.protegido.original}**, ${fuente[h.protegido.fuente] ?? 'nombre'} de <@${h.protegido.userId}>`
                    : `${TEXTO_TIPO[h.tipo]}: ${h.protegido.original}`,
            })),
            { name: 'Acción automática', value: accion },
        )
        .setFooter({ text: 'Anti-suplantación 7x · comparación normalizada (unicode, leet, cirílico)' })
        .setTimestamp();
    return embed;
}

async function revisar(member, origen = 'cambio de nombre', { aislar = true } = {}) {
    try {
        // Sólo 7x: en los demás servidores del bot no se vigila ni se actúa.
        if (!member?.guild || member.guild.id !== config.GUILD_ID || exento(member)) return null;
        if (!protegidos.length) await refrescarProtegidos(member.guild);

        const hallazgos = evaluar(member);
        if (!hallazgos.length) return null;

        const f = firma(member);
        const estado = load();
        if (estado.legitimos[member.id] === f || estado.alertas[member.id] === f) return null;
        estado.alertas[member.id] = f;
        save(estado);

        const edadCuentaDias = (Date.now() - member.user.createdTimestamp) / 86_400_000;
        const grave = hallazgos.some(h => h.tipo === 'exacto' && h.protegido.fuente === 'usuario');

        let accion = 'Ninguna — esperando decisión de un admin';
        if (grave && aislar && S().AISLAR_AUTO && edadCuentaDias < S().AISLAR_CUENTA_DIAS) {
            if (!member.moderatable) accion = 'No se pudo aislar: el rol del bot está por debajo del usuario';
            else try {
                await member.timeout(S().AISLAR_HORAS * 3_600_000, 'Anti-suplantación: nombre idéntico a un owner con cuenta nueva');
                accion = `${ui('reloj')} Aislado automáticamente ${S().AISLAR_HORAS}h`;
            } catch (err) {
                accion = `No se pudo aislar (${err.code === 50013 ? 'el rol del bot está por debajo' : err.message})`;
            }
        }

        const embed = tarjeta(member, hallazgos, { grave, origen, accion });

        await logCanales.enviar(member.guild, 'seguridad', {
            content: config.ADMIN_IDS.map(id => `<@${id}>`).join(' '),
            embeds: [embed],
            components: [botones(member.id)],
            allowedMentions: { users: config.ADMIN_IDS },
        });
        return hallazgos;
    } catch (err) {
        console.error('[suplantacion] revisar:', err.message);
        return null;
    }
}

// ── Eventos ──────────────────────────────────────────────────────────────────

function cambioDeNombre(viejo, nuevo) {
    if (!viejo || viejo.partial) return true;
    return viejo.nickname !== nuevo.nickname
        || viejo.user?.username !== nuevo.user?.username
        || viejo.user?.globalName !== nuevo.user?.globalName;
}

async function alActualizarMiembro(viejo, nuevo) {
    if (nuevo?.guild?.id !== config.GUILD_ID) return;
    // Un owner que se cambia el nombre: la lista de protegidos se actualiza.
    if (esAdmin(nuevo.id) || nuevo.id === nuevo.client.user.id) {
        if (cambioDeNombre(viejo, nuevo)) await refrescarProtegidos(nuevo.guild).catch(() => {});
        return;
    }
    if (cambioDeNombre(viejo, nuevo)) await revisar(nuevo, 'Cambio de nombre o apodo');
}

async function alActualizarUsuario(viejo, nuevo) {
    if (viejo?.username === nuevo.username && viejo?.globalName === nuevo.globalName) return;
    const guild = nuevo.client.guilds.cache.get(config.GUILD_ID);
    const member = guild && await guild.members.fetch(nuevo.id).catch(() => null);
    if (!member) return;
    if (esAdmin(nuevo.id)) return refrescarProtegidos(guild).catch(() => {});
    await revisar(member, 'Cambio de nombre de usuario');
}

// Al arrancar: protegidos y una pasada por todo el servidor (sólo avisa de lo
// que no se había avisado ya con ese mismo nombre).
async function iniciar(client) {
    const guild = client.guilds.cache.get(config.GUILD_ID);
    if (!guild) return;
    await refrescarProtegidos(guild);
    const miembros = await guild.members.fetch().catch(() => guild.members.cache);
    let avisos = 0;
    for (const m of miembros.values()) if (await revisar(m, 'Revisión al arrancar el bot', { aislar: false })) avisos++;
    console.log(`[suplantacion] ${protegidos.length} nombres protegidos · ${miembros.size} miembros revisados · ${avisos} aviso(s) nuevo(s).`);
    const t = setInterval(() => refrescarProtegidos(guild).catch(() => {}), 30 * 60_000);
    t.unref?.();
}

// ── Botones del aviso ────────────────────────────────────────────────────────

// Discord da 3 SEGUNDOS para responder a un botón. Lo primero es confirmarlo
// (deferUpdate), sin ninguna consulta antes: buscar al miembro o banearlo
// puede tardar más, sobre todo justo después de un arranque, y entonces Discord
// enseña "La aplicación no ha respondido". El resultado se escribe después
// editando el propio aviso; un error, en un mensaje sólo para quien pulsó.
async function alBoton(interaction) {
    if (!esAdmin(interaction.user.id)) {
        return interaction.reply({ content: '❌ Sólo los owners pueden usar estos botones.', flags: 64 }).catch(() => {});
    }
    try {
        await interaction.deferUpdate();
    } catch (err) {
        console.error('[suplantacion] deferUpdate falló:', err.message);
        return;
    }

    const [accion, userId] = interaction.customId.split(':');
    const guild = interaction.guild;
    if (guild?.id !== config.GUILD_ID) return;
    const razon = `Anti-suplantación · decisión de ${interaction.user.username}`;
    const quien = `<@${interaction.user.id}>`;

    let resultado;
    try {
        const member = guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null);
        if (accion === 'sup_ok') {
            const estado = load();
            estado.legitimos[userId] = member ? firma(member) : estado.alertas[userId];
            save(estado);
            if (member?.isCommunicationDisabled?.()) await member.timeout(null, razon).catch(() => {});
            resultado = `${ui('escudo')} Marcado como **legítimo** por ${quien}. No se volverá a avisar con este nombre.`;
        } else if (accion === 'sup_ais') {
            if (!member) throw new Error('ya no está en el servidor');
            await member.timeout(S().AISLAR_HORAS * 3_600_000, razon);
            resultado = `${ui('reloj')} **Aislado ${S().AISLAR_HORAS}h** por ${quien}`;
        } else if (accion === 'sup_kick') {
            if (!member) throw new Error('ya no está en el servidor');
            await member.kick(razon);
            resultado = `**Expulsado** por ${quien}`;
        } else if (accion === 'sup_ban') {
            await guild.members.ban(userId, { reason: razon, deleteMessageSeconds: 24 * 3600 });
            resultado = `**Baneado** por ${quien} · se borraron sus mensajes de las últimas 24h`;
        } else {
            return;
        }
    } catch (err) {
        console.error(`[suplantacion] ${accion} sobre ${userId} falló:`, err.message);
        return interaction.followUp({
            content: `❌ No se pudo: ${err.code === 50013 ? 'el rol del bot está por debajo de ese usuario' : err.message}`,
            flags: 64,
        }).catch(() => {});
    }

    const original = interaction.message.embeds[0];
    const embed = new EmbedBuilder(original?.data ?? original?.toJSON?.() ?? {})
        .addFields({ name: 'Resolución', value: `${resultado}\n<t:${Math.floor(Date.now() / 1000)}:R>` })
        .setColor(accion === 'sup_ok' ? 0x22C55E : 0x64748B);
    await interaction.editReply({ embeds: [embed], components: [botones(userId, true)] }).catch(err => {
        console.error('[suplantacion] No se pudo actualizar el aviso:', err.message);
        return interaction.followUp({ content: resultado, flags: 64 }).catch(() => {});
    });
}

module.exports = {
    iniciar, revisar, alActualizarMiembro, alActualizarUsuario, alBoton, refrescarProtegidos,
    __test: { normalizar, levenshtein, compararNombre, evaluar, exento, firma, load, tarjeta, FILE, setProtegidos: l => { protegidos = l; } },
};
