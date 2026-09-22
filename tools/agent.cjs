'use strict'
// node tools/agent.cjs context | capture | request.json
const fs=require('node:fs'),path=require('node:path')
;(async()=>{
 const connection=JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,'照献工程','agent-connection.json'),'utf8'))
 const action=process.argv[2]||'context',base=`http://127.0.0.1:${connection.port}`
 const r=action==='context'||action==='capture'?await fetch(base+'/'+action):await fetch(base+'/agent',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+connection.token},body:fs.readFileSync(action,'utf8')})
 const data=await r.json();if(!r.ok||data.ok===false)throw new Error(data.error||JSON.stringify(data));console.log(JSON.stringify(data,null,2))
})().catch(e=>{console.error(e.message);process.exitCode=1})
