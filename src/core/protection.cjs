'use strict'
const fs = require('fs')
const path = require('path')

function normalizeBox (b) {
  const values = [b.x1,b.x2,b.z1,b.z2,b.y1 ?? 0,b.y2 ?? 255].map(Number)
  if (!values.every(Number.isInteger) || values.slice(0,4).some(v=>Math.abs(v)>29999984) || values.slice(4).some(v=>v<0||v>255)) throw new Error('选区坐标须为整数，Y 范围为 0–255')
  return {
    x1: Math.min(Number(b.x1), Number(b.x2)), y1: Math.min(Number(b.y1 ?? 0), Number(b.y2 ?? 255)), z1: Math.min(Number(b.z1), Number(b.z2)),
    x2: Math.max(Number(b.x1), Number(b.x2)), y2: Math.max(Number(b.y1 ?? 0), Number(b.y2 ?? 255)), z2: Math.max(Number(b.z1), Number(b.z2))
  }
}
function overlap (a, b) { return a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1 && a.z1 <= b.z2 && a.z2 >= b.z1 }
function getProtected (worldPath) {
  const f = path.join(worldPath, '.zxproject', 'project.json')
  if (!fs.existsSync(f)) return []
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).protectedRegions || [] } catch { throw new Error('保护区配置损坏，已停止修改，请恢复项目配置。') }
}
function assertAllowed (worldPath, box, allowProtected = false) {
  if (allowProtected) return
  const b = normalizeBox(box)
  const hit = getProtected(worldPath).find(r => r.enabled !== false && overlap(b, normalizeBox(r)))
  if (hit) throw new Error(`操作与保护区域「${hit.name || '未命名保护区'}」重叠。若确实要修改，请先在照献工程里解除保护。`)
}
module.exports = { normalizeBox, overlap, getProtected, assertAllowed }
