# Technical Architecture

## Repository Shape

LI3D 是 pnpm monorepo：

- `apps/web`：React 18、Vite、TypeScript 浏览器应用。
- `apps/server`：基于 Node 原生 HTTP 的主服务，也复用部分路由构建 Windows 本地组件。
- `packages/core`：共享业务类型/旧 schema；目前不是持久化真源。
- `packages/shared`：共享工具。
- `packages/connector-protocol`：DCC 消息契约。
- `integrations/photoshop-uxp`：已实现的 Photoshop UXP 集成。
- `connectors/blender`、`connectors/3dsmax`：占位 connector。

## Runtime Topology

```text
React/Vite browser
  ├─ Main workspace service
  │    ├─ Web auth/session/telemetry
  │    ├─ server jobs/history/recovery state
  │    ├─ Auto UV / Retopology proxy
  │    ├─ remote Substance bake proxy
  │    └─ model-view inpaint / ComfyUI proxy
  └─ Windows local component (127.0.0.1:4618)
       ├─ texture projects, assets and local settings
       ├─ personal Atlas/Liclick auth and generation
       ├─ local identity-proof verification
       └─ Photoshop/DCC bridge boundary
```

主服务源码默认端口为 `4518`；生产/LAN 通过 `SERVER_PORT` 配置，现有部署示例常用 `4517`。本地组件使用 `4618`。开发页面使用 `5173`。

## Web App

- 应用使用自定义 `App.tsx` pathname 解析和 `history.pushState`，不是 React Router。
- 路由页面使用 `React.lazy` 加载；首页、项目页、贴图编辑器、Auto UV、Auto Retopology、Bake 和工具箱是独立页面入口。
- Three.js + React Three Fiber + Drei 提供场景、相机、变换与控件。
- Zustand 是主要编辑器状态容器；TanStack Query 只在部分服务数据边界使用，不能把它描述成统一数据层。
- Zod 已安装并用于部分契约，但当前项目 JSON 没有在主服务读取时统一通过共享 schema 校验。
- Tailwind CSS、本地 Radix/shadcn 风格 primitives 和 lucide-react 构成 UI 层。

## Data Ownership

- 当前 `Project` 真源是 `apps/web/src/types/project.ts`，包含对象、参考、捕获、生成、图层、`bakedTextures`、`bakeWorkspace` 和追加式 `pipeline` revisions。
- 当前 `workspaceApiClient` 把贴图 project/folder/asset 请求发给 local component；主服务保存 Web 会话、服务端 job/history/recovery 等状态，并保留兼容的工作区路由。两侧都以用户作用域 JSON/二进制文件为主。
- 图片/模型使用项目相对路径，避免把大体积 base64 放入项目 JSON。
- `apps/server/prisma/schema.prisma` 定义下一步数据库目标；当前 runtime 不依赖 Prisma 读写项目。
- `packages/core` 中较早的项目 schema 未覆盖所有当前字段，也未接管服务端持久化。

## Texture Generation Route

1. 保存活动对象、对象矩阵和相机快照。
2. 捕获 Color/Mask/linear-view Depth/Normal。
3. 根据 provider status 选择 workspace Atlas transport 或 personal local-component transport。
4. 单视图直接提交一次生成；多视图为每个相机分别调用 single-view API，并以 batch metadata 组织。
5. 保存 Generation、Capture 和任务恢复信息。
6. 成功结果自动创建 Projected Layer；多视图完成后尝试内容识别补缝。
7. 结果保持实时投影，直到用户手动合并 UV 或导出路径按需生成 BaseColor。

## Projection And UV Route

- `ProjectedLayerMaterial.ts` 是自研 shader 路径，没有依赖 `three-projected-material`。
- 预览依据 frustum、Mask、linear depth、normal、backface、source alpha 和边缘权重筛选投影样本。
- Blend 层按质量组合，Overlay 层按栈顺序覆盖；未覆盖片元回退到底层材质。
- 手动 UV 合并调用 GPU-first UV-space bake，并在不支持或验证失败时使用 CPU 路径；合并结果成为 UV layer。
- 本地重绘修补和内容补缝各自生成/更新 UV 层。
- GLB/FBX/OBJ/BaseColor 导出会查找与当前可见栈一致的缓存；没有精确缓存时按需 bake，再叠加可见 UV layers。

## Main Server And Local Component

两者共享部分服务代码，但安全边界不同：

- 主服务拥有 Feishu/OIDC Web 会话、服务端任务状态和远端代理。
- 本地组件以 `LICLICK_LOCAL_COMPONENT_MODE=1` 启动，只监听 loopback，拥有该 Windows 用户的个人 Liclick 凭据和本地工程/桥接。
- 浏览器访问本地组件使用短期身份凭据证明当前 Web 用户，避免仅靠 CORS 或邮箱字符串信任请求。

## Current Architectural Risks

- `ViewportCanvas.tsx`、`SceneRoot.tsx`、`ProjectedLayerMaterial.ts`、`EditorPage.tsx`、`GeneratePanel.tsx` 等文件集中大量职责，UI/编排/引擎边界并未达到理想拆分。
- 主服务文件存储适合单节点；多实例会缺少数据库事务、分布式锁和共享对象存储。
- 项目 runtime contract 分散在 Web 类型、服务端断言和旧 core schema 之间。
- `App.tsx` 的 retopology URL 生成与解析不一致，直接访问/刷新会路由到 Auto UV。
