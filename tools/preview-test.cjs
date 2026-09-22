'use strict'
const assert = require('node:assert/strict')
const { collectDetailBlocks, shouldExposeFace } = require('../src/core/detail-mesh.cjs')
const { setBlockInRaw, getBlockFromRaw, highestBlockRaw } = require('../src/core/raw-world.cjs')
const { INVISIBLE } = require('../src/core/preview-visibility.cjs')
;(async () => {
  for (const id of [44, 53, 67, 126, 134, 156, 203]) assert(shouldExposeFace({ id: 1 }, { id }), `邻面不能被 ${id} 完全遮住`)
  assert.equal(shouldExposeFace({ id: 1 }, { id: 1 }), false)
  const raw = { value: { Level: { value: {} } } }
  for(let z=0;z<16;z++) for(let x=0;x<16;x++) setBlockInRaw(raw,x,64,z,1)
  const result = await collectDetailBlocks({ loadRaw: async () => raw }, { radiusChunks:4, maxBlocks:10000 })
  assert.equal(result.blocks.length, 81*256, '旧的上限不得截断方块')
  assert.equal(result.truncated,false)
  setBlockInRaw(raw,0,180,0,166)
  setBlockInRaw(raw,0,181,0,217)
  assert.equal(highestBlockRaw(raw,0,0,INVISIBLE).y,64)
  for(const id of [166,217]) assert(shouldExposeFace({id:1},{id}))
  const visible = await collectDetailBlocks({loadRaw:async()=>raw},{radiusChunks:1,closeBoundary:false})
  assert(!visible.blocks.some(b=>INVISIBLE.has(b[3])))
  const shown=await collectDetailBlocks({loadRaw:async()=>raw},{radiusChunks:1,showBarriers:true});assert(shown.blocks.some(b=>b[3]===166));assert(!shown.blocks.some(b=>b[3]===217));
  assert.equal(getBlockFromRaw(raw,0,180,0).id,166,'预览不得修改世界屏障')
  const fs = require('node:fs'), vm = require('node:vm'), THREE = require('three')
  const source=fs.readFileSync(require('node:path').join(__dirname,'../src/renderer/app.js'),'utf8')
  const sandbox={THREE};vm.createContext(sandbox)
  vm.runInContext(source.slice(source.indexOf('function addFace('),source.indexOf('function buildFaceGeometry(')),sandbox)
  for(let dir=0;dir<6;dir++) {
    const b={pos:[],nor:[],uv:[],idx:[]};sandbox.addFace(b,0,0,0,dir)
    const a=new THREE.Vector3(...b.pos.slice(0,3)),c=new THREE.Vector3(...b.pos.slice(3,6)),d=new THREE.Vector3(...b.pos.slice(6,9))
    assert(c.sub(a).cross(d.sub(a)).dot(new THREE.Vector3(...b.nor.slice(0,3)))>0,'三角形朝向必须朝外')
  }
  console.log('PASS: partial-block visibility, >20k complete blocks, six outward faces')
})().catch(e=>{console.error(e);process.exitCode=1})
