'use strict';

// GLOBAL, PERSISTENT registry of "component asset id -> which bundle it
// belongs to" (see ANIMATED_FACE_ASSET_TYPES in valuationService.js). Split
// from assetRepository.js into its own store/file: conceptually a different
// fact (bundle membership vs. an asset's own catalog data), and keeping it
// separate means its own write volume/file size never affects the other.
const { createPersistentStore } = require('../cache/persistentStore');

const bundleLookup = createPersistentStore('bundleLookup');

const metrics = { hits: 0, misses: 0 };

function key(assetId) {
    return String(assetId);
}

// Component asset id -> matched bundle ({id, name, collectibleItemId}), or
// `null` meaning "confirmed: this component is NOT part of a genuine
// official Limited bundle" (e.g. a default/generic MoodAnimation that isn't
// tied to any real animated-face item) — both outcomes are worth
// remembering permanently, since re-hitting catalog/assets/{id}/bundles for
// an id we've already resolved either way is pure waste. `undefined` (vs
// `null`) means "never checked".
function getBundleForComponent(assetId) {
    const record = bundleLookup.get(key(assetId));
    if (record === undefined) {
        metrics.misses++;
        return undefined;
    }
    metrics.hits++;
    return record.match;
}

function setBundleForComponent(assetId, match) {
    bundleLookup.set(key(assetId), { match, storedAt: Date.now() });
}

function getMetrics() {
    return { ...metrics, store: bundleLookup.getMetrics() };
}

module.exports = { getBundleForComponent, setBundleForComponent, getMetrics };
