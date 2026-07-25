'use strict';

require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const config = require('./config');
config.GROUPMEMBERS_GROUP_ID = 7; // public group, smoke test only

const { handleGroupMembers, handleStopGroupMembers } = require('./groupmembers');

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    partials: [Partials.Channel],
});

function makeInteraction(client, options) {
    const obj = {
        user: { id: config.OWNER_ID },
        client,
        replied: false,
        deferred: false,
        options: { getInteger: name => options[name], getString: name => options[name] },
    };
    obj.reply = async payload => console.log('[fake] reply:', JSON.stringify(payload));
    return obj;
}

client.once('ready', async () => {
    console.log('[real-test2] Logged in as', client.user.tag);

    const start = makeInteraction(client, { min_price: 0, max_price: 999999, amount: 3 });
    const t0 = Date.now();
    await handleGroupMembers(start);

    // Enough time for a full 100-member page at the fixed 1700ms pace
    // (~170s) plus pricing/evaluation, so we actually observe Phase 3.
    await new Promise(r => setTimeout(r, 210000));

    const stop = makeInteraction(client, {});
    await handleStopGroupMembers(stop);
    console.log('[real-test2] Elapsed:', ((Date.now() - t0) / 1000).toFixed(1), 's');

    await new Promise(r => setTimeout(r, 500));
    await client.destroy();
    process.exit(0);
});

client.login(process.env.TOKEN);
