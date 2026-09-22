const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {WorldEngine}=require('../src/core/world-engine.cjs')
;(async()=>{const w=new WorldEngine(fs.mkdtempSync(path.join(os.tmpdir(),'zx-agent-test-')))
 try{
 await w.createWorld();await assert.rejects(w.applyBlocks({blocks:[{x:0,y:64,z:0,id:1},{x:1,y:999,z:0,id:1}]}));assert.equal((await w.raw.getBlock(0,64,0)).id,0)
 await w.applyBlocks({name:'stage 1',blocks:[{x:0,y:64,z:0,id:169}]});assert.equal((await w.raw.getBlock(0,64,0)).id,169)
 await w.applyBlocks({name:'stage 2',blocks:[{x:0,y:64,z:0,id:98}]});await w.undo();assert.equal((await w.raw.getBlock(0,64,0)).id,169)
 await w.runTool('begin_transaction',{name:'rollback check'});await w.applyBlocks({blocks:[{x:0,y:64,z:0,id:1}]});await w.runTool('rollback_transaction',{});assert.equal((await w.raw.getBlock(0,64,0)).id,169)
 await w.addProtectedRegion({name:'protected',x1:0,x2:1,y1:0,y2:255,z1:0,z2:1});await assert.rejects(w.applyBlocks({blocks:[{x:0,y:64,z:0,id:1}]}),/保护区域/)
 console.log('PASS: batch validation before writes, stage undo, transaction rollback, protected areas')
 }finally{await w.raw.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
