'use strict';

const fs = require('fs');
const { dataPath, ensureDataDir } = require('./dataDir');

const FILE = dataPath('coupons.json');
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

function normalizeCode(code) {
    return String(code).trim().toUpperCase();
}

function createCoupon(code, discountPct, maxUses, maxRobux, creatorId, roleId = null) {
    const data = load();
    data[normalizeCode(code)] = {
        discount:   discountPct,
        maxUses,
        uses:       0,
        maxRobux,
        creatorId,
        roleId,
        messageRef: null,
        createdAt:  new Date().toISOString(),
    };
    save(data);
}

function getCoupon(code) {
    if (!code) return null;
    return load()[normalizeCode(code)] ?? null;
}

// amount: optional robux amount to check against maxRobux
function isValid(code, amount = null) {
    const c = getCoupon(code);
    if (!c || c.uses >= c.maxUses) return false;
    if (amount !== null && c.maxRobux !== null && amount > c.maxRobux) return false;
    return true;
}

function setMessageRef(code, channelId, messageId) {
    const data = load();
    const key  = normalizeCode(code);
    if (!data[key]) return;
    data[key].messageRef = { channelId, messageId };
    save(data);
}

function useCoupon(code) {
    const data = load();
    const key  = normalizeCode(code);
    const c    = data[key];
    if (!c || c.uses >= c.maxUses) return false;
    c.uses++;
    save(data);
    return true;
}

module.exports = { createCoupon, getCoupon, isValid, setMessageRef, useCoupon };
