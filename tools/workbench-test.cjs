const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict')
const {WorldEngine}=require('../src/core/world-engine.cjs')
const {writeLegacySchematic}=require('../src/core/legacy-schematic.cjs')
const {JobManager}=require('../electron/job-manager.cjs')
const {checkMap}=require('../src/core/map-check.cjs')
const root=fs.mkdtempSync(path.join(__dirname,'../../workbench-test-')),world=path.join(root,'world')
const delay=ms=>new Promise(r=>setTimeout(r,ms))
async function wait(jobs){for(let i=0;i<600&&jobs.running;i++)await delay(50);assert(!jobs.running,'Job did not stop')}
;(async()=>{
 let e=new WorldEngine(world);await e.createWorld({preset:'void'})
 const source=path.join(root,'sample.schematic');fs.writeFileSync(source,writeLegacySchematic({width:3,height:1,length:1,blocks:Buffer.from([0,98,109]),data:Buffer.from([0,1,3])}))
 const imported=await e.placeSchematic({path:source,x:0,y:0,z:0});assert.equal(imported.verified,2);assert.deepEqual(await e.raw.getBlock(1,0,0),{id:98,data:1});assert.deepEqual(await e.raw.getBlock(2,0,0),{id:109,data:3})
 await e.setBlock({x:5,y:40,z:5,block:1});await e.setBlock({x:5,y:70,z:5,block:98});assert.equal((await e.raw.getHighest(5,5)).y,70)
 assert((await e.undo()).ok);assert.equal((await e.raw.getBlock(5,70,5)).id,0);assert((await e.undo()).ok);assert.equal((await e.raw.getBlock(5,40,5)).id,0)
 assert((await e.redo()).ok);assert.equal((await e.raw.getBlock(5,40,5)).id,1);assert((await e.redo()).ok);assert.equal((await e.raw.getBlock(5,70,5)).id,98)
 await e.undo();await e.setBlock({x:6,y:40,z:5,block:1});assert.equal((await e.redo()).ok,false)
 // A stepped route that needs no jump, and a deliberately reversed stair.
 await e.fill({x1:10,x2:18,y1:40,y2:40,z1:10,z2:14,block:1});await e.fill({x1:15,x2:18,y1:41,y2:41,z1:10,z2:14,block:98});await e.fill({x1:14,x2:14,y1:41,y2:41,z1:10,z2:14,block:{id:109,data:0}})
 const options={bounds:{x1:10,x2:18,y1:39,y2:45,z1:10,z2:14},points:[{name:'start',x:11,y:41,z:12},{name:'end',x:17,y:42,z:12}]}
 let report=await checkMap(e,options);assert.equal(report.counts['路线']||0,0);assert.equal(report.counts['点位']||0,0)
 await e.fill({x1:14,x2:14,y1:41,y2:41,z1:10,z2:14,block:{id:109,data:1}});report=await checkMap(e,options);assert(report.counts['楼梯']>0);assert(report.counts['路线']>0)
 await e.raw.close()
 const jobs=new JobManager();let job=await jobs.start(world,'overworld',{kind:'import',spec:{path:source,x:30,y:40,z:0}});assert.throws(()=>jobs.assertIdle(world));await wait(jobs);assert.equal(jobs.read(world,job.id).status,'completed')
 e=new WorldEngine(world);assert.equal((await e.raw.getBlock(31,40,0)).id,98);await e.raw.close()
 // Cancellation after a chunk write restores the original world, then retry works.
 const large=path.join(root,'large.schematic');fs.writeFileSync(large,writeLegacySchematic({width:64,height:16,length:64,blocks:Buffer.alloc(65536,1),data:Buffer.alloc(65536)}))
 let canceled=false;const cancelJobs=new JobManager(j=>{if(!canceled&&j.progress?.done>0&&j.status==='running'){canceled=true;cancelJobs.recover(world,j.id,false).catch(console.error)}})
 job=await cancelJobs.start(world,'overworld',{kind:'import',spec:{path:large,x:64,y:40,z:64}});await wait(cancelJobs);assert.equal(cancelJobs.read(world,job.id).status,'canceled')
 e=new WorldEngine(world);assert.equal((await e.raw.getBlock(64,40,64)).id,0);assert.equal(e.tx.active(),null);await e.raw.close()
 cancelJobs.onChange=()=>{};await cancelJobs.recover(world,job.id,true);await wait(cancelJobs);assert.equal(cancelJobs.read(world,job.id).status,'completed')
 // Simulate a terminated worker after writing one cell, then recover after restart.
 job=await jobs.start(world,'overworld',{kind:'check',spec:options});await wait(jobs);job=jobs.read(world,job.id);job.kind='import';job.status='running';job.spec={path:source,x:90,y:90,z:0}
 e=new WorldEngine(world);const tx=e.tx.begin('任务 '+job.id+' · 中断模拟');job.txId=tx.id;e.tx.backupBox({x1:90,x2:90,y1:90,y2:90,z1:0,z2:0});await e.raw.editBlocks([{x:90,y:90,z:0,id:41,data:0}]);await e.raw.close();jobs.save(job)
 const reopened=new JobManager();assert.equal(reopened.list(world).find(j=>j.id===job.id).status,'interrupted');await reopened.recover(world,job.id,false)
 e=new WorldEngine(world);assert.equal((await e.raw.getBlock(90,90,0)).id,0);await e.raw.close()
 console.log('PASS: native ID/Data + Y=0; heightmap; undo/redo branch; half-step route; reversed stair; async job; cancellation rollback; retry; interrupted recovery')
 console.log(root)
})().catch(e=>{console.error(e);process.exitCode=1})
