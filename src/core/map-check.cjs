const {normalizeBox}=require('./protection.cjs')
const {getBlockFromRaw,mod,floorDiv}=require('./raw-world.cjs')
const STAIRS=new Set([53,67,108,109,114,128,134,135,136,156,163,164,180,203])
const DIRS=[[1,0],[-1,0],[0,1],[0,-1]]
async function checkMap(engine,opt){
 const b=normalizeBox(opt.bounds||opt),w=b.x2-b.x1+1,h=b.y2-b.y1+1,d=b.z2-b.z1+1
 if(w*h*d>1500000)throw new Error('检查选区超过 150 万格，请按房间或路线分区检查')
 const ids=new Uint16Array(w*h*d),meta=new Uint8Array(ids.length),at=(x,y,z)=>((y-b.y1)*d+z-b.z1)*w+x-b.x1
 const inside=(x,y,z)=>x>=b.x1&&x<=b.x2&&y>=b.y1&&y<=b.y2&&z>=b.z1&&z<=b.z2
 let chunks=0,total=(floorDiv(b.x2,16)-floorDiv(b.x1,16)+1)*(floorDiv(b.z2,16)-floorDiv(b.z1,16)+1)
 for(let cz=floorDiv(b.z1,16);cz<=floorDiv(b.z2,16);cz++)for(let cx=floorDiv(b.x1,16);cx<=floorDiv(b.x2,16);cx++){
  engine.checkCanceled?.();const raw=await engine.raw.loadRaw(cx,cz,false)
  if(raw)for(let z=Math.max(b.z1,cz*16);z<=Math.min(b.z2,cz*16+15);z++)for(let x=Math.max(b.x1,cx*16);x<=Math.min(b.x2,cx*16+15);x++)for(let y=b.y1;y<=b.y2;y++){const v=getBlockFromRaw(raw,mod(x,16),y,mod(z,16)),i=at(x,y,z);ids[i]=v.id;meta[i]=v.data}
  engine.progress?.({done:++chunks,total,phase:'读取检查区域'});await new Promise(r=>setImmediate(r))
 }
 const get=(x,y,z)=>inside(x,y,z)?{id:ids[at(x,y,z)],data:meta[at(x,y,z)]}:{id:-1,data:0}
 const pass=id=>id===0||[6,31,32,37,38,39,40,50,55,59,63,65,68,69,70,72,75,76,77,83,104,105,106,111,115,131,132,141,142,143,147,148,149,150,157,171,175].includes(id)
 const findings=[],counts={},add=(type,message,x,y,z)=>{counts[type]=(counts[type]||0)+1;if(findings.length<200)findings.push({type,message,x,y,z})}
 // Half-block sampling models straight stairs/slabs. Doors, fences and corners
 // are conservatively blocked; this is not a substitute for a game-client test.
 function segments(id,m,sx,sz){
  if(pass(id))return []
  if([44,126,182,205].includes(id))return m&8?[[.5,1]]:[[0,.5]]
  if(STAIRS.has(id)){const high=[sx===1,sx===0,sz===1,sz===0][m&3];return m&4?(high?[[0,1]]:[[.5,1]]):(high?[[0,1]]:[[0,.5]])}
  return [[0,1]]
 }
 function clear(qx,foot,qz){const x=Math.floor(qx/2),z=Math.floor(qz/2),sx=mod(qx,2),sz=mod(qz,2);for(let y=Math.floor(foot);y<foot+1.8;y++){const v=get(x,y,z);for(const [lo,hi]of segments(v.id,v.data,sx,sz))if(y+hi>foot+.001&&y+lo<foot+1.8)return false}return true}
 const nodes=new Set(),key=(qx,fy,qz)=>qx+','+fy+','+qz
 let stairs=0
 for(let z=b.z1;z<=b.z2;z++){
  engine.checkCanceled?.()
  for(let x=b.x1;x<=b.x2;x++)for(let y=b.y1;y<=b.y2-2;y++){
   const v=get(x,y,z);if(pass(v.id)||[8,9,10,11].includes(v.id))continue
   for(let sx=0;sx<2;sx++)for(let sz=0;sz<2;sz++)for(const seg of segments(v.id,v.data,sx,sz)){const foot=y+seg[1];if(clear(x*2+sx,foot,z*2+sz))nodes.add(key(x*2+sx,Math.round(foot*2),z*2+sz))}
   if(nodes.size>300000)throw new Error('可通行面过多，请缩小检查选区')
   if(STAIRS.has(v.id)){
    stairs++;if(v.data&4)continue
    const [dx,dz]=DIRS[v.data&3],low=get(x-dx,y,z-dz),high=get(x+dx,y,z+dz)
    if(!pass(get(x,y+1,z).id)||!pass(get(x,y+2,z).id))add('净空','楼梯上方不足两格净空；若为装饰楼梯可忽略',x,y,z)
    if(inside(x-dx,y,z-dz)&&inside(x+dx,y,z+dz)&&!pass(low.id)&&pass(high.id))add('楼梯','楼梯低端被挡、高端无衔接，可能朝向错误',x,y,z)
   }
  }
  if((z-b.z1)%8===0){engine.progress?.({done:z-b.z1,total:d,phase:'检查通行面'});await new Promise(r=>setImmediate(r))}
 }
 const points=opt.points||[],pointNode=p=>{for(const sx of [0,1])for(const sz of [0,1]){const k=key(p.x*2+sx,p.y*2,p.z*2+sz);if(nodes.has(k))return k}return null}
 if(!Array.isArray(points)||points.length>64||points.some(p=>!['x','y','z'].every(a=>Number.isInteger(p[a]))))throw new Error('检查点须为整数坐标，最多 64 个')
 const checks=points.map(p=>({...p,node:pointNode(p),inBounds:inside(p.x,p.y,p.z)}))
 for(const p of checks)if(!p.inBounds)add('范围','检查点不在选区内：'+(p.name||''),p.x,p.y,p.z);else if(!p.node)add('点位','点位没有安全落脚面或头顶空间不足：'+(p.name||''),p.x,p.y,p.z)
 if(checks[0]?.node){const seen=new Set([checks[0].node]),queue=[checks[0].node];for(let i=0;i<queue.length;i++){
  const [qx,fy,qz]=queue[i].split(',').map(Number)
  for(const [dx,dz]of DIRS)for(const dy of [0,1,-1,-2]){const k=key(qx+dx,fy+dy,qz+dz);if(nodes.has(k)&&!seen.has(k)){seen.add(k);queue.push(k)}}
  if(i%4096===0){engine.checkCanceled?.();await new Promise(r=>setImmediate(r))}
 }for(const p of checks.slice(1))if(p.node&&!seen.has(p.node))add('路线','在选区内无法从首个点步行到达：'+(p.name||''),p.x,p.y,p.z)}
 if(opt.boss){const v=opt.boss;if(!['x','y','z','radius','clearance'].every(k=>Number.isInteger(v[k]))||v.radius<0||v.radius>64||v.clearance<2||v.clearance>64)throw new Error('Boss 区参数无效')
  for(let x=v.x-v.radius;x<=v.x+v.radius;x++)for(let z=v.z-v.radius;z<=v.z+v.radius;z++)for(let y=v.y;y<v.y+v.clearance;y++)if(!inside(x,y,z))throw new Error('Boss 战斗区必须完整包含在检查选区内');else if(get(x,y,z).id!==0)add('Boss障碍','Boss 战斗区存在方块',x,y,z)
 }
 return {ok:true,bounds:b,checked:ids.length,stairs,walkSurfaces:nodes.size,counts,findings,truncated:Object.values(counts).reduce((a,n)=>a+n,0)>findings.length,limitations:'只检查选区内的静态步行路线；不模拟跳跃、游泳、动态门和实体。楼梯按直线半格碰撞近似，装饰楼梯可能提示。'}
}
module.exports={checkMap}
