'use strict';

// Strict validation + normalization for POST /battle's JSON body — the
// boundary where we stop trusting the caller. This request comes
// exclusively from a Roblox server script (per spec), but "comes from a
// script we wrote" is not a reason to skip validating it: the game only
// ever gets to say WHAT a player is wearing (a list of asset ids); it must
// never be able to smuggle in a price, a RAP value, a "limited" flag, or a
// total — those fields, if present, are simply never read by anything
// downstream (valuateWornAssets only ever accepts assetIds), but rejecting
// obviously malformed input here means a bug or a compromised/spoofed
// caller gets a clear 400 immediately instead of quietly propagating bad
// data into the valuation pipeline.
//
// "Normalize" (dedup) vs "reject" (everything else) are deliberately
// different responses: a duplicate asset id is still VALID data, just
// redundant — silently deduping it is correct and expected. A non-integer,
// negative, zero, or excessively long assetIds list means the caller's data
// (or the request itself) is actually wrong, and gets a loud, immediate
// rejection instead of a silently-filtered partial result that could
// under-value an outfit without anyone noticing.
class ValidationError extends Error {}

// Roblox avatars don't realistically equip anywhere near this many
// accessories; matches valuationService's own MAX_BATCH_SIZE for the
// catalog batch endpoint, so a single player's assetIds list can never
// itself force more than one batch of unknown-asset lookups.
const MAX_ASSET_IDS_PER_PLAYER = 100;

function isPositiveInteger(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function normalizePlayer(raw, label) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ValidationError(`${label} debe ser un objeto`);
    }
    if (!isPositiveInteger(raw.userId)) {
        throw new ValidationError(`${label}.userId debe ser un entero positivo`);
    }

    // Omitted entirely (not an empty array — see below) -> the caller
    // doesn't have this player's outfit; resolvePlayerValuation falls back
    // to a live/cached avatar.roblox.com check for just this player.
    if (raw.assetIds === undefined) {
        return { userId: raw.userId, assetIds: undefined };
    }

    if (!Array.isArray(raw.assetIds)) {
        throw new ValidationError(`${label}.assetIds debe ser un array`);
    }
    if (raw.assetIds.length > MAX_ASSET_IDS_PER_PLAYER) {
        throw new ValidationError(`${label}.assetIds excede el máximo permitido (${MAX_ASSET_IDS_PER_PLAYER})`);
    }
    if (!raw.assetIds.every(isPositiveInteger)) {
        throw new ValidationError(`${label}.assetIds debe contener únicamente enteros positivos`);
    }

    // A legitimately bare avatar (no accessories at all) is valid — an
    // empty array is NOT the same as "omitted"; it means "confirmed: this
    // player currently has zero of the assets we'd otherwise price."
    return { userId: raw.userId, assetIds: [...new Set(raw.assetIds)] };
}

// Returns { player1, player2, fresh } — both players normalized per
// normalizePlayer above — or throws ValidationError with a caller-facing
// message.
function validateBattlePayload(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new ValidationError('El body debe ser un objeto JSON');
    }

    const player1 = normalizePlayer(body.player1, 'player1');
    const player2 = normalizePlayer(body.player2, 'player2');
    const fresh = body.fresh === true || body.fresh === 'true' || body.fresh === '1';

    return { player1, player2, fresh };
}

module.exports = { validateBattlePayload, ValidationError, MAX_ASSET_IDS_PER_PLAYER };
