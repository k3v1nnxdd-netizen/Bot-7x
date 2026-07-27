'use strict';

require('dotenv').config();

const { Client, GatewayIntentBits, Events, Partials } = require('discord.js');
const { joinVoice, handleVoiceStateUpdate } = require('./utils/voice');
const config              = require('./config');
const { ensurePanel }     = require('./panel');
const { ensureCalcPanel }   = require('./calc');
const { ensureReglasPanel }  = require('./reglas');
const { ensureMetodosPanel, handleMetodosSelect } = require('./metodos');
const { ensureVerifPanel }   = require('./verif');
const { ensureRolesPanel, EMOJI_ROLE_MAP, getRolesMsgId } = require('./roles');
const { ensureSeguidoresPanel } = require('./seguidores');
const tickets             = require('./utils/tickets');
const { handleButton, clearTimers } = require('./handlers/buttons');
const { handleModal }     = require('./handlers/modals');
const { handleOutfit, handlePagos, handlePagoVerified, handleOffer, handleClose } = require('./handlers/commands');
const { handleSnipeUsername, handleStopSnipe, handleCheckSnipe } = require('./snipe');
const { handleGroupMembers, handleStopGroupMembers } = require('./groupmembers');
const { handleMessage }   = require('./handlers/messages');
const { handleMessageDelete } = require('./handlers/messageDelete');
const { handleAntiScam }  = require('./handlers/antiScam');
const { handleSeguidoresSelect } = require('./handlers/seguidoresFlow');
const { markInteraction } = require('./utils/spam');
const { startServer }     = require('./server');

// ── Client ────────────────────────────────────────────────────────────────────

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ── Process-level safety net ──────────────────────────────────────────────────

client.on('error', err => console.error('[client] error:', err));
process.on('unhandledRejection', reason => console.error('[process] unhandledRejection:', reason));
process.on('uncaughtException',  err    => console.error('[process] uncaughtException:',  err));

// ── Ready ─────────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async () => {
    console.log(`[bot] Logged in as ${client.user.tag}`);

    const guild = client.guilds.cache.get(config.GUILD_ID);
    if (!guild) {
        console.warn('[bot] Guild not found — panel and ticket rebuild skipped.');
        return;
    }

    await tickets.rebuildFromGuild(guild).catch(err =>
        console.error('[bot] rebuildFromGuild failed:', err)
    );

    // Clear any stale global commands
    await client.application.commands.set([])
        .catch(err => console.error('[bot] global commands.set failed:', err));

    await guild.commands.set([
        {
            name: 'outfit',
            description: 'Muestra información y avatar de un usuario de Roblox',
            options: [{
                name: 'user',
                type: 3,
                description: 'Nombre de usuario de Roblox (ej: sombrapapoi)',
                required: true,
            }],
        },
        {
            name: 'pagos',
            description: 'Consulta los métodos de pago disponibles en 7x',
            options: [{
                name: 'metodo',
                type: 3,
                description: 'Método de pago que deseas consultar',
                required: true,
                choices: [
                    { name: 'Transferencia', value: 'transferencia' },
                    { name: 'Depósito OXXO', value: 'oxxo' },
                    { name: 'Gift Card',     value: 'giftcard' },
                ],
            }],
        },
        {
            name: 'pagoverified',
            description: 'Envía el mensaje de pago verificado (solo owner)',
            options: [{
                name: 'usuario',
                type: 6,
                description: 'Usuario a mencionar en el mensaje',
                required: false,
            }],
        },
        {
            name: 'close',
            description: 'Inicia el cierre automático del ticket en 10 minutos (solo owner)',
        },
        {
            name: 'offer',
            description: 'Crea un cupón de descuento (solo owner)',
            options: [
                { name: 'codigo',    type: 3, description: 'Código del cupón',                        required: true },
                { name: 'descuento', type: 4, description: 'Porcentaje de descuento (1-99)',           required: true },
                { name: 'usos',      type: 4, description: 'Cantidad máxima de usos',                 required: true },
                { name: 'maxrobux',  type: 4, description: 'Máximo de Robux donde aplica (ej: 10000)', required: true  },
                { name: 'rol',       type: 8, description: 'Rol a mencionar en el ticket de descuento',  required: false },
            ],
        },
        {
            name: 'snipeusername',
            description: 'Inicia una búsqueda automática de usernames de Roblox disponibles (solo owner)',
            options: [
                {
                    name: 'min_characters',
                    type: 4,
                    description: 'Número mínimo de caracteres (3-12)',
                    required: true,
                    min_value: 3,
                    max_value: 12,
                },
                {
                    name: 'max_characters',
                    type: 4,
                    description: 'Número máximo de caracteres (3-12)',
                    required: true,
                    min_value: 3,
                    max_value: 12,
                },
                {
                    name: 'underscores',
                    type: 3,
                    description: '¿Permitir guiones bajos?',
                    required: true,
                    choices: [
                        { name: 'Sí', value: 'si' },
                        { name: 'No', value: 'no' },
                    ],
                },
                {
                    name: 'numbers',
                    type: 3,
                    description: '¿Permitir números?',
                    required: true,
                    choices: [
                        { name: 'Sí', value: 'si' },
                        { name: 'No', value: 'no' },
                    ],
                },
            ],
        },
        {
            name: 'stopsnipe',
            description: 'Detiene la búsqueda activa de usernames (solo owner)',
        },
        {
            name: 'checksnipe',
            description: 'Muestra todos los usernames encontrados y si siguen disponibles (solo owner)',
        },
        {
            name: 'groupmembers',
            description: 'Busca miembros del grupo de Roblox con outfits en un rango de precio (solo owner)',
            options: [
                { name: 'min_price', type: 4, description: 'Precio mínimo del outfit en Robux',            required: true, min_value: 0 },
                { name: 'max_price', type: 4, description: 'Precio máximo del outfit en Robux',             required: true, min_value: 0 },
                { name: 'amount',    type: 4, description: 'Cuántos outfits en ese rango buscar antes de detenerse', required: true, min_value: 1 },
            ],
        },
        {
            name: 'stopgroupmembers',
            description: 'Detiene el escaneo activo de miembros del grupo (solo owner)',
        },
    ]).catch(err => console.error('[bot] commands.set failed:', err));

    await ensurePanel(client).catch(err =>
        console.error('[bot] ensurePanel failed:', err)
    );

    await ensureCalcPanel(client).catch(err =>
        console.error('[bot] ensureCalcPanel failed:', err)
    );

    await ensureReglasPanel(client).catch(err =>
        console.error('[bot] ensureReglasPanel failed:', err)
    );

    await ensureMetodosPanel(client).catch(err =>
        console.error('[bot] ensureMetodosPanel failed:', err)
    );

    await ensureVerifPanel(client).catch(err =>
        console.error('[bot] ensureVerifPanel failed:', err)
    );

    await ensureRolesPanel(client).catch(err =>
        console.error('[bot] ensureRolesPanel failed:', err)
    );

    await ensureSeguidoresPanel(client).catch(err =>
        console.error('[bot] ensureSeguidoresPanel failed:', err)
    );

    joinVoice(guild);
});

// ── Interactions ──────────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async interaction => {
    if (!markInteraction(interaction.id)) return;
    if (interaction.replied || interaction.deferred) return;

    try {
        if      (interaction.isChatInputCommand() && interaction.commandName === 'outfit') await handleOutfit(interaction);
        else if (interaction.isChatInputCommand() && interaction.commandName === 'pagos')          await handlePagos(interaction);
        else if (interaction.isChatInputCommand() && interaction.commandName === 'pagoverified') await handlePagoVerified(interaction);
        else if (interaction.isChatInputCommand() && interaction.commandName === 'close')        await handleClose(interaction);
        else if (interaction.isChatInputCommand() && interaction.commandName === 'offer')        await handleOffer(interaction);
        else if (interaction.isChatInputCommand() && interaction.commandName === 'snipeusername') await handleSnipeUsername(interaction);
        else if (interaction.isChatInputCommand() && interaction.commandName === 'stopsnipe')    await handleStopSnipe(interaction);
        else if (interaction.isChatInputCommand() && interaction.commandName === 'checksnipe')   await handleCheckSnipe(interaction);
        else if (interaction.isChatInputCommand() && interaction.commandName === 'groupmembers') await handleGroupMembers(interaction);
        else if (interaction.isChatInputCommand() && interaction.commandName === 'stopgroupmembers') await handleStopGroupMembers(interaction);
        else if (interaction.isButton())           await handleButton(interaction);
        else if (interaction.isModalSubmit())      await handleModal(interaction);
        else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('seg_')) await handleSeguidoresSelect(interaction);
        else if (interaction.isStringSelectMenu()) await handleMetodosSelect(interaction);
    } catch (err) {
        console.error('[interaction] top-level error:', err);
    }
});

// ── Messages ──────────────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async message => {
    try {
        if (config.FEATURES.ANTI_SCAM && await handleAntiScam(message)) return;
        await handleMessage(message);
    } catch (err) { console.error('[message] error:', err); }
});

client.on(Events.MessageDelete, async message => {
    try { await handleMessageDelete(message); }
    catch (err) { console.error('[messageDelete] error:', err); }
});

// ── Reaction roles ────────────────────────────────────────────────────────────

client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
        if (user.bot) return;
        if (reaction.message.id !== getRolesMsgId()) return;

        if (reaction.partial) await reaction.fetch();
        if (user.partial)     await user.fetch();

        const roleId = EMOJI_ROLE_MAP[reaction.emoji.id];
        if (!roleId) return;

        const guild  = reaction.message.guild;
        const member = await guild.members.fetch(user.id);
        await member.roles.add(roleId);
    } catch (err) {
        console.error('[reaction:add] error:', err.message);
    }
});

client.on(Events.MessageReactionRemove, async (reaction, user) => {
    try {
        if (user.bot) return;
        if (reaction.message.id !== getRolesMsgId()) return;

        if (reaction.partial) await reaction.fetch();
        if (user.partial)     await user.fetch();

        const roleId = EMOJI_ROLE_MAP[reaction.emoji.id];
        if (!roleId) return;

        const guild  = reaction.message.guild;
        const member = await guild.members.fetch(user.id);
        await member.roles.remove(roleId);
    } catch (err) {
        console.error('[reaction:remove] error:', err.message);
    }
});

// ── Voice channel persistence ─────────────────────────────────────────────────

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    handleVoiceStateUpdate(oldState, newState, client);
});

// ── Member auto-role ──────────────────────────────────────────────────────────

client.on(Events.GuildMemberAdd, async member => {
    try {
        const role = member.guild.roles.cache.get(config.ROLES.AUTO_ASSIGN);
        if (role) await member.roles.add(role);
    } catch (err) {
        console.error('[member] role add failed:', err.message);
    }
});

// ── Channel delete → cleanup ──────────────────────────────────────────────────

client.on(Events.ChannelDelete, channel => {
    const ownerId = tickets.getOwner(channel.id);
    tickets.cleanup(channel.id, ownerId);
    clearTimers(channel.id);
});

// ── API Server ────────────────────────────────────────────────────────────────

startServer(client);

// ── Login ─────────────────────────────────────────────────────────────────────

client.login(process.env.TOKEN).catch(err => {
    console.error('[bot] Login failed:', err);
    process.exit(1);
});
