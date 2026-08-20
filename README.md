# Liclick 3D Texture

Liclick 3D Texture（LI3D）当前是一套浏览器工作台：统一首页连接贴图绘制、自动展 UV、模型烘焙和生产工具；贴图模块依赖每位 Windows 用户本机的轻量组件，远端模块由主服务代理。它不是 Electron 桌面应用，运行时也还没有迁移到 Prisma 数据库。

本文描述当前代码实际行为。文档分类、历史记录和规划边界见 [docs/README.md](docs/README.md)。

## 当前产品模块

| 模块 | 当前状态 | 实际能力与边界 |
| --- | --- | --- |
| 贴图绘制 | 已实现，进入前要求本地组件可用 | 多模型项目、参考图、单视图/多视图纹理生成、自动投影、局部重绘、投影层/UV 层、UV 合并、内容识别补缝、模型与贴图导出 |
| 自动展 UV | 已实现，依赖远端资产服务 | 上传模型、提交任务、轮询状态、预览/下载结果、任务历史、继续进入烘焙 |
| 模型烘焙 | 已实现，依赖远端烘焙服务 | 高低模/颜色/Cage 资产、匹配检查、通道和质量设置、任务状态、结果检查、PBR 后处理与发布 |
| 工具箱 | 已实现为目录与下载入口 | 展示 3ds Max、Blender 和独立生产工具；不等同于 Blender/3ds Max 实时连接器 |
| 自动拓扑 V6 | 已实现为工程流程步骤 | 可从贴图工程发布并继续到 UV；目前不是首页独立卡片，且直接刷新拓扑 URL 会错误进入 Auto UV，见“已知实现问题” |

## 贴图工作台

当前可用：

- 导入 `.glb` / `.gltf`，并实验性支持 `.fbx` / `.obj`；一个工程可保存多个模型，贴图操作作用于当前活动模型。
- 模型归一化、落地、居中、相机适配，以及选择/移动/旋转/缩放。
- PBR、Flat、Normal、Wire 显示模式与 ViewCube。
- 导入和分组参考图；可为单图生成配对的多视图参考图。
- 捕获当前相机的颜色、Mask、线性视深和法线图。
- Texture Map 单视图或 6/10/14/自定义多视图生成。多视图会为每个相机提交单视图任务，保存相机/捕获元数据，自动建立投影层，并尝试内容识别补缝。
- 生成任务的恢复、取消和项目内持久化。
- 实时投影预览：相机召回、可见性、透明度、投影强度、HSL 调整、Blend/Overlay 与删除。
- 局部重绘：连续画笔选区、加/减遮罩、表面约束、内容识别填充、远端图像编辑、Worker 边缘色彩融合和 UV 修补层；融合失败会保留原始生成结果。
- 撤销/重做，以及将选中投影层/UV 层合并为新 UV 层或指定空白 UV 层。
- Photoshop UXP Live Link 和本地 Photoshop 会话桥接。

当前没有用户可操作的全局 `Auto UV bake` 开关。生成结果先作为实时投影层存在；用户可手动合并为 UV，局部修补按自己的提交路径生成 UV 层，GLB/FBX/OBJ 与 BaseColor 导出会在需要时为当前可见投影栈准备精确贴图。

尚未实现或尚未作为正式入口开放：

- 普通自由绘制 Brush、Projected Layer Eraser、Quick Mask、Segments/ColorID。Eraser 底层实现仍保留，但当前发布通过 feature constant 隐藏并阻止激活。
- Normal Map 生成（Normal 可视化和导入材质法线贴图导出已可用）。
- 粗糙度/金属度等贴图工作台内的 UV 烘焙输出；这些通道属于独立模型烘焙模块。
- Blender/3ds Max 实时连接器。`connectors/blender` 和 `connectors/3dsmax` 仍是占位实现。
- MP4、Segments ColorID 和 `.liclick3d` 便携工程包。

## 运行架构

```text
Browser (React/Vite/Three.js)
  ├─ Main workspace service (apps/server)
  │    ├─ Feishu/OIDC session and telemetry
  │    ├─ server-side jobs/history/recovery state
  │    └─ remote UV/retopology/bake/inpaint proxies
  └─ Windows local component (loopback)
       ├─ local texture projects, assets and settings
       ├─ personal Atlas/Liclick login and generation
       └─ Photoshop/DCC bridge boundary
```

| 进程/用途 | 当前默认值 |
| --- | --- |
| Vite 开发页面 | `127.0.0.1:5173` |
| 主工作区服务（源码和 `pnpm dev` 默认） | `127.0.0.1:4518` |
| 集成/LAN 部署 | 由 `SERVER_PORT` 配置；现有部署文档通常使用 `4517` |
| Windows 本地组件 | `127.0.0.1:4618`；开发脚本可注入其它端口 |

不要把 `4517`、`4518` 和 `4618` 当成同一个服务。主服务拥有 Web 身份、服务端任务状态与远端代理；当前贴图 project/folder/asset client 指向本地组件。组件属于当前 Windows 用户，还拥有个人 Liclick 身份和本地桥接。

## 安装与本地开发

```bash
pnpm install
pnpm dev
```

`pnpm dev` 启动主工作区服务和 Vite。单独调试可使用：

```bash
pnpm dev:web
pnpm dev:server
pnpm workspace:up
```

默认工作区位于 `workspace/`，可用 `LICLICK_WORKSPACE_DIR` 改写。`workspace/` 是运行时/用户数据，整体被 Git 忽略；不要强制提交工程、登录状态、生成资产、日志或本地备份。

本地组件单独打包：

```bash
corepack pnpm package:windows:local-component
corepack pnpm package:photoshop
```

长期单节点 Web 部署见 [docs/60_SINGLE_NODE_WEB_MVP.md](docs/60_SINGLE_NODE_WEB_MVP.md)，飞书配置见 [docs/61_FEISHU_WEB_LOGIN_SETUP.md](docs/61_FEISHU_WEB_LOGIN_SETUP.md)。

## 身份与 Liclick 账号边界

- Web 身份使用主服务上的飞书 OAuth/OIDC，会话保存在 HttpOnly cookie；Secret、飞书 Token 和 LI3D session token 不进入前端。
- 贴图生成默认使用个人本地组件：组件在本机完成 Atlas/Liclick 授权，只保存于该 Windows 用户的本地应用数据，并验证 Liclick 邮箱与当前飞书邮箱一致。
- 前端访问 `127.0.0.1:4618` 时附带主服务签发的本地身份凭据；主服务不能退化成机器级共享 Liclick 凭据。
- 开发/兼容环境仍支持 workspace Atlas transport；前端根据 provider status 选择 workspace 或 personal-local-component transport。

## 数据与项目

- 当前贴图工程以本地组件每用户目录中的 `project.liclick.json` 和二进制资产为准；主服务的会话、任务、历史与恢复状态也仍主要是文件/JSON 存储。
- `apps/server/prisma/schema.prisma` 是下一步数据库迁移的目标契约，不是当前项目持久化实现。
- 贴图工程保存对象、参考图、捕获、生成、图层、烘焙贴图、Bake Workspace 和 `texture -> retopology -> uv -> bake` 的追加式 pipeline revision。
- File System Access 与 JSON 下载/导入仍作为浏览器回退；正式 Web 工作流以工作区服务/本地组件为主。

## 导出矩阵

- Scene：GLB、FBX、OBJ、STL、Viewport PNG。
- 当前对象：GLB、FBX、OBJ、STL。
- Texture：BaseColor PNG；仅当源材质存在 `normalMap` 时可导出 Normal PNG。
- Video：浏览器支持 `MediaRecorder` 时输出 5 秒 WebM turntable。
- 未支持：Segments ColorID、MP4、便携工程包 zip。

## 已知实现问题

- `App.tsx` 生成 `/retopology` 和 `/project/:id/retopology`，但路径解析当前把这两个 URL 映射成 Auto UV。应用内从贴图发布可进入自动拓扑，直接打开或刷新该 URL 会进入错误模块。
- 项目运行时 JSON 尚未统一走共享 Zod schema；服务端部分项目读取依赖 TypeScript 断言。`packages/core` 的旧项目 schema 不能视为当前持久化真源。
- 编辑器和 3D 引擎的几个核心组件体积很大，功能边界仍高度集中；这是维护性现状，不是文档推荐架构。
- 当前文件工作区适合单节点/轻量多人使用，不具备数据库事务、对象存储和分布式任务队列的扩展能力。

## 验证命令

仓库提供 `build`、`lint`、`typecheck` 以及多组按能力拆分的 smoke/test 脚本。修改功能前先阅读 [docs/10_DEVELOPMENT_RULES.md](docs/10_DEVELOPMENT_RULES.md)，性能基线见 [docs/performance/LI3D_PERFORMANCE_TEST_PROTOCOL.zh-CN.md](docs/performance/LI3D_PERFORMANCE_TEST_PROTOCOL.zh-CN.md)。
