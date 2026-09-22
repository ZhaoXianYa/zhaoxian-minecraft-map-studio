const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),zlib=require('node:zlib'),nbt=require('prismarine-nbt')
const {WorldEngine}=require('../src/core/world-engine.cjs')
const {scanWorldOverview}=require('../src/core/overview-scan.cjs')
;(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'zx-void-test-')),engine=new WorldEngine(dir)
 try{
  const result=await engine.createWorld({name:'虚空验证',size:4096})
  assert.equal(result.preset,'void')
  assert.equal(fs.readdirSync(path.join(dir,'region')).filter(f=>f.endsWith('.mca')).length,0)
  const d=nbt.parseUncompressed(zlib.gunzipSync(fs.readFileSync(path.join(dir,'level.dat')))).value.Data.value
  assert.equal(d.generatorName.value,'flat');assert.equal(d.generatorOptions.value,'3;minecraft:air;1;');assert.equal(d.MapFeatures.value,0)
  const overview=await scanWorldOverview(dir,'overworld',1);assert.equal(overview.chunks,0)
  await engine.fill({x1:0,y1:64,z1:0,x2:3,y2:64,z2:3,block:'stonebrick'})
  assert.equal((await engine.raw.getBlock(0,64,0)).id,98)
  for(const p of [[0,0,0],[4,64,0],[0,63,0],[10000,64,10000]])assert.equal((await engine.raw.getBlock(...p)).id,0)
  console.log('PASS: default void, no terrain regions, air-only generator, 16-block build with surrounding void',dir)
 }finally{await engine.raw.close()}
})().catch(e=>{console.error(e);process.exitCode=1})
