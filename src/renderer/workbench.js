let wbBox=null,wbRefreshing=false,wbTimer=null
const wbStatus={running:'运行中',canceling:'正在取消并恢复',completed:'已完成',failed:'失败',canceled:'已取消',interrupted:'上次运行中断','recovery-needed':'需要恢复'}
function wbSetBounds(){if(['x1','y1','z1','x2','y2','z2'].some(k=>!$('#'+k).value.trim()||!Number.isInteger(Number($('#'+k).value))))throw new Error('请先在编辑页填写完整的整数选区');const b=boxFromInputs();wbBox=b;$('#wbBounds').textContent=`X ${b.x1}～${b.x2} · Y ${b.y1}～${b.y2} · Z ${b.z1}～${b.z2}`;return b}
function wbRenderReport(r){
 const host=$('#wbReport');host.innerHTML='';if(!r)return
 const head=document.createElement('p');head.className='panel-desc';head.textContent=`检查 ${r.checked?.toLocaleString()||0} 格 · 楼梯 ${r.stairs||0} 个 · 提示 ${Object.values(r.counts||{}).reduce((a,n)=>a+n,0)} 条${r.truncated?'（显示前 200 条）':''}`;host.append(head)
 for(const f of r.findings||[]){const button=document.createElement('button');button.className='btn subtle full';button.style.textAlign='left';button.textContent=`${f.type} · ${f.x}, ${f.y}, ${f.z}\n${f.message}`;button.onclick=()=>showDetail({x:f.x,y:f.y,z:f.z},false);host.append(button)}
}
async function refreshWorkbench(){
 if(wbRefreshing||!state.project)return;wbRefreshing=true
 try{
  const [list,history]=await Promise.all([ZXNative.listJobs(),ZXNative.listHistory()]);const host=$('#wbJobs');host.innerHTML=''
  for(const j of list.slice(0,20)){
   const card=document.createElement('div');card.className='resource-card';const pct=Math.min(100,Math.round((j.progress?.done||0)/Math.max(1,j.progress?.total||1)*100))
   card.innerHTML=`<b>${escapeHtml(j.name)} · ${escapeHtml(wbStatus[j.status]||j.status)}</b><p class="panel-desc">${escapeHtml(j.progress?.phase||'')} ${pct}%${j.error?' · '+escapeHtml(j.error):''}</p><progress max="100" value="${pct}" style="width:100%"></progress>`
   if(j.result?.verified!=null){const p=document.createElement('p');p.textContent=`写入 ${j.result.changed.toLocaleString()} 格，核对 ${j.result.verified.toLocaleString()} 格`;card.append(p)}
   const action=(label,fn)=>{const b=document.createElement('button');b.className='btn subtle';b.textContent=label;b.onclick=async()=>{b.disabled=true;try{await fn();await refreshWorkbench()}catch(e){toast(errMsg(e),true)}finally{b.disabled=false}};card.append(b)}
   if(['running','interrupted','recovery-needed'].includes(j.status))action('取消并恢复',()=>ZXNative.cancelJob(j.id))
   if(['failed','canceled','interrupted','recovery-needed'].includes(j.status))action('恢复并重试',()=>ZXNative.retryJob(j.id))
   if(j.kind==='check'&&j.result)action('查看报告',async()=>wbRenderReport(j.result))
   host.append(card)
  }
  const active=history.active;$('#wbActive').innerHTML=''
  if(active){const p=document.createElement('p');p.textContent='未结束事务：'+active.name;$('#wbActive').append(p);for(const [label,name]of [['提交事务','commit_transaction'],['回滚事务','rollback_transaction']]){const b=document.createElement('button');b.className='btn subtle';b.textContent=label;b.onclick=async()=>{try{await ZXNative.executeTool(name,{});await refreshAfterEdit(label);await refreshWorkbench()}catch(e){toast(errMsg(e),true)}};$('#wbActive').append(b)}}
  $('#wbHistory').innerHTML=history.entries.map(t=>`<div class="resource-card"><b>${escapeHtml(t.name)}</b><p class="panel-desc">${escapeHtml(new Date(t.committedAt).toLocaleString())} · ${{applied:'已应用',undone:'已撤销',superseded:'重做已失效'}[t.state]||'已应用'}<br>写入 ${t.changed??'旧记录未统计'} 格 · ${t.files.length} 个 Region${t.bounds?'<br>'+escapeHtml(`X ${t.bounds.x1}～${t.bounds.x2} / Y ${t.bounds.y1}～${t.bounds.y2} / Z ${t.bounds.z1}～${t.bounds.z2}`):''}</p></div>`).join('')||'<p class="placeholder">暂无编辑历史</p>'
 }finally{wbRefreshing=false}
}
function bindWorkbench(){
 const safe=fn=>async()=>{try{await fn()}catch(e){toast(errMsg(e),true)}}
 $('#wbRefresh').onclick=safe(refreshWorkbench);$('#wbImport').onclick=importSchematic;$('#wbSelection').onclick=safe(wbSetBounds)
 $('#wbMarkers').onclick=safe(()=>{const b=wbBox||wbSetBounds();$('#wbPoints').value=(state.project.markers||[]).filter(p=>p.x>=b.x1&&p.x<=b.x2&&p.y>=b.y1&&p.y<=b.y2&&p.z>=b.z1&&p.z<=b.z2).sort((a,b)=>(b.type==='spawn')-(a.type==='spawn')).map(p=>`${p.name.replace(/[,\n]/g,' ')},${p.x},${p.y},${p.z}`).join('\n')})
 $('#wbCheck').onclick=safe(async()=>{
  if(!state.project)throw new Error('先打开世界');const bounds=wbBox||wbSetBounds()
  const points=$('#wbPoints').value.trim().split('\n').filter(Boolean).map(line=>{const a=line.split(',');if(a.length!==4||a.slice(1).some(v=>!v.trim()))throw new Error('每行请填写 名称,X,Y,Z');return {name:a[0],x:Number(a[1]),y:Number(a[2]),z:Number(a[3])}})
  const spec={bounds,points};if($('#wbBoss').checked)spec.boss={x:Number($('#wbBossX').value),y:Number($('#wbBossY').value),z:Number($('#wbBossZ').value),radius:Number($('#wbRadius').value),clearance:Number($('#wbClearance').value)}
  await ZXNative.startJob({kind:'check',name:'地图检查',spec});await refreshWorkbench()
 })
 const historyAction=redo=>safe(async()=>{const r=await (redo?ZXNative.redo():ZXNative.undo());if(!r.ok)throw new Error(r.message);await refreshAfterEdit(redo?'已重做':'已撤销');await refreshWorkbench()})
 $('#wbUndo').onclick=historyAction(false);$('#wbRedo').onclick=$('#btnRedo').onclick=historyAction(true)
 const notified=new Map();ZXNative.onJobChanged(j=>{if(j.worldPath!==state.project?.worldPath)return;if(['completed','failed','canceled'].includes(j.status)&&notified.get(j.id)!==j.status)toast(j.name+'：'+wbStatus[j.status],j.status==='failed');notified.set(j.id,j.status);clearTimeout(wbTimer);wbTimer=setTimeout(()=>refreshWorkbench().catch(()=>{}),250)})
}
