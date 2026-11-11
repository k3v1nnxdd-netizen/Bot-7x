'use strict';

const fs = require('fs');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { dataPath, ensureDataDir } = require('./dataDir');
const config = require('../config');

// ── Canales de registro ──────────────────────────────────────────────────────
//
// Una categoría PRIVADA con un canal por tipo de registro (config.LOGS). Si en
// config hay un id fijo, se usa ese. Si no, el bot crea la categoría y los
// canales la primera vez y guarda los ids en disco; si alguien los borra, los
// vuelve a crear en el siguiente uso.
//
// Privada de verdad: @everyone sin "Ver canal", y con permiso explícito sólo
// los admins de config (por usuario, no por rol: un rol se le puede dar a
// cualquiera por error, a un usuario concreto no) y el propio bot.

const FILE = dataPath('logCanales.json');
const TMP = FILE + '.tmp';

function load() {
    try {
        const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    } catch { return {}; }
}

function save(d) {
    ensureDataDir();
    fs.writeFileSync(TMP, JSON.stringify(d, null, 2), 'utf8');
    fs.renameSync(TMP, FILE);
}

function permisos(guild) {
    const ver = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
    return [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: guild.client.user.id, allow: [...ver, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles] },
        ...config.ADMIN_IDS.map(id => ({ id, allow: ver })),
    ];
}

// Los registros son SÓLO de 7x (config.GUILD_ID). El bot está en otros
// servidores, y un evento de uno de ellos no puede crear canales allí ni
// cambiar cuáles son los canales oficiales: eso fue lo que pasó con ACxQW
// (creó "Registros 7x" en ese servidor, se perdió la referencia a los de 7x y
// se duplicaron). Todo lo de este módulo se niega fuera del servidor principal.
const esPrincipal = guild => Boolean(guild) && guild.id === config.GUILD_ID;

async function existe(guild, id) {
    if (!id || !guild) return null;
    const ch = guild.channels.cache.get(id) ?? await guild.channels.fetch(id).catch(() => null);
    return ch && ch.guildId === guild.id ? ch : null;
}

// El MÁS ANTIGUO con ese nombre (los ids de Discord crecen con el tiempo). Si
// por lo que sea hay canales repetidos, siempre se usan los originales, que son
// los que tienen el historial, y nunca se crea otro más.
function masAntiguo(guild, filtro) {
    const lista = [...guild.channels.cache.values()].filter(filtro);
    lista.sort((x, y) => (BigInt(x.id) < BigInt(y.id) ? -1 : 1));
    return lista[0] ?? null;
}

// Un solo "asegurar" a la vez: dos eventos simultáneos no pueden crear dos
// categorías duplicadas.
let enCurso = null;

// Encuentra (o crea, si de verdad no existen) la categoría y los canales.
// Primero ADOPTA lo que ya hay por nombre; sólo crea lo que falta. Si se borró
// la CATEGORÍA, Discord deja sus canales sueltos: se crea otra y se devuelven
// dentro, con sus permisos. Devuelve los ids y qué tipos se tuvieron que crear
// de cero (esos son los que hay que restaurar desde el archivo).
async function asegurarTodos(guild) {
    if (!esPrincipal(guild)) return null;
    if (enCurso) return enCurso;
    enCurso = (async () => {
        await guild.channels.fetch().catch(() => null);
        const d = load();
        const creados = [];

        let categoria = masAntiguo(guild, c => c.type === ChannelType.GuildCategory && c.name === config.LOGS.CATEGORIA_NOMBRE)
            ?? await existe(guild, d.categoria);
        const necesitaCategoria = Object.values(config.LOGS.CANALES).some(c => !c.id);

        if (!categoria && necesitaCategoria) {
            categoria = await guild.channels.create({
                name: config.LOGS.CATEGORIA_NOMBRE,
                type: ChannelType.GuildCategory,
                permissionOverwrites: permisos(guild),
                reason: 'Registros privados del bot 7x',
            });
            console.log(`[logs] Categoría de registros creada (${categoria.id})`);
        }
        if (categoria) d.categoria = categoria.id;

        for (const [tipo, def] of Object.entries(config.LOGS.CANALES)) {
            if (def.id) continue;
            const ch = masAntiguo(guild, c => c.type === ChannelType.GuildText && c.name === def.nombre)
                ?? await existe(guild, d[tipo]);
            if (ch) {
                d[tipo] = ch.id;
                // Suelto tras borrar la categoría: vuelve dentro y privado.
                if (ch.parentId !== categoria.id) {
                    await ch.setParent(categoria.id, { lockPermissions: false, reason: 'Registros 7x: categoría restaurada' }).catch(() => {});
                    await ch.permissionOverwrites.set(permisos(guild), 'Registros 7x: permisos restaurados').catch(() => {});
                }
                continue;
            }
            const canal = await guild.channels.create({
                name: def.nombre,
                type: ChannelType.GuildText,
                parent: categoria.id,
                permissionOverwrites: permisos(guild),
                reason: 'Registros privados del bot 7x',
            });
            d[tipo] = canal.id;
            creados.push(tipo);
            console.log(`[logs] Canal de registro creado: #${canal.name} (${canal.id})`);
        }
        save(d);
        return { ...d, creados };
    })().finally(() => { enCurso = null; });
    return enCurso;
}

// El canal de un tipo ('mensajes' | 'transcripciones' | 'seguridad'), o null.
// Nunca lanza: un registro que no se puede escribir no puede romper lo que lo
// provocó (un cierre de ticket, un borrado...).
async function canal(guild, tipo) {
    if (!esPrincipal(guild)) return null;
    try {
        const fijo = config.LOGS.CANALES[tipo]?.id;
        if (fijo) return await existe(guild, fijo);
        let ch = await existe(guild, load()[tipo]);
        if (!ch) {
            const d = await asegurarTodos(guild);
            ch = d && await existe(guild, d[tipo]);
        }
        return ch ?? null;
    } catch (err) {
        console.error(`[logs] No se pudo obtener el canal de ${tipo}:`, err.message);
        return null;
    }
}

// Los ids de TODOS los canales de registro: los eventos de mensajes los ignoran
// (si no, editar un registro generaría otro registro).
function idsDeRegistro() {
    const d = load();
    const ids = new Set([d.categoria]);
    for (const [tipo, c] of Object.entries(config.LOGS.CANALES)) ids.add(c.id ?? d[tipo]);
    ids.delete(undefined); ids.delete(null);
    return ids;
}

// Publica en el registro Y lo guarda en el archivo en disco (utils/archivo.js),
// que es lo que permite restaurarlo si alguien borra el mensaje o el canal.
async function enviar(guild, tipo, payload) {
    if (!esPrincipal(guild)) return null;
    const ch = await canal(guild, tipo);
    const msg = ch ? await ch.send(payload).catch(err => {
        console.error(`[logs] No se pudo escribir en el registro de ${tipo}:`, err.message);
        return null;
    }) : null;
    require('./archivo').registrar(tipo, payload, msg?.id ?? null, guild.id);
    return msg;
}

// Qué es un canal: un tipo de registro ('mensajes'…), 'categoria' o null.
function tipoDe(channelId) {
    const d = load();
    if (channelId && channelId === d.categoria) return 'categoria';
    for (const [tipo, c] of Object.entries(config.LOGS.CANALES)) if ((c.id ?? d[tipo]) === channelId) return tipo;
    return null;
}

module.exports = { canal, enviar, asegurarTodos, idsDeRegistro, tipoDe, esPrincipal, TIPOS: () => Object.keys(config.LOGS.CANALES) };
