'use strict';

const { EmbedBuilder } = require('discord.js');
const { table } = require('../data/prices');

const RANGES = [
    [500,   2500,  '⭐ Paquetes Básicos'],
    [2600,  5000,  '✨ Paquetes Estándar'],
    [5100,  10000, '💎 Paquetes Premium'],
    [10500, 30000, '🔥 Paquetes Mega'],
    [35000, 100000,'👑 Paquetes Legendarios'],
];

// target must have a .send(options) method (User DM or TextChannel)
async function sendPricesTo(target) {
    for (const [min, max, title] of RANGES) {
        const lines = Object.entries(table)
            .filter(([k]) => Number(k) >= min && Number(k) <= max)
            .sort(([a], [b]) => Number(a) - Number(b))
            .map(([k, v]) => `**${Number(k).toLocaleString()}** → ${v}`);

        if (!lines.length) continue;

        // Split into ≤2048-char embed description chunks
        const chunks = [];
        let cur = [], len = 0;
        for (const line of lines) {
            const l = line.length + 1;
            if (len + l > 2048) { chunks.push(cur.join('\n')); cur = [line]; len = l; }
            else { cur.push(line); len += l; }
        }
        if (cur.length) chunks.push(cur.join('\n'));

        for (let i = 0; i < chunks.length; i++) {
            const t = title + (chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : '');
            await target.send({
                embeds: [new EmbedBuilder().setColor(0x000000).setTitle(t).setDescription(chunks[i])],
            });
        }
    }
}

module.exports = { sendPricesTo };
