'use strict';

const fs = require('fs');
const { dataPath, ensureDataDir } = require('./dataDir');

const FILE = dataPath('reviews.json');
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
    // Cerrada por plazo: ya no se puede valorar, aunque el botón siguiera ahí
    // en un mensaje que no llegó a editarse.
    if (rec.cerradoEn) return false;

    rec.rating   = score;
    // Las estrellas llegan sin comentario: no borrar el que ya hubiera dejado.
    if (comment != null) rec.comment = comment;
    rec.ratedVia = via;
    rec.ratedAt  = new Date().toISOString();
    save(data);
    return true;
}

// Si una valoración pendiente ya pasó su plazo. Las ya valoradas o ya
// cerradas no "vencen": ya están resueltas.
function estaVencida(rec, plazoMs, ahora = Date.now()) {
    if (!rec || rec.rating !== null || rec.cerradoEn) return false;
    const creada = Date.parse(rec.createdAt);
    return Number.isFinite(creada) && ahora - creada >= plazoMs;
}

// Las pendientes que ya pasaron su plazo y siguen sin cerrar.
function vencidas(plazoMs, ahora = Date.now()) {
    return Object.entries(load())
        .filter(([, rec]) => estaVencida(rec, plazoMs, ahora))
        .map(([id]) => id);
}

// La cierra por plazo. Comprobar y escribir sin un await en medio, igual que
// submitRating: así una valoración que llega en el mismo instante no puede
// quedar a la vez valorada y cerrada. Devuelve false si ya estaba resuelta.
function cerrarPorPlazo(ticketChannelId) {
    const data = load();
    const rec = data[ticketChannelId];
    if (!rec || rec.rating !== null || rec.cerradoEn) return false;
    rec.cerradoEn = new Date().toISOString();
    save(data);
    return true;
}

// El comentario, aparte de las estrellas: se puede dejar antes o después de
// valorar, una sola vez, y sólo dentro del plazo. Devuelve 'ok' o el motivo
// por el que no se guardó. Comprobar y escribir sin awaits, como submitRating.
function addComment(ticketChannelId, userId, comment, plazoMs, ahora = Date.now()) {
    const data = load();
    const rec  = data[ticketChannelId];
    if (!rec) return 'no-existe';
    if (rec.buyerId !== userId) return 'ajeno';
    if (rec.comment) return 'ya-comentado';
    const creada = Date.parse(rec.createdAt);
    if (rec.cerradoEn || (Number.isFinite(creada) && ahora - creada >= plazoMs)) return 'plazo';

    rec.comment = comment;
    rec.commentedAt = new Date(ahora).toISOString();
    save(data);
    return 'ok';
}

module.exports = {
    addComment,
    estaVencida,
    vencidas,
    cerrarPorPlazo,
    getReview,
    createReviewRequest,
    setTicketMessageRef,
    setDmMessageRef,
    setAnnounceMessageRef,
    submitRating,
};
