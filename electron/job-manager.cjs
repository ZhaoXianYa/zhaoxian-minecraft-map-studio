const fs=require('fs'),path=require('path'),{Worker}=require('worker_threads'),{randomUUID}=require('crypto')
const {WorldEngine}=require('../src/core/world-engine.cjs')
class JobManager{
 constructor(onChange=()=>{}){this.onChange=onChange;this.running=null}
 directory(world){return path.join(world,'.zxproject','jobs')}
 save(job){const dir=this.directory(job.worldPath);fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,job.id+'.json');job.updatedAt=new Date().toISOString();fs.writeFileSync(file+'.tmp',JSON.stringify(job,null,2));fs.renameSync(file+'.tmp',file)}
 read(world,id){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('任务编号无效');const j=JSON.parse(fs.readFileSync(path.join(this.directory(world),id+'.json')));if(path.resolve(j.worldPath)!==path.resolve(world)||j.id!==id)throw new Error('任务不属于当前世界');return j}
 list(world){const dir=this.directory(world);if(!fs.existsSync(dir))return [];return fs.readdirSync(dir).filter(f=>/^[a-f0-9-]{36}\.json$/.test(f)).map(f=>{
  const j=this.read(world,f.slice(0,-5));if(['running','canceling'].includes(j.status)&&this.running?.job.id!==j.id){j.status='interrupted';j.error='软件上次关闭时任务未结束，请恢复重试或取消并恢复';this.save(j)}return j
 }).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))}
 assertIdle(world){if(this.running)throw new Error('大任务执行中，请等待完成或先取消');if(world&&this.list(world).some(j=>j.status==='interrupted'||j.status==='recovery-needed'))throw new Error('存在中断任务，请先在任务面板恢复重试或取消恢复')}
 async start(world,dimension,p){
  this.assertIdle(world);if(!['import','check'].includes(p.kind))throw new Error('任务类型无效')
  const engine=new WorldEngine(world,dimension);try{if(engine.tx.active())throw new Error('请先提交或回滚当前事务')}finally{await engine.raw.close()}
  const job={id:randomUUID(),worldPath:world,dimension,kind:p.kind,name:p.name|| (p.kind==='import'?'蓝图导入':'地图检查'),spec:structuredClone(p.spec||{}),createdAt:new Date().toISOString(),status:'running',progress:{done:0,total:1,phase:'准备'}}
  if(job.kind==='import'){
   const source=path.resolve(job.spec.path||'');if(!fs.statSync(source).isFile()||fs.statSync(source).size>64*1024*1024)throw new Error('请选择不超过 64 MB 的蓝图文件')
   const dir=path.join(this.directory(world),job.id);fs.mkdirSync(dir,{recursive:true});const input=path.join(dir,'input.schematic');fs.copyFileSync(source,input);job.sourcePath=source;job.spec.path=input
  }
  this.launch(job);return job
 }
 launch(job){
  const cancel=new SharedArrayBuffer(4);job.status='running';job.error=null;job.progress={done:0,total:1,phase:'准备'};this.save(job)
  const worker=new Worker(path.join(__dirname,'../src/core/job-worker.cjs'),{workerData:{job,cancel}});this.running={job,worker,cancel}
  let final=false
  worker.on('message',m=>{
   if(m.type==='progress')job.progress=m.progress
   if(m.type==='transaction')job.txId=m.txId
   if(m.type==='complete'){job.status='completed';job.result=m.result;job.progress={done:1,total:1,phase:'完成'};final=true}
   if(m.type==='failed'){job.status=m.rolledBack||job.kind==='check'||!job.txId?(m.canceled?'canceled':'failed'):'recovery-needed';job.error=m.error;job.rolledBack=m.rolledBack;final=true}
   this.save(job);this.onChange(job,false)
  })
  worker.on('error',e=>{job.error=e.message})
  worker.on('exit',code=>{if(!final){job.status='interrupted';job.error=job.error||'任务线程中断（'+code+'），需要恢复';this.save(job)}this.running=null;this.onChange(job,true)})
 }
 async recover(world,id,retry){
  if(this.running){if(this.running.job.id!==id)throw new Error('另一个任务正在运行');if(retry)throw new Error('请先等待任务停止');Atomics.store(new Int32Array(this.running.cancel),0,1);this.running.job.status='canceling';this.save(this.running.job);return this.running.job}
  this.list(world)
  const job=this.read(world,id);if(!['interrupted','recovery-needed','failed','canceled'].includes(job.status))throw new Error('该任务不需要恢复')
  const engine=new WorldEngine(world,job.dimension)
  try{
   const tx=engine.tx.active()
   if(tx){if(!tx.name.startsWith('任务 '+job.id+' · '))throw new Error('当前事务不属于此任务，已停止恢复');await engine.rollbackTransaction()}
   const committed=engine.tx.list().find(t=>t.id===job.txId&&t.state==='applied')
   if(committed){job.status='completed';job.result={ok:true,changed:committed.changed,recovered:true};this.save(job);return job}
  }finally{await engine.raw.close()}
  job.status='canceled';job.rolledBack=true;this.save(job)
  if(retry){this.assertIdle(world);this.launch(job)}return job
 }
}
module.exports={JobManager}
