# LI3D 零本地组件现代化收尾报告（2026-08-22）

## 1. 结论

当前隔离分支已经证明：LI3D 可以迁移为不要求用户安装本地组件的浏览器产品，并保留原版的首页、项目、贴图、UV、自动拓扑、烘焙、账号历史和工具箱信息架构。浏览器继续使用用户设备的 CPU/GPU 负责视口、投影、图层、蒙版、合成和适合浏览器的交互计算；LI3D 应用服务器负责登录、项目、历史、权限和任务编排；独立 GPU/AIGC API 集群负责 Auto UV、自动拓扑、Substance Bake 与 AIGC 推理。

这不是“已经可以直接上生产”的结论。代码迁移与核心纵向链路已经可行，发布前仍有三个必须明确的外部阻断：生产 HTTPS SSO 回调尚未验收，大型生产模型 Auto UV 仍可能触发 `UV_QA_FAILED`，自动拓扑仍会触发 `RETOPOLOGY_COORDINATE_MISMATCH`。机器发布闸门继续保持关闭，不能把测试页可用等同于生产就绪。

## 2. 原版功能对齐状态

| 原版能力 | 当前结果 | 说明 |
| --- | --- | --- |
| 首页与五模块入口 | 已对齐 | 保留贴图绘制、自动展 UV、自动拓扑、模型烘焙、工具箱布局；没有改成无关仪表盘。 |
| 飞书/莉刻账号 | 真实员工链路通过 | 2026-08-22 再次由浏览器完成真实员工“任田”登录；页面恢复真实用户身份并读取账号任务历史。正式 HTTPS 企业 OAuth 回调仍待部署验收。 |
| 文件夹、项目和项目卡片 | 已实现 | 创建、列举、加载、保存、重命名、移动、复制、软删除、Revision、Command 幂等和账号隔离均有自动回归。 |
| 贴图工作台 | 核心功能已保留 | 模型加载、视口、相机、图层、投影、蒙版、多视角/单视角生成、局部重绘、内容修补、撤销恢复与导出链路仍在；完整生产模型像素金图矩阵尚未封板。 |
| Auto UV | 真实服务器成功链路已补齐 | 只走真实 Asset Worker，不再把本地 xatlas 结果当产品任务；服务器产物经过摘要校验、写入账号项目 Revision，并可传入烘焙。大型复杂模型质量仍待 Worker 修复。 |
| 自动拓扑 | 真实服务器链路已通，质量未通过 | 上传、排队、Worker、进度、历史和错误门禁都是真实服务；坐标恢复缺陷尚未解决，不能标记生产通过。 |
| PBR 烘焙 | 真实 Substance 纵向通过 | 真实 TLS Worker 已完成 4K 七通道结果；Base Color、Normal、AO、Curvature、World Normal、Thickness、Position、DX/OP 选择和账号历史保留。 |
| 工具箱 | 原版界面和九项清单保留 | `/tools` 保留原产品结构与九项清单。PS/DCC 实时桥接按用户要求暂缓并有明确标签，不作为浏览器核心流程依赖。 |
| 本地组件 | 已移除 | Cloud 产物无安装器、可执行文件、4618 桥接和 localhost 组件回退；用户无需额外下载安装。 |

## 3. 2026-08-22 新增真实纵向证据

### 3.1 真实员工与集群状态

- 浏览器登录后显示真实员工“任田”，不是 Mock 用户。
- LI3D 应用服务器通过真实身份会话访问独立 Asset API 集群。
- 容量接口返回 `9 Worker / 16 槽位`，页面状态来自远端 API。
- 烘焙页面返回 `asset-worker-3090-b-windows 已连接 · TLS 已验证`。

### 3.2 Auto UV 成功任务

| 字段 | 结果 |
| --- | --- |
| Job ID | `29a7bf45-bc4a-4d42-a83e-1ec8e8997db5` |
| 账号 | `atlas-kianaren@lilith.com` |
| 输入 | `server-uv-e2e.obj`，2 个三角面 |
| 状态 | `SUCCEEDED`，100% |
| 交付物 | BLEND、FBX、FBX QA、UV QA、报告，共 5 项 |
| 主要输出 | `server-uv-e2e_PBR_UV.fbx` |
| 项目 | `project-d0fe062f-d406-499b-a6e4-9a231b3e6c1a` |
| 项目 Revision | `sourceMode=processing-job`、`stage=uv`、`status=ready` |
| 页面结果 | UV 线框预览、下载、保存并传入烘焙全部通过 |

这条证据证明真实服务器成功返回和 Browser → App Server → GPU/AIGC Cluster → App Server → Browser → Project Revision → Bake 的完整交接已经成立。它不能覆盖大型生产模型质量：此前 39.7 MB 工业模型任务仍以 `UV_QA_FAILED` 结束，因此 Auto UV 总门禁保持“进行中”。

## 4. 零本地组件、服务器数据与用户本机算力证明

### 4.1 先定义清楚“零本地组件”

“零本地组件”不是“不下载任何代码”，而是用户只访问标准网页，不安装 LI3D 的 EXE/MSI、Windows Service、托盘程序、DLL、浏览器扩展或 `localhost:4618` 守护进程。浏览器仍会像普通网站一样从服务器下载 HTML、CSS、JavaScript、Worker 和 WASM；这些文件在浏览器沙箱内运行，随页面/缓存生命周期管理，不具有系统服务权限，也不等于额外安装的本地组件。

当前证明链如下：

1. Cloud 构建插件在打包时排除 `.bat/.bin/.cmd/.dll/.exe/.msi/.ps1`、旧组件下载目录和工具箱安装资产；生产 alias 强制选择 cloud transport、cloud project API、cloud 性能接口和禁用版 PS bridge，见 [`apps/web/vite.config.ts`](../../apps/web/vite.config.ts)。
2. [`TextureRuntimeBoundary.tsx`](../../apps/web/src/components/runtime/TextureRuntimeBoundary.tsx) 不再执行安装检测、版本门禁或本机守护进程握手，只渲染浏览器工作区。
3. [`check-cloud-boundary.mjs`](../../scripts/check-cloud-boundary.mjs) 禁止 Web 源码重新引入旧运行时 client、安装器文案和下载逻辑，且当前 allowlist 为 0。
4. [`check-cloud-artifact.mjs`](../../scripts/check-cloud-artifact.mjs) 对最终 `dist` 逐文件扫描可执行扩展名，并扫描 `127.0.0.1:4618`、`localhost:4618`、组件安装器、identity proof 和旧 API 字符串。
5. 2026-08-22 最新复验结果为：`168 files / 10.73 MiB / 0 host component / 0 loopback bridge`。`smoke:web` 同时验证旧组件下载 URL、本机性能 API 和 PS/DCC bridge API 在 Cloud Build 中返回 404。

所以能证明的是：发布给用户的 Cloud Web 产物没有 LI3D 原生宿主组件，也没有向用户电脑上的 4618 端口回退。不能仅凭当前 `127.0.0.1:5646` 地址证明“已经部署到生产服务器”；该地址是本轮测试电脑上的应用服务器预览。它模拟正式 Web/App Server 的部署形态，并连接了真实 Asset/Substance/AIGC API，生产域名部署仍属于发布门禁。

### 4.2 数据在哪里，计算在哪里

| 层 | 权威内容/职责 | 实际计算位置 | 证据 |
| --- | --- | --- | --- |
| 浏览器 | 当前打开的模型缓冲区、Canvas、GPU 纹理、临时缓存 | 用户电脑的浏览器进程、Web Worker、WASM、WebGL/WebGPU | [`browserComputeCapabilities.ts`](../../apps/web/src/platform/browserComputeCapabilities.ts)、[`gpuComputeBackend.ts`](../../apps/web/src/engine/performance/gpuComputeBackend.ts) |
| LI3D 应用服务器 | 登录会话、账号 ownership、项目当前快照、不可变 Revision、Command 回执、文件夹、用户设置、任务历史与任务编排 | Web/API 服务器 CPU；不替普通贴图交互补算 | [`postgresProjectRepository.ts`](../../apps/server/src/repositories/postgresProjectRepository.ts)、[`postgresControlRepository.ts`](../../apps/server/src/repositories/postgresControlRepository.ts) |
| 对象存储 | 模型、贴图、导出物和任务交付物的权威二进制对象 | 存储服务；浏览器通过签名 URL 直传/直下 | [`assetTransferService.ts`](../../apps/server/src/services/assetTransferService.ts) |
| 独立 GPU/AIGC 集群 | Auto UV、自动拓扑、Substance Bake、ComfyUI/AIGC 正式任务 | 独立远端 Worker/GPU，不是 LI3D 应用服务器，也不是用户本机 | [ADR-0011](./ADR-0011-real-production-compute-services.md) |

项目数据的完整循环是：账号登录 → 应用服务器返回 Project Revision/签名资产 URL → 浏览器下载工作副本 → 本机 CPU/GPU 进行视口、投影、蒙版、图层和合成 → 结果经签名上传 → 应用服务器用带 expected Revision 的幂等 Command 提交 → PostgreSQL/对象存储成为新权威版本。`localStorage`、IndexedDB、OPFS 只允许保存布局、缓存或断点恢复辅助，不是账号项目的权威数据库。

Auto UV、自动拓扑、生产 Bake 和 AIGC 是例外：这些任务按产品要求把模型/输入交给独立 GPU/AIGC API 集群，集群返回正式产物。它们不冒充“用户本机算力”；“调用用户本机 CPU/GPU”的范围是浏览器贴图交互、3D 视口、投影、蒙版、图层合成、编码/解码和其他适合浏览器的计算。

### 4.3 浏览器 CPU 证明

页面启动时会真实检测 `Worker`、`WebAssembly`、`OffscreenCanvas`、OPFS、共享内存、逻辑处理器和设备内存，并由 [`localComputePolicy.ts`](../../packages/contracts/src/localComputePolicy.ts) 选择本地计划，缺少能力只会降级为 WebGL2/Worker/主线程，不允许切换到 LI3D 服务器补算。

本轮页面实际写出的 DOM 运行态为：

| 字段 | 实测值 | 含义 |
| --- | --- | --- |
| `data-li3d-cpu-backend` | `wasm-worker` | Worker 与 WebAssembly 均可用，CPU 重任务可离开 UI 主线程 |
| `data-li3d-compute-quality` | `high` | 运行时门槛要求 WebGPU、至少 8 个逻辑处理器、至少 8 GB 可报告内存 |
| `data-li3d-server-compute-fallback` | `forbidden` | 普通浏览器计算不能静默改由 LI3D 服务器执行 |
| Worker 创建点 | 21 处 | 图像解码、PNG 编码、蒙版准备、接缝协调、图层合成、GPU 读回、UV 光栅等均有独立 Worker 边界 |
| 模型解析时间线 | FBX 主线程解析 `546.4 ms` | 直接证明测试模型解析发生在浏览器页面，而不是服务器返回预解析占位结果 |

测试电脑硬件盘点为 Intel i7-13700KF，16 个物理核、24 个逻辑处理器；这是本次证据机器，不是所有用户机器的最低配置承诺。

### 4.4 浏览器 GPU、Three.js 与 D3D 关系

当前不是直接编写 D3D 引擎，也不是 Unity/Unreal Native Runtime。基础栈是：

```text
React 18
  └─ React Three Fiber 8.18
      └─ Three.js 0.171 WebGLRenderer / WebGL2（3D 视口、材质、投影与 GPU RenderTarget）

Web Worker
  └─ WebGPU API（RGBA 合成、质量混合、UV 拓扑光栅等重计算）
      └─ Chromium Dawn

Windows 浏览器驱动层
  ├─ WebGL → ANGLE → 通常 D3D11
  └─ WebGPU → Dawn → 由 Chromium/驱动选择 D3D12 或 D3D11
```

视口 [`ViewportCanvas.tsx`](../../apps/web/src/engine/viewport/ViewportCanvas.tsx) 创建 Three.js `WebGLRenderer`，请求 `powerPreference: high-performance`，并处理 WebGL context lost/restored。WebGPU 不是只做 `navigator.gpu` 布尔探测：[`gpuComputeBackend.ts`](../../apps/web/src/engine/performance/gpuComputeBackend.ts) 会申请高性能 adapter/device，创建 compute shader 和 pipeline，让 GPU 写入 `0x4c693344`，提交队列后复制回读；返回值一致才标记 `ready`。

本轮真实页面性能面板记录：

| GPU 指标 | 实测值 |
| --- | --- |
| 计算后端 | `webgpu · ready` |
| GPU 自检 | `验证 1`，真实 shader dispatch + copy/readback 成功 |
| 当时已记录的生产 WebGPU dispatch | `0`；因此不把该瞬间的所有贴图步骤宣称为 WebGPU 计算 |
| WebGL GPU Timer P95 | `0.5 ms`，约占 16.7ms 帧预算 3% |
| Draw Calls / 三角形 | `3 / 300,000 每帧` |
| 纹理 / 几何 / Program | `10 / 5 / 12` |
| 纹理单元 / 最大纹理 | `16 / 16384` |
| Canvas / DPR / JS Heap | `1600×900 / 1.3 / 593 MiB` |

测试机 GPU 为 `NVIDIA GeForce RTX 4070 Ti SUPER`，驱动 `591.74`，`nvidia-smi` 报告显存 `16,376 MiB`。WebGPU adapter 自检和 WebGL GPU timer 证明页面确实获得了浏览器 GPU 设备与 GPU 计时能力；操作系统硬件盘点证明该机器存在这块显卡。但普通网页 API 出于隐私/安全不会稳定暴露“本次上下文最终选中的 D3D11/D3D12 backend”字符串，所以报告不伪造一个精确结论：可以确认 WebGL/WebGPU，Windows Chromium 的实现映射是 ANGLE/Dawn；当前会话究竟由 Dawn 选了 D3D12 还是 D3D11，需要用户在目标浏览器的 `chrome://gpu`/企业诊断页人工留档后才能封板。

Chromium 源码也明确说明 Windows WebGL 继续使用 ANGLE 的 D3D11 device，而 Dawn/Chromium 具备 D3D12 与 D3D11 backend：[Chromium GL feature implementation](https://chromium.googlesource.com/chromium/src/+/master/ui/gl/gl_features.cc)、[Chromium WebGPU technical report](https://chromium.googlesource.com/chromium/src/+/main/docs/security/research/graphics/webgpu_technical_report.md)、[ANGLE repository](https://chromium.googlesource.com/angle/angle)。

### 4.5 如何进一步做成上线级证明

上线验收不能只看开发机。每个目标浏览器/硬件档需要导出一份同结构证据：浏览器版本、CPU 核数、GPU/驱动、`chrome://gpu` 后端、WebGPU 自检、至少一次生产 dispatch、WebGL context、长任务、显存/内存、设备丢失恢复和网络请求清单。还需在干净 Windows 沙箱中验证：没有安装 LI3D 软件、没有 4618 监听端口、浏览器只连接正式域名/对象存储/远端 API，刷新和重启后账号项目仍从服务器恢复。

本轮机器可读证据已保存到 [`quality/evidence/browser-runtime-compute-2026-08-22.json`](../../quality/evidence/browser-runtime-compute-2026-08-22.json)。

## 5. 架构与稳定性优化

### 5.1 多实例数据一致性

- 新增 PostgreSQL 事务 Repository，项目当前快照、不可变 Revision、Command 回执和账号 ownership 进入同一事务边界。
- 支持跨实例重复命令幂等、乐观并发冲突保护、软删除、重命名、移动和复制。
- 正式环境选择 PostgreSQL 时缺少数据库地址会直接失败，不会静默退回本地文件。
- 4 实例、4 账号、15 轮、240 次重复请求、事务回滚注入和重启恢复通过；高压复验 8 实例、4 账号、120 轮、3,840 次重复请求通过。
- 2026-08-22 进一步把原先仍落在应用节点 JSON/内存的用户、Cookie Session、OAuth state/PKCE 事务、文件夹、用户设置、UV/拓扑任务历史、对象上传 Intent/资产元数据迁入共享 PostgreSQL 控制面。每张业务表的主键或查询条件都包含 `user_id`，对象 key 使用用户 ID 的 SHA-256 分区；OAuth state 由数据库原子地一次性消费，回调被负载均衡到另一副本也能完成且不能重放。
- 新增 100 账号、8 应用副本验收：每个账号各自创建项目、会话、文件夹、任务历史、对象元数据和设置；从不同副本读取后逐一尝试相邻账号的 Project ID、Job ID、Asset ID，全部不可见；OAuth state 跨副本只消费一次；关闭并重启数据库后全部恢复。该测试约 2.4 秒完成，属于隔离/一致性契约，不冒充完整生产网络容量测试。

### 5.2 100 人同时在线时为何不会共用应用服务器显卡

100 人同时旋转模型、绘制、投影、显示 PBR 和合成图层时，实际形成的是 100 个互相独立的浏览器图形上下文：

```text
用户 1 浏览器 ─ WebGL2/ANGLE/D3D11 + WebGPU/Dawn/D3D12(或 D3D11) ┐
用户 2 浏览器 ─ WebGL2/ANGLE/D3D11 + WebGPU/Dawn/D3D12(或 D3D11) ├─ 各用各的电脑 GPU/CPU
……                                                               │
用户 100 浏览器 ─ 同上                                           ┘

浏览器 ── HTTPS 元数据/Command/签名 URL ── LI3D 无状态应用副本 ── PostgreSQL
浏览器 ── 签名 PUT/GET ──────────────────────────────── 对象存储/CDN
需要正式生产算力的 Auto UV/拓扑/Bake/AIGC ─────────── 独立 GPU/AIGC API 集群
```

因此，视口每帧 300,000 个三角形、3 个 Draw Call 或贴图 GPU RenderTarget 不会乘以 100 后在 LI3D 应用服务器渲染；应用服务器没有 Three.js Canvas，也不接收逐帧 Draw Call。其负载只随登录、项目命令、历史查询、签名 URL 和任务编排请求增长。大模型二进制应由浏览器通过签名 URL 直传/直下对象存储，避免 100 份文件穿过 Node.js 进程；AIGC 峰值由独立集群的队列和槽位控制，不占 LI3D Web/App Server 显卡。

代码层存在三道防回退证据：`selectLocalComputePlan()` 固定 `serverFallbackAllowed: false`；Cloud Boundary/Artifact 门禁阻止本地组件和 loopback bridge 回归；`/api/health` 明确报告 `browserLocalGraphics=true`、`serverGraphicsFallback=false`。应用入口另有默认 256 个在途请求的 admission 上限，超过时返回 503 + `Retry-After`，避免单节点因突发连接耗尽；Kubernetes/反向代理仍应按 readiness、连接数和 P95 横向扩容。

### 5.3 100 人上线的部署硬条件

只有满足下列配置，才能获得上述性质；把单机预览直接开放给 100 人不在承诺范围：

1. 所有 LI3D App 副本设置同一个 `LICLICK_CLOUD_DATABASE_URL`，并设置 `LICLICK_PROJECT_REPOSITORY=postgres`；发布前运行 `pnpm --filter @liclick/server db:cloud:migrate`，其中 `001` 建项目 Revision/Command，`002` 建共享账号控制面。
2. 所有副本共享同一个强随机 `SESSION_SECRET`，Cookie 在 HTTPS 下启用 `Secure + HttpOnly + SameSite`；禁止各节点生成不同 Secret，否则用户切换节点会掉登录。
3. 必须配置 S3 兼容对象存储；模型、纹理与交付物通过用户/项目分区的短期签名 URL 直传直下。应用节点本机磁盘只能是临时缓存，不能作为多人权威数据源。
4. 至少两个 LI3D App 副本置于负载均衡后，readiness 失败或 draining 时摘流；默认数据库连接池每副本 20，需按 PostgreSQL 最大连接数计算副本上限，不能盲目扩容。
5. GPU/AIGC 集群保持独立，按账号/租户设置并发额度、队列长度、超时和取消；LI3D 应用节点仅代理控制请求，不部署用户视口或浏览器烘焙 GPU。
6. 上线前追加真实环境的 100 浏览器会话、典型项目保存频率、对象存储带宽、SSO、故障切换和 8 小时 soak。当前自动测试已证明 100 账号隔离与重启恢复，但尚未证明目标机房在 100 个大模型同时首次下载时的带宽容量。

### 5.4 服务生命周期与压力

- `/api/health` 与 `/api/ready` 分离存活和可接流量状态。
- SIGTERM/SIGINT 进入 draining，拒绝新业务并等待在途请求，随后同端口重启恢复。
- HTTP 健康接口 60 并发持续 30 秒：367,658 次请求、0 失败、P95 9ms。
- 本轮使用新构建的 Server 再执行 100 并发持续 15 秒：176,246 次 `/api/health` 请求、0 失败、全部 HTTP 200、P95 13.5ms。该数据证明单节点轻量入口和 admission 机制未在 100 并发下崩溃，不代表 176,246 次模型上传或 GPU 任务吞吐。
- Cloud 部署模拟器覆盖构建、readiness、OAuth/PKCE、对象直传、首次失败重试、幂等、优雅停机和重启恢复。

### 5.5 浏览器性能与资源边界

- GLTF/GLB、FBX、OBJ 解析器改为按实际格式动态加载，避免用户只打开一种模型时下载全部解析器。
- Engine Session 最多保留 3 个空闲项目会话；24 项目、每项目 8 MiB 的切换回归中，21 个旧会话立即释放，宽限期结束后资源估算归零。
- 生产 JavaScript 共 61 个 chunk、约 3.02 MB；共享 3D 管线由约 948 KB 收敛到约 831 KB。
- Bundle 门禁收紧为：Shell 265 KB、编辑器 490 KB、高模 Bake 700 KB、共享 3D 管线 850 KB、总 JS 3.05 MB。
- 仍存在两个超过 500 KB 的重型 3D chunk 警告；门禁没有通过抬高警告阈值掩盖该债务。

## 6. 自动化验证汇总

最新分支已通过：

- 全仓 `lint`：通过。
- 全仓 `typecheck`：通过。
- Web 回归：31 项契约通过。
- Server 回归新增共享控制面契约：100 账号、8 副本，项目/会话/文件夹/任务历史/对象元数据/用户设置隔离与重启恢复通过。
- Release/Compute/Project/Asset 契约：9 项通过。
- Cloud 边界：0 个已知本地组件遗留文件，无依赖扩散。
- Project Repository 边界：通过。
- Cloud 产物：168 个文件、10.73 MiB，无宿主组件或 loopback 桥接。
- Cloud 部署模拟器：构建、登录、代理、直传、重试、幂等、停机、重启全部通过。
- 浏览器人工自动联测：真实登录、真实容量、真实 UV 成功、账号历史、项目保存、烘焙交接通过。

## 7. 仍未关闭的发布阻断

| 优先级 | 阻断 | 发布前完成标准 |
| --- | --- | --- |
| P0 | 生产 HTTPS SSO | 登记正式域名回调，企业应用发布，验证 Secure/HttpOnly/SameSite、CSRF、CSP、退出与会话续期。 |
| P0 | 大型 Auto UV 质量 | 修复 Worker/QA，用至少三类生产模型验证成功制品、取消、失败恢复和超大模型。 |
| P0 | 自动拓扑坐标恢复 | 修复 `RETOPOLOGY_COORDINATE_MISMATCH`，验证 FBX/BLEND、三方 SHA 和八项 QA。 |
| P1 | 贴图生产金图 | 补齐遮挡、多对象、多材质、完整图层/撤销、导出和跨浏览器像素对照。 |
| P1 | 数据安全面 | 项目与账号控制面 PostgreSQL 已完成；仍需真实对象存储回收、文件魔数/解压炸弹/内容扫描、备份恢复与迁移演练。 |
| P1 | 100 人真实容量 | 自动测试已覆盖 100 账号/8 副本隔离和入口限流；仍需在目标 LB、PostgreSQL、对象存储上执行真实 100 浏览器/大文件/8 小时 soak 后确定副本数与带宽。 |
| P1 | 目标硬件性能 | 补齐低中高三档设备的 input-to-present、Long Task、显存/内存和设备丢失恢复采样。 |

## 8. 合并与部署建议

1. 继续只在 `codex/modernization` 或新的集成测试分支验证，不直接合并 `master`。
2. 以当前提交构建不可变 Web/Server 镜像，同一 SHA 在测试、预发、生产逐级晋级，不在服务器现场重新构建。
3. 先完成 P0 Worker 与 SSO 阻断，再执行生产对象存储、PostgreSQL、备份和灰度回滚演练。
4. 机器发布闸门全部变为 `passed` 之前，不对外宣称“原版全部功能生产等价”。当前准确表述是：核心功能迁移可行、零安装架构成立、主要纵向链路已通，生产质量与外部部署验收尚未全部关闭。

## 9. 本轮中文提交

- `f30c296 实现：项目数据多实例事务与幂等保存`
- `8909399 测试：增加多实例故障恢复与长稳压测`
- `b6116a95 优化：收紧真实UV交付与浏览器资源边界`
- `c880029 文档：汇总零组件迁移验收与生产阻断`
- `93aa8b3 修复：首页贴图保存语义对齐账号数据`

后续提交继续使用中文标题。
