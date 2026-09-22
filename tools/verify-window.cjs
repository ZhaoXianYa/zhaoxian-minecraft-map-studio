'use strict'
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
app.setPath('userData',require('path').join(__dirname,'../../verify-profile'))
require('../electron/main.cjs')
const delay = ms => new Promise(r => setTimeout(r,ms))
app.whenReady().then(async () => {
  try {
    let w
    for(let i=0;i<60;i++){w=BrowserWindow.getAllWindows()[0];if(w&&!w.webContents.isLoading())break;await delay(500)}
    for(let i=0;i<120;i++){if(await w.webContents.executeJavaScript('!!state.overview && !document.querySelector("#loadProgress").classList.contains("hidden") === false').catch(()=>false))break;await delay(500)}
    console.log(await w.webContents.executeJavaScript(`(async()=>{state.project.ui.viewDistance=2;await showDetail({x:97,y:65,z:-479});return JSON.stringify({detail:state.detail,mode:state.mode,meshes:state.scene.children.length})})()`))
    await delay(1000)
    const out=process.env.ZX_VERIFY_OUTPUT
    if(out) fs.writeFileSync(out,(await w.webContents.capturePage()).toPNG())
    console.log('PREVIEW_CAPTURED')
  } catch(e){console.error(e);process.exitCode=1}
  finally {app.quit()}
})
