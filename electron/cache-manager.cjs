'use strict'
const fs=require('fs'),path=require('path')
const browserDirs=['Cache','Code Cache','GPUCache','DawnGraphiteCache','DawnWebGPUCache']
function safePath(target){
  let p=path.resolve(target)
  while(true){if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw new Error('缓存路径不能包含链接或目录联接');const parent=path.dirname(p);if(parent===p)break;p=parent}
  return path.resolve(target)
}
function prepare(parent){
  const root=safePath(path.join(parent,'ZX-Cache'))
  const marker=path.join(root,'.zx-cache-owner')
  if(fs.existsSync(root)&&!fs.existsSync(marker)&&fs.readdirSync(root).length)throw new Error('所选目录内的 ZX-Cache 已有其他文件，请换一个目录')
  fs.mkdirSync(root,{recursive:true});fs.writeFileSync(marker,'zx-engineering-cache-v1')
  return root
}
async function files(root,filter=()=>true){
  safePath(root);const out=[]
  async function walk(dir){
    let entries;try{entries=await fs.promises.readdir(dir,{withFileTypes:true})}catch(e){if(e.code==='ENOENT')return;throw e}
    for(const ent of entries){if(ent.isSymbolicLink())continue;const file=path.join(dir,ent.name);if(ent.isDirectory())await walk(file);else if(ent.isFile()&&filter(ent.name)){try{const s=await fs.promises.stat(file);out.push({file,size:s.size,time:s.mtimeMs})}catch(e){if(e.code!=='ENOENT')throw e}}}
  }
  await walk(root);return out
}
class CacheManager{
  constructor(userData,defaultParent){
    this.file=path.join(userData,'cache-settings.json');this.oldBrowser=userData
    this.settings={parent:defaultParent,auto:false,days:7,maxMB:1024}
    try{if(fs.existsSync(this.file))Object.assign(this.settings,JSON.parse(fs.readFileSync(this.file,'utf8')))}catch(e){this.warning='缓存设置读取失败，已使用默认位置：'+e.message}
    this.root=prepare(this.settings.parent)
  }
  save(patch){
    const s={...this.settings,...patch}
    if(!Number.isInteger(s.days)||s.days<1||s.days>365||!Number.isInteger(s.maxMB)||s.maxMB<64||s.maxMB>102400||typeof s.auto!=='boolean')throw new Error('天数须为 1–365，容量须为 64–102400 MB')
    prepare(s.parent);fs.mkdirSync(path.dirname(this.file),{recursive:true})
    const temp=this.file+'.tmp';fs.writeFileSync(temp,JSON.stringify(s,null,2));fs.renameSync(temp,this.file);this.settings=s
  }
  async entries(worldPath){
    const groups=[]
    groups.push({name:'地图预览',entries:await files(path.join(this.root,'maps'),n=>/^overview-.*\.json\.gz$/.test(n))})
    for(const base of [path.join(this.root,'browser'),this.oldBrowser])for(const name of browserDirs)groups.push({name:base===this.oldBrowser?'旧版界面缓存':'界面缓存',entries:await files(path.join(base,name))})
    if(worldPath)groups.push({name:'当前世界旧预览',entries:await files(path.join(worldPath,'.zxproject','cache'),n=>/^overview-.*\.json\.gz$/.test(n))})
    return groups
  }
  async info(worldPath){const groups=await this.entries(worldPath);return {root:this.root,warning:this.warning,settings:this.settings,restart: path.resolve(this.settings.parent,'ZX-Cache')!==this.root,total:groups.reduce((s,g)=>s+g.entries.reduce((n,f)=>n+f.size,0),0),groups:groups.map(g=>({name:g.name,bytes:g.entries.reduce((n,f)=>n+f.size,0)}))}}
  async clear(worldPath,automatic=false){
    const all=(await this.entries(worldPath)).flatMap(g=>g.entries).sort((a,b)=>a.time-b.time)
    let remaining=all.reduce((n,f)=>n+f.size,0),removed=0,failed=0
    for(const f of all){
      if(automatic&&Date.now()-f.time<this.settings.days*86400000&&remaining<=this.settings.maxMB*1048576)continue
      try{safePath(f.file);await fs.promises.unlink(f.file);remaining-=f.size;removed+=f.size}catch(e){if(e.code!=='ENOENT')failed++}
    }
    return {removed,failed}
  }
}
module.exports={CacheManager,prepare,safePath}
