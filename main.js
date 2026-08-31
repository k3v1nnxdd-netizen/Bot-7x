'use strict';

require('dotenv').config();

// ── Service mode ─────────────────────────────────────────────────────────────
// Lets this same repo run as two separate Railway services from the exact
// same entrypoint (`node main.js`):
//   SERVICE_MODE=bot → starts ONLY the Discord bot (gateway client + login)
//   SERVICE_MODE=api → starts ONLY the Express API (src/api/server.js)
// SERVICE_MODE unset (any other environment, e.g. local dev) → both start,
// exactly like before this split — nothing changes there.
const SERVICE_MODE = (process.env.SERVICE_MODE || '').toLowerCase();
const RUN_BOT = SERVICE_MODE ? SERVICE_MODE === 'bot' : true;
const RUN_API = SERVICE_MODE ? SERVICE_MODE === 'api' : true;

if (SERVICE_MODE && !RUN_BOT && !RUN_API) {
    console.warn(
        `[main] SERVICE_MODE="${process.env.SERVICE_MODE}" no reconocido (valores válidos: "bot", "api"). ` +
        'No se iniciará ningún proceso.'
    );
}

process.on('unhandledRejection', reason => console.error('[process] unhandledRejection:', reason));
process.on('uncaughtException',  err    => console.error('[process] uncaughtException:',  err));

let client = null;

// ── Discord bot ──────────────────────────────────────────────────────────────

if (RUN_BOT) {
    const { Client, GatewayIntentBits, Events, Partials } = require('discord.js');
    const { joinVoice, handleVoiceStateUpdate, handleConnect } = require('./utils/voice');
    const config              = require('./config');
    const { ensurePanel }     = require('./panel');
    const { ensureCalcPanel }   = require('./calc');
    const { ensureReglasPanel }  = require('./reglas');
    const { ensureMetodosPanel, handleMetodosSelect } = require('./metodos');
    const { ensureVerifPanel }   = require('./verif');
    const { ensureRolesPanel, EMOJI_ROLE_MAP, getRolesMsgId } = require('./roles');
    const { ensureSeguidoresPanel } = require('./seguidores');
    const { ensureCheckGroupPanel } = require('./checkGroup');
    const { updateLeaderboardMessage } = require('./utils/robuxLeaderboardPanel');
    const { backfillFromOrderLog } = require('./utils/robuxLeaderboardBackfill');
    const tickets             = require('./utils/tickets');
    const { handleButton, clearTimers } = require('./handlers/buttons');
    const { handleModal }     = require('./handlers/modals');
    const { handleOutfit, handlePagos, handlePagoVerified, handleOffer, handleClose, handleTopCompradores } = require('./handlers/commands');
    const {
        handleAddGroup, handleRegenerateToken, handleDeleteGroup, handleCheckGroup, handleGroups,
    } = require('./handlers/groupLicenses');
    const outfitApi           = require('./utils/outfitApi');
    const roblox              = require('./src/roblox/client');
    const { handleMessage }   = require('./handlers/messages');
    const { handleMessageDelete } = require('./handlers/messageDelete');
    const { handleAntiScam }  = require('./handlers/antiScam');
    const { handleSeguidoresSelect } = require('./handlers/seguidoresFlow');
    const { markInteraction } = require('./utils/spam');

    // ── Client ────────────────────────────────────────────────────────────────

    client = new Client({
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

    // ── Process-level safety net ──────────────────────────────────────────────

    client.on('error', err => console.error('[client] error:', err));

    // ── Ready ─────────────────────────────────────────────────────────────────

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
                name: 'connect',
                description: 'Conecta o desconecta el bot del canal de voz (solo owner)',
            },
            {
                name: 'topcompradores',
                description: 'Muestra el ranking de los mayores compradores de Robux',
            },

            // ── Licencias de grupos (outfit-api /admin/groups, solo owner) ──
            // El gate real es el chequeo de OWNER_ID dentro de cada handler
            // (handlers/groupLicenses.js), igual que /offer o /pagoverified:
            // el registro del comando no decide permisos.
            {
                name: 'addgroup',
                description: 'Agrega o reactiva la licencia de un grupo de Roblox (solo owner)',
                options: [
                    { name: 'group_id',     type: 3, description: 'ID del grupo de Roblox (ej: 35216530)',        required: true },
                    { name: 'discord_user', type: 6, description: 'Usuario de Discord enlazado a la licencia',    required: true },
                    { name: 'roblox_user',  type: 3, description: 'Usuario de Roblox del comprador',              required: true },
                ],
            },
            {
                name: 'regeneratetoken',
                description: 'Emite una credencial nueva para una licencia e invalida la anterior (solo owner)',
                options: [
                    { name: 'group_id',     type: 3, description: 'ID del grupo de Roblox',                                 required: true },
                    { name: 'discord_user', type: 6, description: 'Usuario de Discord enlazado (confirmación, no se cambia)', required: true },
                    { name: 'roblox_user',  type: 3, description: 'Usuario de Roblox enlazado (confirmación, no se cambia)',  required: true },
                ],
            },
            {
                name: 'deletegroup',
                description: 'Desactiva la licencia de un grupo de Roblox (solo owner)',
                options: [
                    { name: 'group_id', type: 3, description: 'ID del grupo de Roblox',            required: true },
                    { name: 'motivo',   type: 3, description: 'Motivo de la desactivación',        required: false },
                ],
            },
            {
                name: 'checkgroup',
                description: 'Consulta si un grupo de Roblox tiene licencia (solo owner)',
                options: [
                    { name: 'group_id', type: 3, description: 'ID del grupo de Roblox', required: true },
                ],
            },
            {
                name: 'groups',
                description: 'Lista todas las licencias de grupos (solo owner)',
            },
        ]).catch(err => console.error('[bot] commands.set failed:', err));

        // Aviso temprano y explicito: sin estas variables los cuatro comandos
        // de licencias siguen respondiendo, pero solo para decir que el
        // sistema no esta configurado. Mejor verlo en el arranque que
        // descubrirlo al intentar dar de alta a un cliente.
        if (!outfitApi.isConfigured()) {
            console.warn(
                '[bot] OUTFIT_API_URL u OUTFIT_ADMIN_API_KEY no estan definidas — ' +
                '/addgroup, /deletegroup, /checkgroup y /groups no podran contactar con la API de licencias.'
            );
        }

        // Mismo criterio para Check Group's: sin la key de Open Cloud el panel
        // sigue funcionando, pero no puede leer la fecha de ingreso real de
        // Roblox, asi que cada solicitud cae al flujo manual de siempre
        // (tarjeta NO VERIFICADO + botones del owner). Mejor verlo aqui que
        // descubrirlo cuando un cliente pulse el boton.
        if (!roblox.isOpenCloudConfigured()) {
            console.warn(
                "[bot] ROBLOX_OPEN_CLOUD_KEY no esta definida — Check Group's no podra consultar la " +
                'fecha de ingreso (createTime) en Roblox y todas las solicitudes iran a revision manual.'
            );
        }

        const sinConfigurar = Object.entries(config.CHECK_GROUPS)
            .filter(([, grupo]) => !grupo.groupId)
            .map(([clave, grupo]) => `${clave} ("${grupo.label}")`);
        if (sinConfigurar.length) {
            console.warn(
                `[bot] Check Group's: sin ID de Roblox en config.CHECK_GROUPS -> ${sinConfigurar.join(', ')}. ` +
                'Esos botones responderan que la comunidad no esta configurada en vez de consultar a Roblox.'
            );
        }

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

        await ensureCheckGroupPanel(client).catch(err =>
            console.error('[bot] ensureCheckGroupPanel failed:', err)
        );

        await backfillFromOrderLog(client).catch(err =>
            console.error('[bot] backfillFromOrderLog failed:', err)
        );

        await updateLeaderboardMessage(client).catch(err =>
            console.error('[bot] updateLeaderboardMessage failed:', err)
        );

        joinVoice(guild);
    });

    // ── Interactions ──────────────────────────────────────────────────────────

    client.on(Events.InteractionCreate, async interaction => {
        if (!markInteraction(interaction.id)) return;
        if (interaction.replied || interaction.deferred) return;

        try {
            if      (interaction.isChatInputCommand() && interaction.commandName === 'outfit') await handleOutfit(interaction);
            else if (interaction.isChatInputCommand() && interaction.commandName === 'pagos')          await handlePagos(interaction);
            else if (interaction.isChatInputCommand() && interaction.commandName === 'pagoverified') await handlePagoVerified(interaction);
            else if (interaction.isChatInputCommand() && interaction.commandName === 'close')        await handleClose(interaction);
            else if (interaction.isChatInputCommand() && interaction.commandName === 'offer')        await handleOffer(interaction);
            else if (interaction.isChatInputCommand() && interaction.commandName === 'connect')      await handleConnect(interaction);
            else if (interaction.isChatInputCommand() && interaction.commandName === 'topcompradores') await handleTopCompradores(interaction);
            else if (interaction.isChatInputCommand() && interaction.commandName === 'addgroup')      await handleAddGroup(interaction);
            else if (interaction.isChatInputCommand() && interaction.commandName === 'regeneratetoken') await handleRegenerateToken(interaction);
            else if (interaction.isChatInputCommand() && interaction.commandName === 'deletegroup')   await handleDeleteGroup(interaction);
            else if (interaction.isChatInputCommand() && interaction.commandName === 'checkgroup')    await handleCheckGroup(interaction);
            else if (interaction.isChatInputCommand() && interaction.commandName === 'groups')        await handleGroups(interaction);
            else if (interaction.isButton())           await handleButton(interaction);
            else if (interaction.isModalSubmit())      await handleModal(interaction);
            else if (interaction.isStringSelectMenu() && interaction.customId.startsWith('seg_')) await handleSeguidoresSelect(interaction);
            else if (interaction.isStringSelectMenu()) await handleMetodosSelect(interaction);
        } catch (err) {
            console.error('[interaction] top-level error:', err);
        }
    });

    // ── Messages ──────────────────────────────────────────────────────────────

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

    // ── Reaction roles ────────────────────────────────────────────────────────

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

    // ── Voice channel persistence ─────────────────────────────────────────────

    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
        handleVoiceStateUpdate(oldState, newState, client);
    });

    // ── Member auto-role ──────────────────────────────────────────────────────

    client.on(Events.GuildMemberAdd, async member => {
        try {
            const role = member.guild.roles.cache.get(config.ROLES.AUTO_ASSIGN);
            if (role) await member.roles.add(role);
        } catch (err) {
            console.error('[member] role add failed:', err.message);
        }
    });

    // ── Channel delete → cleanup ──────────────────────────────────────────────

    client.on(Events.ChannelDelete, channel => {
        const ownerId = tickets.getOwner(channel.id);
        tickets.cleanup(channel.id, ownerId);
        clearTimers(channel.id);
    });

    // ── Login ─────────────────────────────────────────────────────────────────

    client.login(process.env.TOKEN).catch(err => {
        console.error('[bot] Login failed:', err);
        process.exit(1);
    });
}

// ── API Server ────────────────────────────────────────────────────────────────

if (RUN_API) {
    const { startServer } = require('./src/api/server');
    startServer(client);
}
