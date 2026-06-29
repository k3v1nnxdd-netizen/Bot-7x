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
    fs.writeFileSync(TMP, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(TMP, FILE);
}

// Normalizes old format (plain ISO string) to new format { joinedAt, lastCheckedAt }
function normalize(entry) {
    if (!entry) return null;
    if (typeof entry === 'string') return { joinedAt: entry, lastCheckedAt: entry };
    return entry;
}

// Returns the tracked join Date or null
function getJoinDate(userId) {
    const entry = normalize(load()[String(userId)]);
    return entry ? new Date(entry.joinedAt) : null;
}

// Returns the last checked Date or null
function getLastChecked(userId) {
    const entry = normalize(load()[String(userId)]);
    return entry?.lastCheckedAt ? new Date(entry.lastCheckedAt) : null;
}

// Records join date if not already tracked (first time). Returns true if newly tracked.
function trackIfNew(userId) {
    const data = load();
    const key  = String(userId);
    const now  = new Date().toISOString();
    if (data[key]) {
        // Migrate old format in place
        if (typeof data[key] === 'string') {
            data[key] = { joinedAt: data[key], lastCheckedAt: now };
            save(data);
        }
        return false;
    }
    data[key] = { joinedAt: now, lastCheckedAt: now };
    save(data);
    return true;
}

// Updates the lastCheckedAt timestamp for an existing user
function updateLastChecked(userId) {
    const data = load();
    const key  = String(userId);
    if (!data[key]) return;
    const entry = normalize(data[key]);
    entry.lastCheckedAt = new Date().toISOString();
    data[key] = entry;
    save(data);
}

// Full days elapsed since a Date
function daysSince(date) {
    return Math.floor((Date.now() - date.getTime()) / 86_400_000);
}

module.exports = { getJoinDate, getLastChecked, trackIfNew, updateLastChecked, daysSince };
