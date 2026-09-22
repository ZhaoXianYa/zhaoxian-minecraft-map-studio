'use strict'
const { sectionsValue, getBlockFromRaw, floorDiv, mod } = require('./raw-world.cjs')

const { INVISIBLE: AIR } = require('./preview-visibility.cjs')
const { previewRadius } = require('./preview-range.cjs')
const PARTIAL = new Set([26,27,28,29,33,34,36,43+1,53,54,60,64,67,71,78,81,85,88,92,96,101,102,107,108,109,113,114,116,117,118,120,122,126,128,130,134,135,136,137,138,139,144,145,146,151,154,156,160,163,164,165,167,171,176,177,180,182,183,184,185,186,187,188,189,190,191,192,193,194,195,196,197,198,203,205,208])
// Blocks that should never occlude their neighbours in the editor preview.
const TRANSPARENT = new Set([
  0,6,8,9,10,11,18,20,30,31,32,37,38,39,40,50,51,55,59,63,65,66,68,69,70,72,75,76,77,78,79,83,90,
  93,94,95,102,104,105,106,111,115,127,131,132,140,141,142,143,147,148,149,150,151,154,157,160,161,171,174,175
])
const DIRS = [
  [ 1, 0, 0], [-1, 0, 0], [0, 1, 0], [0,-1, 0], [0, 0, 1], [0, 0,-1]
]

function shouldExposeFace (self, neighbour) {
  if (AIR.has(neighbour.id)) return true
  // Adjacent water/glass/leaves of the same kind should not produce inner faces.
  if (self.id === neighbour.id && TRANSPARENT.has(self.id)) return false
  return TRANSPARENT.has(neighbour.id) || PARTIAL.has(neighbour.id)
}

async function collectDetailBlocks (rawWorld, opt = {}) {
  const cx0 = floorDiv(Number(opt.x || 0), 16)
  const cz0 = floorDiv(Number(opt.z || 0), 16)
  const radius = previewRadius(opt.radiusChunks)
  const chunks = new Map()
  for (let cz = cz0 - radius - 1; cz <= cz0 + radius + 1; cz++) {
    for (let cx = cx0 - radius - 1; cx <= cx0 + radius + 1; cx++) {
      const raw = await rawWorld.loadRaw(cx, cz, false)
      if (raw) chunks.set(`${cx},${cz}`, raw)
    }
  }
  const get = (x, y, z) => {
    if (y < 0 || y > 255) return { id: 0, data: 0 }
    const cx = floorDiv(x,16), cz = floorDiv(z,16)
    // The loaded preview is a closed cutaway: hidden neighbours outside its
    // boundary must not remove the outer faces of the displayed blocks.
    if (opt.closeBoundary !== false && (Math.abs(cx-cx0)>radius || Math.abs(cz-cz0)>radius)) return { id:0,data:0 }
    const raw = chunks.get(`${cx},${cz}`)
    return raw ? getBlockFromRaw(raw, mod(x,16), y, mod(z,16)) : { id: 0, data: 0 }
  }
  const blocks = []
  let scanned = 0
  for (let cz = cz0-radius; cz <= cz0+radius; cz++) {
    for (let cx = cx0-radius; cx <= cx0+radius; cx++) {
      const raw = chunks.get(`${cx},${cz}`)
      if (!raw) continue
      const secs = sectionsValue(raw) || []
      for (const sec of secs) {
        const sy = Number(sec?.Y?.value ?? 0)
        for (let ly=0; ly<16; ly++) for (let lz=0; lz<16; lz++) for (let lx=0; lx<16; lx++) {
          const y=sy*16+ly; if (y<0||y>255) continue
          const b=getBlockFromRaw(raw,lx,y,lz); scanned++
          if (!b.id || (AIR.has(b.id) && !(opt.showBarriers && b.id === 166))) continue
          const x=cx*16+lx, z=cz*16+lz
          let mask = 0
          for (let di=0; di<DIRS.length; di++) {
            const [dx,dy,dz] = DIRS[di]
            if (shouldExposeFace(b, get(x+dx,y+dy,z+dz))) mask |= (1 << di)
          }
          // Special/non-cubic blocks are useful even when surrounded, because their silhouette matters.
          const special = [6,31,32,37,38,39,40,50,53,63,64,65,67,68,71,78,85,96,102,106,108,109,111,113,114,126,127,128,131,134,135,136,139,160,171,175,180,188,189,190,191,192,193,194,195,196,197,203,205].includes(b.id)
          if (mask || special) blocks.push([x,y,z,b.id,b.data,mask || 63])
        }
      }
    }
  }
  return { ok:true, blocks, center:{x:cx0*16+8,z:cz0*16+8}, radiusChunks:radius, truncated:false, scanned }
}
module.exports={ collectDetailBlocks, shouldExposeFace }
