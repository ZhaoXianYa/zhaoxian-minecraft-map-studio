'use strict'
const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),THREE=require('three'),path=require('path')
const code=fs.readFileSync(path.join(__dirname,'../src/renderer/app.js'),'utf8')
const ctx={THREE,Buffer,state:{project:{ui:{panSensitivity:1}}}}
vm.createContext(ctx)
vm.runInContext(code.slice(code.indexOf('function decodeTyped'),code.indexOf('function buildRegionGeometry'))+code.slice(code.indexOf('function buildTopRegion'),code.indexOf('function makeOverviewControls'))+';this.Controls=ZXOrbitControls',ctx)
const dom={clientHeight:1000,addEventListener(){},removeEventListener(){}}
const camera=new THREE.OrthographicCamera(-100,100,100,-100,.1,1000);camera.position.set(0,100,100)
const control=new ctx.Controls(camera,dom);control.update();control._pan(100,0);assert(Math.abs(control.target.x+20)<1e-8)
camera.zoom=2;control._pan(100,0);assert(Math.abs(control.target.x+30)<1e-8)
ctx.state.project.ui.panSensitivity=.5;control._pan(100,0);assert(Math.abs(control.target.x+35)<1e-8)
ctx.blockColor=()=>[.5,.5,.5]
const b64=a=>Buffer.from(a.buffer).toString('base64')
const r={rx:0,rz:0,res:2,sample:256,block:b64(new Uint16Array([1,1,1,1])),data:b64(new Uint8Array(4)),height:b64(new Uint8Array(4)),valid:b64(new Uint8Array([1,1,1,1]))}
const left=ctx.buildTopRegion(r),right=ctx.buildTopRegion({...r,rx:1});assert.equal(left.position.x+256,right.position.x-256)
assert.equal(left.material.map.magFilter,THREE.NearestFilter);assert.equal(left.material.map.image.data.length,16)
console.log('PASS: screen-space panning, zoom scaling, sensitivity, seamless nearest-filtered top map')
