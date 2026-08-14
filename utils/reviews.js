'use strict';

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../data/reviews.json');
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

// One record per ticket channel — keyed by ticketChannelId so the DM prompt
// and the ticket-channel prompt share the same review state and can enforce
// "rate via one, the other locks" against each other.
function getReview(ticketChannelId) {
    return load()[ticketChannelId] ?? null;
}

// Idempotent — a second /pagoverified on the same ticket must not clobber
// an existing (possibly already-rated) record.
function createReviewRequest(ticketChannelId, buyerId, orderLabel = null) {
    const data = load();
    if (data[ticketChannelId]) return data[ticketChannelId];
    data[ticketChannelId] = {
        buyerId,
        orderLabel,
        rating: null,
        comment: null,
        ratedVia: null,
        ratedAt: null,
        ticketMessageRef: null,
        dmMessageRef: null,
        announceMessageRef: null,
        createdAt: new Date().toISOString(),
    };
    save(data);
    return data[ticketChannelId];
}

function setTicketMessageRef(ticketChannelId, channelId, messageId) {
    const data = load();
    if (!data[ticketChannelId]) return;
    data[ticketChannelId].ticketMessageRef = { channelId, messageId };
    save(data);
}

function setDmMessageRef(ticketChannelId, channelId, messageId) {
    const data = load();
    if (!data[ticketChannelId]) return;
    data[ticketChannelId].dmMessageRef = { channelId, messageId };
    save(data);
}

function setAnnounceMessageRef(ticketChannelId, channelId, messageId) {
    const data = load();
    if (!data[ticketChannelId]) return;
    data[ticketChannelId].announceMessageRef = { channelId, messageId };
    save(data);
}

// Synchronous check-then-write (no awaits in between) so a near-simultaneous
// DM + ticket submit can't both succeed.
function submitRating(ticketChannelId, userId, score, comment, via) {
    const data = load();
    const rec  = data[ticketChannelId];
    if (!rec) return false;
    if (rec.buyerId !== userId) return false;
    if (rec.rating !== null) return false;

    rec.rating   = score;
    rec.comment  = comment;
    rec.ratedVia = via;
    rec.ratedAt  = new Date().toISOString();
    save(data);
    return true;
}

module.exports = {
    getReview,
    createReviewRequest,
    setTicketMessageRef,
    setDmMessageRef,
    setAnnounceMessageRef,
    submitRating,
};
