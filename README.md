# 照献工程

[English](README_EN.md)

面向 Minecraft Java 1.12.2 的本地世界与建筑编辑器。它可以读取 Anvil 世界、查看大范围地形与建筑、编辑方块并创建事务备份，也可以通过 MCP 让 Codex 等客户端执行可审查的地图操作。

## 功能

- 打开包含 `region` 目录的 Minecraft 1.12.2 世界
- 地图导航、建筑预览、第一人称自由漫游与俯视检查
- 使用原版 1.12.2 JAR 或资源包 ZIP 显示材质
- 编辑方块、自动备份、撤销与保存前检查
- 显示网格、屏障、完整世界精度和可调预览范围
- 通过本机 MCP 服务读取上下文、检查地图并执行编辑

> 第一人称漫游可以穿墙，仅用于预览，不代表 Minecraft 客户端中的碰撞效果。离线检查也不能替代真实客户端或服务器测试。

## 开始使用

需要 Windows x64 和 Node.js 22。

```powershell
npm ci
npm start
```

首次打开后，选择一个包含 `region` 文件夹的世界目录。软件不会把你的地图或资源包上传到网络，也不会将它们打包进程序。

## 常用命令

```powershell
npm test          # 核心逻辑自检
npm run doctor    # 检查运行环境
npm run dev       # 开发模式
npm run pack:win  # 生成 Windows 便携版
```

MCP 配置见 [MCP接入说明.md](MCP接入说明.md)。

## 项目结构

- `electron/`：桌面程序主进程、预加载桥接和本地代理
- `src/core/`：世界读取、编辑、事务、资源包和预览逻辑
- `src/renderer/`：Three.js 界面与渲染器
- `mcp/`：MCP 服务入口
- `tools/`：诊断、打包与自检脚本

## 当前范围

- 主要支持传统 Minecraft Java 1.12.2 ID/Data。
- 部分特殊方块使用简化几何，例如连接栅栏、门状态和植物。
- 大范围预览的内存占用会随范围增长；普通建筑建议使用 2–4 区块半径。
- Windows 便携版目前没有商业代码签名。

## 贡献

欢迎提交问题、可复现地图样例和拉取请求，细则见 [CONTRIBUTING.md](CONTRIBUTING.md)。报告渲染或存档问题时，请说明 Minecraft 版本、世界格式、操作步骤，以及问题是否能在原版客户端复现。请勿提交含私人服务器数据或无权再分发的地图。

## 许可证

代码采用 [MIT License](LICENSE)。Minecraft、Mojang、Microsoft 及其他第三方名称和资源属于其各自权利人；本项目与其没有隶属或官方认可关系。
