'use strict'
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const nbt = require('prismarine-nbt')
const { dimensionRegionPath, highestBlockRaw } = require('./raw-world.cjs')
const { INVISIBLE } = require('./preview-visibility.cjs')

function parseRegionName (name) {
  const m = /^r\.(-?\d+)\.(-?\d+)\.mca$/.exec(name)
  return m ? { rx: Number(m[1]), rz: Number(m[2]) } : null
}
function readChunkRawFromRegionBuffer (buf, lx, lz) {
  const idx = lx + lz * 32
  const off = buf.readUInt32BE(idx * 4)
  if (!off) return null
  const sector = off >> 8; const count = off & 255
  if (sector < 2 || count <= 0) return null
  const pos = sector * 4096
  if (pos + 5 > buf.length) return null
  const len = buf.readUInt32BE(pos)
  if (len <= 1 || pos + 4 + len > buf.length) return null
  const type = buf.readUInt8(pos + 4)
  const comp = buf.subarray(pos + 5, pos + 4 + len)
  let raw
  if (type === 1) raw = zlib.gunzipSync(comp)
  else if (type === 2) raw = zlib.inflateSync(comp)
  else if (type === 3) raw = comp
  else return null
  return nbt.parseUncompressed(raw)
}
function toB64 (typed) { return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64') }
function autoSampleForRegionCount (count, preferred = 0) {
  if ([1, 2, 4, 8, 16].includes(Number(preferred))) return Number(preferred)
  if (count <= 4) return 2
  if (count <= 16) return 4
  if (count <= 64) return 8
  return 16
}
function regionFingerprint (regionPath, infos, sample) {
  const h = crypto.createHash('sha1').update(`visible-v2;s=${sample};`)
  for (const i of infos) {
    const st = fs.statSync(path.join(regionPath, i.name))
    h.update(`${i.name}:${st.size}:${Math.floor(st.mtimeMs)};`)
  }
  return h.digest('hex')
}
function cacheFile (worldPath, dimension, sample) {
  const dir = process.env.ZX_CACHE_ROOT ? path.join(process.env.ZX_CACHE_ROOT, 'maps', crypto.createHash('sha256').update(path.resolve(worldPath).toLowerCase()).digest('hex')) : path.join(worldPath, '.zxproject', 'cache')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `overview-${dimension}-s${sample}.json.gz`)
}

async function scanRegion (file, rx, rz, sample, showBarriers = false) {
  const invisible = showBarriers ? new Set([0,217]) : INVISIBLE
  const buf = fs.readFileSync(file)
  const res = Math.floor(512 / sample)
  const height = new Uint8Array(res * res)
  const block = new Uint16Array(res * res)
  const data = new Uint8Array(res * res)
  const valid = new Uint8Array(res * res)
  let chunks = 0
  for (let cz = 0; cz < 32; cz++) for (let cx = 0; cx < 32; cx++) {
    let raw = null
    try { raw = readChunkRawFromRegionBuffer(buf, cx, cz) } catch { raw = null }
    if (!raw) continue
    chunks++
    for (let lz = 0; lz < 16; lz += sample) for (let lx = 0; lx < 16; lx += sample) {
      const top = highestBlockRaw(raw, lx, lz, invisible)
      const gx = Math.floor((cx * 16 + lx) / sample); const gz = Math.floor((cz * 16 + lz) / sample)
      const i = gz * res + gx
      height[i] = Math.max(0, Math.min(255, top.y))
      block[i] = top.id
      data[i] = top.data
      valid[i] = top.id === 0 ? 0 : 1
    }
  }
  return { rx, rz, res, sample, chunks, height: toB64(height), block: toB64(block), data: toB64(data), valid: toB64(valid) }
}

async function scanWorldOverview (worldPath, dimension = 'overworld', requestedSample = 0, options = {}) {
  const regionPath = dimensionRegionPath(worldPath, dimension)
  if (!fs.existsSync(regionPath)) throw new Error(`维度 region 目录不存在：${regionPath}`)
  const files = fs.readdirSync(regionPath).filter(n => /^r\.-?\d+\.-?\d+\.mca$/.test(n)).sort()
  const infos = files.map(n => ({ name: n, ...parseRegionName(n) })).filter(v => Number.isFinite(v.rx) && Number.isFinite(v.rz))
  if (!infos.length) return { worldPath, dimension, sample: 4, regions: [], bounds: null, chunks: 0, cached: false }
  const sample = autoSampleForRegionCount(infos.length, requestedSample)
  const fingerprint = regionFingerprint(regionPath, infos, sample) + (options.showBarriers ? '-barriers' : '-hidden')
  const cf = cacheFile(worldPath, dimension, sample)
  if (!options.force && fs.existsSync(cf)) {
    try {
      const cached = JSON.parse(zlib.gunzipSync(fs.readFileSync(cf)).toString('utf8'))
      if (cached.fingerprint === fingerprint) return { ...cached.payload, cached: true }
    } catch {}
  }

  let minRx = Infinity; let maxRx = -Infinity; let minRz = Infinity; let maxRz = -Infinity
  for (const v of infos) { minRx = Math.min(minRx, v.rx); maxRx = Math.max(maxRx, v.rx); minRz = Math.min(minRz, v.rz); maxRz = Math.max(maxRz, v.rz) }
  const regions = []
  for (const info of infos) regions.push(await scanRegion(path.join(regionPath, info.name), info.rx, info.rz, sample, options.showBarriers))
  const payload = {
    worldPath, dimension, sample, regionPath,
    regions,
    chunks: regions.reduce((n, r) => n + r.chunks, 0),
    bounds: {
      minRx, maxRx, minRz, maxRz,
      minX: minRx * 512, maxX: (maxRx + 1) * 512 - 1,
      minZ: minRz * 512, maxZ: (maxRz + 1) * 512 - 1,
      width: (maxRx - minRx + 1) * 512,
      length: (maxRz - minRz + 1) * 512
    }
  }
  try { fs.writeFileSync(cf, zlib.gzipSync(Buffer.from(JSON.stringify({ fingerprint, payload })))) } catch {}
  return { ...payload, cached: false }
}
module.exports = { scanWorldOverview, parseRegionName, autoSampleForRegionCount }
