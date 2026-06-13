'use strict';

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../data/groupJoins.json');
const TMP  = FILE + '.tmp';

function load() {
    try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch { return {}; }
}

function save(data) {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Atomic write: write to temp then rename to avoid corruption on crash
    fs.writeFileSync(TMP, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(TMP, FILE);
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
