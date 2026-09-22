'use strict'
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

function detectVanilla112Jar () {
  const appData = process.env.APPDATA || ''
  const candidates = [
    path.join(appData, '.minecraft', 'versions', '1.12.2', '1.12.2.jar'),
    path.join(appData, '.minecraft', 'versions', '1.12.2-forge1.12.2', '1.12.2-forge1.12.2.jar')
  ]
  return candidates.find(p => p && fs.existsSync(p)) || null
}

class ZipSource {
  constructor (file) {
    this.file = file
    this.buf = fs.readFileSync(file)
    this.entries = new Map()
    this._index()
  }
  _index () {
    const b = this.buf
    let eocd = -1
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
      if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    }
    if (eocd < 0) throw new Error('不是有效的 ZIP/JAR 文件')
    const count = b.readUInt16LE(eocd + 10)
    let off = b.readUInt32LE(eocd + 16)
    for (let i = 0; i < count && off + 46 <= b.length; i++) {
      if (b.readUInt32LE(off) !== 0x02014b50) break
      const method = b.readUInt16LE(off + 10)
      const compSize = b.readUInt32LE(off + 20)
      const uncompSize = b.readUInt32LE(off + 24)
      const nameLen = b.readUInt16LE(off + 28)
      const extraLen = b.readUInt16LE(off + 30)
      const commentLen = b.readUInt16LE(off + 32)
      const localOff = b.readUInt32LE(off + 42)
      const name = b.subarray(off + 46, off + 46 + nameLen).toString('utf8').replace(/\\/g, '/')
      this.entries.set(name, { method, compSize, uncompSize, localOff })
      off += 46 + nameLen + extraLen + commentLen
    }
  }
  has (name) { return this.entries.has(String(name).replace(/\\/g, '/')) }
  read (name) {
    name = String(name).replace(/\\/g, '/')
    const e = this.entries.get(name)
    if (!e) return null
    const b = this.buf, o = e.localOff
    if (b.readUInt32LE(o) !== 0x04034b50) return null
    const nameLen = b.readUInt16LE(o + 26), extraLen = b.readUInt16LE(o + 28)
    const start = o + 30 + nameLen + extraLen
    const raw = b.subarray(start, start + e.compSize)
    if (e.method === 0) return Buffer.from(raw)
    if (e.method === 8) return zlib.inflateRawSync(raw)
    return null
  }
}

class ResourcePack {
  constructor (sourcePath) {
    if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('材质源不存在')
    this.path = sourcePath
    this.kind = fs.statSync(sourcePath).isDirectory() ? 'folder' : 'zip'
    this.zip = this.kind === 'zip' ? new ZipSource(sourcePath) : null
  }
  _candidatePaths (textureName) {
    const clean = String(textureName).replace(/^minecraft:/, '').replace(/^textures\/blocks\//, '').replace(/\.png$/i, '')
    return [
      `assets/minecraft/textures/blocks/${clean}.png`,
      `assets/minecraft/textures/block/${clean}.png`,
      `textures/blocks/${clean}.png`,
      `textures/block/${clean}.png`
    ]
  }
  readTexture (textureName) {
    for (const rel of this._candidatePaths(textureName)) {
      if (this.kind === 'folder') {
        const p = path.join(this.path, ...rel.split('/'))
        if (fs.existsSync(p)) return fs.readFileSync(p)
      } else {
        const b = this.zip.read(rel)
        if (b) return b
      }
    }
    return null
  }
  info () {
    return { ok: true, path: this.path, kind: this.kind, vanilla: /[\\/]versions[\\/]1\.12\.2[\\/]1\.12\.2\.jar$/i.test(this.path) }
  }
}

module.exports = { ResourcePack, detectVanilla112Jar }
