'use strict'
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

function bridgeStatePath () {
  const base = process.env.APPDATA || path.join(os.homedir(), '.zx-engineering')
  const dir = path.join(base, '照献工程')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'bridge-state.json')
}

function defaultProject (worldPath) {
  return {
    schema: 1,
    name: path.basename(worldPath || '未命名世界'),
    worldPath,
    version: '1.12.2',
    dimension: 'overworld',
    concept: '',
    tags: [],
    markers: [],
    protectedRegions: [],
    buildingPlans: [],
    layers: {
      terrain: true,
      structures: true,
      foliage: true,
      water: true,
      entities: false
    },
    ui: { viewDistance: 4, overviewSample: 0, orthographic: true, renderScale: 1.0, showGrid: false, previewMode: 'overview' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

class ProjectStore {
  constructor (worldPath) {
    this.worldPath = worldPath
    this.dir = path.join(worldPath, '.zxproject')
    this.file = path.join(this.dir, 'project.json')
  }
  async ensure () {
    fs.mkdirSync(this.dir, { recursive: true })
    fs.mkdirSync(path.join(this.dir, 'history'), { recursive: true })
    if (!fs.existsSync(this.file)) fs.writeFileSync(this.file, JSON.stringify(defaultProject(this.worldPath), null, 2), 'utf8')
    return this.get()
  }
  async get () {
    await this.ensureIfNeeded()
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch { return defaultProject(this.worldPath) }
  }
  async ensureIfNeeded () {
    if (!fs.existsSync(this.file)) {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(defaultProject(this.worldPath), null, 2), 'utf8')
    }
  }
  async update (patch) {
    const current = await this.get()
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() }
    if (patch.layers) next.layers = { ...current.layers, ...patch.layers }
    if (patch.ui) next.ui = { ...current.ui, ...patch.ui }
    fs.writeFileSync(this.file, JSON.stringify(next, null, 2), 'utf8')
    return next
  }
  static idForPath (p) { return crypto.createHash('sha1').update(String(p)).digest('hex').slice(0, 12) }
}

module.exports = { ProjectStore, bridgeStatePath, defaultProject }
