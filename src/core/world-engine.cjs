'use strict'
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const nbt = require('prismarine-nbt')
const mcDataLoader = require('minecraft-data')
const { Vec3 } = require('vec3')
const { RawWorld, dimensionRegionPath, getBlockFromRaw, setBlockInRaw, highestBlockRaw, updateHeightMap, floorDiv, mod } = require('./raw-world.cjs')
const { TransactionManager } = require('./transactions.cjs')
const { assertAllowed, normalizeBox } = require('./protection.cjs')
const { ProjectStore } = require('./project-store.cjs')
const { exportBoxToLegacySchematic } = require('./legacy-schematic.cjs')

const VERSION = '1.12.2'
const CHINESE_BLOCKS = {
  '空气': 'air', '石头': 'stone', '草方块': 'grass', '泥土': 'dirt', '圆石': 'cobblestone', '橡木木板': 'planks',
  '云杉木板': { id: 5, data: 1 }, '橡木原木': 'log', '云杉原木': { id: 17, data: 1 }, '橡树叶': 'leaves', '云杉树叶': { id: 18, data: 1 },
  '沙子': 'sand', '沙砾': 'gravel', '水': { id: 9, data: 0 }, '石砖': 'stonebrick', '苔石砖': { id: 98, data: 1 },
  '裂纹石砖': { id: 98, data: 2 }, '地狱砖': 'nether_brick', '石英块': 'quartz_block', '玻璃': 'glass', '萤石': 'glowstone',
  '雪块': 'snow', '冰': 'ice', '砖块': 'brick_block', '基岩': 'bedrock'
}

function clamp (v, a, b) { return Math.max(a, Math.min(b, v)) }
function boxFromCenter (x, z, radius, y1 = 0, y2 = 255) { return { x1: x - radius, x2: x + radius, z1: z - radius, z2: z + radius, y1, y2 } }
function pointLineDistance (px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az
  if (dx === 0 && dz === 0) return Math.hypot(px - ax, pz - az)
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz), 0, 1)
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz))
}
function deterministicNoise (x, z, seed = 1337) {
  let n = Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(seed, 1442695041)
  n = (n ^ (n >>> 13)); n = Math.imul(n, 1274126177); n ^= n >>> 16
  return ((n >>> 0) / 4294967295) * 2 - 1
}

class WorldEngine {
  constructor (worldPath, dimension = 'overworld') {
    this.worldPath = worldPath
    this.dimension = dimension
    this.regionPath = dimensionRegionPath(worldPath, dimension)
    this.raw = new RawWorld(worldPath, dimension, VERSION)
    this.tx = new TransactionManager(worldPath, dimension, this.regionPath)
    this.project = new ProjectStore(worldPath)
    this.mcData = mcDataLoader(VERSION)
  }
  blockSpec (spec, fallback = { id: 1, data: 0 }) {
    if (spec == null) return fallback
    if (typeof spec === 'number') return { id: spec, data: 0 }
    if (typeof spec === 'object' && Number.isFinite(Number(spec.id))) return { id: Number(spec.id), data: Number(spec.data || spec.metadata || 0) }
    let s = String(spec).trim()
    if (CHINESE_BLOCKS[s]) return this.blockSpec(CHINESE_BLOCKS[s], fallback)
    const numeric = /^(\d+)(?::(\d+))?$/.exec(s)
    if (numeric) return { id: Number(numeric[1]), data: Number(numeric[2] || 0) }
    s = s.replace(/^minecraft:/, '').toLowerCase().replace(/\s+/g, '_')
    const b = this.mcData.blocksByName?.[s]
    if (b) return { id: b.id, data: Number(b.metadata || 0) }
    throw new Error(`未知 1.12.2 方块：${spec}。可使用 stone、minecraft:stone、98:2 或中文常用名。`)
  }
  async editWithTx (name, box, fn, allowProtected = false) {
    box = normalizeBox(box)
    assertAllowed(this.worldPath, box, allowProtected)
    const hadActive = !!this.tx.active()
    if (!hadActive) this.tx.begin(name)
    this.tx.backupBox(box)
    try {
      const result = await fn()
      this.tx.record(box, typeof result==='number'?result:result?.changed)
      if (!hadActive) this.tx.commit()
      return result
    } catch (err) {
      if (!hadActive) await this.rollbackTransaction()
      throw err
    }
  }
  async createWorld (opt = {}) {
    const name = opt.name || path.basename(this.worldPath)
    const size = clamp(Number(opt.size || 512), 64, 4096)
    const baseHeight = clamp(Number(opt.baseHeight || 64), 4, 220)
    const preset = opt.preset || 'void'
    if (!['void','flat','natural','mountain'].includes(preset)) throw new Error('未知世界预设')
    const isVoid = preset === 'void'
    fs.mkdirSync(this.worldPath, { recursive: true })
    fs.mkdirSync(path.join(this.worldPath, 'region'), { recursive: true })
    const Anvil = require('prismarine-provider-anvil').Anvil(VERSION)
    const provider = new Anvil(path.join(this.worldPath, 'region'))
    const Chunk = require('prismarine-chunk')(VERSION)
    const minChunk = Math.floor(-size / 2 / 16), maxChunk = Math.ceil(size / 2 / 16) - 1
    for (let cz = minChunk; !isVoid && cz <= maxChunk; cz++) for (let cx = minChunk; cx <= maxChunk; cx++) {
      const chunk = new Chunk()
      for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        const wx = cx * 16 + x, wz = cz * 16 + z
        let h = baseHeight
        if (preset === 'natural') h += Math.round(deterministicNoise(Math.floor(wx / 8), Math.floor(wz / 8), 77) * 4 + deterministicNoise(Math.floor(wx / 28), Math.floor(wz / 28), 13) * 7)
        if (preset === 'mountain') h += Math.round(Math.abs(deterministicNoise(Math.floor(wx / 18), Math.floor(wz / 18), 91)) * 32)
        h = clamp(h, 4, 240)
        for (let y = 0; y <= h; y++) {
          let id = 1, data = 0
          if (y === 0) id = 7
          else if (y === h) id = 2
          else if (y > h - 4) id = 3
          chunk.setBlockType(new Vec3(x, y, z), id)
          chunk.setBlockData(new Vec3(x, y, z), data)
          chunk.setSkyLight(new Vec3(x, y, z), y >= h ? 15 : 0)
        }
        chunk.setBiome(new Vec3(x, 0, z), 1)
      }
      await provider.save(cx, cz, chunk)
    }
    await provider.close()
    const level = nbt.comp({
      Data: nbt.comp({
        version: nbt.int(19133), DataVersion: nbt.int(1343), LevelName: nbt.string(name), generatorName: nbt.string(isVoid ? 'flat' : 'default'), generatorVersion: nbt.int(1), generatorOptions: nbt.string(isVoid ? '3;minecraft:air;1;' : ''),
        RandomSeed: nbt.long(BigInt(opt.seed || 0)), GameType: nbt.int(1), hardcore: nbt.byte(0), allowCommands: nbt.byte(1), initialized: nbt.byte(1), MapFeatures: nbt.byte(isVoid ? 0 : 1),
        SpawnX: nbt.int(0), SpawnY: nbt.int(baseHeight + 2), SpawnZ: nbt.int(0), Time: nbt.long(0n), DayTime: nbt.long(0n), Difficulty: nbt.byte(2), DifficultyLocked: nbt.byte(0)
      })
    }, '')
    fs.writeFileSync(path.join(this.worldPath, 'level.dat'), zlib.gzipSync(nbt.writeUncompressed(level)))
    await this.project.ensure()
    await this.project.update({ worldPreset:preset, ui:{ lastPosition:{x:0,y:baseHeight+2,z:0} } })
    return { ok: true, name, size, baseHeight, preset, worldPath: this.worldPath }
  }
  async runTool (name, p = {}) {
    const methods = {
      set_block: () => this.setBlock(p),
      apply_blocks: () => this.applyBlocks(p),
      set_spawn: () => this.setSpawn(p),
      fill: () => this.fill(p),
      flatten: () => this.flatten(p),
      smooth_terrain: () => this.smoothTerrain(p),
      raise_terrain: () => this.raiseTerrain(p, 1),
      lower_terrain: () => this.raiseTerrain(p, -1),
      generate_mountain: () => this.generateMountain(p),
      create_valley: () => this.createValley(p),
      create_river: () => this.createRiver(p),
      create_lake: () => this.createLake(p),
      create_road: () => this.createRoad(p),
      scatter_trees: () => this.scatterTrees(p),
      replace_material: () => this.replaceMaterial(p),
      copy_region: () => this.copyRegion(p),
      create_wall: () => this.createWall(p),
      create_floor: () => this.createFloor(p),
      create_pillar: () => this.createPillar(p),
      create_gable_roof: () => this.createGableRoof(p),
      create_tower: () => this.createTower(p),
      create_bridge: () => this.createBridge(p),
      create_boss_arena: () => this.createBossArena(p),
      place_schematic: () => this.placeSchematic(p),
      export_schematic: () => this.exportLegacySchematic(p),
      material_stats: () => this.materialStats(p),
      add_marker: () => this.addMarker(p),
      add_protected_region: () => this.addProtectedRegion(p),
      create_building_plan: () => this.createBuildingPlan(p),
      update_building_plan: () => this.updateBuildingPlan(p),
      add_building_part: () => this.addBuildingPart(p),
      undo: () => this.undo(),
      redo: () => this.redo(),
      history: () => ({active:this.tx.active(),entries:this.tx.list()}),
      begin_transaction: () => ({ ok: true, transaction: this.tx.begin(p.name || 'AI 编辑') }),
      commit_transaction: () => ({ ok: true, transaction: this.tx.commit() }),
      rollback_transaction: () => this.rollbackTransaction()
    }
    if (!methods[name]) throw new Error(`未知工具：${name}`)
    return await methods[name]()
  }
  async setBlock (p) {
    const b = this.blockSpec(p.block || { id: p.id, data: p.data })
    const box = { x1: p.x, x2: p.x, y1: p.y, y2: p.y, z1: p.z, z2: p.z }
    return this.editWithTx('设置方块', box, async () => ({ ok: true, changed: await this.raw.editBlocks([{ x: Number(p.x), y: Number(p.y), z: Number(p.z), ...b }]) }), p.allowProtected)
  }
  async applyBlocks(p) {
    if(!Array.isArray(p.blocks)||!p.blocks.length||p.blocks.length>500000)throw new Error('批量方块数量须为 1–500000')
    const box={x1:Infinity,y1:Infinity,z1:Infinity,x2:-Infinity,y2:-Infinity,z2:-Infinity}
    for(const b of p.blocks){
      if(!b||!['x','y','z','id'].every(k=>Number.isInteger(b[k]))||Math.abs(b.x)>29999984||Math.abs(b.z)>29999984||b.y<0||b.y>255||b.id<0||b.id>4095||!Number.isInteger(b.data??0)||(b.data??0)<0||(b.data??0)>15)throw new Error('批量方块含无效坐标、ID 或状态')
      for(const a of ['x','y','z']){box[a+'1']=Math.min(box[a+'1'],b[a]);box[a+'2']=Math.max(box[a+'2'],b[a])}
    }
    const regions=(Math.floor(box.x2/512)-Math.floor(box.x1/512)+1)*(Math.floor(box.z2/512)-Math.floor(box.z1/512)+1)
    if(regions>64)throw new Error('单次批量跨度超过 64 个 Region，请拆分')
    return this.editWithTx(p.name||'AI 批量建造',box,async()=>({ok:true,changed:await this.raw.editBlocks(p.blocks),bounds:box}))
  }
  async setSpawn(p){
    if(!['x','y','z'].every(a=>Number.isInteger(p[a]))||p.y<1||p.y>254||Math.abs(p.x)>29999984||Math.abs(p.z)>29999984)throw new Error('出生点坐标无效')
    const file=path.join(this.worldPath,'level.dat'),raw=nbt.parseUncompressed(zlib.gunzipSync(fs.readFileSync(file)))
    for(const a of ['x','y','z'])raw.value.Data.value['Spawn'+a.toUpperCase()]=nbt.int(p[a])
    fs.copyFileSync(file,file+'_old');fs.writeFileSync(file+'.zx.tmp',zlib.gzipSync(nbt.writeUncompressed(raw)));fs.renameSync(file+'.zx.tmp',file)
    return {ok:true,spawn:{x:p.x,y:p.y,z:p.z}}
  }
  async fill (p) {
    const box = normalizeBox(p)
    const volume = (box.x2 - box.x1 + 1) * (box.y2 - box.y1 + 1) * (box.z2 - box.z1 + 1)
    if (volume > 4_000_000) throw new Error('单次 fill 超过 400 万方块，请拆分操作。')
    const b = this.blockSpec(p.block)
    return this.editWithTx('填充区域', box, async () => {
      let changed = 0
      for (let y = box.y1; y <= box.y2; y++) {
        const batch = []
        for (let z = box.z1; z <= box.z2; z++) for (let x = box.x1; x <= box.x2; x++) batch.push({ x, y, z, ...b })
        changed += await this.raw.editBlocks(batch)
      }
      return { ok: true, changed, box }
    }, p.allowProtected)
  }
  async flatten (p) {
    const box = normalizeBox({ ...p, y1: 0, y2: 255 })
    const targetY = clamp(Number(p.y ?? p.targetY ?? 64), 1, 254)
    const top = this.blockSpec(p.topBlock || 'grass')
    const fill = this.blockSpec(p.fillBlock || 'dirt')
    const maxColumns = (box.x2 - box.x1 + 1) * (box.z2 - box.z1 + 1)
    if (maxColumns > 600_000) throw new Error('平整区域过大，请控制在 60 万列以内。')
    return this.editWithTx('平整地形', box, async () => {
      let changed = 0
      changed += await this.raw.editColumns(box, async ({ raw, lx, lz, getTop, set }) => {
        const old = getTop().y
        if (old > targetY) for (let y = targetY + 1; y <= old; y++) set(y, 0, 0)
        else if (old < targetY) for (let y = old + 1; y < targetY; y++) set(y, fill.id, fill.data)
        set(targetY, top.id, top.data)
      })
      return { ok: true, changed, targetY }
    }, p.allowProtected)
  }
  async smoothTerrain (p) {
    const box = normalizeBox({ ...p, y1: 0, y2: 255 })
    const iterations = clamp(Number(p.iterations || 1), 1, 4)
    const blend = clamp(Number(p.blend ?? 0.65), 0.05, 1)
    const columns = (box.x2 - box.x1 + 1) * (box.z2 - box.z1 + 1)
    if (columns > 180000) throw new Error('平滑区域超过 18 万列，请拆分操作。')
    const topMat = this.blockSpec(p.topBlock || 'grass'), fillMat = this.blockSpec(p.fillBlock || 'dirt')
    return this.editWithTx('平滑地形', box, async () => {
      let totalChanged = 0
      for (let iter = 0; iter < iterations; iter++) {
        const heights = new Map()
        for (let z = box.z1 - 1; z <= box.z2 + 1; z++) for (let x = box.x1 - 1; x <= box.x2 + 1; x++) heights.set(`${x},${z}`, (await this.raw.getHighest(x, z)).y)
        const targets = []
        for (let z = box.z1; z <= box.z2; z++) for (let x = box.x1; x <= box.x2; x++) {
          let sum = 0, n = 0
          for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { sum += heights.get(`${x + dx},${z + dz}`) || 0; n++ }
          const old = heights.get(`${x},${z}`) || 0
          const avg = sum / n
          targets.push({ x, z, target: clamp(Math.round(old * (1 - blend) + avg * blend), 1, 254) })
        }
        totalChanged += await this.raw.editColumns(box, async ({ x, z, getTop, set }) => {
          const target = targets[(z - box.z1) * (box.x2 - box.x1 + 1) + (x - box.x1)].target
          const old = getTop().y
          if (target > old) { for (let y = old + 1; y < target; y++) set(y, fillMat.id, fillMat.data); set(target, topMat.id, topMat.data) }
          else if (target < old) { for (let y = old; y > target; y--) set(y, 0, 0); set(target, topMat.id, topMat.data) }
        }, false)
      }
      return { ok: true, changed: totalChanged, iterations, blend }
    }, p.allowProtected)
  }
  async raiseTerrain (p, sign) {
    const radius = clamp(Number(p.radius || 12), 1, 256), strength = clamp(Math.abs(Number(p.strength || 3)), 1, 64) * sign
    const cx0 = Number(p.x || 0), cz0 = Number(p.z || 0), box = boxFromCenter(cx0, cz0, radius)
    const topMat = this.blockSpec(p.topBlock || 'grass'), fillMat = this.blockSpec(p.fillBlock || 'dirt')
    return this.editWithTx(sign > 0 ? '抬高地形' : '降低地形', box, async () => {
      let changed = 0
      changed += await this.raw.editColumns(box, async ({ x, z, getTop, set }) => {
        const d = Math.hypot(x - cx0, z - cz0); if (d > radius) return
        const w = Math.pow(1 - d / radius, Number(p.falloff || 1.5)), delta = Math.round(strength * w); if (!delta) return
        const old = getTop().y, ny = clamp(old + delta, 1, 254)
        if (ny > old) { for (let y = old + 1; y < ny; y++) set(y, fillMat.id, fillMat.data); set(ny, topMat.id, topMat.data) }
        else { for (let y = old; y > ny; y--) set(y, 0, 0); set(ny, topMat.id, topMat.data) }
      }, false)
      return { ok: true, changed, radius, strength }
    }, p.allowProtected)
  }
  async generateMountain (p) {
    const x0 = Number(p.x || 0), z0 = Number(p.z || 0), radius = clamp(Number(p.radius || 80), 4, 800), height = clamp(Number(p.height || 55), 2, 180)
    const roughness = clamp(Number(p.roughness ?? 0.22), 0, 1), seed = Number(p.seed || 1337), box = boxFromCenter(x0, z0, radius)
    const topMat = this.blockSpec(p.topBlock || 'grass'), inner = this.blockSpec(p.innerBlock || 'stone'), dirt = this.blockSpec(p.fillBlock || 'dirt')
    return this.editWithTx('生成山体', box, async () => {
      let changed = 0
      changed += await this.raw.editColumns(box, async ({ x, z, getTop, set }) => {
        const dist = Math.hypot(x - x0, z - z0); if (dist > radius) return
        const t = 1 - dist / radius
        const n = deterministicNoise(Math.floor(x / 5), Math.floor(z / 5), seed) * roughness + deterministicNoise(Math.floor(x / 19), Math.floor(z / 19), seed + 17) * roughness * 0.7
        const add = Math.max(0, Math.round(height * Math.pow(t, Number(p.profile || 1.6)) * (1 + n)))
        if (!add) return
        const old = getTop().y, target = clamp(old + add, 1, 250)
        for (let y = old + 1; y <= target; y++) {
          const depth = target - y
          const b = depth === 0 ? topMat : depth < 4 ? dirt : inner
          set(y, b.id, b.data)
        }
      }, false)
      return { ok: true, changed, center: { x: x0, z: z0 }, radius, height }
    }, p.allowProtected)
  }
  async createValley (p) {
    const x0 = Number(p.x || 0), z0 = Number(p.z || 0), radius = clamp(Number(p.radius || 90), 4, 800), depth = clamp(Number(p.depth || 30), 2, 120)
    const profile = clamp(Number(p.profile || 1.8), 0.5, 5), box = boxFromCenter(x0, z0, radius)
    const topMat = this.blockSpec(p.topBlock || 'grass')
    return this.editWithTx('生成山谷', box, async () => {
      let changed = 0
      changed += await this.raw.editColumns(box, async ({ x, z, getTop, set }) => {
        const dist = Math.hypot(x - x0, z - z0); if (dist > radius) return
        const t = 1 - dist / radius, delta = Math.round(depth * Math.pow(t, profile)); if (!delta) return
        const old = getTop().y, target = clamp(old - delta, 1, 254)
        for (let y = old; y > target; y--) set(y, 0, 0)
        set(target, topMat.id, topMat.data)
      }, false)
      return { ok: true, changed, center: { x: x0, z: z0 }, radius, depth }
    }, p.allowProtected)
  }
  _pathBox (points, width, depth = 255) {
    const xs = points.map(v => Number(v.x)), zs = points.map(v => Number(v.z)); const pad = Math.ceil(width + 2)
    return { x1: Math.min(...xs) - pad, x2: Math.max(...xs) + pad, z1: Math.min(...zs) - pad, z2: Math.max(...zs) + pad, y1: 0, y2: depth }
  }
  _distanceToPath (x, z, points) {
    let best = Infinity
    for (let i = 0; i < points.length - 1; i++) best = Math.min(best, pointLineDistance(x, z, Number(points[i].x), Number(points[i].z), Number(points[i + 1].x), Number(points[i + 1].z)))
    return best
  }
  async createRiver (p) {
    const points = p.points || [{ x: p.x1, z: p.z1 }, { x: p.x2, z: p.z2 }]
    if (points.length < 2) throw new Error('河流至少需要两个路径点')
    const width = clamp(Number(p.width || 8), 1, 80), depth = clamp(Number(p.depth || 4), 1, 30), waterY = p.waterY == null ? null : Number(p.waterY)
    const box = this._pathBox(points, width)
    return this.editWithTx('开挖河流', box, async () => {
      let changed = 0
      changed += await this.raw.editColumns(box, async ({ x, z, getTop, set }) => {
        const d = this._distanceToPath(x, z, points); if (d > width / 2) return
        const top = getTop().y, localDepth = Math.max(1, Math.round(depth * (1 - d / (width / 2 + 0.001))))
        const bottom = Math.max(1, top - localDepth)
        for (let y = bottom; y <= top + 1; y++) set(y, 0, 0)
        const wy = waterY == null ? top : waterY
        for (let y = bottom + 1; y <= Math.min(wy, top); y++) set(y, 9, 0)
        set(bottom, 13, 0)
      }, false)
      return { ok: true, changed, width, depth }
    }, p.allowProtected)
  }
  async createLake (p) {
    const x0 = Number(p.x || 0), z0 = Number(p.z || 0), radiusX = clamp(Number(p.radiusX || p.radius || 35), 2, 400), radiusZ = clamp(Number(p.radiusZ || p.radius || 35), 2, 400)
    const depth = clamp(Number(p.depth || 6), 1, 40), waterY = p.waterY == null ? null : clamp(Number(p.waterY), 1, 254)
    const box = { x1: Math.floor(x0 - radiusX - 2), x2: Math.ceil(x0 + radiusX + 2), z1: Math.floor(z0 - radiusZ - 2), z2: Math.ceil(z0 + radiusZ + 2), y1: 0, y2: 255 }
    const floorMat = this.blockSpec(p.floorBlock || 'gravel')
    return this.editWithTx('生成湖泊', box, async () => {
      let changed = 0
      changed += await this.raw.editColumns(box, async ({ x, z, getTop, set }) => {
        const nx = (x - x0) / radiusX, nz = (z - z0) / radiusZ, d = Math.sqrt(nx * nx + nz * nz)
        if (d > 1) return
        const top = getTop().y, localDepth = Math.max(1, Math.round(depth * Math.pow(1 - d, 0.7)))
        const bottom = Math.max(1, top - localDepth)
        for (let y = bottom; y <= top + 1; y++) set(y, 0, 0)
        set(bottom, floorMat.id, floorMat.data)
        const wy = waterY == null ? Math.max(bottom + 1, top - Math.max(1, Math.round(depth * 0.35))) : waterY
        for (let y = bottom + 1; y <= Math.min(top, wy); y++) set(y, 9, 0)
      }, false)
      return { ok: true, changed, radiusX, radiusZ, depth }
    }, p.allowProtected)
  }
  async createRoad (p) {
    const points = p.points || [{ x: p.x1, z: p.z1 }, { x: p.x2, z: p.z2 }]
    if (points.length < 2) throw new Error('道路至少需要两个路径点')
    const width = clamp(Number(p.width || 5), 1, 40), mat = this.blockSpec(p.block || 'gravel'), box = this._pathBox(points, width)
    return this.editWithTx('铺设道路', box, async () => {
      let changed = 0
      changed += await this.raw.editColumns(box, async ({ x, z, getTop, set }) => {
        if (this._distanceToPath(x, z, points) > width / 2) return
        const top = getTop(); set(top.y, mat.id, mat.data)
      }, false)
      return { ok: true, changed, width }
    }, p.allowProtected)
  }
  async scatterTrees (p) {
    const box = normalizeBox({ ...p, y1: 0, y2: 255 }), density = clamp(Number(p.density || 0.015), 0.001, 0.25), seed = Number(p.seed || 42)
    const log = this.blockSpec(p.log || { id: 17, data: 1 }), leaves = this.blockSpec(p.leaves || { id: 18, data: 1 })
    return this.editWithTx('散布树木', box, async () => {
      const changes = []; let trees = 0; let flushed = 0
      for (let z = box.z1; z <= box.z2; z++) for (let x = box.x1; x <= box.x2; x++) {
        const r = (deterministicNoise(x, z, seed) + 1) / 2
        if (r > density) continue
        const top = await this.raw.getHighest(x, z); if (top.y <= 1 || [8, 9, 10, 11].includes(top.id)) continue
        const h = 4 + Math.floor(((deterministicNoise(x, z, seed + 1) + 1) / 2) * 3)
        for (let y = 1; y <= h; y++) changes.push({ x, y: top.y + y, z, ...log })
        const cy = top.y + h
        for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) if (dx * dx + dz * dz + dy * dy * 1.4 <= 6.2) changes.push({ x: x + dx, y: cy + dy, z: z + dz, ...leaves })
        trees++
        if (changes.length > 60000) { flushed += await this.raw.editBlocks(changes.splice(0)) }
      }
      const changed = flushed + await this.raw.editBlocks(changes)
      return { ok: true, trees, changed }
    }, p.allowProtected)
  }
  async replaceMaterial (p) {
    const box = normalizeBox(p)
    const from = this.blockSpec(p.from), to = this.blockSpec(p.to)
    const volume = (box.x2 - box.x1 + 1) * (box.y2 - box.y1 + 1) * (box.z2 - box.z1 + 1)
    if (volume > 1800000) throw new Error('材质替换区域超过 180 万方块，请拆分操作。')
    return this.editWithTx('替换材质', box, async () => {
      const changes = []
      let changed = 0
      for (let z = box.z1; z <= box.z2; z++) for (let x = box.x1; x <= box.x2; x++) for (let y = box.y1; y <= box.y2; y++) {
        const b = await this.raw.getBlock(x, y, z)
        if (b.id === from.id && (p.matchData === false || b.data === from.data)) {
          changes.push({ x, y, z, ...to })
          if (changes.length >= 60000) changed += await this.raw.editBlocks(changes.splice(0))
        }
      }
      if (changes.length) changed += await this.raw.editBlocks(changes)
      return { ok: true, changed, from, to }
    }, p.allowProtected)
  }
  async copyRegion (p) {
    const src = normalizeBox({ x1: p.x1, y1: p.y1, z1: p.z1, x2: p.x2, y2: p.y2, z2: p.z2 })
    const dx = Number(p.dx || 0), dy = Number(p.dy || 0), dz = Number(p.dz || 0)
    const volume = (src.x2 - src.x1 + 1) * (src.y2 - src.y1 + 1) * (src.z2 - src.z1 + 1)
    if (volume > 1000000) throw new Error('复制区域超过 100 万方块，请缩小选区。')
    const dst = { x1: src.x1 + dx, y1: src.y1 + dy, z1: src.z1 + dz, x2: src.x2 + dx, y2: src.y2 + dy, z2: src.z2 + dz }
    return this.editWithTx('复制区域', dst, async () => {
      const changes = []; let changed = 0
      for (let z = src.z1; z <= src.z2; z++) for (let x = src.x1; x <= src.x2; x++) for (let y = src.y1; y <= src.y2; y++) {
        const b = await this.raw.getBlock(x, y, z)
        if (!p.includeAir && b.id === 0) continue
        changes.push({ x: x + dx, y: y + dy, z: z + dz, id: b.id, data: b.data })
        if (changes.length >= 60000) changed += await this.raw.editBlocks(changes.splice(0))
      }
      if (changes.length) changed += await this.raw.editBlocks(changes)
      return { ok: true, changed, source: src, destination: dst }
    }, p.allowProtected)
  }
  async createWall (p) {
    const x1 = Number(p.x1), z1 = Number(p.z1), x2 = Number(p.x2), z2 = Number(p.z2), y = Number(p.y), height = clamp(Number(p.height || 6), 1, 80), thickness = clamp(Number(p.thickness || 1), 1, 8)
    const mat = this.blockSpec(p.block || 'stonebrick')
    const box = normalizeBox({ x1: Math.min(x1, x2) - thickness, x2: Math.max(x1, x2) + thickness, z1: Math.min(z1, z2) - thickness, z2: Math.max(z1, z2) + thickness, y1: y, y2: y + height - 1 })
    return this.editWithTx('创建墙体', box, async () => {
      const changes = []; const steps = Math.max(Math.abs(x2 - x1), Math.abs(z2 - z1), 1)
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, x = Math.round(x1 + (x2 - x1) * t), z = Math.round(z1 + (z2 - z1) * t)
        for (let w = -Math.floor((thickness - 1) / 2); w <= Math.floor(thickness / 2); w++) for (let yy = y; yy < y + height; yy++) changes.push({ x: Math.abs(x2 - x1) >= Math.abs(z2 - z1) ? x : x + w, z: Math.abs(x2 - x1) >= Math.abs(z2 - z1) ? z + w : z, y: yy, ...mat })
      }
      return { ok: true, changed: await this.raw.editBlocks(changes) }
    }, p.allowProtected)
  }
  async createFloor (p) {
    const y = Number(p.y), mat = this.blockSpec(p.block || 'stonebrick')
    return this.fill({ ...p, y1: y, y2: y, block: mat })
  }
  async createPillar (p) {
    const radius = clamp(Number(p.radius || 0), 0, 5), height = clamp(Number(p.height || 8), 1, 120), mat = this.blockSpec(p.block || 'stonebrick')
    const box = { x1: p.x - radius, x2: p.x + radius, z1: p.z - radius, z2: p.z + radius, y1: p.y, y2: Number(p.y) + height - 1 }
    return this.editWithTx('创建立柱', box, async () => {
      const c = []
      for (let y = Number(p.y); y < Number(p.y) + height; y++) for (let z = -radius; z <= radius; z++) for (let x = -radius; x <= radius; x++) if (radius === 0 || x * x + z * z <= radius * radius + 0.5) c.push({ x: Number(p.x) + x, y, z: Number(p.z) + z, ...mat })
      return { ok: true, changed: await this.raw.editBlocks(c) }
    }, p.allowProtected)
  }
  async createGableRoof (p) {
    const x1 = Math.min(Number(p.x1), Number(p.x2)), x2 = Math.max(Number(p.x1), Number(p.x2)), z1 = Math.min(Number(p.z1), Number(p.z2)), z2 = Math.max(Number(p.z1), Number(p.z2)), baseY = Number(p.y)
    const mat = this.blockSpec(p.block || { id: 112, data: 0 }), overhang = clamp(Number(p.overhang || 1), 0, 4), alongX = (x2 - x1) >= (z2 - z1)
    const box = { x1: x1 - overhang, x2: x2 + overhang, z1: z1 - overhang, z2: z2 + overhang, y1: baseY, y2: baseY + Math.ceil((alongX ? z2 - z1 : x2 - x1) / 2) + 3 }
    return this.editWithTx('创建人字屋顶', box, async () => {
      const c = []
      if (alongX) {
        const mid = (z1 + z2) / 2
        for (let z = z1 - overhang; z <= z2 + overhang; z++) { const rise = Math.max(0, Math.round((z2 - z1) / 2 - Math.abs(z - mid))); const y = baseY + rise; for (let x = x1 - overhang; x <= x2 + overhang; x++) c.push({ x, y, z, ...mat }) }
      } else {
        const mid = (x1 + x2) / 2
        for (let x = x1 - overhang; x <= x2 + overhang; x++) { const rise = Math.max(0, Math.round((x2 - x1) / 2 - Math.abs(x - mid))); const y = baseY + rise; for (let z = z1 - overhang; z <= z2 + overhang; z++) c.push({ x, y, z, ...mat }) }
      }
      return { ok: true, changed: await this.raw.editBlocks(c), peakY: box.y2 }
    }, p.allowProtected)
  }
  async createTower (p) {
    const x0 = Number(p.x || 0), y0 = Number(p.y ?? 64), z0 = Number(p.z || 0), radius = clamp(Number(p.radius || 6), 2, 30), height = clamp(Number(p.height || 24), 4, 140)
    const thickness = clamp(Number(p.thickness || 1), 1, 4), wall = this.blockSpec(p.block || 'stonebrick'), floor = this.blockSpec(p.floorBlock || 'planks')
    const box = { x1: x0 - radius - 1, x2: x0 + radius + 1, z1: z0 - radius - 1, z2: z0 + radius + 1, y1: y0, y2: y0 + height + 3 }
    return this.editWithTx('创建塔楼', box, async () => {
      const changes = []
      for (let y = y0; y < y0 + height; y++) {
        for (let z = -radius; z <= radius; z++) for (let x = -radius; x <= radius; x++) {
          const d = Math.hypot(x, z)
          if (d <= radius + 0.35 && d >= radius - thickness - 0.35) changes.push({ x: x0 + x, y, z: z0 + z, ...wall })
          if ((y === y0 || ((y - y0) % 7 === 0)) && d < radius - thickness) changes.push({ x: x0 + x, y, z: z0 + z, ...floor })
        }
      }
      const battlementY = y0 + height
      for (let z = -radius; z <= radius; z++) for (let x = -radius; x <= radius; x++) {
        const d = Math.hypot(x, z)
        if (d <= radius + 0.35 && d >= radius - 1.2 && ((x + z) & 1) === 0) changes.push({ x: x0 + x, y: battlementY, z: z0 + z, ...wall })
      }
      let changed = 0; while (changes.length) changed += await this.raw.editBlocks(changes.splice(0, 60000))
      return { ok: true, changed, radius, height }
    }, p.allowProtected)
  }
  async createBridge (p) {
    const x1 = Number(p.x1), y1 = Number(p.y1), z1 = Number(p.z1), x2 = Number(p.x2), y2 = Number(p.y2 ?? y1), z2 = Number(p.z2)
    const width = clamp(Number(p.width || 5), 1, 18), mat = this.blockSpec(p.block || 'planks'), rail = this.blockSpec(p.railBlock || 'fence'), support = this.blockSpec(p.supportBlock || 'stonebrick')
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(z2 - z1), 1)
    const box = normalizeBox({ x1: Math.min(x1,x2)-width, x2: Math.max(x1,x2)+width, z1: Math.min(z1,z2)-width, z2: Math.max(z1,z2)+width, y1: Math.min(y1,y2)-2, y2: Math.max(y1,y2)+8 })
    return this.editWithTx('创建桥梁', box, async () => {
      const changes=[]; const alongX = Math.abs(x2-x1) >= Math.abs(z2-z1)
      for (let i=0;i<=steps;i++) {
        const t=i/steps, cx=Math.round(x1+(x2-x1)*t), cz=Math.round(z1+(z2-z1)*t), cy=Math.round(y1+(y2-y1)*t + Math.sin(Math.PI*t)*Number(p.arch||0))
        for (let w=-Math.floor(width/2); w<=Math.floor(width/2); w++) {
          const x=alongX?cx:cx+w, z=alongX?cz+w:cz
          changes.push({x,y:cy,z,...mat})
          if (Math.abs(w)===Math.floor(width/2)) changes.push({x,y:cy+1,z,...rail})
        }
        if (p.supports !== false && i % Math.max(6, Number(p.supportEvery||12)) === 0) {
          const top=await this.raw.getHighest(cx,cz)
          for (let yy=top.y+1; yy<cy; yy++) changes.push({x:cx,y:yy,z:cz,...support})
        }
      }
      let changed=0; while(changes.length) changed += await this.raw.editBlocks(changes.splice(0,60000))
      return {ok:true,changed,width,steps}
    }, p.allowProtected)
  }
  async createBossArena (p) {
    const x0=Number(p.x||0), z0=Number(p.z||0), radius=clamp(Number(p.radius||28),6,120), y=clamp(Number(p.y||64),2,250)
    const floor=this.blockSpec(p.floorBlock||'stonebrick'), rim=this.blockSpec(p.rimBlock||'cobblestone')
    const box=boxFromCenter(x0,z0,radius+4,0,255)
    return this.editWithTx('创建 Boss 场地', box, async()=>{
      let changed=0
      changed += await this.raw.editColumns(box, async({x,z,getTop,set})=>{
        const d=Math.hypot(x-x0,z-z0); if(d>radius+3)return
        const old=getTop().y
        if(d<=radius){
          if(old>y) for(let yy=old;yy>y;yy--) set(yy,0,0)
          else if(old<y) for(let yy=old+1;yy<y;yy++) set(yy,3,0)
          set(y,floor.id,floor.data)
        } else if(d<=radius+2){ set(Math.max(old,y),rim.id,rim.data) }
      },false)
      return {ok:true,changed,center:{x:x0,y,z:z0},radius}
    },p.allowProtected)
  }
  async placeSchematic (p) {
    if(p.includeAir!==undefined&&typeof p.includeAir!=='boolean')throw new Error('includeAir 须为布尔值')
    const {readLegacySchematic}=require('./legacy-schematic.cjs')
    const {levelValue}=require('./raw-world.cjs')
    const schem=readLegacySchematic(p.path),at={x:Number(p.x??0),y:Number(p.y??64),z:Number(p.z??0)}
    const box=normalizeBox({x1:at.x,x2:at.x+schem.width-1,y1:at.y,y2:at.y+schem.height-1,z1:at.z,z2:at.z+schem.length-1})
    if((floorDiv(box.x2,512)-floorDiv(box.x1,512)+1)*(floorDiv(box.z2,512)-floorDiv(box.z1,512)+1)>64)throw new Error('蓝图跨越超过 64 个 Region，请拆分导入')
    const idx=(x,y,z)=>((y-at.y)*schem.length+z-at.z)*schem.width+x-at.x
    const selected=(x,y,z)=>x>=box.x1&&x<=box.x2&&y>=box.y1&&y<=box.y2&&z>=box.z1&&z<=box.z2&&(p.includeAir||schem.blocks[idx(x,y,z)]!==0)
    return this.editWithTx(p.name||'导入蓝图',box,async()=>{
      let changed=0,verified=0,done=0
      const total=(floorDiv(box.x2,16)-floorDiv(box.x1,16)+1)*(floorDiv(box.z2,16)-floorDiv(box.z1,16)+1)
      for(let cz=floorDiv(box.z1,16);cz<=floorDiv(box.z2,16);cz++)for(let cx=floorDiv(box.x1,16);cx<=floorDiv(box.x2,16);cx++){
        this.checkCanceled?.()
        const raw=await this.raw.loadRaw(cx,cz,true),lvl=levelValue(raw)
        const x1=Math.max(box.x1,cx*16),x2=Math.min(box.x2,cx*16+15),z1=Math.max(box.z1,cz*16),z2=Math.min(box.z2,cz*16+15)
        for(let z=z1;z<=z2;z++)for(let x=x1;x<=x2;x++){
          for(let y=box.y1;y<=box.y2;y++){
            const i=idx(x,y,z),id=schem.blocks[i],data=schem.data[i];if(!p.includeAir&&!id)continue
            const old=getBlockFromRaw(raw,mod(x,16),y,mod(z,16));if(old.id!==id||old.data!==data){setBlockInRaw(raw,mod(x,16),y,mod(z,16),id,data);changed++}
          }
          updateHeightMap(raw,mod(x,16),mod(z,16),highestBlockRaw(raw,mod(x,16),mod(z,16)).y)
        }
        const oldTiles=lvl.TileEntities?.value?.value||[]
        lvl.TileEntities={type:'list',value:{type:'compound',value:oldTiles.filter(t=>!selected(t.x?.value,t.y?.value,t.z?.value))}}
        for(const tile of schem.tiles){const x=at.x+tile.x.value,y=at.y+tile.y.value,z=at.z+tile.z.value;if(floorDiv(x,16)===cx&&floorDiv(z,16)===cz&&selected(x,y,z)){const t=structuredClone(tile);t.x.value=x;t.y.value=y;t.z.value=z;lvl.TileEntities.value.value.push(t)}}
        await this.raw.saveRaw(cx,cz,raw)
        const saved=await this.raw.loadRaw(cx,cz,false)
        for(let z=z1;z<=z2;z++)for(let x=x1;x<=x2;x++)for(let y=box.y1;y<=box.y2;y++)if(selected(x,y,z)){
          const i=idx(x,y,z),b=getBlockFromRaw(saved,mod(x,16),y,mod(z,16));if(b.id!==schem.blocks[i]||b.data!==schem.data[i])throw new Error('写入核对失败：'+[x,y,z]);verified++
        }
        this.progress?.({done:++done,total,changed,verified,phase:'写入并核对'})
        await new Promise(r=>setImmediate(r))
      }
      this.checkCanceled?.()
      return {ok:true,changed,verified,bounds:box,size:{x:schem.width,y:schem.height,z:schem.length},version:VERSION}
    },p.allowProtected)
  }
  async exportLegacySchematic (p) {
    if (!p.path) throw new Error('缺少导出路径')
    const box = normalizeBox(p)
    return exportBoxToLegacySchematic(this.raw, box, p.path.endsWith('.schematic') ? p.path : p.path + '.schematic')
  }
  async materialStats (p) {
    const box = normalizeBox(p)
    const volume = (box.x2 - box.x1 + 1) * (box.y2 - box.y1 + 1) * (box.z2 - box.z1 + 1)
    if (volume > 1_500_000) throw new Error('材料统计选区超过 150 万方块，请缩小选区。')
    const counts = new Map()
    for (let z = box.z1; z <= box.z2; z++) for (let x = box.x1; x <= box.x2; x++) for (let y = box.y1; y <= box.y2; y++) {
      const b = await this.raw.getBlock(x, y, z); if (b.id === 0) continue
      const key = `${b.id}:${b.data}`; counts.set(key, (counts.get(key) || 0) + 1)
    }
    return [...counts.entries()].map(([key, count]) => { const [id, data] = key.split(':').map(Number); const info = this.mcData.blocks[id]; return { id, data, name: info?.displayName || info?.name || `方块 ${key}`, count } }).sort((a, b) => b.count - a.count)
  }
  async addMarker (p) {
    await this.project.ensure(); const data = await this.project.get(); const marker = { id: `m-${Date.now()}`, name: p.name || '标记', type: p.type || '普通', x: Number(p.x || 0), y: Number(p.y ?? 64), z: Number(p.z || 0), note: p.note || '' }
    data.markers = [...(data.markers || []), marker]; await this.project.update({ markers: data.markers }); return { ok: true, marker }
  }
  async addProtectedRegion (p) {
    await this.project.ensure(); const data = await this.project.get(); const box = normalizeBox(p); const item = { id: `p-${Date.now()}`, name: p.name || '保护区域', ...box, enabled: true }
    data.protectedRegions = [...(data.protectedRegions || []), item]; await this.project.update({ protectedRegions: data.protectedRegions }); return { ok: true, region: item }
  }
  async createBuildingPlan (p) {
    await this.project.ensure(); const data = await this.project.get(); const plan = { id: `b-${Date.now()}`, name: p.name || '未命名建筑', concept: p.concept || '', style: p.style || '', tags: p.tags || [], bounds: p.bounds || null, parts: [], createdAt: new Date().toISOString() }
    data.buildingPlans = [...(data.buildingPlans || []), plan]; await this.project.update({ buildingPlans: data.buildingPlans }); return { ok: true, plan }
  }
  async updateBuildingPlan (p) {
    await this.project.ensure(); const data = await this.project.get(); const plan = (data.buildingPlans || []).find(v => v.id === p.planId || v.name === p.planId)
    if (!plan) throw new Error('没有找到建筑方案')
    for (const key of ['name','concept','style','bounds']) if (p[key] !== undefined) plan[key] = p[key]
    if (Array.isArray(p.tags)) plan.tags = p.tags
    await this.project.update({ buildingPlans: data.buildingPlans })
    return { ok: true, plan }
  }
  async addBuildingPart (p) {
    await this.project.ensure(); const data = await this.project.get(); const plan = (data.buildingPlans || []).find(v => v.id === p.planId || v.name === p.planId)
    if (!plan) throw new Error('没有找到建筑方案')
    const part = { id: `part-${Date.now()}`, name: p.name || '区域', description: p.description || '', bounds: p.bounds || null, visible: true }
    plan.parts.push(part); await this.project.update({ buildingPlans: data.buildingPlans }); return { ok: true, part }
  }
  async rollbackTransaction(){await this.raw.close();try{return {ok:true,transaction:this.tx.rollback()}}finally{this.raw=new RawWorld(this.worldPath,this.dimension,VERSION)}}
  async redo () { await this.raw.close();try{const tx=this.tx.redoLast();return tx?{ok:true,transaction:tx}:{ok:false,message:'没有可重做的历史'}}finally{this.raw=new RawWorld(this.worldPath,this.dimension,VERSION)} }
  async undo () { await this.raw.close();try{const tx = this.tx.undoLast();return tx ? { ok: true, transaction: tx } : { ok: false, message: '没有可撤销的历史事务' }}finally{this.raw=new RawWorld(this.worldPath,this.dimension,VERSION)} }
}

module.exports = { WorldEngine, dimensionRegionPath }
