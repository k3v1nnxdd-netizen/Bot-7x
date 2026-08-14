'use strict';

const fs = require('fs');
const path = require('path');

// All persisted JSON state (coupons, reviews, group-join tracking, the
// Robux leaderboard, ...) lives under this directory. Defaults to the
// project's local ./data folder, but can be pointed at a mounted volume
// (e.g. a Railway Volume) via DATA_DIR so data survives redeploys, not
// just process restarts.
const DATA_DIR = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(__dirname, '..', 'data');

function dataPath(filename) {
    return path.join(DATA_DIR, filename);
}

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

module.exports = { DATA_DIR, dataPath, ensureDataDir };
