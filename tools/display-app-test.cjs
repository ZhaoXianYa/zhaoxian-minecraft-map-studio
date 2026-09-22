'use strict'
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),Module=require('module')
const {app,BrowserWindow}=require('electron'),root=path.resolve(__dirname,'../../display-app-test'),restart=process.argv.includes('--restart')
fs.mkdirSync(root,{recursive:true});process.env.APPDATA=path.join(root,'appdata');const profile=path.join(root,'profile');fs.mkdirSync(profile,{recursive:true});app.setPath('userData',profile)
fs.writeFileSync(path.join(profile,'cache-settings.json'),JSON.stringify({parent:path.join(root,'cache'),locationConfirmed:true,auto:false,days:7,maxMB:1024}))
app.commandLine.appendSwitch('disable-gpu-sandbox');process.argv.push('--agent-port=44912')
const main=path.join(__dirname,'../electron/main.cjs'),mod=new Module(main,module);mod.filename=main;mod.paths=Module._nodeModulePaths(path.dirname(main))
mod._compile(fs.readFileSync(main,'utf8').replace('backgroundThrottling: false','backgroundThrottling: false, offscreen: true').replace("mainWindow.once('ready-to-show', () => mainWindow.show())","mainWindow.once('ready-to-show', () => {})"),main)
const delay=ms=>new Promise(r=>setTimeout(r,ms))
app.whenReady().then(async()=>{
 try{
  let w;for(let i=0;i<150;i++){w=BrowserWindow.getAllWindows()[0];if(w&&!w.webContents.isLoading())break;await delay(100)}assert(w)
  w.webContents.on('console-message',(_e,level,message)=>console.log('renderer:',message))
  await delay(2500)
  const run=async code=>{console.log('TEST',code.slice(0,85));const r=await w.webContents.executeJavaScript(`(async()=>{try{${code}}catch(e){return {testError:e.stack||String(e)}}})()`);if(r?.testError)throw Error(r.testError);return r}
  if(!restart){
   const {WorldEngine}=require('../src/core/world-engine.cjs')
   for(const name of ['a','b']){const world=path.join(root,name),e=new WorldEngine(world);if(!fs.existsSync(path.join(world,'level.dat')))await e.createWorld({preset:'void',seed:1});const blocks=[];for(let z=0;z<=8;z++){for(let x=0;x<=8;x++)blocks.push({x,y:63,z,id:98});for(let y=64;y<=68;y++)blocks.push({x:8,y,z,id:166});}await e.raw.editBlocks(blocks);await e.raw.close()}
   await run(`await loadWorld(${JSON.stringify(path.join(root,'a'))});`)
   await run(`document.querySelector('#detailDistance').value='5';document.querySelector('#detailDistance').dispatchEvent(new Event('change'));`);await delay(350)
   await run(`await ZXNative.projectUpdate({ui:{renderScale:1.25,panSensitivity:.75,overviewSample:1}});await ZXNative.setResourcePack('D:/优化文件夹/无加密自用版本/.minecraft/versions/1.12.2/1.12.2.jar');await loadWorld(${JSON.stringify(path.join(root,'b'))});`)
   let p=await run('return await ZXNative.projectGet()');assert.equal(p.ui.viewDistance,5);assert.equal(p.ui.renderScale,1.25);assert(p.ui.resourcePackPath.endsWith('1.12.2.jar'))
   const result=await run(`const args={x:4,y:66,z:4,radiusChunks:1};const hidden=await ZXNative.loadDetailBlocks({...args,showBarriers:false}),shown=await ZXNative.loadDetailBlocks({...args,showBarriers:true});const off=await ZXNative.scanOverview({sample:1,showBarriers:false}),on=await ZXNative.scanOverview({sample:1,showBarriers:true});return {hidden:hidden.blocks.filter(b=>b[3]===166).length,shown:shown.blocks.filter(b=>b[3]===166).length,topOff:off.regions.map(r=>r.block),topOn:on.regions.map(r=>r.block)}`)
   assert.equal(result.hidden,0);assert.equal(result.shown,45);assert.notDeepEqual(result.topOff,result.topOn)
   await run(`setCurrent(4,65,4);await showDetail(state.current);showPanel('world');document.querySelector('#showBarriers').checked=true;document.querySelector('#showBarriers').dispatchEvent(new Event('change'));`)
   for(let i=0;i<150;i++){if(await run("return !!state.project?.ui?.showBarriers && document.querySelector('#loadProgress').classList.contains('hidden')"))break;await delay(100)}
   const mesh=await run("return state.scene.children.filter(m=>m.material?.color?.getHex()===0xff3055).length");assert(mesh>0,'Barrier overlay rendered')
   fs.writeFileSync(path.join(root,'屏障显示.png'),(await w.webContents.capturePage()).toPNG())
   console.log('PASS: real UI autosave/world switch; worker hidden=0 shown=45; overview cache differs; red overlay rendered')
  }else{
   for(let i=0;i<150;i++){if(await run("return !!state.project && document.querySelector('#loadProgress').classList.contains('hidden')"))break;await delay(100)}
   const p=await run("return {ui:state.project.ui,checked:document.querySelector('#showBarriers').checked,resource:await ZXNative.getResourceInfo()}")
   assert.equal(p.ui.viewDistance,5);assert.equal(p.ui.showBarriers,true);assert.equal(p.checked,true);assert.equal(p.ui.panSensitivity,.75);assert.equal(p.resource.ok,true)
   console.log('PASS: app restart restores display settings, checkbox and custom texture source')
  }
 }catch(e){console.error(e);process.exitCode=1}finally{app.quit()}
})
