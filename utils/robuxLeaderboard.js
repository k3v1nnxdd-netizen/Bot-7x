'use strict';

const fs = require('fs');
const { dataPath, ensureDataDir } = require('./dataDir');

const FILE = dataPath('robuxLeaderboard.json');
const TMP  = FILE + '.tmp';

function load() {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch { return {}; }
}

function save(data) {
    ensureDataDir();
    fs.writeFileSync(TMP, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(TMP, FILE);
}

// Records one completed Robux purchase against a buyer's running totals.
function recordPurchase(userId, robuxAmount, priceMxn) {
    if (!Number.isFinite(robuxAmount) || robuxAmount <= 0) return;

    const data  = load();
    const key   = String(userId);
    const entry = data[key] ?? { totalRobux: 0, totalSpent: 0, purchases: 0 };

    entry.totalRobux += robuxAmount;
    if (Number.isFinite(priceMxn)) entry.totalSpent += priceMxn;
    entry.purchases += 1;

    data[key] = entry;
    save(data);
}

// Top N buyers by total Robux purchased, descending.
function getTop(limit = 10) {
    const data = load();
    return Object.entries(data)
        .map(([userId, entry]) => ({ userId, ...entry }))
        .sort((a, b) => b.totalRobux - a.totalRobux)
        .slice(0, limit);
}

module.exports = { recordPurchase, getTop };
