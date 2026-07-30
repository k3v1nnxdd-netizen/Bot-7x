'use strict';

// Generic, dependency-free, debounced JSON key-value store with durable
// writes — the persistence layer behind services/assetStore.js.
//
// Why a hand-rolled JSON file instead of a real database: the dataset this
// backs (Roblox asset/bundle metadata) is small (thousands, not millions, of
// small records for a project this size) and needs nothing beyond "get by
// key" — no queries, no joins, no transactions across records. A real DB
// (Postgres/Mongo/Redis) would mean provisioning + operating an extra
// service nobody asked for; a native module (better-sqlite3) risks failing
// to compile on Railway's build image for a dependency this project doesn't
// otherwise need. This project already has ONE precedent for exactly this
// pattern (utils/groupTracker.js — data/groupJoins.json, same tmp+rename
// atomic write), so this follows established local convention rather than
// inventing a new one — the one thing added on top is an in-memory mirror +
// debounced write-back, since groupTracker's read-modify-write-every-call
// approach (re-parsing the whole file on every single operation) would be
// far too slow for a store touched by every worn asset of every valuation.
//
// Storage location: STORAGE_DIR env var, defaulting to ./storage — a
// directory that holds ONLY generated runtime data, never source code
// (unlike data/, which holds committed .js modules alongside
// data/groupJoins.json — mixing a Railway Volume mount into that directory
// would risk shadowing required source files). Mounting a Railway Volume at
// STORAGE_DIR is what turns "survives a process restart" into "survives a
// full redeploy" too; without one, this still correctly survives the
// restart case (crash+respawn, `railway restart`, etc.) since the
// container's local disk persists for the container's lifetime.
const fs = require('fs');
const path = require('path');

const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, '..', 'storage');

// How long to wait after the LAST write before flushing to disk — batches a
// burst of writes (e.g. a catalog batch resolving 40 assets at once) into
// ONE disk write instead of 40. Bounded by MAX_FLUSH_DELAY_MS so a
// continuous stream of writes (many different batches back to back) can't
// starve persistence indefinitely and risk losing more than a few seconds of
// "what we just learned" if the process dies.
const FLUSH_DEBOUNCE_MS = 1000;
const MAX_FLUSH_DELAY_MS = 5000;

const openStores = new Set(); // every createPersistentStore() instance — flushed together on shutdown

function readJsonFile(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.warn(`[persistentStore] Failed to read ${filePath}, starting empty:`, err.message);
        }
        return {};
    }
}

function writeJsonFileAtomic(filePath, data) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
    fs.renameSync(tmpPath, filePath); // atomic on the same filesystem — never leaves a half-written file as the real one
}

// Creates one named store, backed by STORAGE_DIR/<name>.json. Every store is
// independent (its own file, its own in-memory Map) — e.g. asset records and
// bundle-component lookups get separate stores so one's write volume/size
// never affects the other's.
function createPersistentStore(name) {
    const filePath = path.join(STORAGE_DIR, `${name}.json`);
    const map = new Map(Object.entries(readJsonFile(filePath)));

    const metrics = { loadedAtStartup: map.size, writes: 0, flushes: 0, lastFlushAt: null, lastFlushError: null };

    let flushTimer = null;
    let firstDirtyAt = null;
    let dirty = false;

    function flush() {
        if (!dirty) return;
        dirty = false;
        firstDirtyAt = null;
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        try {
            writeJsonFileAtomic(filePath, Object.fromEntries(map));
            metrics.flushes++;
            metrics.lastFlushAt = Date.now();
            metrics.lastFlushError = null;
        } catch (err) {
            metrics.lastFlushError = err.message;
            console.error(`[persistentStore:${name}] Flush failed (will retry on next write):`, err.message);
        }
    }

    function scheduleFlush() {
        dirty = true;
        const now = Date.now();
        if (firstDirtyAt === null) firstDirtyAt = now;

        if (flushTimer) clearTimeout(flushTimer);
        const elapsedSinceFirstDirty = now - firstDirtyAt;
        const delay = Math.min(FLUSH_DEBOUNCE_MS, Math.max(0, MAX_FLUSH_DELAY_MS - elapsedSinceFirstDirty));
        flushTimer = setTimeout(flush, delay);
        flushTimer.unref?.(); // never keep the process alive just to flush this on a timer — shutdown hooks flush synchronously instead
    }

    const store = {
        get: key => map.get(key),
        has: key => map.has(key),
        set(key, value) {
            map.set(key, value);
            metrics.writes++;
            scheduleFlush();
        },
        delete(key) {
            if (!map.delete(key)) return;
            metrics.writes++;
            scheduleFlush();
        },
        flush,
        get size() { return map.size; },
        getMetrics: () => ({ ...metrics, currentSize: map.size, dirty }),
    };

    openStores.add(store);
    return store;
}

// Best-effort durability on shutdown — flushes every store synchronously so
// a graceful stop/restart (Railway redeploy, `railway restart`, Ctrl+C
// locally) never drops the last <1s of learned asset data. A hard kill
// (SIGKILL, OOM) can still lose the last debounce window, same tradeoff any
// debounced-write system makes — acceptable here since worst case is just
// re-fetching a few assets from Roblox next time, not data corruption.
function flushAll() {
    for (const store of openStores) store.flush();
}

// Three DIFFERENT exit paths, each needing its own hook — getting this
// wrong (as an earlier version of this file did) silently drops every
// pending write whenever the process exits via the common paths:
//   - 'exit' fires for BOTH a natural drain AND an explicit
//     process.exit(code) call (a test script's `process.exit(0)`, a
//     process manager restarting this service, etc.) — 'beforeExit' does
//     NOT fire for the explicit-call case, so relying on it alone means
//     any script/manager that calls process.exit() directly loses
//     everything written since the last debounced flush. Only fully
//     SYNCHRONOUS code is guaranteed to run inside an 'exit' handler —
//     flush() only uses writeFileSync/renameSync, so this is safe.
//   - SIGINT/SIGTERM (Ctrl+C locally, `railway restart`/redeploy, a
//     process manager's graceful stop) — Node's DEFAULT behavior for these
//     signals is to exit immediately; adding a listener SUPPRESSES that
//     default; without also calling process.exit() ourselves afterward,
//     the process would just hang instead of stopping. Flush, then exit
//     with the conventional 128+signal code.
function flushAndExit(signal) {
    flushAll();
    process.exit(128 + { SIGINT: 2, SIGTERM: 15 }[signal]);
}

let shutdownHooked = false;
function ensureShutdownHook() {
    if (shutdownHooked) return;
    shutdownHooked = true;
    process.on('exit', flushAll);
    process.on('SIGINT', () => flushAndExit('SIGINT'));
    process.on('SIGTERM', () => flushAndExit('SIGTERM'));
}
ensureShutdownHook();

module.exports = { createPersistentStore, flushAll, STORAGE_DIR };
