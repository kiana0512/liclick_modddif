# Liclick 3D Texture

Liclick 3D Texture（LI3D）当前主线是一套零安装浏览器工作台。统一首页连接贴图绘制、自动展 UV、模型烘焙和生产工具箱；用户不需要下载 LI3D 本地组件。

本文描述当前主线代码的真实行为。系统模块、算法调用和强制变更规则以 [系统模块与变更唯一准则](docs/00_SYSTEM_MODULES_AND_CHANGE_STANDARD.md) 为准；当前性能稳定性和风险热点见 [2026-09-17 全仓审计](docs/PERFORMANCE_STABILITY_RISK_AUDIT_2026-09-17.zh-CN.md)，其它文档分类见 [docs/README.md](docs/README.md)。

## 产品与计算边界

```text
Browser
  ├─ React / Three.js UI
  ├─ viewport, painting, masks, projection, layer composition
  └─ WebGPU / WebGL2 / Worker / WASM browser compute
          │
          ▼
LI3D application server
  ├─ Feishu/Atlas identity and HttpOnly session
  ├─ projects, revisions, commands, account history and audit
  ├─ object-storage orchestration and signed transfers
  └─ production job orchestration
          │
          ▼
Independent GPU/AIGC API cluster
  ├─ Asset V4 Auto UV / Retopology workers
  ├─ Substance Baker workers
  └─ generation / inpaint services
```

- 浏览器使用用户本机 CPU/GPU 完成视口、绘制、投影、图层合成、蒙版和适合浏览器执行的交互内核。
- Auto UV、自动拓扑和生产 PBR Bake 把模型提交给真实 GPU/AIGC API 集群；正式模式不回退到本地 xatlas、三角简化、BVH Bake 或模拟成功。
- LI3D 应用服务器与 GPU/AIGC 集群是两个独立服务器边界。应用服务器负责身份、数据和编排，不替 GPU Worker 执行算法。
- 浏览器缓存不是项目权威数据；项目、任务历史和产物归属真实账号。

## 当前模块状态

| 模块 | 当前状态 | 真实边界 |
| --- | --- | --- |
| 贴图绘制 | 进行中，可测试 | 浏览器视口/投影/图层与本机算力；生成、局部重绘连接受控服务；不依赖本地组件 |
| 自动展 UV | 真实链路已通，生产质量失败 | 容量 API 返回 `9 Worker · 16 槽位`；真实 39.7 MB 任务进入 `asset-control-4090`，被 `UV_QA_FAILED` 阻断，未发布不合格产物 |
| 自动拓扑 | 真实链路已通，生产质量失败 | 真实任务进入 `asset-worker-3090-b`，被 `RETOPOLOGY_COORDINATE_MISMATCH` 阻断，未发布错位低模 |
| 模型烘焙 | 真实服务纵向通过 | `asset-worker-3090-b-windows` 通过 TLS；真实员工完成 4K 七通道 Substance Bake，结果和历史可恢复 |
| 工具箱 | 界面与原产品保持一致 | 保留工具目录、安装包信息和能力说明；PS/Blender/3ds Max 实时桥接暂缓，不作为零安装核心链路 |
| 登录与账号 | 本地真实账号链路通过 | Server-side Atlas/IDaaS OAuth、HttpOnly 会话、真实员工信息和账号级历史；生产 HTTPS 回调仍需部署验收 |

功能状态必须以 [验收矩阵](docs/modernization/FEATURE_ACCEPTANCE_MATRIX.md) 为准。页面可打开、Mock 成功或按钮存在不等于生产功能通过。

## 贴图工作台能力

- 多模型项目、活动对象、变换、居中、落地和相机适配。
- PBR、Flat、Normal、Wire 显示模式与 ViewCube。
- 单图/多视图参考、颜色/Mask/深度/法线捕获和单/多视图 Texture Map。
- 实时投影层、UV 层、透明度/强度/混合调整、手动 UV 合并和内容补缝。
- 局部重绘的浏览器指针蒙版、表面约束、云端生成、Worker 边缘融合和项目恢复。
- GLB/FBX/OBJ/STL、BaseColor、已有 Normal 与 WebM 等现有导出路径。

尚未作为正式能力验收：普通自由绘制 Brush、Quick Mask、Segments/ColorID、Normal 生成、MP4、`.liclick3d` 便携包以及 PS/DCC 实时双向桥接。

## 本地开发与测试预览

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm verify:modernization
```

零安装浏览器模拟部署：

```bash
pnpm simulate:cloud-deployment -- --serve
```

真实员工身份与真实服务联调预览：

```powershell
.\scripts\run-real-employee-auth-preview.ps1 -Port 5646 -WorkspaceDir .codex-tmp\real-auth-workspace
```

预览地址为 `http://127.0.0.1:5646/li3d/`。该命令只在开发机启动 LI3D 应用服务器；UV、拓扑和 Substance Bake 仍调用配置的真实 GPU/AIGC 服务。正式部署必须改用已登记的 HTTPS 域名、OAuth 回调、受保护的 Secret 和生产对象存储。

## 发布与数据规则

- `master` 是当前代码基线；每次只处理一个明确问题，合并前执行对应回归和发布门禁，不从历史 `codex/modernization` 文档反推当前分支策略。
- 2026-09-17 文档同步基线为 `2222576c5bada19b1ff65850b95d6c0cfd1c17ca`：本地正式 `verify:prepush`、Server 24/24、Web 147/147、独立导入 UV 浏览器回归、Cloud 构建/产物/部署模拟均通过；正式 Web 产物为 104 chunks / 3,214,864 bytes。该记录不等同于生产部署或远端流水线已完成。
- Web、Server、协议和 Schema 必须来自同一 Git SHA 与 Release Manifest；同一 SHA 只构建一次。
- 生产 Secret、OAuth Token、Cookie、证书私钥、工作区资产和测试账号数据不得提交 Git。
- Cloud 构建不得包含安装器、`127.0.0.1:4618`、本地守护进程或本地身份桥接回退。
- 历史实验内核保留用于回归，不得改变正式产品的远端服务语义。

## 已知阻断项

1. Auto UV 真实任务当前被生产 Worker 的 `UV_QA_FAILED` 阻断。
2. 自动拓扑真实任务当前被 `RETOPOLOGY_COORDINATE_MISMATCH` 阻断。
3. 生产 HTTPS OAuth 回调、企业应用发布、PostgreSQL/对象存储事务化和目标域名部署尚未完成最终验收。
4. 性能需要继续完成 input-to-present、帧耗、Long Task、静止渲染和内存回落矩阵。
5. 当前全仓 lint 为 0 error、2 个既有 warning；后续仍须同时执行 typecheck、回归、构建和发布边界门禁，不能以 lint 通过替代功能/性能验收。
6. Cloud release-readiness 仍有 8 项 required capability 为 `in_progress`；不得仅因本地冒烟、构建或某次 GitLab 流水线通过而改写为可生产发布。

架构决策见 [现代化总纲](docs/modernization/README.md)，发布门禁见 [ACCEPTANCE_GATES](docs/modernization/ACCEPTANCE_GATES.md)。
