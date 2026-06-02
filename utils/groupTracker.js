'use strict';

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../data/groupJoins.json');

function load() {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch { return {}; }
}

function save(data) {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Returns the tracked join Date for a userId, or null if not tracked yet.
function getJoinDate(userId) {
    const raw = load()[String(userId)];
    return raw ? new Date(raw) : null;
}

// Records today as the join date for userId (only if not already tracked).
function trackIfNew(userId) {
    const data = load();
    const key  = String(userId);
    if (data[key]) return false; // already tracked
    data[key] = new Date().toISOString();
    save(data);
    return true; // newly tracked
}

// Full days elapsed since a Date.
function daysSince(date) {
    return Math.floor((Date.now() - date.getTime()) / 86_400_000);
}

module.exports = { getJoinDate, trackIfNew, daysSince };
