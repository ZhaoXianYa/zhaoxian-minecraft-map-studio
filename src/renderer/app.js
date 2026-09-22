'use strict'
/* 照献工程 Desktop renderer: full-world LOD + prismarine-viewer exact detail. */
const path = require('path')
const fs = require('fs')
const { clipboard } = require('electron')
const THREE = require('three')
const {FirstPersonControls}=require('./first-person.cjs')
const { previewRadius } = require('../core/preview-range.cjs')
global.THREE = THREE

const $ = (s) => document.querySelector(s)
const $$ = (s) => [...document.querySelectorAll(s)]
const V = '1.12.2'
let previewRequest = 0
let navigationLoading = false
let navigationAttempt = 0
const state = {
  project: null, overview: null, mode: 'overview', detail: null, renderer: null, camera: null, controls: null,
  scene: null, raf: null, resizeObserver: null, current: { x: 0, y: 80, z: 0 }, selection: null,
  selectedAction: 'raise', fpsFrames: 0, fpsT: performance.now(), dirtyScan: false
}

function toast (message, error = false) {
  const el = document.createElement('div'); el.className = `toast${error ? ' error' : ''}`; el.textContent = message
  $('#toastWrap').appendChild(el); setTimeout(() => el.remove(), 3600)
}
function errMsg (e) { return e?.message || String(e) }
function safeInt (v, d = 0) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : d }
function updateDistanceHint(){
  try{const r=previewRadius($('#detailDistance').value),width=(r*2+1)*16;$('#detailDistanceHint').textContent=`${width} × ${width} 方块 · ${(r*2+1)**2} 区块。可输入 1–32，点击下方按钮保存并应用。${r>10?'大范围会明显增加内存占用及加载时间，建议逐步调大。':''}`}
  catch(e){$('#detailDistanceHint').textContent=e.message}
}
function boxFromInputs () {
  const b = { x1: safeInt($('#x1').value), y1: safeInt($('#y1').value, 0), z1: safeInt($('#z1').value), x2: safeInt($('#x2').value), y2: safeInt($('#y2').value, 255), z2: safeInt($('#z2').value) }
  for (const a of [['x1','x2'],['y1','y2'],['z1','z2']]) if (b[a[0]] > b[a[1]]) [b[a[0]],b[a[1]]] = [b[a[1]],b[a[0]]]
  return b
}
function setSelection (box) {
  state.selection = box
  for (const k of ['x1','y1','z1','x2','y2','z2']) $(`#${k}`).value = box[k]
  $('#selectionBadge').classList.remove('hidden')
  $('#selectionBadge').textContent = `选区  X ${box.x1}~${box.x2} · Y ${box.y1}~${box.y2} · Z ${box.z1}~${box.z2}`
  renderMaterialCoords()
}
function setCurrent (x, y, z) {
  state.current = { x: Math.round(x), y: Math.round(y), z: Math.round(z) }
  $('#statusX').textContent = state.current.x; $('#statusY').textContent = state.current.y; $('#statusZ').textContent = state.current.z
}
function regionPathForDimension (root, dimension) {
  if (dimension === 'nether') return path.join(root, 'DIM-1', 'region')
  if (dimension === 'end') return path.join(root, 'DIM1', 'region')
  return path.join(root, 'region')
}
function stopRender () {
  if (state.raf) cancelAnimationFrame(state.raf); state.raf = null
  try { state.controls?.dispose?.() } catch {}
  try { state.detail?.world?.stopSaving?.() } catch {}
  try { state.detail?.provider?.close?.() } catch {}
  state.scene?.traverse(o => { o.geometry?.dispose();if(o.userData.overviewTexture){o.material.map.dispose();o.material.dispose()} })
  state.detail = null; state.controls = null
  if (state.renderer) { try { state.renderer.dispose() } catch {}; try { state.renderer.domElement.remove() } catch {} }
  state.renderer = null; state.camera = null; state.scene = null
  $('#viewport').innerHTML = ''
}
function setupRenderer () {
  stopRender()
  const host = $('#viewport')
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
  const renderScale = Number(state.project?.ui?.renderScale || 1); renderer.setPixelRatio(Math.min((window.devicePixelRatio || 1) * renderScale, 2.5))
  renderer.setSize(host.clientWidth, host.clientHeight, false)
  renderer.outputEncoding = THREE.sRGBEncoding
  // Minecraft textures are authored to be read directly. Filmic tone mapping
  // lifts their shadows and was responsible for the pale, low-contrast preview.
  renderer.toneMapping = THREE.NoToneMapping
  renderer.shadowMap.enabled = false
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.setClearColor(0xd9d7d0, 1)
  host.appendChild(renderer.domElement)
  state.renderer = renderer
  state.resizeObserver?.disconnect?.()
  state.resizeObserver = new ResizeObserver(() => {
    if (!state.renderer || !state.camera) return
    const w = host.clientWidth, h = host.clientHeight; state.renderer.setSize(w, h, false)
    if (state.camera.isPerspectiveCamera) { state.camera.aspect = w / Math.max(1,h); state.camera.updateProjectionMatrix() }
    else if (state.camera.isOrthographicCamera && state.camera.userData.frustumSize) {
      const size = state.camera.userData.frustumSize, aspect = w / Math.max(1,h)
      state.camera.left = -size * aspect / 2; state.camera.right = size * aspect / 2; state.camera.top = size / 2; state.camera.bottom = -size / 2; state.camera.updateProjectionMatrix()
    }
  })
  state.resizeObserver.observe(host)
  return renderer
}
function blockColor (id, data = 0, y = 64) {
  let c
  if (id === 166) c = [1,.12,.28]
  else if (id === 2) c = [0.42,0.58,0.30]
  else if (id === 3 || id === 60 || id === 110) c = [0.43,0.33,0.23]
  else if ([8,9].includes(id)) c = [0.36,0.60,0.67]
  else if ([10,11].includes(id)) c = [0.80,0.35,0.12]
  else if (id === 12 || id === 24) c = [0.75,0.69,0.49]
  else if ([17,162].includes(id)) c = [0.39,0.30,0.20]
  else if ([18,161,106].includes(id)) c = [0.31,0.48,0.29]
  else if ([78,80].includes(id)) c = [0.91,0.93,0.91]
  else if ([79,174].includes(id)) c = [0.66,0.80,0.84]
  else if ([5,53,85,126,134,135,136,163,164].includes(id)) {
    const wood = [[0.57,0.44,0.28],[0.36,0.27,0.18],[0.65,0.52,0.33],[0.70,0.65,0.47],[0.47,0.30,0.18],[0.35,0.22,0.15]]; c = wood[data % wood.length]
  } else if ([1,4,43,44,48,67,98,109,139].includes(id)) c = [0.48,0.49,0.46]
  else if ([45,108].includes(id)) c = [0.56,0.31,0.23]
  else if ([112,113,114].includes(id)) c = [0.28,0.16,0.17]
  else if ([20,95,102,160].includes(id)) c = [0.69,0.77,0.76]
  else if (id === 35) { const wool=[[0.80,.80,.76],[.85,.48,.22],[.67,.38,.72],[.38,.57,.73],[.78,.69,.29],[.45,.63,.31],[.78,.51,.60],[.29,.31,.31],[.48,.50,.48],[.26,.51,.56],[.48,.31,.63],[.26,.34,.61],[.45,.31,.22],[.33,.43,.20],[.61,.25,.24],[.13,.14,.14]]; c=wool[data%16] }
  else c = [0.50,0.50,0.46]
  const shade = Math.max(.82, Math.min(1.12, .92 + (y - 55) / 420))
  return c.map(v => Math.min(1, v * shade))
}
function decodeTyped (b64, Type) {
  const buf = Buffer.from(b64, 'base64')
  return new Type(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / Type.BYTES_PER_ELEMENT))
}
function buildRegionGeometry (r) {
  const res = r.res, sample = r.sample
  const h = decodeTyped(r.height, Uint8Array), block = decodeTyped(r.block, Uint16Array), data = decodeTyped(r.data, Uint8Array), valid = decodeTyped(r.valid, Uint8Array)
  // Point-center grid; every sample cell is two triangles. Skip invalid cells completely.
  const positions = [], colors = [], indices = []
  let vtx = 0
  const wx0 = r.rx * 512, wz0 = r.rz * 512
  for (let gz = 0; gz < res - 1; gz++) for (let gx = 0; gx < res - 1; gx++) {
    const ids = [gz*res+gx, gz*res+gx+1, (gz+1)*res+gx+1, (gz+1)*res+gx]
    if (!ids.every(i => valid[i])) continue
    const corners = [[gx,gz],[gx+1,gz],[gx+1,gz+1],[gx,gz+1]]
    for (let k=0;k<4;k++) {
      const i=ids[k], xx=corners[k][0], zz=corners[k][1]
      const left=h[zz*res+Math.max(0,xx-1)]||h[i], right=h[zz*res+Math.min(res-1,xx+1)]||h[i], up=h[Math.max(0,zz-1)*res+xx]||h[i], down=h[Math.min(res-1,zz+1)*res+xx]||h[i]
      const slopeShade=Math.max(.72,Math.min(1.18,1 + (left-right)*.012 + (up-down)*.009))
      const c=blockColor(block[i],data[i],h[i]).map(v=>Math.max(0,Math.min(1,v*slopeShade)))
      positions.push(wx0 + xx*sample, h[i], wz0 + zz*sample)
      const linear=new THREE.Color(...c).convertSRGBToLinear();colors.push(linear.r,linear.g,linear.b)
    }
    indices.push(vtx,vtx+2,vtx+1, vtx,vtx+3,vtx+2); vtx += 4
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  g.setIndex(indices); g.computeVertexNormals(); g.computeBoundingSphere()
  g.userData.region = r
  return g
}
function buildTopRegion(r) {
  const blocks=decodeTyped(r.block,Uint16Array),meta=decodeTyped(r.data,Uint8Array),height=decodeTyped(r.height,Uint8Array),valid=decodeTyped(r.valid,Uint8Array)
  const pixels=new Uint8Array(r.res*r.res*4)
  const bounds={minX:Infinity,minZ:Infinity,maxX:-Infinity,maxZ:-Infinity}
  for(let i=0;i<valid.length;i++) {
    if(!valid[i])continue
    const x=r.rx*512+(i%r.res)*r.sample,z=r.rz*512+Math.floor(i/r.res)*r.sample
    bounds.minX=Math.min(bounds.minX,x);bounds.minZ=Math.min(bounds.minZ,z);bounds.maxX=Math.max(bounds.maxX,x+r.sample);bounds.maxZ=Math.max(bounds.maxZ,z+r.sample)
    const c=blockColor(blocks[i],meta[i],height[i]);pixels.set([Math.round(c[0]*255),Math.round(c[1]*255),Math.round(c[2]*255),255],i*4)
  }
  const texture=new THREE.DataTexture(pixels,r.res,r.res,THREE.RGBAFormat)
  texture.encoding=THREE.sRGBEncoding;texture.flipY=true;texture.magFilter=THREE.NearestFilter;texture.minFilter=THREE.NearestFilter;texture.generateMipmaps=false;texture.needsUpdate=true
  const g=new THREE.PlaneGeometry(512,512);g.rotateX(-Math.PI/2)
  const mesh=new THREE.Mesh(g,new THREE.MeshBasicMaterial({map:texture,transparent:true,alphaTest:.5,side:THREE.DoubleSide}))
  mesh.position.set(r.rx*512+256,0,r.rz*512+256);mesh.userData.region=r;mesh.userData.overviewTexture=true;mesh.userData.validBounds=bounds
  return mesh
}
class ZXOrbitControls {
  constructor (camera, dom) {
    this.camera=camera; this.dom=dom; this.target=new THREE.Vector3(); this.enabled=true
    this.drag=false; this.pan=false; this.last={x:0,y:0}; this.spherical=new THREE.Spherical()
    this.minDistance=4; this.maxDistance=50000; this.dampingFactor=.12
    this._down=e=>{ if(e.button!==0)return; this.drag=true; this.pan=e.shiftKey; this.last={x:e.clientX,y:e.clientY}; dom.setPointerCapture?.(e.pointerId) }
    this._move=e=>{ if(!this.drag)return; const dx=e.clientX-this.last.x,dy=e.clientY-this.last.y; this.last={x:e.clientX,y:e.clientY}; if(this.pan)this._pan(dx,dy); else this._rotate(dx,dy) }
    this._up=e=>{this.drag=false}
    this._wheel=e=>{e.preventDefault(); this._zoom(e.deltaY)}
    dom.addEventListener('pointerdown',this._down); dom.addEventListener('pointermove',this._move); dom.addEventListener('pointerup',this._up); dom.addEventListener('pointercancel',this._up); dom.addEventListener('wheel',this._wheel,{passive:false})
  }
  _rotate(dx,dy){const off=this.camera.position.clone().sub(this.target);this.spherical.setFromVector3(off);this.spherical.theta-=dx*.006;this.spherical.phi-=dy*.006;this.spherical.phi=Math.max(.08,Math.min(Math.PI-.08,this.spherical.phi));off.setFromSpherical(this.spherical);this.camera.position.copy(this.target).add(off);this.camera.lookAt(this.target)}
  _pan(dx,dy){
    const speed=Math.max(.05,Math.min(3,Number(state.project?.ui?.panSensitivity??.6)))
    const height=this.camera.isOrthographicCamera?(this.camera.top-this.camera.bottom)/this.camera.zoom:2*this.camera.position.distanceTo(this.target)*Math.tan(this.camera.fov*Math.PI/360)
    const scale=height/Math.max(1,this.dom.clientHeight)*speed
    this.camera.updateMatrixWorld()
    const offset=new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld,0).multiplyScalar(-dx*scale).add(new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld,1).multiplyScalar(dy*scale))
    this.camera.position.add(offset);this.target.add(offset);this.camera.lookAt(this.target)
  }
  _zoom(delta){if(this.camera.isOrthographicCamera){const f=delta>0?1.12:.89;this.camera.zoom=Math.max(.08,Math.min(30,this.camera.zoom/f));this.camera.updateProjectionMatrix();return}const off=this.camera.position.clone().sub(this.target);let d=off.length()*(delta>0?1.12:.89);d=Math.max(this.minDistance,Math.min(this.maxDistance,d));off.setLength(d);this.camera.position.copy(this.target).add(off)}
  update(){this.camera.lookAt(this.target)}
  dispose(){this.dom.removeEventListener('pointerdown',this._down);this.dom.removeEventListener('pointermove',this._move);this.dom.removeEventListener('pointerup',this._up);this.dom.removeEventListener('pointercancel',this._up);this.dom.removeEventListener('wheel',this._wheel)}
}
function makeOverviewControls (camera, renderer) { const c=new ZXOrbitControls(camera,renderer.domElement);c.minDistance=10;c.maxDistance=50000;return c }
async function showOverview (mode = 'overview') {
  if(mode==='overview') return showDetail(state.current,true)
  if(mode==='front'){
    await showDetail(state.current)
    if(state.detail){const c=state.controls.target,s=state.camera.userData.frustumSize;state.camera.position.set(c.x,c.y,c.z+s);state.controls.update();$$('.view-tab').forEach(b=>b.classList.toggle('active',b.dataset.view==='front'))}
    return
  }
  if (!state.overview) return
  state.navigation=false;state.view=mode
  if(mode==='top' && state.overview.sample!==1){
    const request=++previewRequest;$('#loadProgress').classList.remove('hidden');$('#loadProgress').textContent='正在生成逐方块俯视图，首次生成会稍久…'
    try{const o=await ZXNative.scanOverview({worldPath:state.project.worldPath,dimension:state.project.dimension||'overworld',sample:1,showBarriers:!!state.project?.ui?.showBarriers});if(request!==previewRequest)return;state.overview=o}
    finally{if(request===previewRequest)$('#loadProgress').classList.add('hidden')}
  }
  state.mode = mode; updateViewTabs()
  const renderer = setupRenderer(), scene = new THREE.Scene(); state.scene = scene
  previewRequest++
  scene.background = new THREE.Color(0xe4e2dc)
  const b = state.overview.bounds || { minX:-256,maxX:256,minZ:-256,maxZ:256,width:512,length:512 }
  const size = Math.max(b.width,b.length,512) * (mode === 'overview' ? 1.15 : 1.05)
  const aspect = $('#viewport').clientWidth / Math.max(1,$('#viewport').clientHeight)
  const camera = new THREE.OrthographicCamera(-size*aspect/2,size*aspect/2,size/2,-size/2,-20000,30000); camera.userData.frustumSize=size; state.camera=camera
  const cx=(b.minX+b.maxX)/2, cz=(b.minZ+b.maxZ)/2
  if (mode === 'top') camera.position.set(cx, Math.max(2500,size), cz); else if (mode === 'front') camera.position.set(cx, 120, cz + size*.85); else camera.position.set(cx + size*.48, size*.52, cz + size*.48)
  camera.lookAt(cx, 55, cz)
  const controls = makeOverviewControls(camera, renderer); controls.target.set(cx,55,cz); state.controls=controls
  scene.add(new THREE.HemisphereLight(0xf9f7ee,0x748076,1.5)); const dl=new THREE.DirectionalLight(0xffffff,.7);dl.position.set(-600,1200,-400);scene.add(dl)
  const root = new THREE.Group(); root.name='world-overview'; scene.add(root)
  for (const r of state.overview.regions) {
    if(mode==='top'){root.add(buildTopRegion(r));continue}
    const g=buildRegionGeometry(r); const m=new THREE.MeshBasicMaterial({vertexColors:true,side:THREE.DoubleSide}); const mesh=new THREE.Mesh(g,m); mesh.userData.region=r; root.add(mesh)
  }
  if(mode==='top'){
    const bs=root.children.map(m=>m.userData.validBounds).filter(b=>Number.isFinite(b.minX))
    if(bs.length){const x1=Math.min(...bs.map(b=>b.minX)),x2=Math.max(...bs.map(b=>b.maxX)),z1=Math.min(...bs.map(b=>b.minZ)),z2=Math.max(...bs.map(b=>b.maxZ)),s=Math.max(z2-z1,(x2-x1)/aspect)*1.12
      camera.userData.frustumSize=s;Object.assign(camera,{left:-s*aspect/2,right:s*aspect/2,top:s/2,bottom:-s/2});camera.position.set((x1+x2)/2,2500,(z1+z2)/2);controls.target.set((x1+x2)/2,0,(z1+z2)/2);camera.updateProjectionMatrix();controls.update()
    }
  }
  // World floor reference only around generated bounds, not as fake world terrain.
  if (state.project?.ui?.showGrid) { const gridSize=Math.min(Math.max(b.width,b.length)*1.15,20000); const grid=new THREE.GridHelper(gridSize,Math.min(80,Math.max(20,Math.floor(gridSize/64))),0xb9bbb5,0xd0d0ca); grid.position.y=0; grid.material.opacity=.14;grid.material.transparent=true;scene.add(grid) }
  renderer.domElement.addEventListener('dblclick', overviewPick)
  $('#viewportHelp').textContent='左键旋转 · Shift + 左键平移 · 滚轮缩放 · 双击进入该位置实景'
  $('#statusLod').textContent=`LOD 1:${state.overview.sample}`
  animateOverview()
}
function animateOverview () {
  if (!state.renderer || !state.scene || !state.camera || state.mode === 'detail') return
  state.controls?.update?.(); state.renderer.render(state.scene,state.camera); updateFps(); state.raf=requestAnimationFrame(animateOverview)
}
function overviewPick (ev) {
  if (!state.scene || !state.camera || !state.renderer || !state.overview) return
  const rect=state.renderer.domElement.getBoundingClientRect(), mouse=new THREE.Vector2(((ev.clientX-rect.left)/rect.width)*2-1,-((ev.clientY-rect.top)/rect.height)*2+1)
  const ray=new THREE.Raycaster();ray.setFromCamera(mouse,state.camera);const hits=ray.intersectObjects(state.scene.getObjectByName('world-overview')?.children||[],false)
  if (!hits.length) return
  const p=hits[0].point,r=hits[0].object.userData.region
  if(state.mode==='top'&&r){const x=Math.max(0,Math.min(r.res-1,Math.floor((p.x-r.rx*512)/r.sample))),z=Math.max(0,Math.min(r.res-1,Math.floor((p.z-r.rz*512)/r.sample)));p.y=decodeTyped(r.height,Uint8Array)[z*r.res+x]}
  setCurrent(p.x,p.y,p.z); showDetail(state.current,true).catch(e=>toast(errMsg(e),true))
}
const COLOR_NAMES=['white','orange','magenta','light_blue','yellow','lime','pink','gray','silver','cyan','purple','blue','brown','green','red','black']
const WOODS=['oak','spruce','birch','jungle','acacia','big_oak']
const textureCache=new Map(), materialCache=new Map()

function blockShape(id,data){
  const slabs=new Set([44,126,182,205]); if(slabs.has(id)) return {kind:'slab',oy:(data&8)?.25:-.25}
  const stairs=new Set([53,67,108,109,114,128,134,135,136,156,163,164,180,203]); if(stairs.has(id)) return {kind:'stairs',dir:data&3,up:!!(data&4)}
  const fences=new Set([85,113,188,189,190,191,192]); if(fences.has(id)) return {kind:'fence'}
  if(id===139) return {kind:'wall'}
  const panes=new Set([102,160]); if(panes.has(id)) return {kind:'pane'}
  const plants=new Set([6,31,32,37,38,39,40,50,59,63,65,66,68,83,104,105,106,111,115,127,131,175,198]); if(plants.has(id)) return {kind:'plant'}
  if(id===8||id===9) return {kind:'water'}
  if([64,71,193,194,195,196,197].includes(id)) return {kind:'door',dir:data&3,open:!!(data&4)}
  if([96,167].includes(id)) return {kind:'trapdoor',dir:data&3,open:!!(data&4),top:!!(data&8)}
  if(id===171||id===78) return {kind:'carpet',h:id===78?Math.max(.08,Math.min(1,(data+1)/8)):.07}
  return {kind:'cube'}
}
function colorHex(id,data=0){const c=blockColor(id,data,70);return new THREE.Color(c[0],c[1],c[2])}
function tex(all,extra={}){return {all,...extra}}
function textureSpec(id,data=0){
  if(id===166)return {all:null,transparent:true,opacity:.28,tint:0xff3055,emissive:0xff1838}
  const d=data&15, color=COLOR_NAMES[d%16]
  if(id===6)return tex(`sapling_${WOODS[d%6]}`,{transparent:true,alphaTest:.3})
  if(id===31)return tex(d===2?'fern':'tallgrass',{transparent:true,alphaTest:.3,tint:0x739c45})
  if(id===32)return tex('deadbush',{transparent:true,alphaTest:.3})
  if(id===37)return tex('flower_dandelion',{transparent:true,alphaTest:.3})
  if(id===38)return tex(['flower_rose','flower_blue_orchid','flower_allium','flower_houstonia','flower_tulip_red','flower_tulip_orange','flower_tulip_white','flower_tulip_pink','flower_oxeye_daisy'][Math.min(d,8)],{transparent:true,alphaTest:.3})
  if(id===50)return tex('torch_on',{transparent:true,alphaTest:.3})
  if(id===1){const a=['stone','stone_granite','stone_granite_smooth','stone_diorite','stone_diorite_smooth','stone_andesite','stone_andesite_smooth'];return tex(a[Math.min(d,a.length-1)]||'stone')}
  if(id===2)return {top:'grass_top',side:'grass_side',bottom:'dirt',topTint:0x78a84f}
  if(id===3){if(d===1)return tex('dirt_coarse');if(d===2)return {top:'podzol_top',side:'podzol_side',bottom:'dirt'};return tex('dirt')}
  if(id===4)return tex('cobblestone')
  if(id===5)return tex(`planks_${WOODS[d%6]}`)
  if(id===7)return tex('bedrock')
  if(id===8||id===9)return tex('water_still',{transparent:true,opacity:.72,tint:0x87b9cb})
  if(id===10||id===11)return tex('lava_still',{emissive:0x7b2d0d})
  if(id===12)return tex(d===1?'red_sand':'sand')
  if(id===13)return tex('gravel')
  const ores={14:'gold_ore',15:'iron_ore',16:'coal_ore',21:'lapis_ore',56:'diamond_ore',73:'redstone_ore',74:'redstone_ore',129:'emerald_ore'};if(ores[id])return tex(ores[id])
  if(id===17){const w=WOODS[d&3]||'oak';return {side:`log_${w}`,top:`log_${w}_top`,bottom:`log_${w}_top`}}
  if(id===18){const w=WOODS[d&3]||'oak';return tex(`leaves_${w}`,{transparent:true,alphaTest:.32,tint:(w==='spruce'?0x527e50:0x6e9f52)})}
  if(id===20)return tex('glass',{transparent:true,opacity:.38})
  if(id===22)return tex('lapis_block')
  if(id===24){if(d===1)return tex('sandstone_carved');if(d===2)return tex('sandstone_smooth');return {top:'sandstone_top',side:'sandstone_normal',bottom:'sandstone_bottom'}}
  if(id===35)return tex(`wool_colored_${color}`)
  const solids={41:'gold_block',42:'iron_block',45:'brick',48:'cobblestone_mossy',49:'obsidian',57:'diamond_block',80:'snow',82:'clay',87:'netherrack',88:'soul_sand',89:'glowstone',112:'nether_brick',121:'end_stone',133:'emerald_block',152:'redstone_block',172:'hardened_clay',173:'coal_block',174:'ice_packed',201:'purpur_block',206:'end_bricks',213:'magma',214:'nether_wart_block',215:'red_nether_brick'};if(solids[id])return tex(solids[id])
  if(id===43||id===44){const m=d&7;const a=['stone','sandstone_top','planks_oak','cobblestone','brick','stonebrick','nether_brick','quartz_block_side'];return tex(a[m]||'stone')}
  if(id===46)return {top:'tnt_top',side:'tnt_side',bottom:'tnt_bottom'}
  if(id===47)return {top:'planks_oak',side:'bookshelf',bottom:'planks_oak'}
  if(id===53)return tex('planks_oak')
  if(id===54||id===146)return tex('planks_oak')
  if(id===58)return {top:'crafting_table_top',side:'crafting_table_side',front:'crafting_table_front',bottom:'planks_oak'}
  if(id===60)return {top:d>=7?'farmland_wet':'farmland_dry',side:'dirt',bottom:'dirt'}
  if(id===67)return tex('cobblestone')
  if(id===79)return tex('ice',{transparent:true,opacity:.72})
  if(id===84)return {top:'jukebox_top',side:'jukebox_side',bottom:'planks_oak'}
  if(id===85||id===188)return tex('planks_oak');if(id===189)return tex('planks_spruce');if(id===190)return tex('planks_birch');if(id===191)return tex('planks_jungle');if(id===192)return tex('planks_big_oak')
  if(id===86)return {top:'pumpkin_top',side:'pumpkin_side',bottom:'pumpkin_top'}
  if(id===91)return {top:'pumpkin_top',side:'pumpkin_face_on',bottom:'pumpkin_top',emissive:0x5a2b0d}
  if(id===95||id===160)return tex(`glass_${color}`,{transparent:true,opacity:.5})
  if(id===98){const a=['stonebrick','stonebrick_mossy','stonebrick_cracked','stonebrick_carved'];return tex(a[d&3])}
  if(id===103)return {top:'melon_top',side:'melon_side',bottom:'melon_top'}
  if(id===106)return tex('vine',{transparent:true,alphaTest:.25,tint:0x679744})
  if(id===108)return tex('brick');if(id===109)return tex('stonebrick')
  if(id===110)return {top:'mycelium_top',side:'mycelium_side',bottom:'dirt'}
  if(id===113||id===114)return tex('nether_brick')
  if(id===125||id===126)return tex(`planks_${WOODS[d&7]||'oak'}`)
  if(id===128)return tex('sandstone_normal')
  if(id===134)return tex('planks_spruce');if(id===135)return tex('planks_birch');if(id===136)return tex('planks_jungle')
  if(id===139)return tex((d&1)?'cobblestone_mossy':'cobblestone')
  if(id===155){if(d===1)return tex('quartz_block_chiseled');if(d===2||d===3||d===4)return tex('quartz_block_lines');return {top:'quartz_block_top',side:'quartz_block_side',bottom:'quartz_block_bottom'}}
  if(id===156)return tex('quartz_block_side')
  if(id===159)return tex(`hardened_clay_stained_${color}`)
  if(id===161){const w=(d&1)?'big_oak':'acacia';return tex(`leaves_${w}`,{transparent:true,alphaTest:.32,tint:0x6e9f52})}
  if(id===162){const w=(d&1)?'big_oak':'acacia';return {side:`log_${w}`,top:`log_${w}_top`,bottom:`log_${w}_top`}}
  if(id===163)return tex('planks_acacia');if(id===164)return tex('planks_big_oak')
  if(id===168){const a=['prismarine_rough','prismarine_bricks','prismarine_dark'];return tex(a[Math.min(d,2)]||a[0])}
  if(id===169)return tex('sea_lantern',{emissive:0x274a4a})
  if(id===170)return {top:'hay_block_top',side:'hay_block_side',bottom:'hay_block_top'}
  if(id===171)return tex(`wool_colored_${color}`)
  if(id===179){if(d===1)return tex('red_sandstone_carved');if(d===2)return tex('red_sandstone_smooth');return {top:'red_sandstone_top',side:'red_sandstone_normal',bottom:'red_sandstone_bottom'}}
  if(id===180||id===181||id===182)return tex('red_sandstone_normal')
  if(id===202)return {top:'purpur_pillar_top',side:'purpur_pillar',bottom:'purpur_pillar_top'}
  if(id===203||id===205)return tex('purpur_block')
  if(id===216)return {top:'bone_block_top',side:'bone_block_side',bottom:'bone_block_top'}
  if(id===251)return tex(`concrete_${color}`)
  if(id===252)return tex(`concrete_powder_${color}`)
  return {all:null}
}
function faceTexture(spec,dir){if(dir===2)return spec.top||spec.all;if(dir===3)return spec.bottom||spec.all;if(dir===5&&spec.front)return spec.front;return spec.side||spec.all}
function faceTint(spec,dir){if(dir===2&&spec.topTint)return spec.topTint;return spec.tint||0xffffff}
function primaryTexture(spec){return spec.all||spec.side||spec.top||spec.bottom||null}
function textureDataUrl(name){return loadTexture(name).then(t=>t?.userData?.dataUrl||null)}
async function loadTexture(name){
  if(!name)return null
  if(textureCache.has(name))return textureCache.get(name)
  const promise=(async()=>{try{const r=await ZXNative.getTexture(name);if(!r?.ok||!r.base64)return null;const dataUrl=`data:image/png;base64,${r.base64}`;return await new Promise(resolve=>{const loader=new THREE.TextureLoader();loader.load(dataUrl,t=>{
    // Vanilla animated textures are vertical frame strips, not one tall tile.
    const img=t.image;if(img.height>img.width&&img.height%img.width===0){const frame=document.createElement('canvas');frame.width=frame.height=img.width;frame.getContext('2d').drawImage(img,0,0,img.width,img.width,0,0,img.width,img.width);t.image=frame;t.needsUpdate=true}
    t.magFilter=THREE.NearestFilter;t.minFilter=THREE.NearestMipMapLinearFilter;t.anisotropy=state.renderer?.capabilities?.getMaxAnisotropy?.()||1;t.generateMipmaps=true;t.encoding=THREE.sRGBEncoding;t.userData={dataUrl,name};resolve(t)
  },undefined,()=>resolve(null))})}catch{return null}})()
  textureCache.set(name,promise);return promise
}
async function makeTextureMaterial(spec,dir=2){
  const name=faceTexture(spec,dir), tint=faceTint(spec,dir), key=`${name||'flat'}|${tint}|${spec.transparent?1:0}|${spec.opacity||1}|${spec.emissive||0}|${spec.alphaTest||0}|${spec._id}:${spec._data}`
  if(materialCache.has(key))return materialCache.get(key)
  const map=await loadTexture(name)
  const mat=new THREE.MeshStandardMaterial({map:map||null,color:map?tint:0xffffff,roughness:.92,metalness:0,transparent:!!spec.transparent,opacity:spec.opacity??1,alphaTest:spec.alphaTest||0,side:spec.transparent?THREE.DoubleSide:THREE.FrontSide,depthWrite:!(spec.transparent&&(spec.opacity??1)<.8),emissive:spec.emissive||0x000000,emissiveIntensity:spec.emissive?.22:0})
  if(!map) {
    if(spec._id===166){mat.color.set(0xff3055);materialCache.set(key,mat);return mat}
    mat.color.copy(colorHex(spec._id||1,spec._data||0)).convertSRGBToLinear()
    const pixels=new Uint8Array(16*16*4)
    for(let i=0;i<256;i++){const n=210+((i*73+(spec._id||1)*19)%46);pixels.set([n,n,n,255],i*4)}
    mat.map=new THREE.DataTexture(pixels,16,16,THREE.RGBAFormat);mat.map.magFilter=THREE.NearestFilter;mat.map.minFilter=THREE.LinearMipMapLinearFilter;mat.map.generateMipmaps=true;mat.map.needsUpdate=true
  }
  materialCache.set(key,mat);return mat
}
function addFace(batch,x,y,z,dir){
  const D=[
    [[1,0,0],[1,1,0],[1,1,1],[1,0,1],[1,0,0]],
    [[0,0,1],[0,1,1],[0,1,0],[0,0,0],[-1,0,0]],
    [[0,1,1],[1,1,1],[1,1,0],[0,1,0],[0,1,0]],
    [[0,0,0],[1,0,0],[1,0,1],[0,0,1],[0,-1,0]],
    [[1,0,1],[1,1,1],[0,1,1],[0,0,1],[0,0,1]],
    [[0,0,0],[0,1,0],[1,1,0],[1,0,0],[0,0,-1]]
  ][dir]
  const base=batch.pos.length/3
  for(let i=0;i<4;i++){batch.pos.push(x+D[i][0],y+D[i][1],z+D[i][2]);batch.nor.push(...D[4])}
  batch.uv.push(0,0,0,1,1,1,1,0);batch.idx.push(base,base+1,base+2,base,base+2,base+3)
}
function buildFaceGeometry(batch){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(batch.pos,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(batch.nor,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(batch.uv,2));g.setIndex(batch.idx);g.computeBoundingSphere();return g}
function geometryFor(shape){
  if(shape.kind==='slab'){const g=new THREE.BoxGeometry(1,.5,1);g.translate(0,shape.oy,0);return g}
  if(shape.kind==='carpet'){const g=new THREE.BoxGeometry(1,shape.h,1);g.translate(0,-.5+shape.h/2,0);return g}
  if(shape.kind==='stairs'){
    const parts=[],add=(sx,sy,sz,ox,oy,oz)=>{const g=new THREE.BoxGeometry(sx,sy,sz);g.translate(ox,oy,oz);parts.push(g)}
    const upper=shape.up,yA=upper?.25:-.25,yB=upper?-.25:.25;add(1,.5,1,0,yA,0)
    if(shape.dir===0)add(.5,.5,1,.25,yB,0);else if(shape.dir===1)add(.5,.5,1,-.25,yB,0);else if(shape.dir===2)add(1,.5,.5,0,yB,.25);else add(1,.5,.5,0,yB,-.25)
    return mergeGeometries(parts)
  }
  if(shape.kind==='fence'||shape.kind==='wall'){const parts=[],mk=(sx,sy,sz,ox,oy,oz)=>{const g=new THREE.BoxGeometry(sx,sy,sz);g.translate(ox,oy,oz);parts.push(g)},w=shape.kind==='wall'?.5:.25;mk(w,1,w,0,0,0);mk(1,.14,.14,0,.18,0);mk(1,.14,.14,0,-.18,0);mk(.14,.14,1,0,.18,0);mk(.14,.14,1,0,-.18,0);return mergeGeometries(parts)}
  if(shape.kind==='pane'){return mergeGeometries([new THREE.BoxGeometry(.08,1,1),new THREE.BoxGeometry(1,1,.08)])}
  if(shape.kind==='plant'){const a=new THREE.PlaneGeometry(1,1),b=new THREE.PlaneGeometry(1,1);a.rotateY(Math.PI/4);b.rotateY(-Math.PI/4);return mergeGeometries([a,b])}
  if(shape.kind==='water'){const g=new THREE.BoxGeometry(1,.16,1);g.translate(0,-.42,0);return g}
  if(shape.kind==='door'){const g=new THREE.BoxGeometry(.16,1,1);g.rotateY((shape.dir&1)?Math.PI/2:0);return g}
  if(shape.kind==='trapdoor'){const g=new THREE.BoxGeometry(1,.16,1);g.translate(0,shape.top?.42:-.42,0);if(shape.open){g.rotateZ(Math.PI/2);g.translate(shape.dir===0?.42:shape.dir===1?-.42:0,0,shape.dir===2?.42:shape.dir===3?-.42:0)}return g}
  return new THREE.BoxGeometry(1,1,1)
}
function mergeGeometries(gs){
  const pos=[],nor=[],uv=[];let off=0
  for(const g0 of gs){const g=g0.index?g0.toNonIndexed():g0,p=g.getAttribute('position'),n=g.getAttribute('normal'),u=g.getAttribute('uv');for(let i=0;i<p.count;i++){pos.push(p.getX(i),p.getY(i),p.getZ(i));if(n)nor.push(n.getX(i),n.getY(i),n.getZ(i));if(u)uv.push(u.getX(i),u.getY(i));else uv.push(0,0);off++}}
  const out=new THREE.BufferGeometry();out.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));if(nor.length)out.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));out.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));return out
}
async function showDetail(center=state.current,navigation=!!state.navigation,preserveCamera=false,walk=state.view==='walk'){
  if(!state.project?.worldPath)return toast('请先打开世界',true)
  ZXNative.reportPreview?.({ready:false,worldPath:state.project.worldPath})
  const request = ++previewRequest
  state.navigation=navigation;navigationLoading=navigation
  if(!preserveCamera)state.view=walk?'walk':navigation?'overview':'detail'
  let pendingScene=null
  const progress = $('#loadProgress')
  progress.classList.remove('hidden'); progress.textContent='读取方块中，界面仍可操作…'
  try {
  state.mode='detail';updateViewTabs();$('#statusMode').textContent='加载高清实景…'
  await ensureResourceUi(false)
  if (request !== previewRequest) return
  const renderer=state.renderer||setupRenderer();renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap
  const scene=new THREE.Scene();pendingScene=scene;scene.background=new THREE.Color(0xdedfd9)
  const c={x:safeInt(center.x),y:safeInt(center.y,80),z:safeInt(center.z)},radius=previewRadius(state.project?.ui?.viewDistance)
  const data=await ZXNative.loadDetailBlocks({worldPath:state.project.worldPath,dimension:state.project.dimension||'overworld',x:c.x,y:c.y,z:c.z,radiusChunks:radius,closeBoundary:!navigation,showBarriers:!!state.project?.ui?.showBarriers})
  if (request !== previewRequest) return
  progress.textContent=`正在构建 ${data.blocks.length.toLocaleString()} 个完整方块…`
  const aspect=$('#viewport').clientWidth/Math.max(1,$('#viewport').clientHeight),frustum=Math.max(54,radius*32*1.15)
  let camera=walk?new THREE.PerspectiveCamera(75,aspect,.05,3000):new THREE.OrthographicCamera(-frustum*aspect/2,frustum*aspect/2,frustum/2,-frustum/2,-2500,2500);camera.userData.frustumSize=frustum
  if(walk){camera.position.set(c.x+.5,c.y+1.62,c.z+.5);camera.rotation.order='YXZ'}else{camera.position.set(c.x+frustum*.7,c.y+frustum*.55,c.z+frustum*.7);camera.lookAt(c.x,c.y,c.z)}
  if(walk)scene.add(new THREE.AmbientLight(0xffffff,.85))
  scene.add(new THREE.HemisphereLight(0xf5f7f2,0x59635c,.72));scene.add(new THREE.AmbientLight(0xffffff,.08))
  const sun=new THREE.DirectionalLight(0xfffdf5,1.05);sun.position.set(c.x-frustum*.55,c.y+frustum*1.15,c.z-frustum*.6);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-frustum;sun.shadow.camera.right=frustum;sun.shadow.camera.top=frustum;sun.shadow.camera.bottom=-frustum;sun.shadow.camera.near=.1;sun.shadow.camera.far=frustum*4;sun.shadow.bias=-.00025;scene.add(sun)

  const faceBatches=new Map(),specialGroups=new Map()
  sun.target.position.set(c.x,c.y,c.z);scene.add(sun.target)
  let processed = 0
  const bounds={minX:Infinity,minY:Infinity,minZ:Infinity,maxX:-Infinity,maxY:-Infinity,maxZ:-Infinity}
  if(!data.blocks.length)Object.assign(bounds,{minX:c.x-32,minY:c.y-1,minZ:c.z-32,maxX:c.x+32,maxY:c.y+1,maxZ:c.z+32})
  for(const b of data.blocks){
    if (++processed % 10000 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); if (request !== previewRequest) return }
    const [x,y,z,id,meta,mask=63]=b,shape=blockShape(id,meta),spec={...textureSpec(id,meta),_id:id,_data:meta}
    bounds.minX=Math.min(bounds.minX,x);bounds.minY=Math.min(bounds.minY,y);bounds.minZ=Math.min(bounds.minZ,z);bounds.maxX=Math.max(bounds.maxX,x+1);bounds.maxY=Math.max(bounds.maxY,y+1);bounds.maxZ=Math.max(bounds.maxZ,z+1)
    if(shape.kind==='cube'){
      for(let dir=0;dir<6;dir++)if(mask&(1<<dir)){const t=faceTexture(spec,dir),tint=faceTint(spec,dir),k=`${t||'flat'}|${tint}|${spec.transparent?1:0}|${spec.opacity||1}|${id}:${meta}`;if(!faceBatches.has(k))faceBatches.set(k,{spec,dir,tint,pos:[],nor:[],uv:[],idx:[]});addFace(faceBatches.get(k),x,y,z,dir)}
    }else{
      const k=`${shape.kind}:${id}:${meta}`;if(!specialGroups.has(k))specialGroups.set(k,{id,meta,shape,spec,items:[]});specialGroups.get(k).items.push([x,y,z])
    }
  }
  let rendered=0,faces=0
  for(const batch of faceBatches.values()){
    const mat=await makeTextureMaterial(batch.spec,batch.dir);if(request!==previewRequest)return;const geom=buildFaceGeometry(batch),mesh=new THREE.Mesh(geom,mat);mesh.castShadow=!batch.spec.transparent;mesh.receiveShadow=true;scene.add(mesh);faces+=batch.idx.length/6
  }
  const dummy=new THREE.Object3D()
  for(const g of specialGroups.values()){
    const mat=await makeTextureMaterial(g.spec,2);if(request!==previewRequest)return;const geom=geometryFor(g.shape),mesh=new THREE.InstancedMesh(geom,mat,g.items.length);mesh.frustumCulled=false;mesh.castShadow=g.shape.kind!=='water'&&g.shape.kind!=='plant';mesh.receiveShadow=true
    for(let i=0;i<g.items.length;i++){const [x,y,z]=g.items[i];dummy.position.set(x+.5,y+.5,z+.5);dummy.rotation.set(0,0,0);dummy.updateMatrix();mesh.setMatrixAt(i,dummy.matrix)}mesh.instanceMatrix.needsUpdate=true;scene.add(mesh);rendered+=g.items.length
  }
  if(state.project?.ui?.showGrid){const grid=new THREE.GridHelper(radius*32*2,Math.min(64,radius*16),0xb8bbb4,0xcfd0ca);grid.position.set(c.x,0,c.z);grid.material.opacity=.09;grid.material.transparent=true;scene.add(grid)}
  // Publish a complete scene atomically. The previous scene stays interactive
  // while the worker and material loader prepare the next neighbourhood.
  const previousTarget=preserveCamera?state.controls?.target.clone():null
  const keepWalk=walk&&preserveCamera&&state.controls instanceof FirstPersonControls
  if(keepWalk)camera=state.camera
  else if(previousTarget&&state.camera&&state.camera.type===camera.type){camera.copy(state.camera);camera.userData={...state.camera.userData}}
  if(state.raf)cancelAnimationFrame(state.raf)
  if(!keepWalk)state.controls?.dispose();state.scene?.traverse(o=>{o.geometry?.dispose();if(o.userData.overviewTexture){o.material.map.dispose();o.material.dispose()}})
  state.scene=scene;state.camera=camera
  const controls=keepWalk?state.controls:walk?new FirstPersonControls(camera,renderer.domElement):new ZXOrbitControls(camera,renderer.domElement);if(!walk)controls.target.copy(previousTarget||new THREE.Vector3(c.x,c.y,c.z));state.controls=controls
  state.detail={center:c,radius,rendered:data.blocks.length,faces,bounds};setCurrent(c.x,c.y,c.z)
  $('#worldCard').classList.add('hidden')
  if(!previousTarget&&!walk)fitCamera()
  animateDetail()
  const rinfo=await ZXNative.getResourceInfo().catch(()=>null),label=rinfo?.ok?'真实 1.12.2 材质':'无材质源（使用颜色回退）'
  if (request !== previewRequest) return
  for(const axis of ['x','y','z']) $('#go'+axis.toUpperCase()).value=c[axis]
  state.project.ui={...(state.project.ui||{}),lastPosition:c}
  await ZXNative.projectUpdate({ui:{lastPosition:c}})
  if (request !== previewRequest) return
  $('#viewportHelp').textContent=`${navigation?'真实方块导航 · 平移后自动加载周边':'建筑预览'} · ${label} · Shift + 左键平移 · 滚轮缩放 · 俯视全图可远距离定位`
  if(!data.blocks.length)$('#viewportHelp').textContent='此处是空白空间 · 可在“编辑”中填充方块、导入 schematic 或通过 AI 建造 · 不会自动添加地面'
  if(walk)$('#viewportHelp').textContent='玩家漫游（可穿墙）· 点击画面后鼠标转向 · WASD 移动 · 空格上升 / 左 Ctrl 下降 · 左 Shift 加速 · Esc 释放鼠标 · 可输入坐标跳转'
  $('#statusLod').textContent=`逐方块 1:1 · ${(radius*2+1)*16} × ${(radius*2+1)*16} · ${data.blocks.length.toLocaleString()} 方块`;$('#statusMode').textContent=navigation?'真实方块导航':'建筑预览';updateViewTabs()
  ZXNative.reportPreview?.({ready:true,worldPath:state.project.worldPath,blocks:data.blocks.length})
  } catch(e) { if (request === previewRequest) { ZXNative.reportPreview?.({ready:false,worldPath:state.project?.worldPath,error:errMsg(e)});$('#statusMode').textContent='加载失败'; toast(errMsg(e),true) } }
  finally { if(pendingScene&&pendingScene!==state.scene)pendingScene.traverse(o=>o.geometry?.dispose());if (request === previewRequest) {progress.classList.add('hidden');navigationLoading=false} }
}

function animateDetail () {
  if (state.mode!=='detail'||!state.renderer||!state.detail) return
  state.controls?.update?.(); if(state.controls?.target)setCurrent(state.controls.target.x,state.controls.target.y,state.controls.target.z);state.renderer.render(state.scene,state.camera);updateFps();state.raf=requestAnimationFrame(animateDetail)
  const target=state.controls?.target,loaded=state.detail.center
  if(state.navigation&&!navigationLoading&&!state.controls.drag&&target&&performance.now()-navigationAttempt>1200&&Math.max(Math.abs(target.x-loaded.x),Math.abs(target.z-loaded.z))>=16){navigationAttempt=performance.now();showDetail({x:target.x,y:target.y,z:target.z},true,true)}
}
function updateFps () { state.fpsFrames++; const now=performance.now(); if(now-state.fpsT>900){const fps=Math.round(state.fpsFrames*1000/(now-state.fpsT));$('#statusFps').textContent=`${fps} FPS`;state.fpsFrames=0;state.fpsT=now} }
function fitCamera () {
  if(state.view==='walk'){toast('漫游模式请用 WASD 移动或输入坐标跳转；切换建筑预览可恢复全景');return}
  if (state.mode==='detail' && state.detail) {
    const b=state.detail.bounds,c={x:(b.minX+b.maxX)/2,y:(b.minY+b.maxY)/2,z:(b.minZ+b.maxZ)/2}
    const aspect=$('#viewport').clientWidth/Math.max(1,$('#viewport').clientHeight),span=b.maxX-b.minX+b.maxZ-b.minZ
    const size=Math.max(24,(b.maxY-b.minY)*.88+span*.36,span*.71/aspect)*1.18
    state.camera.zoom=1;state.camera.userData.frustumSize=size
    Object.assign(state.camera,{left:-size*aspect/2,right:size*aspect/2,top:size/2,bottom:-size/2});state.camera.updateProjectionMatrix()
    state.camera.position.set(c.x+size,c.y+size*.8,c.z+size);state.controls.target.set(c.x,c.y,c.z);state.controls.update();return
  }
  showOverview(state.mode).catch(e=>toast(errMsg(e),true))
}
function updateViewTabs(){ $$('.view-tab').forEach(b=>b.classList.toggle('active',b.dataset.view===(state.view||state.mode))) }

async function openWorld () {
  try {
    const worldPath=await ZXNative.openWorldDialog();if(!worldPath)return
    await loadWorld(worldPath,'overworld')
  } catch(e){toast(errMsg(e),true)}
}
async function loadWorld (worldPath,dimension='overworld') {
  toast('正在读取世界…')
  const r=await ZXNative.loadWorld({worldPath,dimension});state.project=r.project
  for(const promise of textureCache.values()) Promise.resolve(promise).then(t=>t?.dispose())
  textureCache.clear();for(const mat of materialCache.values())mat.dispose();materialCache.clear()
  $('#emptyState').classList.add('hidden');$('#worldCard').classList.remove('hidden')
  await refreshProjectUi();await scanOverview(false);toast('世界已加载：完整 Region 已拼接')
}
async function scanOverview (force=false) {
  if(!state.project)return
  $('#statusMode').textContent='扫描完整世界…'
  // Sample auto-adjusts to region count only after fast metadata is known; sample=4 is a strong default.
  const o=await ZXNative.scanOverview({worldPath:state.project.worldPath,dimension:state.project.dimension||'overworld',sample:Number(state.project?.ui?.overviewSample||0),force:!!force,showBarriers:!!state.project?.ui?.showBarriers});state.overview=o;state.dirtyScan=false
  updateWorldMetrics()
  if(state.project.ui?.lastPosition) setCurrent(state.project.ui.lastPosition.x,state.project.ui.lastPosition.y,state.project.ui.lastPosition.z)
  if((state.project.ui?.previewMode||'overview')==='detail') await showDetail(state.current)
  else await showOverview(state.project.ui?.previewMode==='top'?'top':'overview')
}
async function refreshAfterEdit (reason='地图已修改') {
  state.dirtyScan=true;toast(reason)
  if(state.mode==='detail') await showDetail(state.current); else await scanOverview(true)
  await refreshProjectUi()
}
async function refreshProjectUi () {
  const p=await ZXNative.projectGet();if(p)state.project=p
  if(!state.project)return
  $('#crumbWorld').textContent=state.project.name||path.basename(state.project.worldPath||'世界');$('#sceneName').textContent=state.project.name||'世界';$('#statusWorld').textContent=state.project.name||'世界';$('#worldPanelName').textContent=state.project.name||'世界';$('#worldCardName').textContent=state.project.name||'世界';$('#dimensionSelect').value=state.project.dimension||'overworld'
  if($('#overviewQuality')) $('#overviewQuality').value=String(state.project.ui?.overviewSample??0); if($('#detailDistance')) $('#detailDistance').value=String(state.project.ui?.viewDistance??6); if($('#renderScale')) $('#renderScale').value=String(state.project.ui?.renderScale??1); if($('#showGrid')) $('#showGrid').checked=!!state.project.ui?.showGrid
  $('#panSensitivity').value=String(state.project.ui?.panSensitivity??.6)
  $('#showBarriers').checked=!!state.project.ui?.showBarriers
  updateDistanceHint()
  updateWorldMetrics();renderPlans();renderLayers();renderMarkers();renderProtections();updateMcpUi()
}
function updateWorldMetrics () {
  const b=state.overview?.bounds
  $('#metricX').textContent=b?b.width:'—';$('#metricZ').textContent=b?b.length:'—';$('#metricY').textContent='256';$('#metricChunks').textContent=state.overview?`${state.overview.chunks.toLocaleString()} chunks`:'—'
  if(state.overview){$('#sceneMeta').textContent=`${state.overview.regions.length} Region · ${state.overview.chunks.toLocaleString()} Chunk`;$('#worldCardMeta').textContent=`${b?.width||0} × ${b?.length||0} · ${state.overview.regions.length} Region · ${state.overview.chunks.toLocaleString()} Chunk`;if(state.mode!=='detail')$('#statusLod').textContent=`LOD 1:${state.overview.sample}`}
  const stats=$('#worldStats'); if(stats) stats.innerHTML = [
    ['世界宽度',b?`${b.width} m`:'—'],['世界进深',b?`${b.length} m`:'—'],['Region',state.overview?.regions.length??'—'],['Chunk',state.overview?.chunks?.toLocaleString?.()??'—'],['维度',state.project?.dimension||'—'],['数据版本','Java 1.12.2']
  ].map(([a,v])=>`<div><small>${a}</small><strong>${v}</strong></div>`).join('')
}
function renderPlans () {
  const plans=state.project?.buildingPlans||[],sel=$('#planSelect');const old=sel.value;sel.innerHTML=plans.length?plans.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join(''):'<option value="">暂无建筑方案</option>';if(plans.some(p=>p.id===old))sel.value=old
  $('#planCount').textContent=`${plans.length} 个方案`;renderParts()
}
function currentPlan(){const plans=state.project?.buildingPlans||[];return plans.find(p=>p.id===$('#planSelect').value)||plans[0]||null}
function updatePlanMetrics(p){
  if(p?.bounds){const b=p.bounds;$('#metricX').textContent=Math.abs(b.x2-b.x1)+1;$('#metricZ').textContent=Math.abs(b.z2-b.z1)+1;$('#metricY').textContent=Math.abs(b.y2-b.y1)+1;$('#metricChunks').textContent=`${Math.ceil((Math.abs(b.x2-b.x1)+1)/16)} × ${Math.ceil((Math.abs(b.z2-b.z1)+1)/16)} chunks`}
  else updateWorldMetrics()
}
function renderParts(){const p=currentPlan(),list=$('#partsList');if(!p){$('#planTitle').textContent='建筑方案';$('#conceptText').value=state.project?.concept||'';list.innerHTML='<div class="placeholder">创建建筑方案后，可以把主殿、偏殿、庭院、塔楼等拆成可定位区域。</div>';updatePlanMetrics(null);return}$('#planTitle').textContent=p.name||'建筑方案';$('#conceptText').value=p.concept||'';updatePlanMetrics(p);list.innerHTML=(p.parts||[]).length?(p.parts||[]).map((x,i)=>`<div class="part-item"><span class="part-index">${String(i+1).padStart(2,'0')}</span><div class="part-main"><b>${escapeHtml(x.name)}</b><span>${escapeHtml(x.description||'未填写描述')}</span></div><button class="part-go" data-part="${x.id}">↗</button></div>`).join(''):'<div class="placeholder">这个方案还没有空间区域。</div>';$$('[data-part]').forEach(b=>b.onclick=()=>focusPart(p.parts.find(x=>x.id===b.dataset.part))) }
function focusPart(part){if(!part?.bounds)return toast('该区域还没有保存坐标范围',true);const b=part.bounds;setCurrent((b.x1+b.x2)/2,(b.y1+b.y2)/2,(b.z1+b.z2)/2);showDetail(state.current).catch(e=>toast(errMsg(e),true))}
function renderLayers(){
  const raw=state.project?.layers||{};const defs=[['terrain','地形与地表'],['structures','建筑结构'],['foliage','园景与植被'],['water','水体'],['entities','实体']]
  const layers=Array.isArray(raw)?raw:defs.map(([id,name])=>({id,name,visible:raw[id]!==false}))
  $('#layerList').innerHTML=layers.map((l,i)=>`<div class="layer-row"><span>${escapeHtml(l.name||l.id)}</span><div class="switch ${l.visible!==false?'on':''}" data-layer="${i}"></div></div>`).join('')
  $$('[data-layer]').forEach(sw=>sw.onclick=async()=>{layers[+sw.dataset.layer].visible=layers[+sw.dataset.layer].visible===false?true:false;const obj={};for(const l of layers)obj[l.id]=l.visible!==false;await ZXNative.projectUpdate({layers:obj});state.project.layers=obj;renderLayers()})
}
function renderMarkers(){const a=state.project?.markers||[];$('#markerList').innerHTML=a.length?a.map(m=>`<div class="simple-item"><span class="part-index">◆</span><div><b>${escapeHtml(m.name)}</b><span>${m.type||'普通'} · X ${m.x} Y ${m.y} Z ${m.z}</span></div><button class="part-go" data-marker="${m.id}">↗</button></div>`).join(''):'<div class="placeholder">暂无标记。</div>';$$('[data-marker]').forEach(b=>b.onclick=()=>{const m=a.find(x=>x.id===b.dataset.marker);setCurrent(m.x,m.y,m.z);showDetail(state.current).catch(e=>toast(errMsg(e),true))})}
function renderProtections(){const a=state.project?.protectedRegions||[];$('#protectionList').innerHTML=a.length?a.map(p=>`<div class="simple-item"><span class="part-index">▣</span><div><b>${escapeHtml(p.name)}</b><span>X ${p.x1}~${p.x2} · Z ${p.z1}~${p.z2}</span></div><span class="tag good">保护</span></div>`).join(''):'<div class="placeholder">暂无保护区域。</div>'}
function renderMaterialCoords(){const b=state.selection;$('#materialCoords').innerHTML=b?[['X',`${b.x1} ~ ${b.x2}`],['Y',`${b.y1} ~ ${b.y2}`],['Z',`${b.z1} ~ ${b.z2}`],['体积',((b.x2-b.x1+1)*(b.y2-b.y1+1)*(b.z2-b.z1+1)).toLocaleString()]].map(([a,v])=>`<div><small>${a}</small><strong>${v}</strong></div>`).join(''):'<div><small>选区</small><strong>未建立</strong></div>'}
async function materialStats(){
  if(!state.selection)return toast('请先在编辑页建立选区',true)
  try{
    $('#materialList').innerHTML='<div class="placeholder">正在统计真实方块…</div>'
    const raw=await ZXNative.listMaterials(state.selection),groups=new Map();let total=0
    for(const x of raw){total+=x.count;const nd=normalizedMaterialData(x.id,x.data),k=`${x.id}:${nd}`;if(!groups.has(k))groups.set(k,{id:x.id,data:nd,count:0,fallback:x.name,variants:[]});const g=groups.get(k);g.count+=x.count;g.variants.push({data:x.data,count:x.count})}
    const a=[...groups.values()].sort((x,y)=>y.count-x.count);$('#materialTotal').textContent=`${a.length} 种 · ${total.toLocaleString()} 方块`
    if(!a.length){$('#materialList').innerHTML='<div class="placeholder">选区内没有非空气方块。</div>';return}
    const cards=await Promise.all(a.slice(0,120).map(async x=>{const spec=textureSpec(x.id,x.data),tn=primaryTexture(spec),url=tn?await textureDataUrl(tn):null,pct=total?x.count*100/total:0,name=chineseBlockName(x.id,x.data,x.fallback),variant=x.variants.length>1?`已合并 ${x.variants.length} 个方向 / 状态`:`ID ${x.id}:${x.data}`;return `<div class="material-card"><div class="mat-icon" style="${url?`background-image:url('${url}')`:`background:${'#'+colorHex(x.id,x.data).getHexString()}`}" title="${escapeHtml(tn||'颜色回退')}"></div><div class="mat-copy"><b>${escapeHtml(name)}</b><span>${escapeHtml(variant)}</span><div class="mat-bar"><i style="width:${Math.max(1,Math.min(100,pct)).toFixed(1)}%"></i></div></div><div class="mat-side"><strong>${x.count.toLocaleString()}</strong><em>${pct.toFixed(1)}%</em></div></div>`}))
    $('#materialList').innerHTML=cards.join('')
  }catch(e){toast(errMsg(e),true)}
}
function escapeHtml(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

async function ensureResourceUi(autoSet=true){
  try{
    let info=await ZXNative.getResourceInfo()
    if(!info?.ok&&autoSet){const d=await ZXNative.autoDetectResourcePack();if(d?.ok&&d.path){info=await ZXNative.setResourcePack(d.path);textureCache.clear();materialCache.clear()}}
    const st=$('#resourceStatus'),rp=$('#resourcePath');if(st)st.textContent=info?.ok?'已加载':'未加载';if(rp)rp.textContent=info?.ok?info.path:'未找到本机 1.12.2.jar，可手动选择资源包 ZIP / 1.12.2.jar。'
    return info
  }catch(e){const st=$('#resourceStatus');if(st)st.textContent='加载失败';return null}
}
async function chooseResourcePack(){const p=await ZXNative.chooseResourcePack();if(!p)return;try{await ZXNative.setResourcePack(p);textureCache.clear();materialCache.clear();await ensureResourceUi(false);toast('高清材质源已切换');if(state.mode==='detail')await showDetail(state.current)}catch(e){toast(errMsg(e),true)}}
async function autoResourcePack(){try{const d=await ZXNative.autoDetectResourcePack();if(!d?.ok)return toast('没有检测到官方启动器的 Minecraft 1.12.2.jar，请手动选择。',true);await ZXNative.setResourcePack(d.path);textureCache.clear();materialCache.clear();await ensureResourceUi(false);toast('已加载 Minecraft 1.12.2 原版材质');if(state.mode==='detail')await showDetail(state.current)}catch(e){toast(errMsg(e),true)}}
function normalizedMaterialData(id,data){const stairs=new Set([53,67,108,109,114,128,134,135,136,156,163,164,180,203]);if(stairs.has(id))return 0;if([85,113,188,189,190,191,192,64,71,96,167,193,194,195,196,197].includes(id))return 0;if(id===17)return data&3;if(id===18)return data&3;if(id===161||id===162)return data&1;if(id===44||id===126||id===182||id===205)return data&7;return data&15}
function chineseBlockName(id,data=0,fallback=''){const d=normalizedMaterialData(id,data),colors=['白色','橙色','品红','淡蓝','黄色','黄绿色','粉色','灰色','淡灰','青色','紫色','蓝色','棕色','绿色','红色','黑色'],woods=['橡木','云杉木','白桦木','丛林木','金合欢木','深色橡木'];
  if(id===1)return ['石头','花岗岩','磨制花岗岩','闪长岩','磨制闪长岩','安山岩','磨制安山岩'][d]||'石头';if(id===2)return'草方块';if(id===3)return d===1?'砂土':d===2?'灰化土':'泥土';if(id===4)return'圆石';if(id===5)return`${woods[d%6]}木板`;if(id===7)return'基岩';if(id===8||id===9)return'水';if(id===12)return d===1?'红沙':'沙子';if(id===13)return'沙砾';if(id===17)return`${woods[d%4]}原木`;if(id===18)return`${woods[d%4]}树叶`;if(id===20)return'玻璃';if(id===24)return d===1?'錾制砂岩':d===2?'平滑砂岩':'砂岩';if(id===35)return`${colors[d]}羊毛`;if(id===41)return'金块';if(id===42)return'铁块';if(id===44)return['石台阶','砂岩台阶','橡木台阶','圆石台阶','砖台阶','石砖台阶','地狱砖台阶','石英台阶'][d]||'台阶';if(id===45)return'砖块';if(id===48)return'苔石';if(id===49)return'黑曜石';if(id===53)return'橡木楼梯';if(id===57)return'钻石块';if(id===67)return'圆石楼梯';if(id===79)return'冰';if(id===80)return'雪块';if(id===85)return'橡木栅栏';if(id===89)return'萤石';if(id===95)return`${colors[d]}染色玻璃`;if(id===98)return['石砖','苔石砖','裂纹石砖','錾制石砖'][d]||'石砖';if(id===108)return'砖楼梯';if(id===109)return'石砖楼梯';if(id===112)return'地狱砖';if(id===113)return'地狱砖栅栏';if(id===114)return'地狱砖楼梯';if(id===121)return'末地石';if(id===126)return`${woods[d%6]}台阶`;if(id===128)return'砂岩楼梯';if(id===133)return'绿宝石块';if(id===134)return'云杉木楼梯';if(id===135)return'白桦木楼梯';if(id===136)return'丛林木楼梯';if(id===139)return d?'苔石墙':'圆石墙';if(id===152)return'红石块';if(id===155)return d===1?'錾制石英块':d>=2?'竖纹石英块':'石英块';if(id===156)return'石英楼梯';if(id===159)return`${colors[d]}陶瓦`;if(id===160)return`${colors[d]}玻璃板`;if(id===163)return'金合欢木楼梯';if(id===164)return'深色橡木楼梯';if(id===168)return['海晶石','海晶石砖','暗海晶石'][Math.min(d,2)];if(id===169)return'海晶灯';if(id===171)return`${colors[d]}地毯`;if(id===172)return'陶瓦';if(id===173)return'煤炭块';if(id===174)return'浮冰';if(id===179)return d===1?'錾制红砂岩':d===2?'平滑红砂岩':'红砂岩';if(id===180)return'红砂岩楼梯';if(id===201)return'紫珀块';if(id===203)return'紫珀楼梯';if(id===206)return'末地石砖';if(id===213)return'岩浆块';if(id===214)return'地狱疣块';if(id===215)return'红色地狱砖';if(id===216)return'骨块';if(id===251)return`${colors[d]}混凝土`;if(id===252)return`${colors[d]}混凝土粉末`;return fallback||`方块 ${id}:${data}`}

function showPanel(name){if(name==='tasks')refreshWorkbench().catch(e=>toast(errMsg(e),true));$$('.ins-tab').forEach(x=>x.classList.toggle('active',x.dataset.panel===name));$$('.panel').forEach(x=>x.classList.toggle('active',x.dataset.panelContent===name));if(name==='world')refreshCacheUi().catch(e=>toast(errMsg(e),true))}
async function refreshCacheUi(){
  const r=await ZXNative.cacheInfo();$('#cacheInfo').textContent=`占用 ${(r.total/1048576).toFixed(2)} MB · 当前目录：${r.root}${r.restart?'；重启后改为：'+r.settings.parent+'\\ZX-Cache':''}${r.warning?'；'+r.warning:''}`
  $('#cacheAuto').checked=r.settings.auto;$('#cacheDays').value=r.settings.days;$('#cacheMax').value=r.settings.maxMB
}
function modal(title,html,onReady){$('#modalTitle').textContent=title;$('#modalBody').innerHTML=`<div class="modal-body">${html}</div>`;$('#modalBackdrop').classList.remove('hidden');onReady?.()}
function closeModal(){ $('#modalBackdrop').classList.add('hidden') }
async function newWorldModal(){
  modal('新建 Minecraft Java 1.12.2 世界',`<div class="modal-form"><label>世界名称<input id="nwName" value="RPG虚空副本"></label><label>保存目录<div style="display:flex;gap:6px"><input id="nwPath" readonly placeholder="选择空目录"><button class="btn subtle" id="nwChoose">选择</button></div></label><label>地形预设<select id="nwPreset"><option value="void">全虚空 · RPG 副本（默认）</option><option value="flat">平坦</option><option value="natural">自然丘陵</option><option value="mountain">山地区域</option></select></label><p class="panel-desc">虚空模式不生成地面、基岩或出生平台，只保留后续建造的副本。尺寸只用于其他地形预设。进入游戏前请先建造安全出生点。</p><label>地形尺寸<select id="nwSize" disabled><option>512</option><option>1024</option><option>2048</option><option>4096</option></select></label><label>建造参考高度 / 地面高度<input id="nwHeight" type="number" min="4" max="220" value="64"></label><div class="modal-actions"><button class="btn subtle" id="nwCancel">取消</button><button class="btn primary" id="nwCreate">创建世界</button></div></div>`,()=>{
    $('#nwPreset').onchange=()=>{$('#nwSize').disabled=$('#nwPreset').value==='void'}
    $('#nwChoose').onclick=async()=>{$('#nwPath').value=await ZXNative.chooseCreateWorldFolder()||''};$('#nwCancel').onclick=closeModal;$('#nwCreate').onclick=async()=>{try{const dir=$('#nwPath').value;if(!dir)throw new Error('请选择保存目录');const name=$('#nwName').value.trim()||'照献新世界';closeModal();toast('正在生成世界，请稍候…');const created=await ZXNative.createWorld({parentPath:dir,name,size:+$('#nwSize').value,preset:$('#nwPreset').value,baseHeight:+$('#nwHeight').value});await loadWorld(created.project.worldPath,'overworld')}catch(e){toast(errMsg(e),true)}}
  })
}
async function importSchematic(){
 if(!state.project)return toast('先打开世界',true);const file=await ZXNative.openSchematicDialog();if(!file)return
 modal('后台导入蓝图',`<div class="modal-form"><p>MCEdit Alpha / Java 1.12.2 · 完成后核对写入结果，可取消恢复。</p><label>X<input id="scX" type="number" value="${state.current.x}"></label><label>Y<input id="scY" type="number" value="${state.current.y}"></label><label>Z<input id="scZ" type="number" value="${state.current.z}"></label><label><input id="scAir" type="checkbox"> 同时粘贴空气（会清除蓝图内原有方块）</label><button class="btn primary" id="scPaste">开始任务</button><button class="btn subtle" id="scCancel">取消</button></div>`,()=>{
 $('#scCancel').onclick=closeModal;$('#scPaste').onclick=async()=>{const button=$('#scPaste');button.disabled=true;try{const spec={path:file,x:Number($('#scX').value),y:Number($('#scY').value),z:Number($('#scZ').value),includeAir:$('#scAir').checked};await ZXNative.startJob({kind:'import',name:path.basename(file),spec});closeModal();showPanel('tasks')}catch(e){toast(errMsg(e),true);button.disabled=false}}
 })
}

async function exportModal(){if(!state.project)return toast('请先打开世界',true);modal('导出',`<div class="modal-form"><p class="panel-desc">可以导出完整 1.12.2 世界副本、建筑 .schematic 或当前预览图。完整世界副本不会覆盖原目录。</p><button class="btn primary full" id="exWorld">导出完整世界副本</button><button class="btn subtle full" id="exSchematic">导出当前选区 .schematic</button><button class="btn subtle full" id="exPreview">导出当前画面 PNG</button><button class="btn subtle full" id="exOpen">打开当前世界目录</button></div>`,()=>{
  $('#exWorld').onclick=async()=>{try{const dir=await ZXNative.chooseExportFolder();if(!dir)return;const r=await ZXNative.exportWorldCopy({parentPath:dir,name:`${state.project.name}_ZX导出_${Date.now()}`});toast(`完整世界已导出：${r.path}`);closeModal()}catch(e){toast(errMsg(e),true)}}
  $('#exSchematic').onclick=async()=>{if(!state.selection)return toast('请先建立选区',true);const dir=await ZXNative.chooseExportFolder();if(!dir)return;const out=path.join(dir,`照献建筑-${Date.now()}.schematic`);try{const r=await ZXNative.exportSchematic({...state.selection,path:out});toast(`已导出 ${r.path||out}`);closeModal()}catch(e){toast(errMsg(e),true)}}
  $('#exPreview').onclick=async()=>{const p=await ZXNative.capturePreview();toast(`预览已保存：${p}`)}
  $('#exOpen').onclick=async()=>{try{await ZXNative.openPath(state.project.worldPath)}catch(e){toast(errMsg(e),true)}}
})}

async function executeEdit(){if(!state.project)return toast('请先打开世界',true);const a=state.selectedAction,b=boxFromInputs(),block=$('#blockInput').value.trim()||'stonebrick',radius=+$('#radiusInput').value||18,strength=+$('#strengthInput').value||5,width=+$('#widthInput').value||7,c=state.current;let name,p
  if(a==='raise'){name='raise_terrain';p={x:c.x,z:c.z,radius,strength}}
  else if(a==='lower'){name='lower_terrain';p={x:c.x,z:c.z,radius,strength}}
  else if(a==='smooth'){name='smooth_terrain';p={...b,iterations:Math.max(1,Math.min(4,Math.round(strength/3))),blend:.65}}
  else if(a==='flatten'){name='flatten';p={...b,y:c.y,topBlock:block}}
  else if(a==='mountain'){name='generate_mountain';p={x:c.x,z:c.z,radius,height:strength*5,topBlock:'grass',innerBlock:'stone'}}
  else if(a==='valley'){name='create_valley';p={x:c.x,z:c.z,radius,depth:strength*3}}
  else if(a==='river'){name='create_river';p={points:[{x:b.x1,z:b.z1},{x:b.x2,z:b.z2}],width,depth:strength}}
  else if(a==='lake'){name='create_lake';p={x:c.x,z:c.z,radiusX:radius,radiusZ:Math.max(2,Math.round(radius*.75)),depth:strength}}
  else if(a==='road'){name='create_road';p={points:[{x:b.x1,z:b.z1},{x:b.x2,z:b.z2}],width,block}}
  else if(a==='fill'){name='fill';p={...b,block}}
  else if(a==='wall'){name='create_wall';p={x1:b.x1,z1:b.z1,x2:b.x2,z2:b.z2,y:b.y1,height:strength,thickness:Math.max(1,Math.min(8,Math.round(width/4))),block}}
  else if(a==='floor'){name='create_floor';p={x1:b.x1,x2:b.x2,z1:b.z1,z2:b.z2,y:b.y1,block}}
  else if(a==='pillar'){name='create_pillar';p={x:c.x,y:c.y,z:c.z,height:strength,radius:Math.min(5,Math.max(0,Math.floor(width/5))),block}}
  else if(a==='roof'){name='create_gable_roof';p={x1:b.x1,x2:b.x2,z1:b.z1,z2:b.z2,y:b.y2+1,block,overhang:1}}
  else if(a==='tower'){name='create_tower';p={x:c.x,y:c.y,z:c.z,radius:Math.max(2,Math.min(30,Math.round(radius/3))),height:strength*3,block}}
  else if(a==='bridge'){name='create_bridge';p={x1:b.x1,y1:b.y1,z1:b.z1,x2:b.x2,y2:b.y2,z2:b.z2,width:Math.max(1,Math.min(18,width)),block}}
  else if(a==='boss'){name='create_boss_arena';p={x:c.x,y:c.y,z:c.z,radius:Math.max(6,Math.min(120,radius)),floorBlock:block}}
  else if(a==='trees'){name='scatter_trees';p={...b,density:Math.min(.25,Math.max(.001,width/1000))}}
  try{$('#statusMode').textContent=`执行 ${a}…`;const r=await ZXNative.executeTool(name,p);await refreshAfterEdit(`${name} 完成 · ${r.changed?.toLocaleString?.()??''}`);$('#statusMode').textContent='就绪'}catch(e){$('#statusMode').textContent='失败';toast(errMsg(e),true)}
}
async function addPlan(){if(!state.project)return toast('请先打开世界',true);const name=prompt('建筑方案名称，例如：听雨小筑');if(!name)return;const concept=prompt('设计理念（可留空）','');await ZXNative.executeTool('create_building_plan',{name,concept,bounds:state.selection});await refreshProjectUi();showPanel('plan')}
async function addPart(){const p=currentPlan();if(!p)return toast('请先创建建筑方案',true);const name=prompt('空间区域名称，例如：主殿');if(!name)return;const description=prompt('区域描述（可留空）','');await ZXNative.executeTool('add_building_part',{planId:p.id,name,description,bounds:state.selection});await refreshProjectUi()}
async function addMarker(){if(!state.project)return;const name=prompt('标记名称','新标记');if(!name)return;await ZXNative.executeTool('add_marker',{name,...state.current});await refreshProjectUi()}
async function protectSelection(){if(!state.selection)return toast('请先建立选区',true);const name=prompt('保护区域名称','重要区域');if(!name)return;await ZXNative.executeTool('add_protected_region',{name,...state.selection});await refreshProjectUi()}
async function updateConcept(){if(!state.project)return;const p=currentPlan();if(p){await ZXNative.executeTool('update_building_plan',{planId:p.id,concept:$('#conceptText').value});await refreshProjectUi()}else{await ZXNative.projectUpdate({concept:$('#conceptText').value});state.project.concept=$('#conceptText').value}}

async function updateMcpUi(){
  try{
    const info=await ZXNative.getBridgeInfo()
    if(info.needsLocation){$('#mcpLocation').textContent='尚未选择 MCP 安装位置；点击接入后先选择目录，不会默认安装到 C 盘。';$('#mcpSnippet').textContent='选择位置并完成安装后生成配置。';return}
    $('#mcpLocation').textContent='安装目标：'+path.dirname(info.mcpCommand)
    $('#bridgeUrl').textContent=`127.0.0.1:${info.port}`
    $('#bridgeState').textContent=state.project?`当前：${state.project.name}`:'未连接世界'
    const cmd=(info.mcpCommand||info.node||'node').replace(/\\/g,'\\\\')
    const server=(info.mcpServer||path.join(__dirname,'..','..','mcp','server.mjs')).replace(/\\/g,'\\\\')
    const snippet=`[mcp_servers.zx-engineering]\ncommand = "${cmd}"\nargs = ["${server}"]\nenv = { ELECTRON_RUN_AS_NODE = "1" }\nenabled = true\nstartup_timeout_sec = 20\ntool_timeout_sec = 180`
    $('#mcpSnippet').textContent=snippet
  }catch(e){console.warn(e)}
}

function bindUi(){
  bindWorkbench()
  $('#cacheRefresh').onclick=()=>refreshCacheUi().catch(e=>toast(errMsg(e),true))
  $('#cacheSave').onclick=async()=>{try{await ZXNative.cacheSave({auto:$('#cacheAuto').checked,days:+$('#cacheDays').value,maxMB:+$('#cacheMax').value});await refreshCacheUi();toast('缓存设置已保存')}catch(e){toast(errMsg(e),true)}}
  $('#cacheChoose').onclick=async()=>{try{if(await ZXNative.cacheChoose()){await refreshCacheUi();toast('缓存目录已设置，保存世界并重启软件后生效')}}catch(e){toast(errMsg(e),true)}}
  $('#cacheClear').onclick=async()=>{if(!confirm('清理可重建的预览和界面缓存？下次预览可能稍慢，地图和撤销记录不受影响。'))return;const b=$('#cacheClear');b.disabled=true;try{const r=await ZXNative.cacheClear();await refreshCacheUi();toast(`清理完成${r.failed?'，'+r.failed+' 个被占用文件暂未清理':''}`)}catch(e){toast(errMsg(e),true)}finally{b.disabled=false}}
  const installMcp=async(chooseLocation=false)=>{
    const button=$('#btnInstallMcp'),choose=$('#btnMcpLocation'),status=$('#mcpInstallStatus');button.disabled=true;choose.disabled=true;button.textContent='正在安装并检测…'
    status.textContent='正在准备内置运行环境，首次可能需要一分钟，请勿关闭软件。'
    try{const r=await ZXNative.installCodexMcp(chooseLocation);if(r.canceled){status.textContent='已取消，安装位置和配置未改变。';return}await updateMcpUi();$('#mcpSnippet').textContent=r.snippet;status.textContent=`接入配置成功，已检测到 ${r.toolCount} 个工具。请重启 Codex。固定安装目录：${path.dirname(r.command)}${r.cleanupPending?'；旧备份被占用，请关闭 Codex 后清理 previous 目录':''}`;toast('配置成功，请重启 Codex')}
    catch(e){status.textContent='接入未完成：'+e.message;toast('接入失败，请查看 MCP 面板提示')}
    finally{button.disabled=false;choose.disabled=false;button.textContent='一键接入 / 重新检测'}
  }
  $('#btnInstallMcp').onclick=()=>installMcp(false)
  $('#btnMcpLocation').onclick=()=>installMcp(true)
  $('#panSensitivity').addEventListener('input',()=>{const value=Number($('#panSensitivity').value);if(state.project&&Number.isFinite(value)&&value>=.05&&value<=3)state.project.ui={...(state.project.ui||{}),panSensitivity:value}})
  $('#panSensitivity').addEventListener('change',async()=>{const value=Number($('#panSensitivity').value);if(!Number.isFinite(value)||value<.05||value>3){$('#panSensitivity').value=String(state.project?.ui?.panSensitivity??.6);return toast('平移灵敏度范围为 0.05–3',true)}if(state.project){try{await ZXNative.projectUpdate({ui:{panSensitivity:value}});toast('平移灵敏度已保存')}catch(e){toast(errMsg(e),true)}}})
  $('#renderScale').addEventListener('change',()=>{if(state.renderer){state.renderer.setPixelRatio(Math.min((window.devicePixelRatio||1)*Number($('#renderScale').value),2.5));state.renderer.setSize($('#viewport').clientWidth,$('#viewport').clientHeight,false)}})
  $('#goLocation').onclick=()=>showDetail({x:safeInt($('#goX').value),y:safeInt($('#goY').value,80),z:safeInt($('#goZ').value)})
  $('#btnOpen').onclick=$('#emptyOpen').onclick=openWorld;$('#btnNew').onclick=$('#emptyNew').onclick=newWorldModal;$('#btnSchematic').onclick=importSchematic;$('#btnExport').onclick=exportModal
  $('#btnUndo').onclick=async()=>{if(!state.project)return;try{const r=await ZXNative.undo();if(r.ok)await refreshAfterEdit('已撤销最近一次事务');else toast(r.message||'没有历史')}catch(e){toast(errMsg(e),true)}}
  $('#btnFit').onclick=fitCamera;$('#btnCapture').onclick=async()=>{const p=await ZXNative.capturePreview();toast(`预览已保存：${p}`)};$('#enterDetail').onclick=()=>showDetail(state.current).catch(e=>toast(errMsg(e),true))
  $$('.view-tab').forEach(b=>b.onclick=async()=>{
    const v=b.dataset.view
    try{
      if(v==='walk'){const entry=state.project?.markers?.find(m=>m.type==='spawn')||state.current;await showDetail(entry,true,false,true);return}
      if(state.view==='walk'){state.view=v;state.controls?.dispose();if(v==='front')await showDetail(state.current,false,false,false)}
      if(v==='front'){
        if(state.mode!=='detail')await showDetail(state.current,false)
        if(state.detail){const c=state.controls.target,size=state.camera.userData.frustumSize;state.camera.position.set(c.x,c.y,c.z+size);state.controls.update();state.view='front';updateViewTabs()}
        return
      }
      if(state.project){state.project.ui={...(state.project.ui||{}),previewMode:v};await ZXNative.projectUpdate({ui:{previewMode:v}})}
      if(v==='detail')await showDetail(state.current,false)
      else await showOverview(v)
    }catch(e){toast(errMsg(e),true)}
  })
  $$('.ins-tab').forEach(b=>b.onclick=()=>showPanel(b.dataset.panel));$$('.rail-btn').forEach(b=>b.onclick=()=>{ $$('.rail-btn').forEach(x=>x.classList.toggle('active',x===b)); const t=b.dataset.tool;if(t==='mcp')showPanel('mcp');else if(t==='settings')showPanel('world');else if(['terrain','build','select'].includes(t))showPanel('edit') })
  $('#planSelect').onchange=renderParts;$('#btnAddPlan').onclick=addPlan;$('#btnAddPart').onclick=addPart;$('#conceptText').addEventListener('change',updateConcept);$('#btnMaterialStats').onclick=materialStats
  $$('.tool-grid button').forEach(b=>b.onclick=()=>{$$('.tool-grid button').forEach(x=>x.classList.toggle('active',x===b));state.selectedAction=b.dataset.action});$$('.tool-grid button')[0]?.classList.add('active');$('#btnExecuteEdit').onclick=executeEdit
  $('#btnUseCursor').onclick=()=>setSelection({x1:state.current.x-8,y1:Math.max(0,state.current.y-4),z1:state.current.z-8,x2:state.current.x+8,y2:Math.min(255,state.current.y+12),z2:state.current.z+8})
  $('#btnAddMarker').onclick=addMarker;$('#btnProtectSelection').onclick=protectSelection;$('#btnChooseResource').onclick=chooseResourcePack;$('#btnAutoResource').onclick=autoResourcePack;$('#dimensionSelect').onchange=async()=>{if(!state.project)return;const d=$('#dimensionSelect').value;try{await loadWorld(state.project.worldPath,d)}catch(e){toast(errMsg(e),true);$('#dimensionSelect').value=state.project.dimension||'overworld'}}
  $('#btnCopyMcp').onclick=()=>{clipboard.writeText($('#mcpSnippet').textContent);toast('Codex MCP 配置已复制')};$('#btnCaptureMcp').onclick=async()=>{const p=await ZXNative.capturePreview();toast(`预览已保存：${p}`)}
  const saveQuality=async()=>{if(!state.project)return false;let radius;try{radius=previewRadius($('#detailDistance').value)}catch(e){toast(e.message,true);return false}const ui={overviewSample:+$('#overviewQuality').value,viewDistance:radius,renderScale:+$('#renderScale').value,showGrid:$('#showGrid').checked,showBarriers:$('#showBarriers').checked};const p=await ZXNative.projectUpdate({ui});state.project=p;toast('显示设置已保存');return true};['overviewQuality','renderScale','showGrid'].forEach(id=>$('#'+id)?.addEventListener('change',()=>saveQuality().catch(e=>toast(errMsg(e),true))));$('#btnRescanWorld').onclick=async()=>{if(await saveQuality())await scanOverview(true)}
  $('#detailDistance').addEventListener('input',updateDistanceHint)
  $('#detailDistance').addEventListener('change',()=>saveQuality().catch(e=>toast(errMsg(e),true)))
  $('#showBarriers').addEventListener('change',async()=>{try{if(await saveQuality()){if(state.mode==='detail')await showDetail(state.current,!!state.navigation,true);else await scanOverview(false)}}catch(e){toast(errMsg(e),true)}})
  $('#btnApplyDistance').onclick=async()=>{try{if(await saveQuality()){if(state.mode==='detail')await showDetail(state.current,!!state.navigation,true);else toast('范围已保存，进入地图导航或建筑预览时生效')}}catch(e){toast(errMsg(e),true)}}
  $('#modalClose').onclick=closeModal;$('#modalBackdrop').addEventListener('click',e=>{if(e.target===$('#modalBackdrop'))closeModal()})
  ZXNative.onRefreshRequested(async(d)=>{try{const p=await ZXNative.projectGet();if(!p)return;if(p.worldPath!==state.project?.worldPath||p.dimension!==state.project?.dimension)await loadWorld(p.worldPath,p.dimension);else{await refreshProjectUi();await refreshAfterEdit(d?.reason||'外部 AI 已修改地图')}}catch(e){toast(errMsg(e),true)}})
  ZXNative.onFocusRequested(d=>{setCurrent(d.x,d.y,d.z);showDetail(state.current).catch(e=>toast(errMsg(e),true))})
}

async function boot(){bindUi();renderMaterialCoords();await updateMcpUi();await ensureResourceUi(true);try{const p=await ZXNative.projectGet();if(p?.worldPath&&fs.existsSync(p.worldPath)){state.project=p;$('#emptyState').classList.add('hidden');$('#worldCard').classList.remove('hidden');await refreshProjectUi();await scanOverview(false)}}catch(e){console.warn('restore project:',e)}}
boot()
