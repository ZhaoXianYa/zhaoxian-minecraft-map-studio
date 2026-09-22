# Zhaoxian Engineering — Minecraft 1.12.2 Map Studio

[简体中文](README.md)

A local Minecraft Java 1.12.2 world and structure editor. It reads Anvil worlds, renders large terrain and structures, edits blocks with transaction backups, and exposes reviewable map operations through MCP for clients such as Codex.

The project is initiated, designed, and maintained by its author. OpenAI Codex assists with implementation, debugging, automated tests, and open-source documentation. This is an independent community project and is not an official OpenAI, Mojang, or Microsoft product.

## Highlights

- World navigation, structure preview, free-flight inspection, and top-down checks
- Vanilla 1.12.2 JAR and resource-pack texture support
- Block edits with backups, undo, and save-time validation
- Adjustable preview distance, world precision, grid, and barrier overlays
- A local authenticated MCP bridge for assisted map workflows

Free-flight preview has no collision and does not prove in-game behavior. Offline checks do not replace testing in a matching Minecraft client or server.

## Development

Windows x64 and Node.js 22 are currently supported.

```powershell
npm ci
npm test
npm start
```

Use `npm run pack:win` to build the unsigned Windows portable executable. See [MCP接入说明.md](MCP接入说明.md) for MCP setup.

## Privacy and safety

Worlds and resource packs remain on the local machine. The MCP bridge listens only on `127.0.0.1` and uses a random per-process bearer token. Do not publish private worlds, server data, or third-party maps without redistribution permission.

## License

Source code is available under the [MIT License](LICENSE). Minecraft, Mojang, Microsoft, and third-party assets remain the property of their respective owners. This project is not affiliated with or endorsed by them.
