'use strict';

// Manually curated Robux values for official Roblox items whose catalog
// data badly understates (or doesn't expose at all) their real
// community/collector value — e.g. Roblox's own price field for some
// classic character bundles reflects a years-old listing price, not what
// the community actually treats them as worth.
//
// Most entries here are BUNDLES (Headless Horseman, Korblox, etc.), not
// single assets. This matters: a bundle id is never itself something a
// player "wears" — avatar.roblox.com only ever lists the bundle's
// INDIVIDUAL component assets (torso/arms/legs/head/hat/mood/etc.) as
// equipped. So each entry is matched by any of its component asset ids,
// not by the bundle id.
//
// To add a new one:
//   1. POST catalog.roblox.com/v1/catalog/items/details
//      body: { items: [{ itemType: "Bundle", id: <bundleId> }] }
//   2. From the response's `bundledItems`, list every entry with
//      `type: "Asset"` in `matchAssetIds` below — EXCEPT generic/shared
//      pieces reused across many different avatars/bundles (e.g. the
//      default Rthro Climb/Fall/Idle/Jump/Run/Swim/Walk animations, or
//      any other genuinely generic-named component) — including those
//      would make the match trigger for players who aren't actually
//      wearing this item at all. Only include pieces uniquely named after
//      the bundle itself.
//   3. For a plain single asset (not a bundle) instead, just set
//      matchAssetIds to that one asset's own id.
//
// If a player is wearing ANY ONE of an entry's matchAssetIds, `value` is
// counted ONCE toward their outfit, and the matched component id(s) are
// excluded from normal per-item valuation so it isn't also priced
// individually (which would double-count and clutter the response with
// near-worthless individual pieces).
const OFFICIAL_VALUE_OVERRIDES = [
    {
        id: 201,
        name: 'Headless Horseman',
        value: 31_000,
        matchAssetIds: [
            134082453, // Headless Horseman Left Arm
            134082473, // Headless Horseman Right Arm
            134082507, // Headless Horseman Left Leg
            134082533, // Headless Horseman Right Leg
            134082557, // Headless Horseman Torso
            131592085, // Headless Horseman's New Head
            15093053680, // Headless Head (DynamicHead)
        ],
    },
    {
        id: 192,
        name: 'Korblox Deathspeaker',
        value: 17_000,
        matchAssetIds: [
            139607570, // Korblox Deathspeaker Left Arm
            139607625, // Korblox Deathspeaker Right Arm
            139607673, // Korblox Deathspeaker Left Leg
            139607718, // Korblox Deathspeaker Right Leg
            139607770, // Korblox Deathspeaker Torso
            139610147, // Korblox Deathspeaker Hood
        ],
    },
    {
        // Catalog's own price for this bundle is 29,000 — using the
        // 31,000 value provided, but flagging the mismatch in case it was
        // meant to match the catalog figure instead.
        id: 319226,
        name: 'Korblox Deathwalker',
        value: 31_000,
        matchAssetIds: [
            16580476645, // Korblox Deathwalker - Left Arm
            16580483447, // Korblox Deathwalker - Left Leg
            16580486626, // Korblox Deathwalker - Right Arm
            16580488790, // Korblox Deathwalker - Right Leg
            16580491126, // Korblox Deathwalker - Torso
            16580496865, // Korblox Deathwalker - Cape
            16580499833, // Korblox Deathwalker - Helmet
            16580501745, // Korblox Deathwalker - Left Pauldron
            16580503696, // Korblox Deathwalker - Right Pauldron
            16580506579, // Korblox Deathwalker - Scythe
            16580510733, // Korblox Deathwalker - Skirt
            100022298014920, // Korblox Deathwalker - Mood
            99223542650102, // Korblox Deathwalker - Head (DynamicHead)
        ],
        // NOT included: 2510230574/2510233257/2510235063/2510236649/
        // 2510238627/2510240941/2510242378 (Rthro Climb/Fall/Idle/Jump/
        // Run/Swim/Walk) — these are Roblox's generic default animations,
        // shared across countless unrelated avatars, not exclusive to this
        // bundle. Matching on them would false-positive constantly.
    },
];

// Reverse lookup for O(1) matching during valuation: assetId -> override entry.
const ASSET_TO_OVERRIDE = new Map();
for (const override of OFFICIAL_VALUE_OVERRIDES) {
    for (const assetId of override.matchAssetIds) {
        ASSET_TO_OVERRIDE.set(assetId, override);
    }
}

module.exports = { OFFICIAL_VALUE_OVERRIDES, ASSET_TO_OVERRIDE };
