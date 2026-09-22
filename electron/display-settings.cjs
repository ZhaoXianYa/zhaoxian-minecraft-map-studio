'use strict'
const fs = require('fs'), path = require('path')
const rules = {
  viewDistance: v => Number.isInteger(v) && v >= 1 && v <= 32,
  overviewSample: v => [0,1,2,4,8,16,32].includes(v),
  renderScale: v => [.75,1,1.25].includes(v),
  panSensitivity: v => Number.isFinite(v) && v >= .05 && v <= 3,
  showGrid: v => typeof v === 'boolean', showBarriers: v => typeof v === 'boolean',
  resourcePackPath: v => typeof v === 'string' && !!v.trim()
}
function read(file) { try { return select(JSON.parse(fs.readFileSync(file,'utf8'))) } catch(e) { if(e.code !== 'ENOENT') console.warn('读取显示设置失败：',e.message); return {} } }
function select(ui = {}) { return Object.fromEntries(Object.entries(ui).filter(([k,v]) => rules[k]?.(v))) }
function save(file, ui) {
  const next = {...read(file), ...select(ui)}
  fs.mkdirSync(path.dirname(file),{recursive:true})
  fs.writeFileSync(file+'.tmp',JSON.stringify(next,null,2)); fs.renameSync(file+'.tmp',file)
  return next
}
async function apply(file, store) {
  const p = await store.get(), saved = read(file)
  // Seed from the last world once; later worlds inherit the user's choices.
  const ui = save(file,{...select(p.ui),...saved})
  return store.update({ui})
}
module.exports = {read,save,apply}
