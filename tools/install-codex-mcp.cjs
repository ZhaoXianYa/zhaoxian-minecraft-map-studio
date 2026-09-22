'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const root = path.resolve(__dirname, '..')
const server = path.join(root, 'mcp', 'server.mjs')
const localNode = path.join(root, '.runtime', 'node.exe')
const node = fs.existsSync(localNode) ? localNode : process.execPath

function q(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') }
const snippet = `\n[mcp_servers.zx-engineering]\ncommand = "${q(node)}"\nargs = ["${q(server)}"]\nenabled = true\nstartup_timeout_sec = 20\ntool_timeout_sec = 180\n`

console.log('照献工程 MCP 安装器')
console.log('Server:', server)
try {
  cp.execFileSync('codex', ['mcp', 'remove', 'zx-engineering'], { stdio: 'ignore', windowsHide: true })
} catch {}
try {
  cp.execFileSync('codex', ['mcp', 'add', 'zx-engineering', '--', node, server], { stdio: 'inherit', windowsHide: false })
  console.log('\n已通过 Codex CLI 添加 zx-engineering MCP。')
  process.exit(0)
} catch (e) {
  console.log('\n没有检测到可用的 `codex mcp add`，下面给出手动配置。')
  const configDir = path.join(os.homedir(), '.codex')
  const out = path.join(root, 'Codex_MCP_配置片段.toml')
  fs.writeFileSync(out, snippet.trimStart(), 'utf8')
  console.log(`把下面内容加入 ${path.join(configDir, 'config.toml')}：\n${snippet}`)
  console.log('同时已写入：', out)
  process.exit(2)
}
