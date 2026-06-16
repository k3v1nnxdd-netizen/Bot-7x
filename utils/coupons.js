'use strict';

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../data/coupons.json');
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

function normalizeCode(code) {
    return String(code).trim().toUpperCase();
}

function createCoupon(code, discountPct, maxUses, creatorId) {
    const data = load();
    data[normalizeCode(code)] = {
        discount: discountPct,
        maxUses,
        uses: 0,
        creatorId,
        createdAt: new Date().toISOString(),
    };
    save(data);
}

function getCoupon(code) {
    if (!code) return null;
    return load()[normalizeCode(code)] ?? null;
}

function isValid(code) {
    const c = getCoupon(code);
    return c !== null && c.uses < c.maxUses;
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

module.exports = { createCoupon, getCoupon, isValid, useCoupon };
