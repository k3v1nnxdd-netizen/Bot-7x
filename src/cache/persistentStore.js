'use strict';

// Generic, dependency-free, debounced JSON key-value store with durable
// writes — the persistence layer behind src/repositories/*.
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
// Storage location: STORAGE_DIR env var (Railway: a Volume mounted at
// /app/storage — see src/config/index.js), defaulting to ./storage when
// unset — a directory that holds ONLY generated runtime data, never source
// code (unlike data/, which holds committed .js modules alongside
// data/groupJoins.json — mounting a Volume there would risk shadowing
// required source files). With the Volume mounted, this survives full
// Railway redeploys, not just process restarts.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('../config');

const STORAGE_DIR = config.storageDir;

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

// A unique tmp filename PER WRITE ATTEMPT (not a fixed `${filePath}.tmp`) —
// this is what makes it safe for the periodic ASYNC flush and the
// synchronous SHUTDOWN flush to potentially race (see flushSync/flushAsync
// below): two writes targeting the same fixed tmp name could interleave at
// the OS level and corrupt it before the rename ever happens; two writes
// each to their OWN uniquely-named tmp file can't collide — whichever
// rename lands last simply wins, and both were serializing equivalent
// up-to-date data anyway.
function tmpPathFor(filePath) {
    return `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
}

function writeJsonFileAtomicSync(filePath, data) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = tmpPathFor(filePath);
    fs.writeFileSync(tmpPath, JSON.stringify(data), 'utf8');
    fs.renameSync(tmpPath, filePath); // atomic on the same filesystem — never leaves a half-written file as the real one
}

async function writeJsonFileAtomicAsync(filePath, data) {
    const dir = path.dirname(filePath);
    await fsp.mkdir(dir, { recursive: true });
    const tmpPath = tmpPathFor(filePath);
    await fsp.writeFile(tmpPath, JSON.stringify(data), 'utf8');
    await fsp.rename(tmpPath, filePath);
}

// One-time startup hygiene: a process that died between writeFile and
// rename (SIGKILL, OOM) leaves an orphaned uniquely-named .tmp file behind.
// Harmless (never read by anything), but cheap to sweep on boot rather than
// accumulate forever across many restarts.
function cleanupStaleTmpFiles() {
    try {
        for (const entry of fs.readdirSync(STORAGE_DIR)) {
            if (entry.endsWith('.tmp')) {
                try { fs.unlinkSync(path.join(STORAGE_DIR, entry)); } catch { /* best-effort */ }
            }
        }
    } catch { /* STORAGE_DIR may not exist yet on a brand new deploy — fine */ }
}
cleanupStaleTmpFiles();

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

    // Used by the periodic debounce timer — NON-blocking. The event loop
    // stays free to handle other requests while the write completes, unlike
    // a synchronous write which would stall EVERY concurrent request for
    // however long the write takes. Snapshots the map synchronously (cheap —
    // just copying references, no I/O) before the `await`, so a `.set()`
    // that happens WHILE this write is in flight doesn't get scrambled into
    // the payload already being serialized — it just gets marked dirty again
    // and picked up by the next debounced flush.
    async function flushAsync() {
        if (!dirty) return;
        dirty = false;
        firstDirtyAt = null;
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        const snapshot = Object.fromEntries(map);
        try {
            await writeJsonFileAtomicAsync(filePath, snapshot);
            metrics.flushes++;
            metrics.lastFlushAt = Date.now();
            metrics.lastFlushError = null;
        } catch (err) {
            metrics.lastFlushError = err.message;
            dirty = true; // failed — leave dirty so a future write's debounce (or the shutdown flush) retries it
            console.error(`[persistentStore:${name}] Async flush failed (will retry):`, err.message);
        }
    }

    // Used ONLY by the shutdown hook — MUST be synchronous: Node's 'exit'
    // event does not wait for pending Promises, so an in-flight
    // fs.promises write would simply be abandoned when the process actually
    // terminates. This is the one place blocking the event loop briefly is
    // correct and necessary — the process is shutting down anyway, nothing
    // else needs the event loop after this.
    function flushSync() {
        if (!dirty) return;
        dirty = false;
        firstDirtyAt = null;
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        try {
            writeJsonFileAtomicSync(filePath, Object.fromEntries(map));
            metrics.flushes++;
            metrics.lastFlushAt = Date.now();
            metrics.lastFlushError = null;
        } catch (err) {
            metrics.lastFlushError = err.message;
            console.error(`[persistentStore:${name}] Shutdown flush failed:`, err.message);
        }
    }

    function scheduleFlush() {
        dirty = true;
        const now = Date.now();
        if (firstDirtyAt === null) firstDirtyAt = now;

        if (flushTimer) clearTimeout(flushTimer);
        const elapsedSinceFirstDirty = now - firstDirtyAt;
        const delay = Math.min(FLUSH_DEBOUNCE_MS, Math.max(0, MAX_FLUSH_DELAY_MS - elapsedSinceFirstDirty));
        flushTimer = setTimeout(() => { flushAsync().catch(() => {}); }, delay);
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
        flush: flushSync, // exposed for tests/manual use — always the safe synchronous version
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
//     flushAll() only calls flushSync (writeFileSync/renameSync), so this
//     is safe.
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
