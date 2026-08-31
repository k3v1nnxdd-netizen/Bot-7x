'use strict';

// ── Per-key cooldown / mutex ──────────────────────────────────────────────────

const locks = new Map(); // key -> expiresAt (ms)

// Hasta cuándo está bloqueada una clave, o null si está libre. Devolver el
// INSTANTE y no un booleano es lo que permite decirle a alguien "vuelve en 8s"
// en vez del inútil "espera un momento" — con un timestamp de Discord, además,
// lo ve en su propia zona horaria y se actualiza solo.
function lockedUntil(key) {
    const exp = locks.get(key);
    if (exp === undefined) return null;
    if (Date.now() < exp) return exp;
    locks.delete(key);
    return null;
}

function isLocked(key) {
    return lockedUntil(key) !== null;
}

function lock(key, durationMs) {
    locks.set(key, Date.now() + durationMs);
    setTimeout(() => {
        const exp = locks.get(key);
        if (exp !== undefined && Date.now() >= exp) locks.delete(key);
    }, durationMs + 50);
}

function unlock(key) {
    locks.delete(key);
}

// ── Cuota por ventana deslizante ─────────────────────────────────────────────
// Un lock responde a "¿cuánto hace de la última vez?"; esto responde a "¿cuántas
// veces en los últimos N minutos?", que es otra pregunta. Hacen falta las dos:
// un cooldown de 15 s por sí solo deja que alguien haga 240 comprobaciones por
// hora sin saltarse ninguna regla, y una cuota por sí sola deja meter todas las
// del periodo en una ráfaga de dos segundos.
//
// Ventana DESLIZANTE, no cubos fijos: con cubos, quien gasta su cuota al final
// de uno puede gastar otra entera al empezar el siguiente y colar el doble de
// golpe justo en la frontera.
const hits = new Map(); // key -> timestamps (ms, ascendentes)

// Nada de esto se persiste: se reinicia con el proceso, igual que los locks de
// arriba. Es lo correcto para un anti-spam — el peor caso tras un reinicio es
// que alguien recupere su cuota antes de tiempo, no que se quede bloqueado.
const MAX_TRACKED_MS = 60 * 60_000;

function prune(key, windowMs) {
    const cutoff = Date.now() - windowMs;
    const kept = (hits.get(key) ?? []).filter(t => t > cutoff);
    if (kept.length) hits.set(key, kept);
    else hits.delete(key);
    return kept;
}

// Cuántos usos lleva `key` dentro de la ventana.
function hitsInWindow(key, windowMs) {
    return prune(key, windowMs).length;
}

// Registra un uso. Devuelve cuántos van, éste incluido.
function registerHit(key, windowMs) {
    const list = prune(key, windowMs);
    list.push(Date.now());
    hits.set(key, list);
    return list.length;
}

// Cuándo (ms epoch) vuelve a haber sitio si ya se alcanzó `max`; null si aún
// queda. Es el instante en que caduca el más antiguo de los `max` últimos usos.
function slotFreesAt(key, windowMs, max) {
    const list = prune(key, windowMs);
    if (list.length < max) return null;
    return list[list.length - max] + windowMs;
}

// Barrido periódico para que una clave que nadie vuelve a consultar no se quede
// en memoria para siempre. unref() para no mantener vivo el proceso por esto.
setInterval(() => {
    const cutoff = Date.now() - MAX_TRACKED_MS;
    for (const [key, list] of hits) {
        const kept = list.filter(t => t > cutoff);
        if (kept.length) hits.set(key, kept);
        else hits.delete(key);
    }
}, 10 * 60_000).unref();

// ── Global interaction deduplication ─────────────────────────────────────────
// Discord gateway can resend the same interaction event on reconnect.
// Track every interaction.id we process; reject duplicates immediately.

const handledInteractions = new Set();

function markInteraction(id) {
    if (handledInteractions.has(id)) return false;
    handledInteractions.add(id);
    // Interaction tokens expire after 15 min — clean up after 20 min to be safe
    setTimeout(() => handledInteractions.delete(id), 20 * 60 * 1000);
    return true;
}

module.exports = {
    isLocked, lockedUntil, lock, unlock,
    hitsInWindow, registerHit, slotFreesAt,
    markInteraction,
};
