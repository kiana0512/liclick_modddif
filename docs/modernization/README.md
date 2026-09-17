# LI3D 现代化迭代总纲

> 历史说明：本文件记录 2026-08 的迁移决策与阶段状态，其中 `codex/modernization`、`desktop-legacy` 和阶段完成度不是 2026-09-17 当前分支/运行时说明。当前真值以 [系统模块与变更唯一准则](../00_SYSTEM_MODULES_AND_CHANGE_STANDARD.md)、[文档地图](../README.md) 和 [性能稳定性审计](../PERFORMANCE_STABILITY_RISK_AUDIT_2026-09-17.zh-CN.md) 为准。

状态：已批准执行，采用隔离仓库渐进迁移。

2026-08-22 的功能对齐、稳定性、真实服务成功/失败证据和剩余发布阻断见 [CLOSING_REPORT_2026-08-22.zh-CN.md](./CLOSING_REPORT_2026-08-22.zh-CN.md)；上一轮记录保留在 [HANDOFF_2026-08-21.zh-CN.md](./HANDOFF_2026-08-21.zh-CN.md)。

## 不可妥协的目标

1. 莉刻 Cloud Build 不要求安装本地组件，也不允许回退到 `localhost`。
2. 投影、图层合成、蒙版和视口交互使用用户浏览器的 CPU/GPU；Auto UV、自动拓扑和生产烘焙按产品要求提交真实服务集群。
3. LI3D 应用服务器负责身份、权限、项目 Revision、对象存储、同步、审计和任务编排；独立 GPU/AIGC API 集群负责 UV、拓扑、Substance 烘焙和 AI 推理。
4. 一个 Git SHA 只构建一次；Web、Server、协议和数据 Schema 必须具有同一 Release Manifest。
5. 迁移采用适配器和可回滚阶段，不通过验收门禁的替代实现不得删除旧路径。

## 目标边界

```text
Browser local compute plane
  React UI -> Project Domain -> Engine Session
                              -> WebGPU/WebGL2
                              -> Web Worker/WASM
                              -> OPFS/IndexedDB cache

Cloud control plane
  BFF -> Liclick SSO
      -> Project revisions
      -> PostgreSQL metadata
      -> signed object-storage URLs
      -> audit and observability
      -> GPU/AIGC API cluster
           -> Asset V4 UV / Retopology Workers
           -> Substance Baker Workers
           -> Generation / Inpaint services
```

浏览器缓存不是项目权威数据。大模型、图片和贴图使用签名 URL 在浏览器和对象存储之间直传，BFF 不代理普通贴图中间像素。

## 迁移原则

- `master` 保留原始产品基线，现代化工作只进入 `codex/modernization`。
- 当前桌面路径被视为 `desktop-legacy` 适配器；新增业务代码不得直接依赖它。
- Cloud 边界检查首先采用固定白名单阻止债务扩散，随后按功能迁移逐项清零。
- 项目数据采用版本化 Command 和 Revision，禁止多个存储实现长期双写。
- WebGPU 是优先 Compute 后端；WebGL2 保留为成熟渲染和降级后端；CPU 算法进入 Worker/WASM。

## 阶段

| 阶段          | 交付物                                | 退出条件                       |
| ------------- | ------------------------------------- | ------------------------------ |
| 0. 隔离与基线 | 独立仓库、审计、基准、ADR             | 原仓库零修改，基线可复现       |
| 1. 发布与契约 | Release Manifest、CI、Cloud 边界门禁  | 混合版本可检测，新债务被阻断   |
| 2. 项目领域   | 权威 Schema、Command、Revision、迁移  | 项目协议只有一个实现           |
| 3. 云端数据面 | PostgreSQL、对象存储、签名直传、SSO   | 无本地组件可保存和恢复项目     |
| 4. 本地计算面 | Engine Session、Scheduler、资源预算   | 浏览器交互任务不阻塞主线程     |
| 5. 算法迁移   | 浏览器贴图内核、真实 UV/拓扑/Bake API | 本地与远端任务边界可验证       |
| 6. 切换       | Cloud Build 清零 localhost 依赖、灰度 | 干净设备纯浏览器 E2E 通过      |

详细门禁见 [ACCEPTANCE_GATES.md](./ACCEPTANCE_GATES.md)，首个架构决策见 [ADR-0001](./ADR-0001-cloud-local-compute.md)。

逐功能的真实完成状态见 [FEATURE_ACCEPTANCE_MATRIX.md](./FEATURE_ACCEPTANCE_MATRIX.md)。机器可读发布闸门会拒绝任何仍为进行中、失败或未测试的必需能力。

## 当前实施状态

- 隔离基线已建立，原仓库不参与现代化修改。
- Release Manifest、协议兼容检查和发布环境一致性校验已接入。
- Cloud 构建已采用独立适配器：项目/设置走同源控制面，浏览器贴图入口不检测桌面组件。
- Cloud 产物门禁会拒绝安装器、可执行文件、本地账号桥接端点和 `4618` loopback 回退。
- Windows 本地组件、安装器、个人设备账号桥接和 localhost 运行时已从现代化分支退役。Photoshop/DCC 实时交互暂缓，后续只能以独立方案重新立项，不能成为浏览器核心流程依赖。
- 真实员工身份的本地验收使用 `pnpm preview:real-auth`：浏览器仍为零安装，开发机上的后端进程模拟云服务器并调用 server-side Atlas/IDaaS。该命令不启动 Mock IDaaS，也不会进入 Cloud Web 产物。它只证明真实员工登录、退出和会话链路；正式发布仍必须通过已登记 HTTPS 回调的企业 OAuth/IDaaS 验收。
- 浏览器能力协商已形成版本化 Compute Policy；任何降级仍在用户浏览器执行，`serverFallbackAllowed` 固定为 `false`。
- 项目保存已加入服务器签发的单调 Revision；Cloud 模式拒绝缺失或过期令牌，避免多端用客户端时间戳互相覆盖。
- Cloud 保存、重命名和移动已统一为版本化 Project Command；网络重试具有持久化幂等回执，同一命令不会重复生成 Revision，旧桌面接口继续作为兼容适配器。
- 项目路由、命令、资产、导出和文件夹服务已收拢到单一 Project Repository；门禁阻止业务层重新绑定文件系统，并已给出 PostgreSQL/对象存储权威数据蓝图。
- Cloud 最终产物已加入分块和总 JavaScript 体积 ratchet；当前性能债务、拆分顺序和 demand-render 前置条件记录在性能基线中。
- GitLab 每次提交都会阻断式执行 Web 功能回归、Server 资产/持久化回归，以及发布产物上的 OAuth、对象存储失败重试、幂等提交和服务重启恢复模拟；单项测试有硬超时，避免 Runner 被挂起任务长期占用。
- Cloud 大资产已采用签名对象存储直传；本地远端部署模拟器已覆盖失败重试、校验、幂等完成、签名下载和控制面重启恢复。
- 真实员工预览环境的对象存储模拟器已改为磁盘持久化；服务重启后仍可恢复已验证对象，浏览器无签名探测只返回 `403`，不会终止模拟服务器。
- 项目级 Engine Session 已接管第一批全分辨率 UV/修补任务，并统一计算计划、并发、取消和资源释放边界；其余算法继续渐进迁移。
- Auto UV 产品路径已切回真实 Asset V4 集群：页面读取实时 Worker/槽位，模型由 LI3D 应用服务器代理提交，任务、产物和历史按真实账号隔离；浏览器 xatlas 仅保留为已隔离的实验/回归内核，不再作为产品默认路径。
- 局部重绘真实纵向链路已完成一次浏览器验收：真实员工会话、浏览器指针蒙版、云端 ModelView 生成、浏览器投影应用、Revision 保存、服务重启和图层像素恢复均已通过。该证据只覆盖测试模型，生产资产遮挡/导出矩阵尚未完成，因此总门禁仍保持进行中。
- Auto Retopology 已完成模拟远端纵向验收：真实员工浏览器上传可解析高模，BFF 通过严格 TLS 与 SHA 固定的测试 CA 连接远端 Worker，返回正式 `_game_low.fbx` 与 `_game_low.blend`；FBX 经三方 SHA 后在浏览器解析，取消、历史和双服务重启恢复均通过。该证据不代表生产拓扑算法、生产 CA 或生产 Worker 已验收，因此门禁保持进行中。
- 生产 Bake 已切回真实 Substance Worker：服务状态、TLS、进度、取消和输出均来自服务端任务。2026-08-21 已用真实员工会话完成一次 4K、7 通道交付，账号历史可恢复；浏览器 BVH Bake 仅保留为隔离回归内核。
- PostgreSQL 项目 Repository 已实现事务化项目快照、不可变 Revision、Command 回执和账号 ownership，并通过多实例重复投递、回滚注入、冲突保护和重启恢复测试。
- 2026-08-22 使用真实员工会话和真实 Asset Worker 完成一个 Auto UV 成功任务，5 个服务器制品通过校验，UV FBX 写入账号项目 Revision 并成功传入烘焙页；大型生产模型质量门禁仍保持进行中。
- 模型解析器已按 GLTF/FBX/OBJ 格式拆包；Engine Session 注册表最多保留 3 个空闲项目会话，项目切换后会主动释放旧 GPU/Worker 资源。

计算策略见 [ADR-0002](./ADR-0002-browser-compute-policy.md)，项目并发策略见 [ADR-0003](./ADR-0003-project-revisions.md)，写入协议见 [ADR-0004](./ADR-0004-project-commands.md)，Cloud 数据边界见 [ADR-0005](./ADR-0005-project-repository-cloud-data.md)，对象直传见 [ADR-0006](./ADR-0006-direct-object-storage.md)，Engine Session 见 [ADR-0007](./ADR-0007-engine-session.md)，被替代的浏览器 Auto UV 决策见 [ADR-0008](./ADR-0008-browser-local-auto-uv.md)，被替代的浏览器 PBR Bake 决策见 [ADR-0009](./ADR-0009-browser-local-pbr-bake.md)，零安装和 DCC 暂缓见 [ADR-0010](./ADR-0010-zero-install-runtime-and-dcc-deferral.md)，真实生产计算边界见 [ADR-0011](./ADR-0011-real-production-compute-services.md)，当前性能预算见 [PERFORMANCE_BASELINE](./PERFORMANCE_BASELINE.md)。

## 服务生命周期门禁

- `/api/health` 是进程存活探针，并报告 `starting`、`ready` 或 `draining`；`/api/ready` 只在服务可接收流量时返回 200。
- 收到 `SIGTERM`/`SIGINT` 后先切换为 `draining`，拒绝新业务请求、停止后台同步调度、关闭空闲连接并等待正在处理的请求结束；超过 `LICLICK_SERVER_SHUTDOWN_GRACE_MS`（默认 30 秒）才强制关闭。
- HTTP headers、request、keep-alive 均有明确预算，可分别通过 `LICLICK_SERVER_HEADERS_TIMEOUT_MS`、`LICLICK_SERVER_REQUEST_TIMEOUT_MS`、`LICLICK_SERVER_KEEP_ALIVE_TIMEOUT_MS` 调整。
- Cloud 部署模拟器必须验证 readiness、真实 OAuth/PKCE 会话、对象直传重试、命令幂等、Linux 优雅停机和同端口重启恢复，任一失败都会阻断发布构建。
