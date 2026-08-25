# Technical Architecture

## Repository Shape

LI3D 是 pnpm monorepo：

- `apps/web`：React 18、Vite、TypeScript、Three.js/R3F 浏览器应用。
- `apps/server`：Node 主应用服务器，负责身份、项目、历史、对象存储编排和生产服务代理。
- `packages/contracts`：Release、Project Command/Revision、资产传输和计算策略契约。
- `packages/core`、`packages/shared`：共享业务类型与工具。
- `packages/connector-protocol`：暂缓的 DCC 消息契约。
- `integrations/photoshop-uxp`、`connectors/*`：历史集成和占位连接器，不属于零安装核心运行时。

Windows 本地组件、安装器、下载分片、loopback 路由和启动/打包脚本已从 `codex/modernization` 退役。

## Runtime Topology

```text
React/Vite browser
  ├─ Three.js viewport and editor state
  ├─ WebGPU/WebGL2 rendering and UV layer composition
  ├─ Worker/WASM masks, image processing and browser-safe kernels
  └─ same-origin HTTPS API
          │
          ▼
LI3D application server
  ├─ Feishu/Atlas OAuth and HttpOnly session
  ├─ tenant/user/project ownership
  ├─ Project Command + Revision + account history
  ├─ signed object-storage transfer orchestration
  ├─ generation/inpaint proxy
  └─ Asset V4 / Substance task proxy
          │
          ▼
Independent GPU/AIGC API cluster
  ├─ Auto UV / Retopology workers
  ├─ Substance Baker workers
  └─ generation / inpaint workers
```

LI3D 应用服务器和 GPU/AIGC 集群是两个部署边界。应用服务器不能把页面请求标成“远端”后在本机模拟算法；GPU/AIGC Worker 也不拥有 LI3D 用户会话或项目权限。

源码服务默认端口为 `4518`，生产/LAN 通过 `SERVER_PORT` 配置，Vite 开发页默认 `5173`。`4618` 只属于已退役历史组件，Cloud 构建和正式运行时不得监听或访问该端口。

## Web App

- `App.tsx` 使用自定义 pathname 解析和 `history.pushState`；页面按路由懒加载。
- Three.js + React Three Fiber + Drei 提供场景、相机、变换与控件。
- Zustand 是主要编辑器状态容器；TanStack Query 只覆盖部分服务数据边界。
- 项目级 Engine Session 管理浏览器 GPU/CPU/IO lane、取消令牌和资源生命周期。
- Cloud Vite 构建以 alias 和边界检查禁止本地组件 client、loopback transport 和安装资产进入产物。

## Compute Ownership

### Browser compute plane

- 视口渲染、相机与变换交互。
- 指针蒙版、局部选区、投影采样、图层合成和手动 UV 图层合并。
- 图片编码、边缘融合以及适合 Worker/WASM/WebGPU 的交互内核。
- 设备能力不足时显式降级或阻断，不把普通交互计算偷偷转移到 LI3D 服务器。

### Production service plane

- Auto UV：模型经应用服务器提交 Asset V4，页面显示真实 Worker/槽位、进度、错误和账号历史。
- Auto Retopology：高模提交 Worker，只有通过坐标/几何/产物 QA 的低模才允许发布。
- PBR Bake：高低模、材质贴图和参数提交真实 Substance Worker，返回校验后的通道产物。
- Generation/Inpaint：由受控 AIGC API 提供，浏览器负责蒙版和结果应用。

正式模式禁止回退到模拟器、本地 xatlas、浏览器三角简化或 BVH Bake。历史内核只保留为隔离回归测试。

## Data Ownership

- LI3D 应用服务器按 tenant/user/project 验证项目、资产、Job、历史和下载权限。
- Project Command 使用幂等键，成功写入产生新 Revision；浏览器缓存不是权威数据。
- 大模型和图片优先使用签名 URL 直传对象存储，控制面保存哈希、尺寸、类型和资产引用。
- `apps/server/prisma/cloud.schema.prisma` 定义目标 Cloud schema；当前文件型开发存储和远端部署模拟器不等于生产数据库验收完成。
- Web、Server、协议和 Schema 由同一 Release Manifest 与 Git SHA 绑定。

## Texture And Repaint Route

1. 保存活动对象、变换和相机快照。
2. 浏览器捕获 Color、Mask、linear-view Depth 和 Normal。
3. 单视图或多视图任务经应用服务器提交生成服务。
4. 结果保存为账号/项目资产并创建 Projected Layer。
5. 局部重绘由浏览器生成指针蒙版，服务完成图像编辑，浏览器进行边缘融合和投影/UV 应用。
6. Project Revision 保存资产引用和图层状态，刷新或服务重启后恢复。

## Current Architectural Risks

- `ViewportCanvas.tsx`、`SceneRoot.tsx`、`EditorPage.tsx`、`GeneratePanel.tsx` 等仍集中较多职责。
- 生产 PostgreSQL、对象存储事务、回收、内容安全和多实例锁尚未完成最终验收。
- Auto UV 的真实服务输出被 `UV_QA_FAILED` 阻断；自动拓扑被 `RETOPOLOGY_COORDINATE_MISMATCH` 阻断。
- 生产 OAuth HTTPS 回调、企业应用发布、目标域名安全头和 Secret 管理仍需部署验收。
- 浏览器性能和资源回落矩阵尚未完成，不得宣称整体性能门禁通过。

决策真源见 [modernization/README.md](modernization/README.md) 与 [modernization/ADR-0011-real-production-compute-services.md](modernization/ADR-0011-real-production-compute-services.md)。
