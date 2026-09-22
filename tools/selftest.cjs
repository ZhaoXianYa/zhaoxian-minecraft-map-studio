'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const root = path.resolve(__dirname, '..')
function ok(msg){ console.log('[OK]  ' + msg) }
function fail(msg, err){ console.error('[FAIL] ' + msg); if(err) console.error(err.stack || err); process.exitCode = 1 }

async function main(){
  console.log('照献工程 1.1 - 功能自检\n')
  const required = [
    'electron','three','minecraft-data','vec3','prismarine-nbt','prismarine-block','prismarine-chunk',
    'prismarine-provider-anvil','prismarine-schematic','@modelcontextprotocol/server','zod'
  ]
  for(const mod of required){
    try { require.resolve(mod,{paths:[root]}); ok('依赖 ' + mod) }
    catch(e){ fail('缺少依赖 ' + mod, e); return }
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zx-engineering-selftest-'))
  const world = path.join(temp, 'world')
  try {
    const { WorldEngine } = require(path.join(root,'src/core/world-engine.cjs'))
    const { scanWorldOverview } = require(path.join(root,'src/core/overview-scan.cjs'))
    const engine = new WorldEngine(world,'overworld')
    await engine.createWorld({ name:'ZX SelfTest', size:64, baseHeight:64, preset:'flat', seed:1 })
    if(!fs.existsSync(path.join(world,'level.dat')) || !fs.existsSync(path.join(world,'region'))) throw new Error('世界文件未生成')
    ok('创建 Minecraft 1.12.2 测试世界')

    const before = await engine.raw.getBlock(0,65,0)
    await engine.setBlock({x:0,y:65,z:0,block:'stonebrick'})
    const after = await engine.raw.getBlock(0,65,0)
    if(after.id !== 98) throw new Error(`写入方块失败：${JSON.stringify({before,after})}`)
    ok('读取 / 修改 MCA Chunk')

    const overview = await scanWorldOverview(world,'overworld',4,{force:true})
    if(!overview.regions.length || !overview.chunks) throw new Error('完整世界扫描无结果')
    ok(`完整世界 LOD 扫描 (${overview.regions.length} Region / ${overview.chunks} Chunk)`)

    const sch = path.join(temp,'selftest.schematic')
    await engine.exportLegacySchematic({x1:-2,y1:60,z1:-2,x2:2,y2:68,z2:2,path:sch})
    if(!fs.existsSync(sch) || fs.statSync(sch).size < 64) throw new Error('schematic 导出失败')
    ok('导出 1.12.2 MCEdit .schematic')

    const undo = await engine.undo()
    if(!undo.ok) throw new Error('撤销事务失败')
    const restored = await engine.raw.getBlock(0,65,0)
    if(restored.id === 98) throw new Error('撤销后方块没有恢复')
    ok('Region 事务备份 / 撤销')

    await engine.raw.close().catch(()=>{})

    // MCP process smoke test: if the server stays alive for 1.2s, transport/imports are healthy.
    const node = process.execPath
    const child = cp.spawn(node,[path.join(root,'mcp/server.mjs')],{stdio:['pipe','pipe','pipe'],env:{...process.env,ZX_ENGINEERING_SELFTEST:'1'}})
    let exited = false, stderr = ''
    child.stderr.on('data',d=>stderr += d.toString())
    child.on('exit',()=>{ exited = true })
    await new Promise(r=>setTimeout(r,1200))
    if(exited) throw new Error('MCP Server 提前退出：' + stderr.trim())
    child.kill()
    ok('MCP stdio Server 启动')

    console.log('\n全部核心自检通过。')
  } finally {
    try { fs.rmSync(temp,{recursive:true,force:true}) } catch {}
  }
}

main().catch(e=>{ fail('核心自检异常',e) })
