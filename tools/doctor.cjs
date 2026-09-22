'use strict'
const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const root = path.resolve(__dirname, '..')
const checks = []
function add (name, ok, detail = '') { checks.push({ name, ok, detail }) }
add('Node.js >= 20', Number(process.versions.node.split('.')[0]) >= 20, process.version)
for (const p of ['electron/main.cjs','electron/preload.cjs','src/renderer/index.html','src/renderer/app.js','src/core/world-engine.cjs','mcp/server.mjs']) {
  add(p, fs.existsSync(path.join(root, p)), fs.existsSync(path.join(root,p)) ? '存在' : '缺失')
}
for (const p of ['electron','prismarine-nbt','prismarine-provider-anvil','@modelcontextprotocol/server']) {
  try { require.resolve(p, { paths: [root] }); add(`依赖 ${p}`, true, '已安装') } catch { add(`依赖 ${p}`, false, '未安装，请先运行 首次安装并启动.bat') }
}
try {
  const out = cp.execFileSync('codex', ['--version'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore','pipe','ignore'] }).trim()
  add('Codex CLI', true, out)
} catch { add('Codex CLI', false, '未检测到；不影响软件本体，MCP 以后再接') }
console.log('照献工程 1.1 - 环境诊断\n')
for (const c of checks) console.log(`${c.ok ? '[OK] ' : '[!!] '} ${c.name}${c.detail ? ' - ' + c.detail : ''}`)
const hardFail = checks.some(c => !c.ok && !['Codex CLI'].includes(c.name))
console.log(`\n结果：${hardFail ? '存在需要处理的项目。' : '基础环境正常。'}`)
process.exitCode = hardFail ? 1 : 0
