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

async function existe(guild, id) {
    if (!id) return null;
    return guild.channels.cache.get(id) ?? await guild.channels.fetch(id).catch(() => null);
}

// Un solo "asegurar" a la vez: dos eventos simultáneos no pueden crear dos
// categorías duplicadas.
let enCurso = null;

async function asegurarTodos(guild) {
    if (enCurso) return enCurso;
    enCurso = (async () => {
        const d = load();
        let categoria = await existe(guild, d.categoria);
        const faltan = Object.entries(config.LOGS.CANALES)
            .filter(([tipo, c]) => !c.id);

        for (const [tipo, def] of faltan) {
            if (await existe(guild, d[tipo])) continue;
            if (!categoria) {
                categoria = await guild.channels.create({
                    name: config.LOGS.CATEGORIA_NOMBRE,
                    type: ChannelType.GuildCategory,
                    permissionOverwrites: permisos(guild),
                    reason: 'Registros privados del bot 7x',
                });
                d.categoria = categoria.id;
            }
            const canal = await guild.channels.create({
                name: def.nombre,
                type: ChannelType.GuildText,
                parent: categoria.id,
                permissionOverwrites: permisos(guild),
                reason: 'Registros privados del bot 7x',
            });
            d[tipo] = canal.id;
            console.log(`[logs] Canal de registro creado: #${canal.name} (${canal.id})`);
        }
        save(d);
        return d;
    })().finally(() => { enCurso = null; });
    return enCurso;
}

// El canal de un tipo ('mensajes' | 'transcripciones' | 'seguridad'), o null.
// Nunca lanza: un registro que no se puede escribir no puede romper lo que lo
// provocó (un cierre de ticket, un borrado...).
async function canal(guild, tipo) {
    try {
        const fijo = config.LOGS.CANALES[tipo]?.id;
        if (fijo) return await existe(guild, fijo);
        let ch = await existe(guild, load()[tipo]);
        if (!ch) {
            const d = await asegurarTodos(guild);
            ch = await existe(guild, d[tipo]);
        }
        return ch;
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

async function enviar(guild, tipo, payload) {
    const ch = await canal(guild, tipo);
    if (!ch) return null;
    return ch.send(payload).catch(err => {
        console.error(`[logs] No se pudo escribir en el registro de ${tipo}:`, err.message);
        return null;
    });
}

module.exports = { canal, enviar, asegurarTodos, idsDeRegistro };
