'use strict';

require('dotenv').config();

const { Client, GatewayIntentBits, Events } = require('discord.js');
const config              = require('./config');
const { ensurePanel }     = require('./panel');
const tickets             = require('./utils/tickets');
const { handleButton, clearTimers } = require('./handlers/buttons');
const { handleModal }     = require('./handlers/modals');
const { handleOutfit }    = require('./handlers/commands');
const { handleMessage }   = require('./handlers/messages');
const { markInteraction } = require('./utils/spam');

// ── Client ────────────────────────────────────────────────────────────────────

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
});

// ── Process-level safety net ──────────────────────────────────────────────────
// Prevents the process from dying on unhandled async errors.

client.on('error', err => console.error('[client] error:', err));
process.on('unhandledRejection', reason => console.error('[process] unhandledRejection:', reason));
process.on('uncaughtException',  err    => console.error('[process] uncaughtException:',  err));

// ── Ready ─────────────────────────────────────────────────────────────────────
// client.once guarantees this runs exactly once per process lifetime.

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

    await guild.commands.set([{
        name: 'outfit',
        description: 'Muestra información y avatar de un usuario de Roblox',
        options: [{
            name: 'user',
            type: 3,
            description: 'Nombre de usuario de Roblox (ej: sombrapapoi)',
            required: true,
        }],
    }]).catch(err => console.error('[bot] commands.set failed:', err));

    // ensurePanel is the ONLY place that ever sends the panel message.
    // It checks pins → history → waits → re-checks before sending.
    await ensurePanel(client).catch(err =>
        console.error('[bot] ensurePanel failed:', err)
    );
});

// ── Interactions ──────────────────────────────────────────────────────────────
// Single listener. All routing happens here.
//
// Layer 1 — markInteraction: rejects any interaction ID we've already seen.
//            Discord gateway can replay events on reconnect; this blocks replays.
//
// Layer 2 — replied/deferred guard inside each handler (buttons.js / modals.js).
//
// Layer 3 — per-key spam locks inside each handler.
//
// Nothing outside this listener handles interactions.

client.on(Events.InteractionCreate, async interaction => {
    // Layer 1: global deduplication by interaction ID (atomic, synchronous Set check)
    if (!markInteraction(interaction.id)) return;

    // Belt-and-suspenders: if Discord delivered an already-acknowledged interaction,
    // do nothing — every safe* wrapper would bail anyway, but this saves the round-trip.
    if (interaction.replied || interaction.deferred) return;

    try {
        if      (interaction.isChatInputCommand() && interaction.commandName === 'outfit') await handleOutfit(interaction);
        else if (interaction.isButton())      await handleButton(interaction);
        else if (interaction.isModalSubmit()) await handleModal(interaction);
    } catch (err) {
        console.error('[interaction] top-level error:', err);
    }
});

// ── Messages ──────────────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async message => {
    try { await handleMessage(message); }
    catch (err) { console.error('[message] error:', err); }
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

// ── Login ─────────────────────────────────────────────────────────────────────

client.login(process.env.TOKEN).catch(err => {
    console.error('[bot] Login failed:', err);
    process.exit(1);
});
