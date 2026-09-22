'use strict'
const fs = require('fs'), path = require('path'), os = require('os')
const { spawn } = require('child_process')
function runtimeBase(userData){
  const file=path.join(userData,'mcp-location.json')
  if(fs.existsSync(file)){
    const saved=JSON.parse(fs.readFileSync(file,'utf8'))
    if(!path.isAbsolute(saved.root||''))throw new Error('MCP 安装目录设置无效，请重新选择位置')
    return saved.root
  }
  throw new Error('请先选择 MCP 安装位置')
}
function saveLocation(userData,root){
  fs.mkdirSync(userData,{recursive:true})
  const file=path.join(userData,'mcp-location.json'),temp=file+'.tmp'
  fs.writeFileSync(temp,JSON.stringify({root},null,2));fs.renameSync(temp,file)
}
function snippet(command, server) {
  return `[mcp_servers.zx-engineering]\ncommand = ${JSON.stringify(command)}\nargs = [${JSON.stringify(server)}]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\nenabled = true\nstartup_timeout_sec = 30\ntool_timeout_sec = 180\n`
}
function mergeConfig(original, section) {
  // Refuse uncommon syntax rather than risk editing a multiline string.
  if (original.includes('"""') || original.includes("'''")) throw new Error('配置包含多行字符串，请复制配置手动接入；原配置未修改。')
  let skip = false
  const kept = []
  for (const line of original.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) {
      const m = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)
      const header = m?.[1].replace(/\s/g, '').replace(/["']/g, '')
      skip = header === 'mcp_servers.zx-engineering' || header?.startsWith('mcp_servers.zx-engineering.')
    }
    if (!skip) kept.push(line)
  }
  const rest = kept.join('\n').trimEnd()
  if (/^\s*(?:mcp_servers|["']?zx-engineering["']?)\s*=/m.test(rest)) throw new Error('检测到内联 MCP 配置，请手动接入；原配置未修改。')
  return rest + (rest ? '\n\n' : '') + section
}
function probe(command, server) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [server], { windowsHide:true, env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}, stdio:['pipe','pipe','pipe'] })
    let buffer='', errors='', done=false
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);const end=()=>error?reject(error):resolve(value);if(child.pid&&child.exitCode===null){child.once('exit',end);child.kill()}else end()}
    const timer=setTimeout(()=>finish(new Error('MCP 启动检测超时，配置未修改。')),30000)
    child.on('error',e=>finish(e));child.stdin.on('error',e=>finish(e))
    child.stderr.on('data',d=>{errors=(errors+d).slice(-3000)})
    child.on('exit',()=>finish(new Error('MCP 启动失败：'+errors)))
    const send=data=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...data})+'\n')
    child.stdout.on('data',data=>{
      buffer+=data;let p
      while((p=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,p);buffer=buffer.slice(p+1)
        let r;try{r=JSON.parse(line)}catch{continue}
        if(r.error)return finish(new Error(r.error.message))
        if(r.id===1){send({method:'notifications/initialized'});send({id:2,method:'tools/list',params:{}})}
        if(r.id===2){const names=r.result?.tools?.map(t=>t.name)||[];if(!names.includes('zx_apply_blocks'))return finish(new Error('建造工具缺失'));finish(null,names.length)}
      }
    })
    send({id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'ZX一键接入检测',version:'1'}}})
  })
}
async function copyDirectory(source,target){
  await fs.promises.mkdir(target,{recursive:true})
  for(const item of await fs.promises.readdir(source,{withFileTypes:true})){
    const from=path.join(source,item.name),to=path.join(target,item.name)
    if(item.isDirectory())await copyDirectory(from,to)
    else await fs.promises.copyFile(from,to)
  }
}
async function install({appPath,execPath,version,runtimeBase,configHome}){
  if(!runtimeBase||!path.isAbsolute(runtimeBase))throw new Error('请先选择 MCP 安装位置')
  const root=runtimeBase
  require('./cache-manager.cjs').safePath(root)
  const dir=path.join(root,'current'),previous=path.join(root,'previous'),command=path.join(dir,path.basename(execPath)),server=path.join(dir,'app','mcp','server.mjs')
  const removeOwned=async target=>{
    if(![dir,previous].includes(target)&&!path.basename(target).startsWith('.install-'))throw new Error('非托管目录，拒绝清理')
    if(path.dirname(path.resolve(target))!==path.resolve(root))throw new Error('目录越界')
    require('./cache-manager.cjs').safePath(target)
    if(fs.existsSync(target))await fs.promises.rm(target,{recursive:true,force:false})
  }
  let switched=false,staging=null
  const rollback=async()=>{if(switched){await removeOwned(dir);if(fs.existsSync(previous))await fs.promises.rename(previous,dir)}}
  const configPath=path.join(configHome||process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'config.toml')
  const original=fs.existsSync(configPath)?fs.readFileSync(configPath,'utf8'):''
  const section=snippet(command,server),updated=mergeConfig(original,section)
  let installed=null;try{installed=JSON.parse(fs.readFileSync(path.join(dir,'ready.json'),'utf8'))}catch{}
  if(fs.existsSync(dir)&&!installed)throw new Error('current 目录不是完整安装，请先检查其中内容；未覆盖文件')
  if(installed?.version!==version){
    if(fs.existsSync(previous))throw new Error('上次更新仍有 previous 备份，请关闭 Codex 并处理该备份后重试，避免累积安装')
    await fs.promises.mkdir(root,{recursive:true})
    staging=await fs.promises.mkdtemp(path.join(root,'.install-'))
    try{
    // Reuse the bundled runtime, without downloads or a system Node installation.
    for(const item of await fs.promises.readdir(path.dirname(execPath),{withFileTypes:true})){
      if(item.isFile())await fs.promises.copyFile(path.join(path.dirname(execPath),item.name),path.join(staging,item.name))
    }
    await copyDirectory(appPath,path.join(staging,'app'))
    await fs.promises.writeFile(path.join(staging,'ready.json'),JSON.stringify({version}))
    await probe(path.join(staging,path.basename(execPath)),path.join(staging,'app','mcp','server.mjs'))
    // Refuse replacement of a running runtime; never terminate the user's MCP.
    if(fs.existsSync(command)){const handle=await fs.promises.open(command,'r+');await handle.close()}
    if(fs.existsSync(dir))await fs.promises.rename(dir,previous)
    try{await fs.promises.rename(staging,dir)}catch(e){if(fs.existsSync(previous))await fs.promises.rename(previous,dir);throw e}
    switched=true;staging=null
    }catch(e){if(staging)await removeOwned(staging).catch(()=>{});throw new Error('MCP 更新未完成，请关闭使用中的 MCP 后重试：'+e.message)}
  }
  try{
  const toolCount=await probe(command,server)
  await fs.promises.mkdir(path.dirname(configPath),{recursive:true})
  const current=fs.existsSync(configPath)?fs.readFileSync(configPath,'utf8'):''
  if(current!==original)throw new Error('配置刚被其他程序修改，请重新点击接入。')
  let backup=null
  if(updated!==original){
    if(fs.existsSync(configPath)){backup=configPath+'.zx-backup-'+Date.now();await fs.promises.copyFile(configPath,backup,fs.constants.COPYFILE_EXCL)}
    const temp=configPath+'.zx-'+process.pid+'.tmp'
    await fs.promises.writeFile(temp,updated,{flag:'wx'})
    await fs.promises.rename(temp,configPath)
  }
  let cleanupPending=false
  if(switched&&fs.existsSync(previous)){try{await removeOwned(previous)}catch{cleanupPending=true}}
  return {ok:true,toolCount,configPath,backup,command,server,snippet:section,cleanupPending}
  }catch(e){await rollback();throw e}
}
module.exports={install,mergeConfig,snippet,probe,runtimeBase,saveLocation}
