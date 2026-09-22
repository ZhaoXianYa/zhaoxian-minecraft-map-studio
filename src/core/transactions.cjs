'use strict'
const fs = require('fs')
const path = require('path')

function regionCoord (v) { return Math.floor(v / 512) }
function regionName (rx, rz) { return `r.${rx}.${rz}.mca` }

class TransactionManager {
  constructor (worldPath, dimension, regionPath) {
    this.worldPath = worldPath
    this.dimension = dimension
    this.regionPath = regionPath
    this.projectDir = path.join(worldPath, '.zxproject')
    this.historyDir = path.join(this.projectDir, 'history')
    this.activeFile = path.join(this.projectDir, 'active-transaction.json')
    fs.mkdirSync(this.historyDir, { recursive: true })
  }
  active () { return this._readActive() }
  _readActive () {
    if (!fs.existsSync(this.activeFile)) return null
    const tx = JSON.parse(fs.readFileSync(this.activeFile, 'utf8'))
    if(tx.dimension!==this.dimension)throw new Error('另一个维度存在未结束事务，请先提交或回滚。')
    return this.resolve(tx)
  }
  resolve(tx){
    if(!/^[0-9]+-[a-z0-9]+$/.test(tx.id))throw new Error('事务编号无效')
    tx.dir=path.join(this.historyDir,tx.id)
    if((tx.files||[]).some(f=>!/^r\.-?\d+\.-?\d+\.mca$/.test(f)))throw new Error('事务区域文件名无效')
    return tx
  }
  begin (name = '编辑') {
    const existing = this._readActive()
    if (existing) return existing
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const dir = path.join(this.historyDir, id)
    fs.mkdirSync(path.join(dir, 'regions'), { recursive: true })
    const tx = { id, name, dimension: this.dimension, createdAt: new Date().toISOString(), dir, files: [], committed: false }
    fs.writeFileSync(this.activeFile, JSON.stringify(tx, null, 2), 'utf8')
    return tx
  }
  backupBox (box) {
    const tx = this._readActive() || this.begin('自动编辑')
    const minRx = regionCoord(Math.min(box.x1, box.x2)); const maxRx = regionCoord(Math.max(box.x1, box.x2))
    const minRz = regionCoord(Math.min(box.z1, box.z2)); const maxRz = regionCoord(Math.max(box.z1, box.z2))
    const known = new Set(tx.files)
    for (let rz = minRz; rz <= maxRz; rz++) for (let rx = minRx; rx <= maxRx; rx++) {
      const name = regionName(rx, rz)
      if (known.has(name)) continue
      const src = path.join(this.regionPath, name)
      const dst = path.join(tx.dir, 'regions', name)
      if (fs.existsSync(src)) fs.copyFileSync(src, dst)
      else fs.writeFileSync(dst + '.missing', '')
      tx.files.push(name); known.add(name)
    }
    fs.writeFileSync(this.activeFile, JSON.stringify(tx, null, 2), 'utf8')
    return tx
  }
  record(box,changed){
    const tx=this._readActive();if(!tx)return
    tx.bounds=tx.bounds||{...box}
    for(const a of ['x','y','z']){tx.bounds[a+'1']=Math.min(tx.bounds[a+'1'],box[a+'1']);tx.bounds[a+'2']=Math.max(tx.bounds[a+'2'],box[a+'2'])}
    tx.changed=(tx.changed||0)+(Number(changed)||0)
    fs.writeFileSync(this.activeFile,JSON.stringify(tx,null,2))
  }
  snapshot(tx,folder){
    fs.mkdirSync(path.join(tx.dir,folder),{recursive:true})
    for(const f of tx.files){const src=path.join(this.regionPath,f),dst=path.join(tx.dir,folder,f);if(fs.existsSync(src)){fs.copyFileSync(src,dst);fs.rmSync(dst+'.missing',{force:true})}else{fs.writeFileSync(dst+'.missing','');fs.rmSync(dst,{force:true})}}
  }
  commit () {
    const tx = this._readActive()
    if (!tx) return null
    this.snapshot(tx,'after')
    for(const old of this.list().filter(t=>t.state==='undone')){old.state='superseded';fs.writeFileSync(path.join(old.dir,'transaction.json'),JSON.stringify(old,null,2))}
    tx.state='applied'
    tx.committed = true; tx.committedAt = new Date().toISOString()
    fs.writeFileSync(path.join(tx.dir, 'transaction.json'), JSON.stringify(tx, null, 2), 'utf8')
    fs.rmSync(this.activeFile, { force: true })
    this.trim(15)
    return tx
  }
  rollback () {
    const tx = this._readActive()
    if (!tx) return null
    this.restore(tx)
    fs.rmSync(this.activeFile, { force: true })
    return tx
  }
  restore (tx, folder='regions') {
    tx=this.resolve(tx)
    // Validate every snapshot before restoring any file.
    for(const name of tx.files)if(!fs.existsSync(path.join(tx.dir,folder,name))&&!fs.existsSync(path.join(tx.dir,folder,name+'.missing')))throw new Error('事务快照缺失，无法恢复：'+name)
    for (const name of tx.files || []) {
      const src = path.join(tx.dir, folder, name)
      const missing = src + '.missing'
      const dst = path.join(this.regionPath, name)
      if (fs.existsSync(src)) {fs.copyFileSync(src,dst+'.zx-restore');fs.renameSync(dst+'.zx-restore',dst)}
      else if (fs.existsSync(missing)) fs.rmSync(dst, { force: true })
    }
  }
  list () {
    if (!fs.existsSync(this.historyDir)) return []
    return fs.readdirSync(this.historyDir)
      .map(id => {
        if(!/^[0-9]+-[a-z0-9]+$/.test(id))return null
        const f = path.join(this.historyDir, id, 'transaction.json')
        if (!fs.existsSync(f)) return null
        try { const tx=this.resolve(JSON.parse(fs.readFileSync(f,'utf8')));return tx.dimension===this.dimension?{...tx,state:tx.state||'applied'}:null } catch { return null }
      }).filter(Boolean).sort((a, b) => String(b.committedAt).localeCompare(String(a.committedAt))||b.id.localeCompare(a.id))
  }
  undoLast () {
    if(this.active())throw new Error('请先提交或回滚当前事务')
    const list = this.list().filter(t=>t.state==='applied')
    if (!list.length) return null
    const tx = list[0]
    if(!fs.existsSync(path.join(tx.dir,'after')))this.snapshot(tx,'after')
    this.restore(tx);tx.state='undone';tx.undoneAt=new Date().toISOString()
    fs.writeFileSync(path.join(tx.dir,'transaction.json'),JSON.stringify(tx,null,2))
    return tx
  }
  redoLast(){
    if(this.active())throw new Error('请先提交或回滚当前事务')
    const tx=this.list().filter(t=>t.state==='undone').sort((a,b)=>a.committedAt.localeCompare(b.committedAt)||a.id.localeCompare(b.id))[0]
    if(!tx)return null
    this.restore(tx,'after');tx.state='applied';fs.writeFileSync(path.join(tx.dir,'transaction.json'),JSON.stringify(tx,null,2));return tx
  }
  trim (max) {
    const list = this.list()
    for (const tx of list.slice(max)) fs.rmSync(tx.dir, { recursive: true, force: true })
  }
}

module.exports = { TransactionManager, regionCoord, regionName }
