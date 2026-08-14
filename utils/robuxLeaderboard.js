'use strict';

const fs = require('fs');
const { dataPath, ensureDataDir } = require('./dataDir');

const FILE = dataPath('robuxLeaderboard.json');
const TMP  = FILE + '.tmp';

function load() {
    try {
        const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        return {
            users: raw.users ?? {},
            messageRef: raw.messageRef ?? null,
            top1UserId: raw.top1UserId ?? null,
            processedOrders: raw.processedOrders ?? {},
        };
    } catch {
        return { users: {}, messageRef: null, top1UserId: null, processedOrders: {} };
    }
}

function save(data) {
    ensureDataDir();
    fs.writeFileSync(TMP, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(TMP, FILE);
}

// Records one completed Robux purchase against a buyer's running totals.
// orderId (the order-log message id) makes this idempotent — the same
// order is never counted twice, so robuxLeaderboardBackfill.js can safely
// re-scan the full order log on every boot to reconcile any gap without
// double-counting purchases already recorded here in real time. Returns
// true if this order was newly recorded, false if it was already counted
// (or the amount was invalid) — callers use this to know whether to react
// (refresh the panel, sync roles) or skip.
function recordPurchase(userId, robuxAmount, priceMxn, orderId = null) {
    if (!Number.isFinite(robuxAmount) || robuxAmount <= 0) return false;

    const data = load();

    if (orderId) {
        if (data.processedOrders[orderId]) return false;
        data.processedOrders[orderId] = true;
    }

    const key   = String(userId);
    const entry = data.users[key] ?? { totalRobux: 0, totalSpent: 0, purchases: 0 };

    entry.totalRobux += robuxAmount;
    if (Number.isFinite(priceMxn)) entry.totalSpent += priceMxn;
    entry.purchases += 1;

    data.users[key] = entry;
    save(data);
    return true;
}

// Clears buyer totals and the order-dedup set, while keeping the panel
// message ref and current Top-1 holder intact — those aren't part of what's
// being rebuilt. Used by robuxLeaderboardBackfill.js to force a clean,
// complete rebuild from the order log (the only reliable way to reconcile
// against purchases recorded before per-order dedup existed).
function resetUsers() {
    const data = load();
    data.users = {};
    data.processedOrders = {};
    save(data);
}

function getEntry(userId) {
    const entry = load().users[String(userId)];
    return entry ? { userId: String(userId), ...entry } : null;
}

// Every buyer ranked by total Robux purchased, descending.
function getRanked() {
    const data = load();
    return Object.entries(data.users)
        .map(([userId, entry]) => ({ userId, ...entry }))
        .sort((a, b) => b.totalRobux - a.totalRobux);
}

// Top N buyers by total Robux purchased, descending.
function getTop(limit = 10) {
    return getRanked().slice(0, limit);
}

// Ref to the persistent leaderboard message, so it can be edited in place
// on every purchase instead of resending (and re-found after a restart).
function getMessageRef() {
    return load().messageRef;
}

function setMessageRef(channelId, messageId) {
    const data = load();
    data.messageRef = { channelId, messageId };
    save(data);
}

// Discord user id currently holding the Top-1 role, so a rank change can be
// detected (and the role swapped) without re-scanning guild members.
function getTop1UserId() {
    return load().top1UserId;
}

function setTop1UserId(userId) {
    const data = load();
    data.top1UserId = userId ?? null;
    save(data);
}

module.exports = {
    recordPurchase,
    resetUsers,
    getEntry,
    getRanked,
    getTop,
    getMessageRef,
    setMessageRef,
    getTop1UserId,
    setTop1UserId,
};
