'use strict'
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const http = require('http')
const { Worker } = require('worker_threads')
const { collectDetailBlocks } = require('../src/core/detail-mesh.cjs')
const { WorldEngine, dimensionRegionPath } = require('../src/core/world-engine.cjs')
const { ProjectStore, bridgeStatePath } = require('../src/core/project-store.cjs')
const { scanWorldOverview } = require('../src/core/overview-scan.cjs')
const { ResourcePack, detectVanilla112Jar } = require('../src/core/resource-pack.cjs')

const VERSION = '2.11.0'
const displaySettings = require('./display-settings.cjs')
const displayFile = () => path.join(app.getPath('userData'),'display-settings.json')
const { CacheManager } = require('./cache-manager.cjs')
let cacheManager
const requestedPort=Number(process.argv.find(a=>a.startsWith('--agent-port='))?.split('=')[1]||43927)
const BRIDGE_PORT=Number.isInteger(requestedPort)&&requestedPort>=1024&&requestedPort<=65535?requestedPort:43927
let mainWindow = null
let editBusy=false
const {JobManager}=require('./job-manager.cjs')
const jobs=new JobManager((job,finished)=>{mainWindow?.webContents.send('job:changed',job);if(finished&&job.kind==='import')mainWindow?.webContents.send('bridge:refresh',{reason:'大任务状态已更新'})})
let engine = null
let projectStore = null
let bridgeServer = null
let resourcePack = null
const agentToken=require('crypto').randomBytes(32).toString('hex')
const agentHandlers=new Map()
let agentBusy=false
let previewStatus={ready:false}
function registerAgentHandler(name,handler){
 const wrapped=async(...args)=>{
  if(['job:list','history:list'].includes(name))return handler(...args)
  if(name==='job:cancel'){if(editBusy&&!jobs.running)throw new Error('编辑执行中，请稍后恢复');return handler(...args)}
  if(editBusy)throw new Error('另一个编辑操作正在执行，请稍后重试')
  const uiOnly=name==='project:update'&&args[1]&&Object.keys(args[1]).every(k=>k==='ui')
  if(!name.startsWith('job:')&&!uiOnly)jobs.assertIdle((await projectStore?.get())?.worldPath)
  editBusy=true;try{return await handler(...args)}finally{editBusy=false}
 };ipcMain.handle(name,wrapped);agentHandlers.set(name,wrapped)
}
const previewWorkers = new Map()
function runPreview(kind, payload) {
  if(cacheBusy)return Promise.reject(new Error('正在清理缓存，请稍后重试预览'))
  previewWorkers.get(kind)?.terminate()
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, '../src/core/preview-worker.cjs'), { workerData: { kind, payload } })
    previewWorkers.set(kind, worker)
    worker.once('message', m => m.error ? reject(new Error(m.error)) : resolve(m.result))
    worker.once('error', reject)
    worker.once('exit', () => { if (previewWorkers.get(kind) === worker) previewWorkers.delete(kind); reject(new Error('预览任务已取消')) })
  })
}
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => { mainWindow?.restore(); mainWindow?.focus() })

app.commandLine.appendSwitch('enable-gpu-rasterization')
app.commandLine.appendSwitch('enable-zero-copy')

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1760,
    height: 1060,
    minWidth: 1280,
    minHeight: 760,
    backgroundColor: '#eceae3',
    title: '照献工程',
    icon: path.join(__dirname, '../build/icon.ico'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  mainWindow.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => mainWindow.show())
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools({ mode: 'detach' })
  mainWindow.on('close',e=>{if(jobs.running||editBusy){e.preventDefault();mainWindow.webContents.send('app:toast',{message:'请先等待任务完成，或取消任务并等待恢复。',error:true})}})
  mainWindow.on('closed', () => { mainWindow = null })
}

async function restoreLastWorld () {
  try {
    const saved = JSON.parse(fs.readFileSync(bridgeStatePath(), 'utf8'))
    if (!saved.worldPath || !fs.existsSync(path.join(saved.worldPath, 'region'))) return
    projectStore = new ProjectStore(saved.worldPath)
    await projectStore.ensure(); await displaySettings.apply(displayFile(),projectStore)
    await ensureEngine(saved.worldPath, saved.dimension || 'overworld')
  } catch {}
}

function json (res, status, body) {
  const data = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, 'cache-control': 'no-store' })
  res.end(data)
}
function startBridge () {
  bridgeServer = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`)
      if(u.pathname==='/agent'){
        if(req.method!=='POST')return json(res,405,{ok:false,error:'POST required'})
        if(req.headers.authorization!==`Bearer ${agentToken}`)return json(res,401,{ok:false,error:'Invalid local agent token'})
        if(agentBusy)return json(res,409,{ok:false,error:'Another AI operation is running'})
        agentBusy=true
        try{
          const chunks=[];let size=0
          for await(const chunk of req){size+=chunk.length;if(size>32*1024*1024)throw new Error('请求超过 32 MB');chunks.push(chunk)}
          const input=JSON.parse(Buffer.concat(chunks).toString('utf8')),handler=agentHandlers.get(input.action)
          if(!handler)throw new Error('不支持的 AI 操作')
          if(!['world:open','world:create'].includes(input.action)){
            const p=await projectStore?.get()
            if(!p||!input.worldPath||path.resolve(input.worldPath).toLowerCase()!==path.resolve(p.worldPath).toLowerCase())throw new Error('目标存档与当前世界不一致，已阻止操作')
          }
          const result=await handler(null,input.payload||{})
          if(input.action!=='world:tool'&&!input.action.startsWith('job:')&&input.action!=='history:list')mainWindow?.webContents.send('bridge:refresh',{reason:'AI 项目已更新'})
          return json(res,200,{ok:true,result})
        }finally{agentBusy=false}
      }
      if (u.pathname === '/health') return json(res, 200, { ok: true, name: '照献工程', version: VERSION, worldOpen: !!projectStore,agentBusy,preview:previewStatus })
      if (u.pathname === '/context') return json(res, 200, projectStore ? await projectStore.get() : {})
      if (u.pathname === '/refresh') { mainWindow?.webContents.send('bridge:refresh', { reason: u.searchParams.get('reason') || 'MCP 修改' }); return json(res, 200, { ok: true }) }
      if (u.pathname === '/focus') {
        const data = { x: Number(u.searchParams.get('x') || 0), y: Number(u.searchParams.get('y') || 80), z: Number(u.searchParams.get('z') || 0) }
        mainWindow?.webContents.send('bridge:focus', data); return json(res, 200, { ok: true, ...data })
      }
      if (u.pathname === '/capture') {
        if (!mainWindow) return json(res, 503, { ok: false, error: '照献工程未打开' })
        const image = await mainWindow.webContents.capturePage()
        const out = path.join(app.getPath('temp'), `zx-engineering-preview-${Date.now()}.png`)
        fs.writeFileSync(out, image.toPNG())
        return json(res, 200, { ok: true, path: out })
      }
      json(res, 404, { ok: false, error: 'not found' })
    } catch (err) { json(res, 500, { ok: false, error: String(err.message || err) }) }
  })
  bridgeServer.on('error', (err) => mainWindow?.webContents.send('app:toast', { message: `MCP 桥接端口启动失败：${err.message}`, error: true }))
  bridgeServer.listen(BRIDGE_PORT, '127.0.0.1',()=>{
    fs.writeFileSync(path.join(path.dirname(bridgeStatePath()),'agent-connection.json'),JSON.stringify({port:BRIDGE_PORT,token:agentToken,version:VERSION,pid:process.pid}))
  })
}

async function ensureEngine (worldPath, dimension = 'overworld') {
  if (!worldPath) throw new Error('没有打开世界')
  if (!engine || engine.worldPath !== worldPath || engine.dimension !== dimension) {await engine?.raw.close();engine = new WorldEngine(worldPath, dimension)}
  return engine
}
function copyTree (src, dst, onFile = () => {}) {
  const st = fs.statSync(src)
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true })
    for (const name of fs.readdirSync(src)) {
      if (name === 'session.lock') continue
      copyTree(path.join(src, name), path.join(dst, name), onFile)
    }
  } else { fs.copyFileSync(src, dst); onFile(src, dst) }
}

function registerIpc () {
  ipcMain.on('preview:status',(_e,status)=>{previewStatus={ready:!!status.ready,worldPath:status.worldPath,blocks:status.blocks||0,error:status.error||null}})
  ipcMain.handle('dialog:open-world', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], title: '选择 Minecraft Java 1.12.2 世界文件夹' })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  ipcMain.handle('dialog:open-schematic', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters: [{ name: 'Minecraft Schematic', extensions: ['schematic', 'schem'] }] })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  ipcMain.handle('dialog:export-folder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'], title: '选择导出目录' })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('dialog:create-world-folder', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'createDirectory'], title: '选择新世界保存目录' })
    return r.canceled ? null : r.filePaths[0]
  })

  ipcMain.handle('dialog:open-resource-pack', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], title: '选择 Minecraft 1.12.2.jar 或资源包 ZIP', filters: [{ name: 'Minecraft 材质源', extensions: ['jar', 'zip'] }, { name: '全部文件', extensions: ['*'] }] })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  ipcMain.handle('resource:auto-detect', async () => {
    const p = detectVanilla112Jar()
    return p ? { ok: true, path: p } : { ok: false, path: null }
  })
  ipcMain.handle('resource:set', async (_e, sourcePath) => {
    if (!sourcePath) { resourcePack = null; return { ok: true, path: null } }
    resourcePack = new ResourcePack(sourcePath)
    displaySettings.save(displayFile(),{resourcePackPath:sourcePath})
    if (projectStore) { try { const p = await projectStore.get(); await projectStore.update({ ui: { ...(p.ui || {}), resourcePackPath: sourcePath } }) } catch {} }
    return resourcePack.info()
  })
  ipcMain.handle('resource:info', async () => {
    if (resourcePack) return resourcePack.info()
    const p = await projectStore?.get()
    const configured = displaySettings.read(displayFile()).resourcePackPath || p?.ui?.resourcePackPath
    const source = configured && fs.existsSync(configured) ? configured : detectVanilla112Jar()
    if (!source) return { ok: false, path: null }
    try { resourcePack = new ResourcePack(source); return resourcePack.info() } catch (e) { return { ok: false, path: source, error: e.message } }
  })
  ipcMain.handle('resource:texture', async (_e, textureName) => {
    if (!resourcePack) {
      const p = await projectStore?.get(); const configured = displaySettings.read(displayFile()).resourcePackPath || p?.ui?.resourcePackPath
      const source = configured && fs.existsSync(configured) ? configured : detectVanilla112Jar()
      if (source) { try { resourcePack = new ResourcePack(source) } catch {} }
    }
    if (!resourcePack) return { ok: false, name: textureName }
    const b = resourcePack.readTexture(textureName)
    return b ? { ok: true, name: textureName, base64: b.toString('base64') } : { ok: false, name: textureName }
  })

  registerAgentHandler('world:open', async (_e, payload) => {
    resourcePack = null
    const worldPath = payload?.worldPath; const dimension = payload?.dimension || 'overworld'
    if (!worldPath || !fs.existsSync(worldPath)) throw new Error('世界目录不存在')
    if (!fs.existsSync(path.join(worldPath, 'region'))) throw new Error('没有找到 region 文件夹，请选择世界根目录')
    projectStore = new ProjectStore(worldPath); await projectStore.ensure(); await displaySettings.apply(displayFile(),projectStore)
    const patch = { worldPath, dimension, version: '1.12.2', name: path.basename(worldPath), openedAt: new Date().toISOString(), bridgePort: BRIDGE_PORT }
    await projectStore.update(patch)
    fs.writeFileSync(bridgeStatePath(), JSON.stringify({ ...patch, projectFile: projectStore.file }, null, 2))
    await ensureEngine(worldPath, dimension)
    return { ok: true, project: await projectStore.get(), dimensions: { overworld: fs.existsSync(path.join(worldPath, 'region')), nether: fs.existsSync(path.join(worldPath, 'DIM-1', 'region')), end: fs.existsSync(path.join(worldPath, 'DIM1', 'region')) }, regionPath: dimensionRegionPath(worldPath, dimension) }
  })

  registerAgentHandler('world:create', async (_e, payload) => {
    const parent = payload?.parentPath; const name = String(payload?.name || '照献世界').trim()
    if (!parent) throw new Error('缺少保存目录')
    const out = path.join(parent, name.replace(/[<>:"/\\|?*]/g, '_'))
    if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error('目标世界目录已经存在且非空，请换一个名称')
    const eng = new WorldEngine(out, 'overworld'); await eng.createWorld({ ...payload, worldPath: out })
    projectStore = new ProjectStore(out); await projectStore.ensure(); await displaySettings.apply(displayFile(),projectStore); await projectStore.update({ worldPath: out, dimension: 'overworld', version: '1.12.2', name, bridgePort: BRIDGE_PORT })
    engine = eng
    fs.writeFileSync(bridgeStatePath(), JSON.stringify({ worldPath: out, dimension: 'overworld', version: '1.12.2', name, bridgePort: BRIDGE_PORT, projectFile: projectStore.file }, null, 2))
    return { ok: true, project: await projectStore.get(), regionPath: dimensionRegionPath(out, 'overworld') }
  })

  ipcMain.handle('world:detail-blocks', async (_e, payload) => { if(jobs.running?.job.kind==='import')throw new Error('地图正在写入，完成后自动刷新');
    const p = await projectStore?.get(); const eng = await ensureEngine(payload?.worldPath || p?.worldPath, payload?.dimension || p?.dimension || 'overworld')
    return runPreview('detail', { ...payload, worldPath: eng.worldPath, dimension: eng.dimension })
  })
  ipcMain.handle('world:scan-overview', async (_e, payload) => { if(jobs.running?.job.kind==='import')throw new Error('地图正在写入，完成后自动刷新');
    const p = await projectStore?.get(); const eng = await ensureEngine(payload?.worldPath || p?.worldPath, payload?.dimension || p?.dimension || 'overworld')
    return runPreview('overview', { worldPath: eng.worldPath, dimension: eng.dimension, sample: payload?.sample || 0, force: !!payload?.force, showBarriers: !!payload?.showBarriers })
  })
  registerAgentHandler('world:tool', async (_e, { name, payload }) => {
    const p = await projectStore?.get(); const eng = await ensureEngine(p?.worldPath, p?.dimension || 'overworld')
    const result = await eng.runTool(name, payload || {});previewStatus={ready:false,worldPath:p.worldPath};mainWindow?.webContents.send('bridge:refresh', { reason: payload?.name||`执行 ${name}` }); return result
  })
  ipcMain.handle('project:get', async () => projectStore ? await projectStore.get() : null)
  registerAgentHandler('project:update', async (_e, patch) => {
    if (!projectStore) throw new Error('请先打开世界')
    const p = await projectStore.update(patch || {})
    if(patch?.ui) displaySettings.save(displayFile(),patch.ui)
    fs.writeFileSync(bridgeStatePath(), JSON.stringify({ worldPath: p.worldPath, dimension: p.dimension, version: '1.12.2', name: p.name, bridgePort: BRIDGE_PORT, projectFile: projectStore.file }, null, 2))
    return p
  })
  ipcMain.handle('world:material-stats', async (_e, box) => { if(jobs.running?.job.kind==='import')throw new Error('地图正在写入，完成后自动刷新'); const p = await projectStore?.get(); const eng = await ensureEngine(p?.worldPath, p?.dimension); return await eng.materialStats(box) })
  registerAgentHandler('world:export-schematic', async (_e, payload) => { const p = await projectStore?.get(); const eng = await ensureEngine(p?.worldPath, p?.dimension); return await eng.exportLegacySchematic(payload) })
  registerAgentHandler('world:import-schematic', async (_e, payload) => { const p = await projectStore?.get(); const eng = await ensureEngine(p?.worldPath, p?.dimension); const r = await eng.placeSchematic(payload); mainWindow?.webContents.send('bridge:refresh', { reason: '导入 schematic' }); return r })
  registerAgentHandler('world:undo', async () => { const p = await projectStore?.get(); const eng = await ensureEngine(p?.worldPath, p?.dimension); const r = await eng.undo(); mainWindow?.webContents.send('bridge:refresh', { reason: '撤销' }); return r })
  registerAgentHandler('world:redo',async()=>{const p=await projectStore?.get(),eng=await ensureEngine(p?.worldPath,p?.dimension);const r=await eng.redo();mainWindow?.webContents.send('bridge:refresh',{reason:'重做'});return r})
  registerAgentHandler('history:list',async()=>{const p=await projectStore?.get();if(!p)return {entries:[],active:null};const eng=await ensureEngine(p.worldPath,p.dimension);return {entries:eng.tx.list(),active:eng.tx.active()}})
  registerAgentHandler('job:list',async()=>{const p=await projectStore?.get();return p?jobs.list(p.worldPath):[]})
  registerAgentHandler('job:start',async(_e,payload)=>{const p=await projectStore?.get();if(!p)throw new Error('请先打开世界');await engine?.raw.close();engine=null;return jobs.start(p.worldPath,p.dimension,payload)})
  registerAgentHandler('job:cancel',async(_e,{id})=>{const p=await projectStore?.get();if(!p)throw new Error('请先打开世界');return jobs.recover(p.worldPath,id,false)})
  registerAgentHandler('job:retry',async(_e,{id})=>{const p=await projectStore?.get();if(!p)throw new Error('请先打开世界');await engine?.raw.close();engine=null;jobs.list(p.worldPath);return jobs.recover(p.worldPath,id,true)})
  registerAgentHandler('world:export-copy', async (_e, payload) => {
    const p = await projectStore?.get(); if (!p?.worldPath) throw new Error('没有打开世界')
    const parent = payload?.parentPath; if (!parent) throw new Error('没有选择导出目录')
    const name = (payload?.name || `${p.name || path.basename(p.worldPath)}_ZX导出`).replace(/[<>:"/\\|?*]/g, '_')
    const out = path.join(parent, name)
    if (fs.existsSync(out)) throw new Error('导出目录已存在，请换一个名称')
    copyTree(p.worldPath, out)
    return { ok: true, path: out }
  })
  ipcMain.handle('app:open-path', async (_e, target) => { if (!target || !fs.existsSync(target)) throw new Error('路径不存在'); return shell.openPath(target) })
  ipcMain.handle('app:capture-preview', async () => {
    if (!mainWindow) return null
    const img = await mainWindow.webContents.capturePage(); const out = path.join(app.getPath('pictures'), `照献工程预览-${Date.now()}.png`); fs.writeFileSync(out, img.toPNG()); return out
  })
  ipcMain.handle('app:bridge-info', async () => {
    if(!fs.existsSync(path.join(app.getPath('userData'),'mcp-location.json')))return {port:BRIDGE_PORT,needsLocation:true}
    const runtime=path.join(require('./mcp-install.cjs').runtimeBase(app.getPath('userData')),'current')
    return {port:BRIDGE_PORT,stateFile:bridgeStatePath(),version:VERSION,mcpServer:path.join(runtime,'app','mcp','server.mjs'),mcpCommand:path.join(runtime,path.basename(process.execPath)),mcpEnv:{ELECTRON_RUN_AS_NODE:'1'}}
  })
}

let mcpInstalling = false
ipcMain.handle('app:install-mcp', async (_e,chooseLocation=false) => {
  if(mcpInstalling)throw new Error('正在接入，请稍候')
  if(!app.isPackaged)throw new Error('请使用打包后的 EXE 进行一键接入')
  mcpInstalling=true
  try{
    const installer=require('./mcp-install.cjs')
    let root
    if(chooseLocation===true||!fs.existsSync(path.join(app.getPath('userData'),'mcp-location.json'))){
      const choice=await dialog.showOpenDialog(mainWindow,{title:'选择 MCP 安装位置（自动创建 ZX-MCP 子目录）',properties:['openDirectory','createDirectory']})
      if(choice.canceled)return {canceled:true}
      root=require('./cache-manager.cjs').safePath(path.join(choice.filePaths[0],'ZX-MCP'))
    }else root=installer.runtimeBase(app.getPath('userData'))
    const result=await installer.install({appPath:app.getAppPath(),execPath:process.execPath,version:VERSION,runtimeBase:root})
    installer.saveLocation(app.getPath('userData'),root)
    return result
  }
  finally{mcpInstalling=false}
})
let cacheBusy=false
async function clearManagedCache(automatic=false){
  if(cacheBusy||previewWorkers.size||agentBusy)throw new Error('正在预览或建造，请稍后清理')
  cacheBusy=true
  try{
    if(!automatic&&mainWindow)await mainWindow.webContents.session.clearCache()
    return await cacheManager.clear((await projectStore?.get())?.worldPath,automatic)
  }finally{cacheBusy=false}
}
ipcMain.handle('cache:info',async()=>cacheManager.info((await projectStore?.get())?.worldPath))
ipcMain.handle('cache:clear',()=>clearManagedCache())
ipcMain.handle('cache:save',async(_e,p)=>{cacheManager.save({auto:p.auto,days:Number(p.days),maxMB:Number(p.maxMB)});return true})
ipcMain.handle('cache:choose',async()=>{
  const r=await dialog.showOpenDialog(mainWindow,{title:'选择缓存存放位置（自动创建 ZX-Cache 子目录）',properties:['openDirectory','createDirectory']})
  if(r.canceled)return false
  cacheManager.save({parent:r.filePaths[0]});return true
})
app.whenReady().then(async () => {
  const data=app.getPath('userData'),settingsFile=path.join(data,'cache-settings.json')
  let saved={};try{saved=JSON.parse(fs.readFileSync(settingsFile,'utf8'))}catch{}
  while(!cacheManager){
    if(!saved.locationConfirmed){
      const choice=await dialog.showOpenDialog({title:'请先选择缓存保存位置（建议 D 盘；取消则退出）',properties:['openDirectory','createDirectory']})
      if(choice.canceled){app.quit();return}
      saved={...saved,parent:choice.filePaths[0],locationConfirmed:true}
    }
    try{
      require('./cache-manager.cjs').prepare(saved.parent)
      fs.mkdirSync(data,{recursive:true});fs.writeFileSync(settingsFile,JSON.stringify(saved,null,2))
      cacheManager=new CacheManager(data,saved.parent)
    }catch(e){saved.locationConfirmed=false;await dialog.showMessageBox({type:'error',message:'此缓存位置不可用，请重新选择。不会自动改存 C 盘。',detail:e.message})}
  }
  process.env.ZX_CACHE_ROOT=cacheManager.root
  fs.mkdirSync(path.join(cacheManager.root,'browser'),{recursive:true})
  app.setPath('sessionData',path.join(cacheManager.root,'browser'))
  app.commandLine.appendSwitch('disk-cache-dir',path.join(cacheManager.root,'browser','Cache'))
  await restoreLastWorld();registerIpc()
  if(cacheManager.settings.auto)await clearManagedCache(true).catch(e=>console.warn('缓存清理：',e.message))
  createWindow();startBridge()
  setInterval(()=>{if(cacheManager.settings.auto)clearManagedCache(true).catch(()=>{})},300000).unref()
})
app.on('before-quit',e=>{if(jobs.running||editBusy){e.preventDefault();mainWindow?.webContents.send('app:toast',{message:'任务仍在执行，请先取消并等待恢复完成，再关闭软件。',error:true})}})
app.on('window-all-closed', () => { bridgeServer?.close(); if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
