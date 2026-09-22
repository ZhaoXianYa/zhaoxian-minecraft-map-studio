import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import * as z from 'zod/v4'
import fs from 'fs'
import path from 'path'
import http from 'http'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const { WorldEngine } = require('../src/core/world-engine.cjs')
const { ProjectStore, bridgeStatePath } = require('../src/core/project-store.cjs')
const VERSION = '2.10.0'

function textResult (value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }
}
function readState () {
  const f = bridgeStatePath()
  if (!fs.existsSync(f)) throw new Error('照献工程尚未打开过世界。请先启动软件并导入/创建一个 1.12.2 世界。')
  const s = JSON.parse(fs.readFileSync(f, 'utf8'))
  if (!s.worldPath || !fs.existsSync(s.worldPath)) throw new Error('MCP 当前世界路径无效，请在照献工程中重新打开世界。')
  return s
}
function engineFromState () { const s = readState(); return { state: s, engine: new WorldEngine(s.worldPath, s.dimension || 'overworld') } }
async function projectFromState () { const s = readState(); const store = new ProjectStore(s.worldPath); await store.ensure(); return { state: s, store, project: await store.get() } }
function bridgeGet (pathname) {
  return new Promise((resolve, reject) => {
    let s; try { s = readState() } catch (e) { return reject(e) }
    const port = s.bridgePort || 43927
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 2500 }, res => {
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch(e){reject(e)}})
    })
    req.on('error', reject); req.on('timeout',()=>req.destroy(new Error('照献工程桌面程序没有响应')))
  })
}
async function refreshApp (reason) { try { await bridgeGet(`/refresh?reason=${encodeURIComponent(reason || 'MCP 修改')}`) } catch {} }
async function ensureDesktop () {
  try { const h = await bridgeGet('/health'); if (!h?.ok) throw new Error('照献工程桌面端未运行') } catch { throw new Error('请先启动照献工程并打开目标世界，再让 Codex 修改地图。') }
}
async function runTool (name, payload, label = name) {
  await ensureDesktop()
  return agentRequest('world:tool',{name,payload},readState().worldPath)
}
async function agentRequest(action,payload,worldPath){
  const c=JSON.parse(fs.readFileSync(path.join(path.dirname(bridgeStatePath()),'agent-connection.json'),'utf8'))
  const response=await fetch(`http://127.0.0.1:${c.port}/agent`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${c.token}`},body:JSON.stringify({action,worldPath,payload})})
  const out=await response.json();if(!response.ok||!out.ok)throw new Error(out.error||'AI 操作失败')
  return textResult(out.result)
}

const point = z.object({ x: z.number(), z: z.number() })
const boxXZ = { x1: z.number(), z1: z.number(), x2: z.number(), z2: z.number() }
const boxXYZ = { ...boxXZ, y1: z.number(), y2: z.number() }
const block = z.union([z.string(), z.number(), z.object({ id: z.number(), data: z.number().optional() })])

function createServer () {
  const server = new McpServer(
    { name: 'zx-engineering', version: VERSION },
    { capabilities: { tools: {} }, instructions: '这是“照献工程”Minecraft Java 1.12.2 地图编辑器。修改正式世界前优先使用 zx_begin_transaction；尊重保护区域；大型地图优先使用高层地形/建筑工具而不是逐方块调用；修改后可 zx_capture_preview 检查，并在满意后 zx_commit_transaction，不满意则 zx_rollback_transaction。' }
  )
  server.registerTool('zx_start_import_job',{title:'后台导入蓝图',description:'推荐用于大地图：仅传本地 MCEdit Alpha 蓝图路径。立即返回任务编号；软件分区写入、核对，可查询进度或取消恢复。任务自行管理事务，请勿预先 begin_transaction。',inputSchema:z.object({path:z.string(),name:z.string().optional(),x:z.number().int(),y:z.number().int().min(0).max(255),z:z.number().int(),includeAir:z.boolean().default(false)})},async p=>agentRequest('job:start',{kind:'import',name:p.name,spec:p},readState().worldPath))
  const checkPoint=z.object({name:z.string().optional(),x:z.number().int(),y:z.number().int(),z:z.number().int()})
  server.registerTool('zx_start_check_job',{title:'后台地图检查',description:'检查选区内楼梯、净空和检查点连通性；首点为路线起点。静态近似，不模拟跳跃和动态门。最多150万格。Boss参数为中心、半径和净空高度。',inputSchema:z.object({...boxXYZ,points:z.array(checkPoint).max(64).optional(),boss:z.object({x:z.number().int(),y:z.number().int(),z:z.number().int(),radius:z.number().int().min(0).max(64),clearance:z.number().int().min(2).max(64)}).optional()})},async p=>agentRequest('job:start',{kind:'check',spec:p},readState().worldPath))
  server.registerTool('zx_list_jobs',{title:'查询任务进度',description:'查询当前世界任务、进度、结果与恢复状态。',inputSchema:z.object({})},async()=>agentRequest('job:list',{},readState().worldPath))
  server.registerTool('zx_cancel_job',{title:'取消任务并恢复',description:'取消正在运行的任务，或恢复软件中断后的未完成任务。等状态变为 canceled 后再编辑。',inputSchema:z.object({id:z.string()})},async p=>agentRequest('job:cancel',p,readState().worldPath))
  server.registerTool('zx_retry_job',{title:'恢复并重试任务',description:'先恢复任务前快照，再使用保留的输入文件从头重试；不是从中间断点继续。',inputSchema:z.object({id:z.string()})},async p=>agentRequest('job:retry',p,readState().worldPath))
  server.registerTool('zx_list_history',{title:'查看编辑历史',description:'列出当前维度已提交事务及活动事务，含范围、写入数量、撤销状态。',inputSchema:z.object({}),annotations:{readOnlyHint:true}},async()=>agentRequest('history:list',{},readState().worldPath))
  server.registerTool('zx_redo_last',{title:'重做最近撤销',description:'恢复最近撤销的编辑；新编辑提交后旧的重做分支失效。',inputSchema:z.object({})},async()=>runTool('redo',{}))
  server.registerTool('zx_apply_blocks',{
    title:'分阶段批量建造',description:'一次提交一阶段的方块，软件立即刷新预览并生成可撤销事务。建议按地基、主体、装饰拆成多次调用，用户可看到过程。坐标为绝对世界坐标，ID 和 data 使用 Java 1.12.2。',
    inputSchema:z.object({name:z.string(),blocks:z.array(z.object({x:z.number().int(),y:z.number().int().min(0).max(255),z:z.number().int(),id:z.number().int().min(0).max(4095),data:z.number().int().min(0).max(15).default(0)})).min(1).max(500000)})
  },async p=>runTool('apply_blocks',p,p.name))
  server.registerTool('zx_create_void_world',{title:'新建独立虚空副本',description:'创建新世界并在软件中打开；非空目标目录会拒绝，不覆盖旧地图。',inputSchema:z.object({parentPath:z.string(),name:z.string()})},async p=>agentRequest('world:create',{...p,preset:'void',baseHeight:63}))
  server.registerTool('zx_open_world',{title:'打开待编辑世界',description:'切换软件当前世界，修改前应再次检查上下文。',inputSchema:z.object({worldPath:z.string(),dimension:z.enum(['overworld','nether','end']).default('overworld')})},async p=>agentRequest('world:open',p))
  server.registerTool('zx_set_spawn',{title:'设置副本出生点',description:'设置 level.dat 出生坐标；请先确认脚下实体地板和头顶净空。旧 level.dat 备份为 level.dat_old，此设置不包含在方块事务撤销内。',inputSchema:z.object({x:z.number().int(),y:z.number().int().min(1).max(254),z:z.number().int()})},async p=>runTool('set_spawn',p))

  server.registerTool('zx_get_context', {
    title: '读取照献工程上下文', description: '读取当前打开的世界、维度、建筑方案、标记和保护区域。只读。', inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => { const { state, project } = await projectFromState(); return textResult({ app: '照献工程', version: VERSION, bridge: state, project }) })

  server.registerTool('zx_focus', {
    title: '聚焦坐标', description: '让照献工程桌面视图跳转到指定 Minecraft 坐标。', inputSchema: z.object({ x: z.number(), y: z.number().default(80), z: z.number() }), annotations: { readOnlyHint: true }
  }, async ({x,y,z}) => textResult(await bridgeGet(`/focus?x=${x}&y=${y}&z=${z}`)))

  server.registerTool('zx_capture_preview', {
    title: '截图检查', description: '截取照献工程当前窗口并把 PNG 图像返回给 MCP 客户端，用于视觉检查地图或建筑。', inputSchema: z.object({}), annotations: { readOnlyHint: true }
  }, async () => {
    const r = await bridgeGet('/capture'); if (!r.ok || !r.path || !fs.existsSync(r.path)) throw new Error(r.error || '截图失败')
    return { content: [{ type: 'image', data: fs.readFileSync(r.path).toString('base64'), mimeType: 'image/png' }, { type: 'text', text: `截图路径：${r.path}` }] }
  })

  server.registerTool('zx_begin_transaction', {
    title: '开始 AI 编辑事务', description: '把后续多个修改合并为一次可回滚任务。大型操作前推荐先调用。', inputSchema: z.object({ name: z.string().default('Codex 地图编辑') }), annotations: { destructiveHint: false }
  }, async (p) => runTool('begin_transaction', p, `开始事务：${p.name}`))
  server.registerTool('zx_commit_transaction', { title: '提交编辑事务', description: '提交当前事务并保留 Region 快照用于后续撤销。', inputSchema: z.object({}), annotations: { destructiveHint: false } }, async () => runTool('commit_transaction', {}, 'MCP 事务已提交'))
  server.registerTool('zx_rollback_transaction', { title: '回滚编辑事务', description: '恢复当前事务开始前的 Region 快照。', inputSchema: z.object({}), annotations: { destructiveHint: true } }, async () => runTool('rollback_transaction', {}, 'MCP 事务已回滚'))
  server.registerTool('zx_undo_last', { title: '撤销上次编辑', description: '恢复最近一次已经提交的照献工程事务。', inputSchema: z.object({}), annotations: { destructiveHint: true } }, async () => runTool('undo',{}))

  server.registerTool('zx_set_block', {
    title:'设置方块', description:'设置单个 Minecraft 1.12.2 方块。大量建造请优先用高层工具。', inputSchema:z.object({x:z.number(),y:z.number(),z:z.number(),block,allowProtected:z.boolean().optional()}), annotations:{destructiveHint:true}
  }, async p=>runTool('set_block',p,'MCP 设置方块'))
  server.registerTool('zx_fill', {
    title:'填充区域',description:'用指定 1.12.2 方块填充长方体选区；单次上限 400 万方块。',inputSchema:z.object({...boxXYZ,block,allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('fill',p,'MCP 填充区域'))
  server.registerTool('zx_flatten', {
    title:'平整地形',description:'把指定 XZ 区域平整到目标 Y，高层地形工具。',inputSchema:z.object({...boxXZ,y:z.number(),topBlock:block.optional(),fillBlock:block.optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('flatten',p,'MCP 平整地形'))
  server.registerTool('zx_smooth_terrain', {
    title:'平滑地形',description:'对选定 XZ 区域执行多次邻域平滑，适合消除山体锯齿。',inputSchema:z.object({...boxXZ,iterations:z.number().min(1).max(4).optional(),blend:z.number().min(.05).max(1).optional(),topBlock:block.optional(),fillBlock:block.optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('smooth_terrain',p,'MCP 平滑地形'))
  server.registerTool('zx_raise_terrain', {
    title:'抬高地形',description:'以圆形笔刷自然抬高地形。',inputSchema:z.object({x:z.number(),z:z.number(),radius:z.number().min(1).max(256),strength:z.number().min(1).max(64),falloff:z.number().optional(),topBlock:block.optional(),fillBlock:block.optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('raise_terrain',p,'MCP 抬高地形'))
  server.registerTool('zx_lower_terrain', {
    title:'降低地形',description:'以圆形笔刷自然降低地形。',inputSchema:z.object({x:z.number(),z:z.number(),radius:z.number().min(1).max(256),strength:z.number().min(1).max(64),falloff:z.number().optional(),topBlock:block.optional(),fillBlock:block.optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('lower_terrain',p,'MCP 降低地形'))
  server.registerTool('zx_generate_mountain', {
    title:'生成山体',description:'生成带噪声和自然轮廓的山体，适合 RPG 大世界。',inputSchema:z.object({x:z.number(),z:z.number(),radius:z.number().min(4).max(768),height:z.number().min(2).max(180),roughness:z.number().optional(),profile:z.number().optional(),seed:z.number().optional(),topBlock:block.optional(),innerBlock:block.optional(),fillBlock:block.optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('generate_mountain',p,'MCP 生成山体'))
  server.registerTool('zx_create_valley', {
    title:'生成山谷',description:'以圆形区域向下塑形，生成自然山谷或盆地。',inputSchema:z.object({x:z.number(),z:z.number(),radius:z.number().min(4).max(768),depth:z.number().min(2).max(120),profile:z.number().optional(),topBlock:block.optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('create_valley',p,'MCP 生成山谷'))
  server.registerTool('zx_create_river', {
    title:'生成河流',description:'沿路径点开挖河道并填水。',inputSchema:z.object({points:z.array(point).min(2),width:z.number().min(1).max(80),depth:z.number().min(1).max(30),waterY:z.number().optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('create_river',p,'MCP 生成河流'))
  server.registerTool('zx_create_lake', {
    title:'生成湖泊',description:'在椭圆区域开挖湖盆并填水。',inputSchema:z.object({x:z.number(),z:z.number(),radius:z.number().optional(),radiusX:z.number().min(2).max(400).optional(),radiusZ:z.number().min(2).max(400).optional(),depth:z.number().min(1).max(40).optional(),waterY:z.number().optional(),floorBlock:block.optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('create_lake',p,'MCP 生成湖泊'))
  server.registerTool('zx_create_road', {
    title:'铺设道路',description:'沿路径点在现有地表铺设道路。',inputSchema:z.object({points:z.array(point).min(2),width:z.number().min(1).max(40),block:block.optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('create_road',p,'MCP 铺设道路'))
  server.registerTool('zx_scatter_trees', {
    title:'散布树木',description:'在选定区域按密度和种子散布简单 1.12.2 树木。',inputSchema:z.object({...boxXZ,y1:z.number().optional(),y2:z.number().optional(),density:z.number().min(.001).max(.25).optional(),seed:z.number().optional(),log:block.optional(),leaves:block.optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('scatter_trees',p,'MCP 散布树木'))

  server.registerTool('zx_replace_material', {
    title:'替换材质',description:'在选区内批量把一种 1.12.2 方块替换成另一种。',inputSchema:z.object({...boxXYZ,from:block,to:block,matchData:z.boolean().optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('replace_material',p,'MCP 替换材质'))
  server.registerTool('zx_copy_region', {
    title:'复制区域',description:'按 XYZ 偏移复制一个长方体区域，适合镜像前的基础复制或建筑模块复用。',inputSchema:z.object({...boxXYZ,dx:z.number(),dy:z.number().optional(),dz:z.number(),includeAir:z.boolean().optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('copy_region',p,'MCP 复制区域'))
  server.registerTool('zx_create_wall', {
    title:'创建墙体',description:'从两个 XZ 端点创建指定高度和厚度的墙。',inputSchema:z.object({x1:z.number(),z1:z.number(),x2:z.number(),z2:z.number(),y:z.number(),height:z.number().min(1).max(80),thickness:z.number().min(1).max(8).optional(),block:block.optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('create_wall',p,'MCP 创建墙体'))
  server.registerTool('zx_create_floor', {
    title:'创建地板',description:'在矩形区域创建一层地板。',inputSchema:z.object({...boxXZ,y:z.number(),block:block.optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('create_floor',p,'MCP 创建地板'))
  server.registerTool('zx_create_pillar', {
    title:'创建立柱',description:'创建方形/圆近似立柱。',inputSchema:z.object({x:z.number(),y:z.number(),z:z.number(),height:z.number().min(1).max(120),radius:z.number().min(0).max(5).optional(),block:block.optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('create_pillar',p,'MCP 创建立柱'))
  server.registerTool('zx_create_gable_roof', {
    title:'创建人字屋顶',description:'在矩形边界上快速创建人字屋顶。',inputSchema:z.object({...boxXZ,y:z.number(),block:block.optional(),overhang:z.number().min(0).max(4).optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('create_gable_roof',p,'MCP 创建屋顶'))

  server.registerTool('zx_create_tower', {
    title:'创建塔楼',description:'生成圆形塔楼外墙、楼层与垛口，适合城堡/哨塔。',inputSchema:z.object({x:z.number(),y:z.number(),z:z.number(),radius:z.number().min(2).max(30),height:z.number().min(4).max(140),thickness:z.number().optional(),block:block.optional(),floorBlock:block.optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('create_tower',p,'MCP 创建塔楼'))
  server.registerTool('zx_create_bridge', {
    title:'创建桥梁',description:'在两个端点之间创建带栏杆和可选桥墩的桥。',inputSchema:z.object({x1:z.number(),y1:z.number(),z1:z.number(),x2:z.number(),y2:z.number().optional(),z2:z.number(),width:z.number().min(1).max(18).optional(),arch:z.number().optional(),block:block.optional(),railBlock:block.optional(),supportBlock:block.optional(),supports:z.boolean().optional(),supportEvery:z.number().optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('create_bridge',p,'MCP 创建桥梁'))
  server.registerTool('zx_create_boss_arena', {
    title:'创建 Boss 场地',description:'把圆形区域平整为可战斗平台并生成外围边缘。',inputSchema:z.object({x:z.number(),y:z.number(),z:z.number(),radius:z.number().min(6).max(120),floorBlock:block.optional(),rimBlock:block.optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>runTool('create_boss_arena',p,'MCP 创建 Boss 场地'))
  server.registerTool('zx_place_schematic', {
    title:'放置 schematic',description:'把 MCEdit/Sponge schematic 放置到当前世界指定坐标。',inputSchema:z.object({path:z.string(),x:z.number(),y:z.number(),z:z.number(),includeAir:z.boolean().optional(),allowProtected:z.boolean().optional()}),annotations:{destructiveHint:true}
  }, async p=>{await ensureDesktop();const {engine}=engineFromState();const r=await engine.placeSchematic(p);await refreshApp('MCP 粘贴 schematic');return textResult(r)})
  server.registerTool('zx_export_schematic', {
    title:'导出 schematic',description:'把世界选区导出为 Minecraft 1.12.2/WorldEdit 可用的 MCEdit Alpha .schematic。',inputSchema:z.object({...boxXYZ,path:z.string()}),annotations:{readOnlyHint:true}
  }, async p=>{const {engine}=engineFromState();return textResult(await engine.exportLegacySchematic(p))})

  server.registerTool('zx_add_marker', {
    title:'添加地图标记',description:'为 Boss、NPC、主城、副本等创建照献工程项目标记。',inputSchema:z.object({name:z.string(),type:z.string().optional(),x:z.number(),y:z.number().default(64),z:z.number(),note:z.string().optional()}),annotations:{destructiveHint:false}
  }, async p=>runTool('add_marker',p,'MCP 添加标记'))
  server.registerTool('zx_protect_region', {
    title:'保护区域',description:'把指定长方体标记为保护区，后续工具默认拒绝覆盖它。',inputSchema:z.object({name:z.string(),...boxXYZ}),annotations:{destructiveHint:false}
  }, async p=>runTool('add_protected_region',p,'MCP 添加保护区域'))
  server.registerTool('zx_create_building_plan', {
    title:'创建建筑方案',description:'创建右侧“建筑方案”，记录名称、设计理念、风格、标签与整体边界。',inputSchema:z.object({name:z.string(),concept:z.string().optional(),style:z.string().optional(),tags:z.array(z.string()).optional(),bounds:z.object(boxXYZ).optional()}),annotations:{destructiveHint:false}
  }, async p=>runTool('create_building_plan',p,'MCP 创建建筑方案'))
  server.registerTool('zx_update_building_plan', {
    title:'更新建筑方案',description:'修改已有建筑方案的名称、设计理念、风格、标签或整体边界。',inputSchema:z.object({planId:z.string(),name:z.string().optional(),concept:z.string().optional(),style:z.string().optional(),tags:z.array(z.string()).optional(),bounds:z.object(boxXYZ).optional()}),annotations:{destructiveHint:false}
  }, async p=>runTool('update_building_plan',p,'MCP 更新建筑方案'))
  server.registerTool('zx_add_building_part', {
    title:'添加建筑区域',description:'给某个建筑方案添加主殿、偏殿、塔楼、庭院等结构区域，并关联坐标。',inputSchema:z.object({planId:z.string(),name:z.string(),description:z.string().optional(),bounds:z.object(boxXYZ).optional()}),annotations:{destructiveHint:false}
  }, async p=>runTool('add_building_part',p,'MCP 更新建筑方案'))

  server.registerTool('zx_material_stats', {
    title:'统计材料',description:'统计选区内的真实 1.12.2 方块 ID/Data 与数量。只读，最多 150 万方块。',inputSchema:z.object(boxXYZ),annotations:{readOnlyHint:true}
  }, async p=>{const {engine}=engineFromState();return textResult(await engine.materialStats(p))})

  return server
}

async function main () {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => {
  console.error('[ZX MCP] 启动失败:', err?.stack || err)
  process.exit(1)
})
