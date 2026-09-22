'use strict'
const fs = require('fs')
const path = require('path')
const nbt = require('prismarine-nbt')
const { Vec3 } = require('vec3')

function dimensionRegionPath (worldPath, dimension = 'overworld') {
  if (dimension === 'nether') return path.join(worldPath, 'DIM-1', 'region')
  if (dimension === 'end') return path.join(worldPath, 'DIM1', 'region')
  return path.join(worldPath, 'region')
}
function floorDiv (n, d) { return Math.floor(n / d) }
function mod (n, d) { return ((n % d) + d) % d }
function nibbleGet (arr, i) { const b = Number(arr[i >> 1] ?? 0) & 255; return (i & 1) ? ((b >> 4) & 15) : (b & 15) }
function nibbleSet (arr, i, v) { const p = i >> 1; const b = Number(arr[p] ?? 0) & 255; arr[p] = (i & 1) ? ((b & 15) | ((v & 15) << 4)) : ((b & 240) | (v & 15)) }
function sectionIndex (x, y, z) { return ((y & 15) << 8) | ((z & 15) << 4) | (x & 15) }

function levelValue (raw) {
  if (!raw?.value) throw new Error('无效的 Chunk NBT')
  if (raw.value.Level?.value) return raw.value.Level.value
  return raw.value
}
function sectionsValue (raw) {
  const lvl = levelValue(raw)
  const tag = lvl.Sections || lvl.sections
  if (!tag) return null
  return tag.value?.value || null
}
function sectionY (sec) { return Number(sec?.Y?.value ?? sec?.y?.value ?? 0) }
function makeByteArrayTag (size, fill = 0) { return { type: 'byteArray', value: Buffer.alloc(size, fill) } }
function makeSection (sy) {
  return {
    Y: { type: 'byte', value: sy },
    Blocks: makeByteArrayTag(4096, 0),
    Data: makeByteArrayTag(2048, 0),
    BlockLight: makeByteArrayTag(2048, 0),
    SkyLight: makeByteArrayTag(2048, 255)
  }
}
function ensureSections (raw) {
  const lvl = levelValue(raw)
  if (!lvl.Sections) lvl.Sections = { type: 'list', value: { type: 'compound', value: [] } }
  if (!lvl.Sections.value) lvl.Sections.value = { type: 'compound', value: [] }
  if (!Array.isArray(lvl.Sections.value.value)) lvl.Sections.value.value = []
  return lvl.Sections.value.value
}
function getSection (raw, sy, create = false) {
  const sections = create ? ensureSections(raw) : (sectionsValue(raw) || [])
  let sec = sections.find(s => sectionY(s) === sy)
  if (!sec && create) { sec = makeSection(sy); sections.push(sec); sections.sort((a, b) => sectionY(a) - sectionY(b)) }
  return sec || null
}
function byteArrayValue (tag, size) {
  if (!tag) return null
  if (Buffer.isBuffer(tag.value)) return tag.value
  if (tag.value instanceof Uint8Array) { tag.value = Buffer.from(tag.value); return tag.value }
  if (Array.isArray(tag.value)) { tag.value = Buffer.from(tag.value.map(v => v & 255)); return tag.value }
  if (size) { tag.value = Buffer.alloc(size); return tag.value }
  return tag.value
}
function getBlockFromRaw (raw, x, y, z) {
  if (!raw || y < 0 || y > 255) return { id: 0, data: 0 }
  const sec = getSection(raw, y >> 4, false)
  if (!sec) return { id: 0, data: 0 }
  const i = sectionIndex(x, y, z)
  const blocks = byteArrayValue(sec.Blocks, 4096)
  const data = byteArrayValue(sec.Data, 2048)
  const add = sec.Add ? byteArrayValue(sec.Add, 2048) : null
  const low = blocks ? (blocks[i] & 255) : 0
  const high = add ? nibbleGet(add, i) : 0
  return { id: low | (high << 8), data: data ? nibbleGet(data, i) : 0 }
}
function setBlockInRaw (raw, x, y, z, id, meta = 0) {
  if (y < 0 || y > 255) return
  const sec = getSection(raw, y >> 4, true)
  const i = sectionIndex(x, y, z)
  const blocks = byteArrayValue(sec.Blocks, 4096)
  const data = byteArrayValue(sec.Data, 2048)
  blocks[i] = id & 255
  nibbleSet(data, i, meta)
  const high = (id >> 8) & 15
  if (high || sec.Add) {
    if (!sec.Add) sec.Add = makeByteArrayTag(2048, 0)
    nibbleSet(byteArrayValue(sec.Add, 2048), i, high)
  }
}
function highestBlockRaw (raw, lx, lz, ignore = new Set([0])) {
  const lvl = levelValue(raw)
  let start = 255
  for (let y = start; y >= 0; y--) {
    const b = getBlockFromRaw(raw, lx, y, lz)
    if (!ignore.has(b.id)) return { y, ...b }
  }
  return { y: 0, id: 0, data: 0 }
}
function updateHeightMap (raw, lx, lz, y) {
  const lvl = levelValue(raw)
  if (!lvl.HeightMap) lvl.HeightMap = { type: 'intArray', value: new Array(256).fill(0) }
  if (!Array.isArray(lvl.HeightMap.value) && !(lvl.HeightMap.value instanceof Int32Array)) lvl.HeightMap.value = new Array(256).fill(0)
  lvl.HeightMap.value[(lz & 15) * 16 + (lx & 15)] = y + 1
}

class RawWorld {
  constructor (worldPath, dimension = 'overworld', version = '1.12.2') {
    this.worldPath = worldPath
    this.dimension = dimension
    this.version = version
    this.regionPath = dimensionRegionPath(worldPath, dimension)
    fs.mkdirSync(this.regionPath, { recursive: true })
    const Anvil = require('prismarine-provider-anvil').Anvil(version)
    this.provider = new Anvil(this.regionPath)
    this.Chunk = require('prismarine-chunk')(version)
    this.Block = require('prismarine-block')(version)
  }
  async loadRaw (cx, cz, create = false) {
    let raw = await this.provider.loadRaw(cx, cz)
    if (!raw && create) {
      const chunk = new this.Chunk()
      await this.provider.save(cx, cz, chunk)
      raw = await this.provider.loadRaw(cx, cz)
    }
    return raw
  }
  async getBlock (x, y, z) {
    const cx = floorDiv(x, 16), cz = floorDiv(z, 16)
    const raw = await this.loadRaw(cx, cz, false)
    if (!raw) return { id: 0, data: 0 }
    return getBlockFromRaw(raw, mod(x, 16), y, mod(z, 16))
  }
  async getHighest (x, z) {
    const cx = floorDiv(x, 16), cz = floorDiv(z, 16)
    const raw = await this.loadRaw(cx, cz, false)
    if (!raw) return { y: 0, id: 0, data: 0 }
    return highestBlockRaw(raw, mod(x, 16), mod(z, 16))
  }
  async saveRaw(cx, cz, raw) {
    // NBT byteArray is signed; editing uses unsigned Buffers for bit operations.
    for(const sec of sectionsValue(raw)||[])for(const name of ['Blocks','Data','Add','BlockLight','SkyLight']){
      const tag=sec[name];if(tag?.value)tag.value=Array.from(tag.value,v=>(v&255)>127?(v&255)-256:v&255)
    }
    await this.provider.saveRaw(cx,cz,raw)
  }
  async editColumns (box, callback, create = true) {
    const minX = Math.min(box.x1, box.x2), maxX = Math.max(box.x1, box.x2)
    const minZ = Math.min(box.z1, box.z2), maxZ = Math.max(box.z1, box.z2)
    const minCx = floorDiv(minX, 16), maxCx = floorDiv(maxX, 16), minCz = floorDiv(minZ, 16), maxCz = floorDiv(maxZ, 16)
    let changed = 0
    for (let cz = minCz; cz <= maxCz; cz++) for (let cx = minCx; cx <= maxCx; cx++) {
      const raw = await this.loadRaw(cx, cz, create)
      if (!raw) continue
      let dirty = false
      const x0 = Math.max(minX, cx * 16), x1 = Math.min(maxX, cx * 16 + 15)
      const z0 = Math.max(minZ, cz * 16), z1 = Math.min(maxZ, cz * 16 + 15)
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const r = await callback({ raw, x, z, lx: mod(x, 16), lz: mod(z, 16), cx, cz, getTop: () => highestBlockRaw(raw, mod(x, 16), mod(z, 16)), set: (y, id, data = 0) => { setBlockInRaw(raw, mod(x, 16), y, mod(z, 16), id, data); dirty = true; changed++ } })
        if (r === true) dirty = true
      }
      if (dirty) {
        for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) { const top = highestBlockRaw(raw, mod(x, 16), mod(z, 16)); updateHeightMap(raw, mod(x, 16), mod(z, 16), top.y) }
        await this.saveRaw(cx, cz, raw)
      }
    }
    return changed
  }
  async editBlocks (changes) {
    const byChunk = new Map()
    for (const c of changes) {
      if (c.y < 0 || c.y > 255) continue
      const cx = floorDiv(c.x, 16), cz = floorDiv(c.z, 16), key = `${cx},${cz}`
      if (!byChunk.has(key)) byChunk.set(key, { cx, cz, list: [] })
      byChunk.get(key).list.push(c)
    }
    let changed = 0
    for (const { cx, cz, list } of byChunk.values()) {
      const raw = await this.loadRaw(cx, cz, true)
      const touchedColumns = new Set()
      for (const c of list) {
        setBlockInRaw(raw, mod(c.x, 16), c.y, mod(c.z, 16), Number(c.id), Number(c.data || 0))
        touchedColumns.add(`${mod(c.x, 16)},${mod(c.z, 16)}`); changed++
      }
      for (const key of touchedColumns) {
        const [lx, lz] = key.split(',').map(Number)
        const top = highestBlockRaw(raw, lx, lz)
        updateHeightMap(raw, lx, lz, top.y)
      }
      await this.saveRaw(cx, cz, raw)
    }
    return changed
  }
  async close () { await this.provider.close() }
}

module.exports = {
  RawWorld, dimensionRegionPath, floorDiv, mod, nibbleGet, nibbleSet, sectionIndex,
  levelValue, sectionsValue, getBlockFromRaw, setBlockInRaw, highestBlockRaw, updateHeightMap
}
