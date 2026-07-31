'use strict';

const express = require('express');
const router = express.Router();
const { makeLegacyGoneHandler } = require('../legacyGone');

// RETIRED (see src/api/legacyGone.js): public Roblox servers were confirmed
// still calling this, each triggering a real avatar.roblox.com worn-items
// check. Responds 410 immediately — never calls buildAvatarValuation, never
// touches Roblox. Solo valuations now go through POST /battle by supplying
// the same userId as both players if needed, or by a future dedicated
// endpoint if one gets requested.
router.get('/:userId', makeLegacyGoneHandler('POST /battle'));

module.exports = router;
