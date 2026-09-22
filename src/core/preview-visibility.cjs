'use strict'
// Invisible gameplay/editor blocks must not become geometry or hide terrain.
const INVISIBLE = new Set([0, 166, 217])
module.exports = { INVISIBLE }
