# Project Workspace And Packaging

早期 Electron launcher、`4617/5673` 端口对、`package:windows` 和 `dist-installer` 已退役。当前产品是 Browser Service + 单独 Windows Local Component。

## Main Workspace Service

`apps/server` 使用 Node 原生 HTTP，并增加 `busboy`、`sharp`、`ws` 等当前能力所需依赖；它不是“完全无 runtime dependencies”的早期服务器。

开发启动：

```bash
corepack pnpm dev
```

该命令启动：

- Vite：`127.0.0.1:5173`；
- main workspace service：默认 `127.0.0.1:4518`。

也可单独运行：

```bash
corepack pnpm dev:web
corepack pnpm dev:server
corepack pnpm workspace:up
```

主服务端口读取 `SERVER_PORT`，再回退到 `LICLICK_WORKSPACE_PORT`，源码默认 `4518`。LAN/集成部署文档常显式设置 `4517`，这不是源码默认值。

当前浏览器的 Texture `workspaceApiClient` 将 project/folder/asset 请求发往 Local Component；主服务主要拥有 Web auth、远端模块代理、服务端 job/history/recovery，并保留兼容 workspace routes。两者共享部分项目/资产服务代码，但不能据此把 4518 和 4618 当成同一数据所有者。

默认工作区为仓库 `workspace/`，通过 `LICLICK_WORKSPACE_DIR` 改写。长期部署应使用 systemd/Windows service/process manager，而不是把开发脚本当作生产 supervisor。

## Windows Local Component

本地组件默认监听：

```text
127.0.0.1:4618
```

它复用 `apps/server` 的受限路由，以 `LICLICK_LOCAL_COMPONENT_MODE=1` 启动，当前 capabilities 包括：

- texture painting；
- local files/project storage/settings；
- personal Atlas/Liclick auth and generation；
- Photoshop/DCC bridge boundary；
- local performance telemetry。

它不承载统一 Web 首页、远端 Auto UV/Retopology/Bake 服务，也不打包 ComfyUI/AI model。打包命令：

```bash
corepack pnpm package:windows:local-component
```

Photoshop UXP 单独打包：

```bash
corepack pnpm package:photoshop
```

## Workspace Layout

主服务与本地组件都按用户隔离工程，具体 user root 由身份模式决定。项目逻辑布局：

```text
projects/<projectSlug>/
  project.liclick.json
  assets/
    models/
    references/
    captures/
    generations/
    layers/
    baked/
  exports/
  thumbnails/
  autosave/
```

目录级 metadata 还包括 folders、recent projects、settings、auth/job/telemetry 等服务文件。`workspace/` 整体属于 runtime/user data，不能提交到 Git。

## Autosave And Assets

- Dirty project 在约 1.5 秒 debounce 后保存。
- JSON 写入采用临时文件 + rename；autosave 保留有限滚动副本。
- Capture/generation/layer/baked 图像和模型写入二进制 assets，项目 JSON 保存相对路径/安全 URL。
- 服务公开 workspace 文件时只允许匹配的用户/项目资产路径，并检查 path traversal 与 realpath 边界。
- 远端生成资产只从 HTTPS allowlisted hosts 导入。

## Browser Fallback

File System Access API 与 JSON 下载/导入仍保留为离线或不支持工作区服务时的 fallback。Blob URL 是会话态，必须在保存时物化；单纯下载 JSON 不保证包含所有未物化的大资产。

## Portable Package

`.liclick3d` zip 仍未实现。当前 export package endpoint/概念不能描述成可用的便携工程交付。目标内容仍可包含 project JSON、models、references、captures、generations、layers、baked 和 thumbnails，但实现前应补安全 manifest、版本迁移和完整性校验。

## Multi-user Boundary

当前 per-user 文件工作区适合单节点。多实例/大规模多人需要数据库事务、共享对象存储、分布式任务/锁和迁移策略；Prisma schema 目前只是目标契约。
