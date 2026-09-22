'use strict'
const { parentPort, workerData } = require('worker_threads')
const { RawWorld } = require('./raw-world.cjs')
const { collectDetailBlocks } = require('./detail-mesh.cjs')
const { scanWorldOverview } = require('./overview-scan.cjs')
;(async () => {
  let world
  try {
    const p = workerData.payload
    let result
    if (workerData.kind === 'overview') result = await scanWorldOverview(p.worldPath, p.dimension, p.sample, { force: p.force, showBarriers: p.showBarriers })
    else {
      world = new RawWorld(p.worldPath, p.dimension)
      result = await collectDetailBlocks(world, p)
    }
    parentPort.postMessage({ result })
  } catch (e) { parentPort.postMessage({ error: e.message }) }
  finally { await world?.close().catch(() => {}) }
})()
