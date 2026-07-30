'use strict';

// Explicit registry of confirmed Limited item ids — forces RAP-based
// (real-time resale value) valuation for these regardless of what
// itemRestrictions/hasResellers happen to report, as a defensive guarantee
// on top of the automatic detection in services/valuationService.js
// (isLimitedItem). Every id below was verified live against the catalog
// when added, and — as of that verification — every single one was ALREADY
// correctly auto-detected as Limited by the normal heuristic
// (itemRestrictions includes "Limited"/"LimitedUnique", hasResellers:true).
// So this list doesn't change today's valuation for these items; it's
// insurance against that heuristic ever missing one of these specific,
// known-important items later (e.g. if Roblox changes how a legacy item is
// tagged).
//
// To add more: verify the id resolves via
//   POST catalog.roblox.com/v1/catalog/items/details
//   body: { items: [{ itemType: "Asset", id }] }
// before adding it here — several ids passed in bulk on 2026-07-28 (Ojos de
// copo de nieve, Cara Super Super Feliz, Goof Azul, and ~20 others) returned
// a clean 404 from BOTH the catalog and economy/details endpoints and were
// deliberately left out — those ids don't currently resolve to any real
// Roblox asset, so adding them would be inert at best. Re-verify before
// re-adding in case the id was mistyped.
const KNOWN_LIMITED_IDS = new Set([
    74891470,        // Frozen Horns of the Frigid Planes
    10159600649,     // 8-Bit Royal Crown
    16477149823,     // Gold Clockwork Headphones
    19027209,        // Perfectly Legitimate Business Hat
    10159617728,     // 8-Bit Tabby Cat
    10159610478,     // 8-Bit HP Bar
    14463095,        // Pinstripe Fedora
    9255011,         // Silverthorn Antlers
    128217885,       // Fall Fairy
    110673146052704, // Clockwork's Golden Shades
    1080949,         // Bunny Ears
    113598419875472, // Helsworn Valkyrie
    398674411,       // Black Iron Antlers
    10159606132,     // 8-Bit Extra Life
    10159622004,     // 8-Bit Roblox Coin
    1191112079,      // Blizzard Beast Mode Bandana
    507783603,       // Blue 8-Bit Antlers
    162066057,       // Adurite Antlers
    450557238,       // 8-Bit Clockwork Shades
    1365767,         // Valkyrie Helm
    11999235,        // Spec Alpha Biograft Energy Sword
    439945661,       // Silver King of the Night
    13416321,        // Mrs. Tentacles
    628771505,       // Black Iron Horns
    1744060292,      // Poisoned Horns of the Toxic Wasteland
    527365852,       // Dominus Praefectus
]);

module.exports = { KNOWN_LIMITED_IDS };
