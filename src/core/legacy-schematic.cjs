'use strict'
const fs = require('fs')
const zlib = require('zlib')
const nbt = require('prismarine-nbt')

function readLegacySchematic(file){
  if(fs.statSync(file).size>64*1024*1024)throw new Error('蓝图文件超过 64 MB')
  const input=fs.readFileSync(file),bytes=input[0]===31&&input[1]===139?zlib.gunzipSync(input,{maxOutputLength:96*1024*1024}):input
  const raw=nbt.parseUncompressed(bytes),s=nbt.simplify(raw)
  const width=s.Width,height=s.Height,length=s.Length,count=width*height*length
  if(![width,height,length].every(n=>Number.isInteger(n)&&n>0)||count>8000000||height>256)throw new Error('蓝图尺寸无效或超过 800 万格')
  if(!s.Blocks||!s.Data||s.Blocks.length!==count||s.Data.length!==count)throw new Error('需要 Minecraft 1.12.2 MCEdit Alpha 格式蓝图（Blocks/Data）')
  if(s.AddBlocks&&s.AddBlocks.length!==Math.ceil(count/2))throw new Error('蓝图 AddBlocks 长度错误')
  if(s.Data.some(v=>v<0||v>15))throw new Error('蓝图 Data 须为 0–15 的 1.12.2 状态')
  if(s.Entities?.length)throw new Error('蓝图含实体，当前导入只支持方块和方块实体；请先单独保存并移除实体。')
  const blocks=Uint16Array.from(s.Blocks,(b,i)=>(b&255)|(s.AddBlocks?(((s.AddBlocks[i>>1]&255)>>((i&1)*4)&15)<<8):0)),data=Uint8Array.from(s.Data,b=>b&15)
  const mc=require('minecraft-data')('1.12.2')
  for(const id of new Set(blocks))if(!mc.blocks[id])throw new Error('蓝图含未识别的 1.12.2 方块 ID：'+id)
  const tiles=raw.value.TileEntities?.value?.value||[]
  for(const t of tiles){const p=[t.x?.value,t.y?.value,t.z?.value];if(!p.every(Number.isInteger)||p.some((v,i)=>v<0||v>=[width,height,length][i]))throw new Error('方块实体坐标无效')}
  return {width,height,length,blocks,data,tiles,count}
}

const TE = new TextEncoder()
class Writer {
  constructor () { this.a = [] }
  u8 (v) { this.a.push(v & 255) }
  i16 (v) { this.a.push((v >> 8) & 255, v & 255) }
  i32 (v) { this.a.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255) }
  i64 (v) { let b = BigInt(Math.trunc(v || 0)); if (b < 0) b = (1n << 64n) + b; for (let s = 56n; s >= 0n; s -= 8n) this.a.push(Number((b >> s) & 255n)) }
  raw (b) { for (const v of b) this.a.push(v & 255) }
  str (s) { const b = TE.encode(String(s)); this.i16(b.length); this.raw(b) }
  named (type, name, fn) { this.u8(type); this.str(name); fn(this) }
  end () { this.u8(0) }
  bytes () { return Buffer.from(this.a) }
}
const N = { BYTE: 1, SHORT: 2, INT: 3, LONG: 4, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10 }
const tag = {
  short: (w, n, v) => w.named(N.SHORT, n, x => x.i16(v)),
  int: (w, n, v) => w.named(N.INT, n, x => x.i32(v)),
  string: (w, n, v) => w.named(N.STRING, n, x => x.str(v)),
  bytes: (w, n, v) => w.named(N.BYTE_ARRAY, n, x => { x.i32(v.length); x.raw(v) }),
  emptyCompoundList: (w, n) => w.named(N.LIST, n, x => { x.u8(N.COMPOUND); x.i32(0) })
}
function setNibble (arr, idx, val) { const p = idx >> 1; const old = arr[p] || 0; arr[p] = (idx & 1) ? ((old & 0x0f) | ((val & 15) << 4)) : ((old & 0xf0) | (val & 15)) }
function writeLegacySchematic (spec) {
  const w = new Writer(); w.u8(N.COMPOUND); w.str('Schematic')
  tag.short(w, 'Width', spec.width); tag.short(w, 'Height', spec.height); tag.short(w, 'Length', spec.length)
  tag.string(w, 'Materials', 'Alpha'); tag.bytes(w, 'Blocks', spec.blocks); tag.bytes(w, 'Data', spec.data)
  if (spec.addBlocks && spec.addBlocks.some(v => v)) tag.bytes(w, 'AddBlocks', spec.addBlocks)
  tag.emptyCompoundList(w, 'Entities'); tag.emptyCompoundList(w, 'TileEntities')
  tag.int(w, 'WEOriginX', spec.originX || 0); tag.int(w, 'WEOriginY', spec.originY || 0); tag.int(w, 'WEOriginZ', spec.originZ || 0)
  tag.int(w, 'WEOffsetX', 0); tag.int(w, 'WEOffsetY', 0); tag.int(w, 'WEOffsetZ', 0)
  w.end(); return zlib.gzipSync(w.bytes())
}
async function exportBoxToLegacySchematic (rawWorld, box, outPath) {
  const x1 = Math.min(box.x1, box.x2), x2 = Math.max(box.x1, box.x2)
  const y1 = Math.min(box.y1, box.y2), y2 = Math.max(box.y1, box.y2)
  const z1 = Math.min(box.z1, box.z2), z2 = Math.max(box.z1, box.z2)
  const width = x2 - x1 + 1, height = y2 - y1 + 1, length = z2 - z1 + 1
  const count = width * height * length
  if (count > 8_000_000) throw new Error('选区超过 800 万方块，请缩小后再导出 schematic。')
  const blocks = Buffer.alloc(count), data = Buffer.alloc(count), addBlocks = Buffer.alloc(Math.ceil(count / 2))
  let i = 0
  for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) for (let x = x1; x <= x2; x++) {
    const b = await rawWorld.getBlock(x, y, z)
    blocks[i] = b.id & 255; data[i] = b.data & 15; setNibble(addBlocks, i, (b.id >> 8) & 15); i++
  }
  const buf = writeLegacySchematic({ width, height, length, blocks, data, addBlocks, originX: x1, originY: y1, originZ: z1 })
  fs.writeFileSync(outPath, buf)
  return { ok: true, path: outPath, width, height, length, blocks: count }
}
module.exports = { writeLegacySchematic, exportBoxToLegacySchematic, readLegacySchematic }
