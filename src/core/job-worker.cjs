const {parentPort,workerData}=require('worker_threads')
const {WorldEngine}=require('./world-engine.cjs')
const {checkMap}=require('./map-check.cjs')
const job=workerData.job,flag=new Int32Array(workerData.cancel),engine=new WorldEngine(job.worldPath,job.dimension)
engine.checkCanceled=()=>{if(Atomics.load(flag,0))throw new Error('用户取消任务')}
let last=0
engine.progress=p=>{engine.checkCanceled();if(Date.now()-last>150||p.done===p.total){last=Date.now();parentPort.postMessage({type:'progress',progress:p})}}
;(async()=>{
 try{
  if(engine.tx.active())throw new Error('当前世界存在未结束事务')
  if(job.kind==='import'){const tx=engine.tx.begin('任务 '+job.id+' · '+job.name);parentPort.postMessage({type:'transaction',txId:tx.id})}
  engine.checkCanceled()
  const result=job.kind==='import'?await engine.placeSchematic(job.spec):await checkMap(engine,job.spec)
  engine.checkCanceled()
  if(job.kind==='import')engine.tx.commit()
  parentPort.postMessage({type:'complete',result})
 }catch(e){
  let rolledBack=false,error=e.message
  try{const tx=engine.tx.active();if(tx&&tx.name.startsWith('任务 '+job.id+' · ')){await engine.rollbackTransaction();rolledBack=true}}catch(re){error+='；恢复失败：'+re.message}
  parentPort.postMessage({type:'failed',error,rolledBack,canceled:!!Atomics.load(flag,0)})
 }finally{await engine.raw.close()}
})()
