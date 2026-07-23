'use strict';

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../data/snipeFound.json');
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

// Idempotent — keeps the earliest foundAt if the same username shows up again.
function addFound(username) {
    const data = load();
    if (!data[username]) {
        data[username] = new Date().toISOString();
        save(data);
    }
}

function getAllFound() {
    const data = load();
    return Object.entries(data)
        .map(([username, foundAt]) => ({ username, foundAt }))
        .sort((a, b) => new Date(a.foundAt) - new Date(b.foundAt));
}

module.exports = { addFound, getAllFound };
