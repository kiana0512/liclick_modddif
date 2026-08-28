# LI3D Cloud 系统模块、算法与变更管理唯一准则

> 文档版本：`2.4.2`
>
> 生效日期：`2026-08-27`
>
> 代码盘点基线：`7d1e7bb8386849e1244175ec70db13a353e49544 + b9ca6dbcf9acebe69ceb6b1ebb515b430d624244 + f993f29f08c3 + 95a7473 + 21a1c20`
>
> 基线仓库：`E:\Liclick 3D Texture Modernization`
>
> 审计口径：`0a2519d + 607e82f + 2568e40`，不包含错误文档提交 `2bde8c6/e03bab2/d1c5f78`

## 1. 文档地位与强制边界

本文档是 LI3D Cloud 当前模块边界、算法语义、调用关系、持久化协议和变更流程的唯一维护准则。日期型审计、旧设计稿和历史 ADR 只能提供背景，若与本文档或基线源码冲突，以基线源码和本文档的明确状态为准。

### 1.1 已彻底废弃的架构

Windows 本地组件、localhost/4618 守护进程、安装器、浏览器端点切换、本地组件持有个人凭证，以及依赖本地组件启动 Photoshop/DCC 的主链路均已废弃。它们不是兼容模式、回退路径或备用部署方式。任何变更不得重新引入这些依赖。

Cloud 发布边界由 `scripts/cloud-boundary-policy.json` 执行机器检查，当前 `legacyAllowlist=[]`。唯一运行时定义在 `apps/web/src/platform/runtimeCapabilities.ts`：`runtimeMode='cloud'`、`isCloudBuild=true`、`hostExtensionFeaturesAvailable=false`。

### 1.2 唯一现行拓扑

```text
浏览器零安装客户端
  ├─ React / Zustand：界面、用例状态、撤销重做
  ├─ Three.js / WebGL2 / WebGPU：视口、投影、UV 合成、蒙版
  ├─ Worker / WASM：图像后处理、质量合成、诊断内核
  └─ 同源 Cookie API
          ↓
LI3D Cloud 控制面（无状态 Node.js App）
  ├─ SSO、Session、ownership、项目命令、Revision、历史、签名 URL
  ├─ PostgreSQL：权威项目文档、不可变 Revision、幂等回执、用户与任务元数据
  └─ 对象存储：模型、参考图、捕获、生成图、图层图像、烘焙图
          ↓
独立生产计算集群
  ├─ AIGC / ModelView：纹理生成与局部生图
  ├─ Asset V4：Auto UV 与自动拓扑
  └─ Substance Worker：生产 PBR Bake
```

浏览器交互图形不发送逐帧命令给 App Server。Auto UV、自动拓扑、生产 PBR Bake 必须使用真实生产服务，不得在服务失败时静默切换为浏览器 xatlas/BVH 模拟结果。浏览器保留的 UV/PBR 内核只用于隔离测试、算法对照和明确标记的实验，不是产品正式默认路径。

## 2. 大模块划分

| ID | 大模块 | 唯一职责 | 主要实现 |
|---|---|---|---|
| `M01` | Cloud 工程与工作区 | 项目 CRUD、Project Command、Revision、冲突与保存状态 | `workspaceApiClient.ts`、projects routes、ProjectRepository |
| `M02` | 输入与资产 | 模型/参考图接收、格式解析、预处理、直传、ownership | loaders、asset transfer contracts/services |
| `M03` | 场景、相机与捕获 | 对象归一化、相机、Color/Mask/Depth/Normal 捕获 | `engine/scene`、`engine/capture`、viewport |
| `M04` | 生成编排 | 单视图、多视图、参考图配对、任务身份、轮询/取消/恢复 | `GeneratePanel.tsx`、generation/modelview clients |
| `M05` | 图层领域 | Layer 类型/角色、顺序、显隐、调整、合并事务 | `types/layer.ts`、`layerStore.ts` |
| `M06` | 实时投影 | 捕获空间重投影、深度/法线门控、Top-3/Overlay 预览 | `engine/projection` |
| `M07` | UV 合成与发布 | UV 栅格、权重合成、后处理、PBR 显示固化、PNG 发布 | `engine/bake`、`engine/layers` |
| `M08` | 局部重绘 | 选择蒙版、ModelView 三输入、接缝谐调、表面画笔回贴 | `GeneratePanel`、`localRepaint`、`ViewportCanvas` |
| `M09` | 内容识别补缝 | UV 缺口识别、表面拓扑传播、修补 underlay | `engine/contentAware` |
| `M10` | 生产 UV/拓扑/Bake | 真实任务提交、QA、产物验证、Pipeline 交接 | AssetProcessing/Bake workspace、server proxies |
| `M11` | 输出与标准文件集成 | 贴图、GLB/GLTF/FBX/OBJ/STL、快照、视频、ZIP | `engine/export`、server export |
| `M12` | 状态、历史与版本 | Zustand、Engine Session、撤销重做、Pipeline Revision | stores、session、`projectPipeline.ts` |
| `M13` | 身份、任务与平台 | SSO、Cookie、账号隔离、任务历史、遥测、调度 | auth、history、performance、task services |
| `M14` | 数据与对象存储 | PostgreSQL Repository、签名上传/下载、校验与回收 | postgres repositories、assetTransferService |
| `M15` | 质量门禁与发布 | Cloud 边界、契约、回归、构建、CI/CD | scripts、package scripts、GitLab pipeline |

依赖方向固定为 `UI → application/use case → domain algorithm → typed port → infrastructure adapter`。React 页面和 Zustand store 不得新增算法常量；投影、UV、颜色空间和局部重绘的语义必须位于可测试模块。

## 3. 界面模块审计

| UI ID | 界面区域 | 功能与调用模块 | 关键输出 |
|---|---|---|---|
| `UI-01` | 工程头 | 返回项目、重命名、Saved/Saving/Failed；调用 `M01/M12` | Project Command/Revision |
| `UI-02` | 贴图/UV/烘焙 | 工作流导航；调用 `M10/M12`，不在标签按钮内执行算法 | route + Pipeline stage |
| `UI-03` | 工作区/下载/分辨率 | 场景、贴图、法线、导出、1K/2K/4K/8K | settings + export intent |
| `UI-04` | 对象面板 | 选择、显隐、聚焦、变换、复制、删除、导入、排列 | SceneObject + Project document |
| `UI-05` | 生成面板 | 多视图、单视图、重绘效果；提交/恢复任务并创建 Layer | Capture + Generation + projected Layer |
| `UI-06` | 中央视口 | Three 场景、实时投影、选择、表面画笔、局部预览 | GPU material/session state |
| `UI-07` | 视口面板 | 透视/正交，Flat/PBR/Normal/Wire，曝光/环境/灯光 | display settings，非源图层 |
| `UI-08` | View Cube/HUD | 固定视角、FPS/P95/最大帧 | camera + telemetry |
| `UI-09` | 图层面板 | 图层增删改排、眼睛、调整、内容修补、剪刀合并 | Layer transaction + merged UV |
| `UI-10` | 底部工具条 | 选择/移动/旋转/缩放；当前图层橡皮；局部选择→局部生图→结果回贴 | paint session + layer coverage/repaint overlay |
| `UI-11` | Dock | 面板过滤、折叠、排序、左右布局 | workspace layout state |
| `UI-12` | 模态任务层 | 导入、兼容编辑、长任务进度/取消、编辑锁 | abort/job state |
| `UI-13` | UV/拓扑页 | 真实 Asset V4 任务、QA 状态、已验证产物下载 | Job + artifact + Pipeline Revision |
| `UI-14` | Bake 页 | 素材、对齐、Substance Bake、检查、PBR、发布 | Bake job + channel manifest |
| `UI-15` | 性能实验室云端记录 | `perfLab=1` 下复用人工录制按钮，显示客户端采集/上传状态；维护员按飞书身份查看记录 | PERF-LAB-REPORT v2 + browser chunks |

`UI-05` 生成面板与 `UI-10` 底部工具条必须共用局部生图运行态：从同步提交锁建立开始，到 Generation 行创建、远端执行与结果融合结束，两个入口都显示运行中。禁止仅以 Generation 行是否存在判定面板按钮状态，因为蒙版/视角捕获发生在该行创建之前。

`2568e40` 基线的新选择契约：贴图工作区优先显示用户显式选择的模型；所选 ID 缺失时回退到活动模型；点击空白视口不清空贴图模型选择。超过 20,000 三角面的 Auto UV 错误使用醒目的警告呈现。对应测试为 `test:multi-model-restore-policy`。

## 4. 工程保存、Ctrl+S 与数据格式

### 4.1 Ctrl+S 一句话答案

Ctrl+S 保存的是结构化 `Project` JSON 文档及其引用的不可变资产，不是单一 JSON 文件下载，也不是本地组件保存。Cloud 主链路通过版本化 `ProjectCommand` 写入权威 Repository；大二进制先通过签名 URL 进入对象存储。

### 4.2 精确调用链

```text
window keydown
 → shortcutMatches(event, 'project.save')
 → EditorPage.manualSaveHandlerRef
 → getProjectSnapshot(refreshThumbnail=true)
 → prepareProjectForWorkspaceSave
      ├─ models/references/captures/generations/layers/baked 分三并发槽持久化
      └─ Project 中只保留稳定资产 URL/ID，不保存 Blob URL 或 File
 → workspace save queue（同一编辑器串行）
 → workspaceApiClient.saveProject（同 projectId mutation lock）
 → ProjectCommand schema v1 / replace-project-document
      id=command-*，expectedRevisionId=current revision
 → POST /api/projects/:projectId/commands，30s timeout；网络错误用同 ID 重试一次
 → server parseProjectCommand
 → executeProjectCommand（userId:projectId 串行）
 → ProjectRepository.save
 → Revision compare-and-swap + 幂等 command SHA-256
 → PostgreSQL 同事务写当前文档、不可变 Revision、回执与审计
 → 返回新 revision-*；前端仅在快照仍为最新时显示 Saved
```

### 4.3 Project 文档内容

| 字段组 | 结构 | 说明 |
|---|---|---|
| identity | id/name/createdAt/updatedAt/folderId | 项目身份和目录 |
| scene | objects/activeObjectId | 模型、变换、显隐与绑定 |
| input | references | 单/多视图配对、来源和对象绑定 |
| capture | captures | 相机矩阵、Color/Mask/Depth/Normal URL |
| generation | generations | client/server task identity、状态、结果和算法元数据 |
| layer | layers/activeLayerId | 完整 Layer contract 与图层顺序 |
| bake | bakedTextures/bakeWorkspace | UV 结果、Bake Set、通道与 Job |
| workflow | pipeline | texture→retopology→uv→bake 的追加式 Revision |
| settings | resolution/display/projection/color management | 编辑器设置 |
| concurrency | revision/deletedObjectIds | 乐观并发和显式删除意图 |

Cloud 权威实现使用 PostgreSQL JSONB 当前快照和不可变 Revision 表；文件型 Repository 只允许隔离开发，不是生产架构。配置 `LICLICK_PROJECT_REPOSITORY=postgres` 却缺少数据库 URL 时必须启动失败，禁止静默回退。

### 4.4 对象存储协议

`ASSET_TRANSFER_PROTOCOL_VERSION=1`，单资产最大 `160 MiB`。类别固定为 models、references、captures、generations、layers、baked。浏览器计算 SHA-256，请求绑定 user/project/category/filename/MIME/size/hash 的上传意图，使用短期签名 PUT 上传；完成接口通过 HEAD 校验长度、MIME 和 checksum 后把资产从 pending 置为 verified。对象 key 为 `users/<sha256(userId)>/projects/<projectId>/<assetId>/<safe-name>`。下载先校验 ownership，再返回短时签名 GET；访问对象存储时 `credentials: omit`。

### 4.5 浏览器保存调度 `SAVE-SCHEDULER` v1.0.0

编辑器保存调度由独立 `ProjectSaveCoordinator` 负责：普通编辑采用 2 秒 trailing debounce；持续编辑从首个待保存变更起最多等待 10 秒；视口交互、性能只读事务或图层同步抑制期间每 1 秒重试。Ctrl+S、生成/导入等既有即时保存事件仍直接进入同一项目串行保存队列，不等待自动保存窗口。

每个项目维护不写入 Project JSON 的单调 `editVersion`。获取保存快照时同时冻结该版本；资产上传和 Project Command 完成后，只有当前版本仍等于保存版本，前端才清除 dirty、删除意图并显示 Saved。保存途中发生任何持久编辑时，服务器返回的 Revision 仍被接收用于后续 CAS，但页面保持 Unsaved 并自动提交最新快照。该规则替代仅比较 `updatedAt`、对象 ID 和图层 ID 的旧判断，能够识别同一图层内容、蒙版、显隐或参数变化。

此版本不改变 Project Command v1、Revision CAS、Project/Layer Schema、资产类别、ownership 或对象存储校验；旧工程无需迁移。回退时可恢复原 5 秒首次 dirty 定时和快照 ID 比较，已保存 Project、Revision 与资产不需要改写。最低回归覆盖 2 秒尾随、10 秒最长等待、过期回包不得清除 dirty、最新回包能够标记 Saved，以及 Web typecheck/build。

## 5. 图层类型、角色与效果

Layer 的 `type`、`role`、`blendMode`、`visibility policy` 是四个独立维度，禁止用名称字符串代替结构化语义。

| 截图/产品名称 | type | role/识别条件 | 当前效果与合成位置 |
|---|---|---|---|
| 合并 UV 图层 | `uv` | `merged-uv` | 已发布的最终 UV；`uvMergeVersion=4`；PBR 预览光照已固化，显示时 unlit |
| 投射贴图·方向 | `projected` | 普通生成层 | 捕获相机空间投影；普通层参加 Top-3 质量合成 |
| 单视图优先贴图 | `projected` | `projectionCompositeMode=single-view-priority-v1` | 在普通多视图后覆盖核心；有可见纹理底层时，编辑器生成距离场 Alpha 让轮廓宽带平滑接回底层 |
| 局部重绘·局部替换 | `projected` | `local-repaint-overlay` 或稳定 ID | literal overlay；alpha 直接等于用户表面画笔 coverage |
| 局部重绘草稿 | `projected/patch` | `local-repaint-draft` | 生成结果与蒙版会话，不应直接当成最终 UV |
| 内容识别修补 | `uv` | `content-aware-underlay` | 只填投影缺口，位于投影结果之下，不能覆盖有效投影 |
| 空白/底色 UV | `uv` | `base-color` 或无 role | 可作为剪刀事务目标；空图像时只是容器 |
| 法线层 | `normal` | channel-specific | 法线显示/输出，不进入 BaseColor 颜色权重 |

数组 index 是界面从上到下顺序，store 每次变更重写连续 `order`。眼睛关闭表示不参加当前显示/合并；opacity 乘最终 coverage；strength 改变角度质量 gamma；blendMode 支持 normal/multiply/screen/overlay/soft-light。移动、调整或替换已烘焙参与层必须标记 `needsRebake=true`。

删除最后一个活动对象图层后，store 自动创建空 UV 保底层。剪刀发布时会隐藏所有实际被消费的源层；若指定空 UV 目标则原位填充，否则在源层位置创建 merged-uv。

### 5.1 当前图层橡皮 `ALG-ERASE-001` v1.1.0

橡皮采用 Modddif 式“编辑当前图层覆盖”语义，不对最终合成画面做破坏性擦除。快捷键为贴图工作区 `E`，目标由 `engine/paint/eraserTargetPolicy.ts` 唯一判定，React 和 Zustand 不得复制类型分支。

| 图层目标 | 编辑数据 | 结果 |
|---|---|---|
| 普通/合并 UV | 当前图层 Straight-RGBA alpha coverage | 擦除后露出下方可见图层；空 UV 不可擦 |
| 普通 projected | UV0 keep mask，`maskSpace='uv'` | 原投影图像、相机、深度/法线不变，只缩小该层投影覆盖 |
| projected/UV 局部重绘 | 已保存的作者 coverage/mask | 保留生成源图与几何授权，只编辑该重绘层的可见范围 |
| content-aware underlay | 只读计算结果 | 必须先显式创建普通 UV 可编辑副本；原 underlay 不变 |
| normal/patch | 无 | fail-closed；normal 禁止颜色橡皮，patch 先合并为 UV |

覆盖公式为 `effectiveCoverage = authoredCoverage × editKeepCoverage`。UV 图层在提交时把 keep coverage 合入该层 alpha；projected 图层把它保存为 UV0 灰度 keep mask；局部重绘沿用独立作者 mask。GPU 实时材质、GPU UV bake、CPU UV rasterizer、UV Worker source-over、图层合并和模型导出都消费同一结果。交互笔画预览可使用 512/1024 代理，但持久遮罩、延迟补缝和输出必须使用项目选择的 1K/2K/4K/8K，不得以旧 2K 上限作为最终结果。

v1.1.0 的交互调度只优化普通 projected keep-mask：原始鼠标/压感笔事件在每个显示帧仅保留最后一个表面命中，512 代理画布用连续笔刷段补齐帧间路径；抬笔后的持久画布、历史瓦片和图层发布至少等待 120ms 无输入窗口并进入浏览器 idle 时隙，高分辨率投影补缝仍在 3000ms 交互空闲后运行。普通/合并 UV 橡皮继续使用密集 BVH/UV 重采样，局部重绘作者 coverage 继续使用其独立实时蒙版，因此不会以性能优化换取 UV 接缝或作者蒙版精度。

Layer 以可选 `eraserAlgorithmVersion=1` 标记首次采用该语义的内容修订；未带字段的旧图层按原 image/mask 读取，首次擦除时惰性升级，不执行批量迁移。项目保存继续使用 Project Command v1、Revision CAS 与现有 verified layer asset 上传，未引入新的命令或资产类别。高分辨率提交失败时保留上一持久版本并显示错误，禁止静默写入低分辨率结果。

回退时可移除 UI-10 入口、`texture.eraser` 快捷键和目标策略调用；额外字段会被旧代码忽略，已有 image/mask 仍是合法 Layer 资产。内容填补转换创建的是独立 UV 行，因此回退不会修改或删除原 underlay。

## 6. 投影算法登记（关键）

| ALG ID / 名称 | 版本 | 调用者 | 核心定义 | 失败/回退 |
|---|---|---|---|---|
| `ALG-PROJ-001` 捕获锁定矩阵重投影 | `2.0.0` | 实时材质、UV bake、画笔 | `clip=Pcap·Vcap·(Mcap·inverse(Mcurrent))·worldCurrent` | 缺矩阵/相机时层不可靠，禁止偷偷用当前相机 |
| `ALG-PROJ-002` 连续 Coverage 门控 | `3.0.0` | projection shaders | 普通层=`opacity×sourceAlpha×mask×angle×visibility×facing×edgeFade`；surface-locked depth 命中层以捕获 mask/depth 覆盖为权威 | coverage≤0.02 丢弃，不用二值膨胀掩盖 |
| `ALG-PROJ-003` 深度-法线表面可见性 | `3.0.0` | preview/GPU UV | linear-view depth + 3×3 支持；surface-locked 深度邻域支持在 0→0.05 内转为完整可见性，可靠 depth 命中不再被插值 mesh normal 二次衰减 | 缺 depth 才走角度退化，不伪造可见性 |
| `ALG-PROJ-004` Top-3 颜色一致性合成 | `2.0.0` | 普通多视图 | 每 texel 保留 score 最高 3 个；线性 RGB 离群降权 | WebGPU parity 不通过使用 CPU exact 输出 |
| `ALG-PROJ-005` Priority 单视图覆盖 | `2.0.0` | single-view layer | 核心沿用 priority coverage/quality；若同对象已有可见 projected/UV 底层，源图轮廓距离场在画幅 3.5% 宽度内由 0.12→1.0，之后再与捕获 mask/depth 相乘 | 无底层时保持不透明源；不越过捕获/深度边界 |
| `ALG-PROJ-006` Literal Overlay | `2.0.0` | 局部重绘 | 用户 authored coverage 直接 source-over，不再乘质量 feather | mask/source 未就绪不发布半层 |
| `ALG-PROJ-007` GPU 驻留与分块 | `2.0.1` | ProjectedLayerMaterial | direct samplers 或 WebGL2 arrays；512 tile 保持输出尺寸；多模型预览按选中对象预热隐藏 UV 行，批量上传期间固定 Worker bitmap，缓存保留九模型 proxy/exact 与当前对象六层切换工作集 | 可缩放预览驻留，不得降低生产 UV 请求尺寸；array 上传失败保留上一有效材质并走有界 fallback |

### 6.1 当前生产常量

| 参数 | 当前值 | 语义 |
|---|---:|---|
| 无深度背面硬拒绝 | `N·V < -0.35` | 捕获背面拒绝 |
| 无深度角度覆盖 | `-0.62 → -0.18` | smoothstep feather |
| 有深度角度覆盖 | `0.02 → 0.38` | 使用绝对面向 |
| 深度容差 | `max(0.00625, viewDepth×0.00075)` | 掠射角最多放大 5 倍 |
| 法线一致度 | `0.72 → 0.92` | 捕获法线门控 |
| 图像边缘 | `0.015` | coverage fade |
| 质量边缘 | `0.035` | quality fade |
| quality 角度 | `smoothstep(0.02,0.25,n)×n^(4/clamp(strength,.25,3))` | 强度控制角度锐度 |
| 入选分数 | `max(quality, coverage×0.08)` | coverage 保底 |
| 强质量权重 | `quality^2.4` | 主权重 |
| coverage 残差 | `20%` | 防止低质量完全消失 |
| 胜者比例 | `1.45 → 2.6` | 第一/第二质量比 |
| 胜者差值 | `0.05 → 0.2` | 绝对质量差 |
| 颜色一致 sigma | `0.22` | 线性 RGB 距离抑制 |
| surface-lock 深度支持羽化 | `0.00 → 0.05` | 任一可信 3×3 depth 邻域命中即快速恢复完整覆盖 |
| 单视图轮廓距离场 | `max(24,min(128,maxDim×0.035))` | 有可见底层时，源 Alpha 从 0.12 平滑升至 1.0 |
| 投影 RGB 外扩 | `max(8,min(48,maxDim×0.015))` | 只保护过滤采样颜色；几何 footprint 仍由独立 capture mask 决定 |

投影参数的 GPU 实时材质、GPU UV 栅格、Worker/CPU exact 和导出路径必须共同审查。当前缺少持久化 `projectionAlgorithmVersion` 是治理债务；改变上述阈值至少升级 Minor，改变矩阵、深度编码或权重模型升级 Major。

## 7. UV 合成与剪刀事务（关键）

### 7.1 完整调用链

```text
UI-09 剪刀
 → 冻结当前对象、选中 Layer IDs、分辨率和 PBR 显示设置
 → 普通 projected：GPU UV0 栅格，生成 RGBA/coverage/quality
 → literal/priority overlays：按图层顺序单独栅格
 → Top-3 exact quality blend（Worker；WebGPU 必须 parity）
 → content-aware UV underlay 从下方补透明缺口
 → gutter / topology gap / enclosed hole / physical seam reconciliation
 → bakePbrPreviewLightingIntoUv（仅普通 albedo；rendered-color mask 保持原值）
 → Straight-RGBA PNG
 → 对象存储 layers 资产
 → mergeLayersIntoUvLayer 原子发布，uvMergeVersion=4，隐藏被消费源层
 → Project Command 保存文档与 Revision
```

### 7.2 算法登记

| ALG ID / 名称 | 版本 | 精确定义 |
|---|---|---|
| `ALG-UV-001` UV0 三角形投影栅格 | `2.0.0` | GPU 默认把 mesh UV 三角形画入 RT，重建世界位置/法线并复用投影门控；CPU 每 texel 4 子样本是诊断回退 |
| `ALG-UV-002` Runtime 可见性补获 | `2.0.0` | stale/missing depth 按原 capture camera 重新捕获，完整捕获上限 2048，不改变最终 UV 分辨率 |
| `ALG-UV-003` Top-3 质量合成 | `2.0.0` | 与第 6 节常量一致；输出 authored color、coverage confidence、rendered-color mask |
| `ALG-UV-004` 有序 Overlay | `3.0.0` | feathered=`coverage×(0.75+0.25×qualityFade)`；priority 使用 `ALG-PROJ-005` v2 距离场 source Alpha；literal=`coverage`；实时与 GPU UV bake 同义 |
| `ALG-UV-005` 拓扑约束后处理 | `2.0.0` | gutter/gap=`clamp(ceil(res/512),2,8)`；hole=`clamp(ceil(res/2048),1,3)`；seam=`clamp(ceil(res/1024),2,4)`，不得跨无关 island |
| `ALG-UV-006` Under 合成 | `2.0.0` | 投影在前、content-aware 在下；straight alpha：`Aout=Af+Au(1-Af)` |
| `ALG-UV-007` PBR 预览光照固化 | `4.0.0` | 依据 UV 法线、环境预设、曝光、环境强度、主光强度/方位计算 deterministic preview light；rendered-color 像素权重 1 时保持原色 |
| `ALG-UV-008` Straight-RGBA 发布 | `2.0.0` | RGB 不预乘；透明 texel 的 padding RGB 可保留；PNG 与 Layer 在资产就绪后原子发布 |

`UV_MERGE_COMPOSITION_VERSION=4` 的产品语义是“把当前确定性 PBR 预览光写入最终 UV，并把合并层按 unlit 显示”。它不是生产 Substance 多通道 Bake；只生成当前作者颜色结果。修改此语义必须升级 merge version 并给旧工程迁移/重烘焙策略。

## 8. 局部重绘算法（关键）

### 8.1 主路径状态机

```text
局部选择（多相机表面笔画）
 → 点击局部生图时冻结 square camera + object matrix
 → 2K selection mask；1K clay white model；2K flat BaseColor viewport reference（仅本地融合）
 → 若材质参考是单图，先生成 durable 多视图配对
 → ModelView 三输入任务与 1K linear-view depth guard 并行
 → 结果做 seam harmonization（enhanced v14 / compatible v5）
 → 保存 raw、harmonized、mask、reference 与版本元数据
 → 用户用表面画笔决定实际回贴 coverage
 → 1024 live GPU overlay；停笔后两帧内先发布完整 projected repaint 图层行
 → 3000ms 空闲窗口只用于 latest-wins 后台持久化/自动保存合并，不阻塞图层面板
```

### 8.2 算法登记

| ALG ID / 名称 | 版本 | 输入与规则 |
|---|---|---|
| `ALG-LR-001` 冻结视角选择重投影 | `2.0.0` | 累积多相机表面选择在生成瞬间重投影为 2048 方形 mask；相机/对象矩阵冻结 |
| `ALG-LR-002` ModelView 三业务输入生成 | workflow `2026.08.26-740115a-truev3-gguf-3input-rseed-r1` | 远端字段固定为可空 `prompt`、必填 1K `image` 白模、必填 `material_image` 多视图材质参考；不提交 `viewport_reference`、`seed`、`noise_seed`；用户 mask 与 flat viewport reference 只用于浏览器回贴和接缝融合 |
| `ALG-LR-003` 并行深度保护 | `2.0.0` | 1K linear-view depth 与远端请求并行；失败保留生成结果但明确 warning，几何保护降级 |
| `ALG-LR-004` 增强边界谐调 | `14.0.0` | blend 12-40、sample 8-32、cell 64、correction depth 96、启用局部颜色匹配；alpha 仍来自生成结果/蒙版契约 |
| `ALG-LR-005` 兼容边界谐调 | `5.0.0` | blend 4-8、edge opacity 1、不做 color match，用于兼容模式 |
| `ALG-LR-006` 表面画笔重投影 | `2.0.0` | raycast 命中表面，投射到 frozen source UV；最小绝对 face-on 0.08；世界半径 0.004-0.12 包围盒比例；texture radius 1-72 |
| `ALG-LR-007` 低延迟实时覆盖 | `2.0.2` | live mask/source 最大 1024；`surface-locked-v1`；ignore source alpha，coverage 由用户 mask 和几何决定；同一 source revision 复用驻留 GPU overlay、linear-view depth 与已链接 shader program。renderer preview 持有图层时，创建、重绑定、复用与 tool 切换分支必须共同保持 overlay 可见并静音同一 persisted twin；ordered projected stack 已拥有显示权时 overlay 保持隐藏 |
| `ALG-LR-008` 延迟投影持久化 | `2.2.0` | interactive UV bake 固定关闭；生图前 Project Command snapshot 后台执行，不再作为 ModelView 提交门槛，失败仍触发正常即时保存恢复；Generation、对象、目标层与 GPU-ready 标记共同识别驻留 source，稳定 mask URL 与等价 live PNG URL 不构成冷启动依据；pointer-up 两帧内发布权威图层行，idle 3000ms 仅合并后台持久化；visible projected overlay + hidden/session draft，needsRebake=true |
| `ALG-LR-009` Inward Crossfade 栈合成 | `1.0.0` | 连续重绘层向内部交叉淡化，避免普通 alpha stacking 在边缘重复显露接缝 |
| `ALG-LR-010` Provider 兼容编辑 | `1.0.0-compat` | `LocalRepaintDialog` 的 image/edit/protect/hole masks 独立路径，不得与三输入主路径混改 |
| `ALG-LR-011` 生图透明显示副本 | `1.0.0` | UI-05 重绘效果图和 UI-10 普通投射图层缩略图优先使用 capture linear-view depth 清除明确无几何覆盖的背景，按精确 alpha bounds 仅裁切一次并保留 6% 留白；几何覆盖区的 RGB/alpha 原样保留。深度不可用时只清除与画布边缘连通的近黑外背景，不做第二次 matte、侵蚀或分位裁边。局部重绘图层不走整图副本，继续使用用户涂绘 mask，只显示笔刷授权区域 |

局部生图远端不接收用户最终回贴 mask、UV 图集或表面深度；这些是浏览器本地的几何授权。远端返回的是候选图，用户通过表面画笔决定真正写回区域。

`ALG-LR-007/008` v2.0.2/v2.2.0 与 `ALG-PROJ-007` v2.0.1 不改变投影矩阵、深度编码、face-on 阈值、1024 实时上限、最终 UV 分辨率或颜色合成公式。GPU 继续消费同一 source/mask/depth；CPU、Worker、UV raster、shader 门限与 export compositor 没有算法分叉。生图前 snapshot 与 Generation 最终写回仍进入同一 critical save queue，沿用 Project Command v1、Revision CAS、ownership 与 verified object asset；只把提交前的网络等待移出用户可见关键路径，失败由即时保存恢复。多层恢复的 Worker bitmap 在整组 striped upload 期间固定，缓存上限从 18 调整到 24，并只为当前选中对象预热隐藏 UV 行；其他模型的可见 exact/proxy 仍驻留，不降低图片尺寸或跳过 QA。旧工程无需批量迁移，重开时按现有 Layer/Generation/Capture 字段重建资源。回退可恢复提交前 save barrier、mask URL 严格相等判断、旧 overlay 可见分支和 18 项缓存；已有 projected layer、mask、capture、Generation、对象资产与 Revision 无需删除或改写。

`ALG-LR-011` 只生成最大 1024 的内存 UI 显示副本，不回写 `Layer.imageUrl`、Generation、对象存储或 Project Revision。GPU/CPU/Worker/shader、投影矩阵、UV raster、持久化与 export compositor 均继续消费原始 source/mask/depth，因此无需数据迁移。回滚只需移除 UI-05/UI-10 显示副本调用；已有图层与资产不变。测试必须证明透明显示不替换投影源、黑色材质与几何边缘不被扣除、普通投射层不再出现黑底、局部重绘层仍仅显示用户涂绘区域。

## 9. 内容识别补缝

| ALG ID / 名称 | 版本 | 定义 |
|---|---|---|
| `ALG-CA-001` 覆盖缺口检测 | `1.0.0` | 从投影 coverage/confidence 构造待修复 mask，排除已有可靠投影 |
| `ALG-CA-002` UV 表面拓扑 | `1.0.0` | UV 三角形 region、可选物理 seam link、normal dot 门限；预热并缓存 |
| `ALG-CA-003` 表面约束传播 | `1.0.0` | Worker 在同一表面/region 内传播颜色，不跨无关 UV island |
| `ALG-CA-004` Underlay 原子发布 | `1.0.0` | 生成 `uv + content-aware-underlay`，GPU 预热后一次发布，合并时永远在投影之下 |

本地兼容填充的搜索半径为 `clamp(ceil(max(ROI.w,ROI.h)×0.2),16,48)`，迭代 2 次；它不能冒充远端生成或覆盖有效投影颜色。

## 10. 生产 Auto UV、拓扑与 PBR Bake

| 流程 | 正式算法/服务 | 输入 | 产物与门禁 |
|---|---|---|---|
| Auto UV | Asset V4 `uv.production-service` | 模型资产 + 参数 | 可轮询 Job、UV 模型/报告；严格 UV QA 失败不得发布 |
| 自动拓扑 | Asset V4 `RETOPOLOGY_PROCESS_V2` | 高模 + mixed_game_ready metadata | final FBX/GLB、诊断产物；坐标/质量门禁失败不得标成功 |
| PBR Bake | Substance Worker `bake.production-substance` | high/low/cage/color + BakeDraftSettings | BaseColor、Normal、AO、Curvature、WorldNormal、Thickness、Position，可选 Roughness/Metallic |

任务必须支持 Job ID、queued/running/cancelling/succeeded/failed/cancelled、真实进度、Worker ID、账号历史、取消、恢复和已验证 artifact。服务不可用时 UI 阻断并显示真实错误。浏览器 local UV/PBR 测试内核不得成为正式 fallback。

Bake 设置包含 resolution、frontal/rear distance、distance/cage、cage inflation、always/by-name、sampling、padding、DirectX/OpenGL、GPU/CPU、UDIM、hit strategy、ignore backfaces、dehighlight 和 enabledChannels。输出进入对象存储并追加 Pipeline bake Revision。

## 11. 输入、捕获、生成与输出算法

| ALG ID | 名称 | 当前规则 |
|---|---|---|
| `ALG-IN-001` 格式路由导入 | GLB/GLTF 正式，FBX/OBJ 兼容；按扩展名/loader 解析为统一 LoadedModel |
| `ALG-IN-002` 模型归一化 | 通过父 Group 居中、落地、适配相机，不改 mesh 原始顶点 |
| `ALG-IN-003` 多模型放置 | 按已有场景包围盒并排放置，保留独立 objectId 与 transform |
| `ALG-CAP-001` 相机序列化 | position/quaternion/target/near/far/fov/zoom/P/V/world/aspect 完整保存 |
| `ALG-CAP-002` Color 捕获 | 线性 RT + 输出变换；viewport/clay/target-only/flat 明确区分 |
| `ALG-CAP-003` Mask 捕获 | 目标白色 BasicMaterial、黑背景；灰度×alpha 作为连续 mask |
| `ALG-CAP-004` Depth 捕获 | `(-viewZ-near)/(far-near)` linear-view，RGB packing，alpha=1 |
| `ALG-CAP-005` Normal 捕获 | 默认 view normal，编码 `n×0.5+0.5` |
| `ALG-GEN-001` 单视图生成 | 当前相机 Capture + 材质参考 → Generation；结果先生成原捕获尺寸的边缘去污染投影源，再与 capture mask/depth 一起创建 single-view-priority projected layer |
| `ALG-GEN-002` 多视图批次 | N 个捕获共享 batch；完成层串行 commit，整批结束一次发布新投影栈 |
| `ALG-GEN-003` 任务身份归一 | clientGenerationId/serverJobId/taskId 合并，避免恢复时重复 running 行 |
| `ALG-GEN-004` ModelView 远端单视图 | `1.0.0`；当前视角白模 + 多视图材质参考 + 可选提示词 → `modelview-single-view` → Generation；结果继续使用 `ALG-PROJ-005` 单视图优先投影 |
| `ALG-OUT-001` 纹理/模型导出 | BaseColor 与 GLB/GLTF/FBX/OBJ/STL/ZIP；验证 UV 方向和颜色空间 |
| `ALG-OUT-002` 快照/转台 | 当前视口设置生成静态图或视频，不改变 Layer 作者数据 |

### 11.1 单视图双提供方契约

- UI：`UI-05` 的单视图页显示 `GPT2 / 远端` 切换；默认保持 `GPT2`，多视图和局部重绘不受此选择影响。
- 模块：`M04` 生成编排；远端适配由同源 `/api/modelview/single-view` 进入 Node 控制面，浏览器不得直接持有 API Key 或跳过局域网 TLS 校验。
- GPT2 输入与行为：继续使用现有完整纹理提示词、LiClick/Atlas 任务提交、轮询、取消和投影流程，不改变既有语义。
- 远端输入：必填当前视角 clay 白模 `image`、已选多视图材质参考 `material_image`；`prompt` 可空且最长 4096 字符；禁止发送 mask、seed、noise_seed、模型名、采样步数或工作流节点参数。
- 远端身份：每次新生成使用新的 client generation ID，并派生独立 `Idempotency-Key`；网络层重放同一请求必须复用该键。
- 远端输出：同步 PNG 先写入当前项目 generations 资产，再创建 `workflow=texture-map`、`provider=modelview-single-view` 的 Generation；GPT2 与远端都必须用同一 capture camera/mask/depth 和 `ALG-PROJ-005` v2 创建 `single-view-priority-v1` 图层，供应方差异不得改变投影几何。
- 工作流：`modelview-single-view`，生产版本 `2026.08.26-c0e6218-single-view-4step-r1`，与局部重绘 `modelview-inpaint` 分开排队和审计。
- 失败与回退：远端失败只标记本次 Generation 失败并显示真实错误，不自动改走 GPT2；用户可显式切回 GPT2 重新生成。远端为非默认、非持久化界面选择，旧工程无需迁移。
- 回滚：移除单视图远端 UI 分支和同源路由即可；已有远端 Generation/Layer 继续按普通单视图优先层读取，不需要删除资产或改写 Project Revision。
- 测试：`test:single-view-priority` 必须覆盖双提供方分流与投影语义；`smoke:modelview-inpaint` 同时验证两条 ModelView URL、multipart 字段、幂等键、X-Job-ID 和 PNG 持久化。

### 11.2 单视图投影源、迁移与回退

- 面板返回图与投影源分离：面板可使用裁切显示副本；投影源必须保持捕获原尺寸，避免改变 projector UV。capture mask 是几何 footprint 权威，投影 PNG Alpha 只在 `projectionEdgeBlendMode=distance-field-v1` 时表达编辑器生成的轮廓过渡。
- 生成结果轮廓先依据 capture mask 从主体内部回拉 RGB，再把清理后的 RGB 向 mask 外扩散；外扩像素不会扩大几何覆盖。浏览器编码需要的非零外侧 Alpha 最终仍会乘独立 mask，因此不会投影到背景。
- 新建单视图检测同对象是否已有可见普通 projected/UV 底层。有底层时持久化 `ignoreSourceAlpha=false` 并使用距离场；无底层时 `ignoreSourceAlpha=true`，保持单层完整覆盖。旧图层缺少显式 false 时继续按旧逻辑读取，不批量改写 Project。
- 迁移：Project Command、Revision、ownership、Capture/Layer 字段和资产类别均不升级；旧项目直接兼容。要让已有单视图获得新轮廓过渡，需要重新生成或重新创建投影层。
- 回退：停止生成 `distance-field-v1` Alpha并恢复 `ignoreSourceAlpha=true` 即可；已保存 PNG、mask、depth 均仍为合法资产。不得删除用户历史图层或重写 Revision。

## 12. 状态、Revision 与并发

Project Revision 协议版本 1，ID 为 `revision-*`，number 从 1 连续增加，记录 parentRevisionId/savedAt。Project Command 协议版本 1，当前 kind 为 replace-project-document、rename-project、move-project。命令 ID 重放且 SHA 相同返回同一结果；同 ID 不同内容返回 `409 PROJECT_COMMAND_ID_REUSE_CONFLICT`；expected revision 不匹配返回 `409 PROJECT_REVISION_CONFLICT`。

Pipeline Revision 与 Project Revision 不同：前者记录 texture/retopology/uv/bake 业务产物来源和 stale overlay，追加后不可原位改写；后者是整个 Project 文档的存储并发版本。任何维护说明不得混称为“版本”。

## 13. 身份、安全、容量与性能

### 13.1 客户端性能录制 `ALG-PERF-SESSION-001` v1.0.0

A100 发布同时显式配置 `LICLICK_PERFORMANCE_LAB_ENABLED=true` 与构建变量 `VITE_LICLICK_PERFORMANCE_LAB_ENABLED=true` 后，`perfLab=1` 才按需加载云端记录桥；本地默认关闭且不生成/上传统计。既有“开始人工录制/结束并分析”状态从 `data-perf-manual-local-repaint-recording` 驱动一次完整会话。每次开始必须创建新的 `perf_<UUID>`，允许同一用户连续录制多次；结束后由 Worker 计算 SHA-256、写入 IndexedDB 待传队列并按 start → chunk → complete 顺序重试。采集不得写 Project/Scene/Layer Store，也不得触发 Project Command 或 Revision。

| 契约 | 当前版本/规则 |
|---|---|
| 算法 | `ALG-PERF-SESSION-001` v1.0.0，状态 production-diagnostic |
| 报告 Schema | `PERF-LAB-REPORT` v2；collector `2.0.0`；5 秒原始数据分块 |
| 浏览器输入 | rAF 帧时间/P50/P95/P99/最大帧、>16.67ms 掉帧、Long Task、Long Animation Frame、Event Timing、布局偏移、输入节拍、资源瀑布、JS heap、可见性、运行时错误、业务阶段 dataset、WebGL2/ANGLE renderer 与能力/扩展/GPU timer 支持、采集器自身开销 |
| 隐私边界 | 资源 URL 删除 query/hash，并泛化 UUID/业务 ID；不采集提示词、Cookie、键盘文本、模型/纹理像素；身份只取服务端可信 Session |
| 不可观测项 | 零组件浏览器无法直接读取 Windows ETW/DXGI/D3DKMT 调度计数、系统级 CPU/GPU 利用率、VRAM、温度、功耗及其他进程竞争；报告必须写 `unsupportedWithoutNativeComponent`，禁止伪造 |
| Cloud 职责 | A100/Cloud 只接收、校验、持久化和查询浏览器日志，不采样服务器 GPU，不参与用户视口帧循环 |
| 身份隔离 | 服务端以 Session user_id 写入，并保存录制时飞书 displayName/avatar/email 快照；普通用户只能通过本人查询读取本人记录；跨用户管理员查询必须使用独立 `/api/performance-lab/admin/sessions` 接口，并同时校验维护者角色与邮箱 allowlist，未命中白名单的普通用户或其他管理员固定返回 403 |
| 持久化 | SQL migration `003_performance_lab_sessions.sql`；`performance_lab_sessions` + 幂等主键 `(session_id, source, sequence)` 的 `performance_lab_chunks`；分片与最终报告分别校验 SHA-256 |
| 管理员配置 | `/li3d/performance-lab-admin` 为同源、飞书登录后的专用只读 HTML；`LICLICK_PERFORMANCE_LAB_MAINTAINER_EMAILS` 为可信登录邮箱逗号分隔 allowlist；前端页面不可替代服务端 403 门禁；匹配账号登录时只升级为 maintainer，不因配置临时移除而自动降权 |

迁移只新增性能会话/分片表，不回填旧 `sessionStorage` 报告，不改变 Project Command、Revision CAS、对象 ownership 或任何图层资产。回滚可停止挂载 Cloud bridge、关闭性能 API 并保留新增表供审计；IndexedDB 未发送记录可由恢复后的同版本页面继续重试，禁止为回滚删除用户项目或恢复 Windows 本地采集组件。

- 同源 Session Cookie；浏览器不保存长期对象存储密钥。
- 所有项目、Job、Asset 查询同时带 user_id 和资源 ID。
- OAuth state 使用数据库原子消费，拒绝重放。
- App 默认最多 256 在途请求；过载返回 503 + Retry-After。
- PostgreSQL 默认每副本 20 连接，副本数服从数据库预算。
- 大文件直传对象存储；GPU 任务进入独立集群队列，不占用 App Server GPU。
- Engine Session 管理项目级 CPU/GPU lane、任务取消和资源释放。
- 交互期间 Worker/GPU 重任务受 frame budget/heavy task scheduler 约束，但不得静默降低最终分辨率或关闭可见性检查。
- 性能实验室入口契约 `PERF-LAB-ENTRY/2.0.0`：项目贴图路由追加 `?perfLab=1` 时，只为当前真实项目打开性能 HUD、人工录制、帧时间与算法基准按钮。入口不得创建合成 Project、不得调用 `replaceCurrentProject`、不得写 Scene/Layer Store、不得改变活动对象或活动图层、不得触发项目保存；`perfScenario` 不再是编辑器路由契约。合成压力数据只能进入独立测试 Harness，且不得挂载真实项目持久化服务。投影预览失败保留上一份有效材质、写入 console 并熔断相同签名，禁止弹出用户 Toast 或无限重算。
- P0 数据安全门禁：任何调试、性能、演示或测试模块不得向真实 Project/Layer/Capture/Generation 持久化路径写入数据。回归测试必须静态断言编辑器不挂载场景替换加载器，并验证 `perfLab=1` 仅返回布尔诊断开关。若发生污染，先停自动保存、备份原文件，再依据 Generation.metadata.projectedLayerId、textureBatchId、Capture.camera 与本地资产重建，禁止直接删除整个项目。

## 14. 变更分级与修改上限

| 等级 | 示例 | 必须动作 |
|---|---|---|
| Patch | UI 文案、错误呈现、无语义回归测试 | 模块测试 + typecheck |
| Minor | 新 Layer role、兼容参数、非默认算法能力 | ALG/Schema Minor、迁移与回退说明、对应矩阵测试 |
| Major | 投影矩阵、权重模型、深度编码、颜色空间、UV 合并语义、持久化契约 | ADR、显式批准、版本升级、旧工程迁移、CPU/GPU/Worker/export 全链验证 |

默认一次修复只跨一个大模块，不超过 5 个源码文件或 300 行净变化。跨两个以上大模块、修改投影/UV/局部重绘阈值、Project/Layer/Capture/Generation 契约、默认分辨率、目录移动或兼容删除，必须先提交证据化方案并获得批准。

## 15. 模块验收矩阵

| 模块 | 最低自动验证 |
|---|---|
| M01/M12/M14 | contracts、project pipeline persistence、revision conflict、Postgres Repository、asset transfer |
| M02/M03 | model import、FBX repair、placement/camera、capture 对照 |
| M04 | generation polling/conflict/auth continuation、单/多视图 |
| M05/M06 | projection layers、multi-model restore、眼睛、相机旋转、对象 transform 后对齐 |
| M07 | projection、UV merge、backpressure、CPU/GPU parity、export orientation |
| M08 | local repaint material reference、seam、ordered/inward composition、bake batching、layer retention |
| M09 | content-aware topology/repair、island 不串色、取消 |
| M10 |真实 UV/retopology/Substance smoke、QA failure、artifact ownership、Bake alignment |
| M11 | GLB/FBX/OBJ/BaseColor 方向、重开与下载 |
| M13/M15 | cloud boundary、repository boundary、auth、scheduler、bundle budget、release readiness |

本基线合入验证：`pnpm --filter @liclick/web test:multi-model-restore-policy` 通过；contracts build 与 Web typecheck 通过。红色历史流水线状态不能以本地测试替代，推送后仍需核对 GitLab CI。

GitLab CI 依赖安装必须把 pnpm store 与 Prisma engine cache 放入 `$CI_PROJECT_DIR` 下的项目级缓存目录。Prisma engine 下载发生瞬时网络错误时，允许完整的 `pnpm install --frozen-lockfile` 最多重试 3 次并采用有界退避；禁止通过 `--ignore-scripts`、跳过 Prisma engine、放宽测试或使用未冻结 lockfile 伪造通过。此策略只提高 M15 发布验证的网络容错，不改变生产 Prisma schema、数据库协议、Project Command/Revision 或浏览器运行时。

## 16. 固定审计卡格式

以后新增或修改算法必须记录：ALG ID、中英文名称、SemVer、状态（production/experimental/deprecated/disabled）、所有调用 UI/use case、输入、输出、单位、颜色空间、矩阵空间、常量、CPU/GPU/Worker/shader 对应实现、持久化字段、回退、迁移、测试、负责人和变更单。

回答维护问题的固定顺序：`UI ID → 大/小模块 → ALG ID/版本 → 输入 → 公式/阈值 → Layer 输出 → 资产/Project 输出 → 回退 → 测试`。例如“Ctrl+S 怎么保存”必须回答 Project Command、Revision、对象存储和 PostgreSQL，而不是只说“保存 JSON”。

## 17. 当前架构债务

| 优先级 | 债务 | 处理原则 |
|---|---|---|
| P0 | 远端 main 含错误顺序的旧文档提交 | 由 Maintainer 受控重置为干净链；禁止把旧正文再合入 |
| P0 | `EditorPage.tsx`、`GeneratePanel.tsx` 仍承担大量编排 | 按用例迁入 application 层，不在拆分时改变算法 |
| P1 | 投影核心常量没有独立持久化版本 | 增加 projectionAlgorithmVersion 和旧工程策略 |
| P1 | 代码仍有 local-server/workspace 迁移期字段和错误文案 | 只做受控 schema/UI 清理，不得恢复本地组件拓扑 |
| P1 | 生产 UV/拓扑/Bake 尚需更多真实资产矩阵 | 失败门禁保持 fail-closed，模拟结果不得升级状态 |
| P2 | delete/duplicate 尚未统一为 Project Command | 先扩展契约和事务测试，再迁移调用者 |

## 18. 修订历史

| 版本 | 日期 | 基线 | 变更 |
|---|---|---|---|
| `2.0.0` | 2026-08-26 | `2568e405` | 从 Modernization 基线重新审计；彻底移除旧本地组件架构；重建 Cloud 保存、图层、投影、UV v4、局部重绘 v14/v5、生产 UV/拓扑/Bake 与维护规则 |
| `2.1.0` | 2026-08-26 | `待提交` | `ALG-LR-002` 对齐 ModelView GGUF 三业务输入：新增可选提示词，只提交白模与材质多视图两张图片，移除远端 viewport/seed 字段；本地 mask、flat reference、depth、接缝融合和回贴规则保持不变 |
| `2.1.1` | 2026-08-26 | `本次发布提交` | 固化 `PERF-LAB-ENTRY/1.1.0`：`perfLab=1` 同时启用性能 HUD 与默认单模型 100 图层基准，显式 `perfScenario` 仍可覆盖；补齐 URL 导航保留和云端测试说明 |
| `2.1.2` | 2026-08-26 | `本次发布提交` | `PERF-LAB-ENTRY/1.1.1`：投影预览失败改为静默保留上一份有效材质并熔断相同签名；错误仅写 console，禁止反复弹出用户 Toast |
| `2.1.3` | 2026-08-26 | `本次发布提交` | P0 修复：废止会替换真实项目的合成性能场景，`perfLab=1` 升级为只读测试台；增加真实项目零写入门禁和恢复规则 |
| `2.2.0` | 2026-08-26 | `本次发布提交 + 本地待提交` | 新增 `ALG-ERASE-001` v1.0.0：恢复 UI-10 当前图层橡皮与 `E` 快捷键；普通/合并 UV、投影蒙版和局部重绘按各自 coverage 编辑，内容填补底图需显式转可编辑 UV 副本；最终遮罩对齐 1K/2K/4K/8K，并登记迁移、失败与回退契约。同步修复 UI-05/UI-10 局部生图提交准备态显示不一致。新增 `ALG-GEN-004`：单视图增加非默认 ModelView 远端提供方；GPT2 原路径保持不变，远端复用当前白模捕获和 `single-view-priority-v1` 投影，通过同源服务端代理执行独立 4 步工作流 |
| `2.3.0` | 2026-08-26 | `本次发布提交` | 新增 `ALG-PERF-SESSION-001` v1.0.0 / `PERF-LAB-REPORT` schema v2：`perfLab=1` 人工录制采集用户浏览器真实帧、主线程、网络、内存及 ANGLE/D3D 能力，Worker 分块可靠上传，Cloud 按可信飞书身份隔离保存/查询；明确排除 A100 GPU 与浏览器不可见的原生系统计数 |
| `2.3.1` | 2026-08-26 | `本次发布提交` | 新增同源 `/li3d/performance-lab-admin` 只读分析页与独立管理员 list/detail API；跨用户读取必须同时命中维护者角色和两人邮箱白名单，普通用户及白名单外管理员均返回 403；A100 显式启用、本地默认不采集；发布总 JS 门禁依据新增隔离模块实测从 3.050 MB 调整为 3.080 MB，原有本人查询、本地项目及贴图/UV/重绘链路保持不变 |
| `2.3.2` | 2026-08-26 | `本次发布提交` | `ALG-PERF-SESSION-001` v1.0.1：A100 正式恢复 `/li3d` 构建前缀；录制按钮增加显式 Cloud start/end 通道；HTTP 内网环境对 `crypto.randomUUID` 与 `crypto.subtle` 缺失分别使用 RFC 4122 v4 UUID 和既有纯 JS SHA-256 回退。真实飞书账号已完成 1 次服务器录制，读回 1 分块、85 样本、19,854 字节及最终 SHA；本地仍为根路径且默认不采集，Project/Revision/贴图、UV、重绘数据未迁移。 |
| `2.3.3` | 2026-08-27 | `7d1e7bb + b9ca6dbc + f993f29 + 95a7473 + 本次文档提交` | `ALG-LR-007` v2.0.1 / `ALG-LR-008` v2.1.0：修复第二次及后续按钮 3 需要重复点击、预热卡顿、停笔后图层延迟显示、重复工作区资产上传和有序图层栈下 GPU overlay 重复投影到底面；停笔后两帧内立即发布完整图层行，3000ms idle 仅保留后台 latest-wins 保存合并；历史图层选择保护与远端契约对齐，稳定 vendor 分包后云端 bundle budget 保持通过；不改变 Project Command/Revision、投影/UV/颜色公式、输出分辨率或旧工程资产格式。 |
| `2.3.4` | 2026-08-27 | `21a1c20 + 本次 CI 修复提交` | M15 GitLab 安装验证加固：修正未命中项目缓存导致的全量冷下载，缓存 pnpm store 与 Prisma engine；`pnpm install --frozen-lockfile` 对瞬时 `ECONNRESET` 最多重试 3 次并采用 5/10 秒退避。保持 lifecycle、Prisma engine、全部 verify/build 门禁与生产契约不变。 |
| `2.3.5` | 2026-08-27 | `本次显示修复提交` | 新增 `ALG-LR-011` v1.0.0：重绘效果图与普通投射图层统一为 depth-authoritative 透明、单次精确裁切显示副本，完整保留几何覆盖区、黑色材质和边缘；深度失败仅使用边缘连通近黑背景的保守降级。局部重绘图层明确排除整图显示副本，继续按用户涂绘 mask 只显示笔刷授权区域。投影、UV、GPU/CPU/Worker/shader、持久化、对象资产、Project Command/Revision 与导出均不变，无迁移。 |
| `2.3.6` | 2026-08-27 | `0172822 + 本次延迟与多层修复提交` | `ALG-LR-007` v2.0.2 / `ALG-LR-008` v2.2.0 / `ALG-PROJ-007` v2.0.1：局部生图不再等待提交前项目同步；按钮 3 允许等价 live mask URL 命中已驻留 GPU source；多重绘层的 renderer/persisted twin 在创建、重绑、工具切换时保持单一可见所有权；多模型 UV 预热按选中对象限定隐藏层并在整组 striped upload 期间固定 Worker bitmap，消除 `no longer resident` 与后续 WebGL 1282 降级。保持投影、深度、颜色、分辨率、CPU/Worker/shader/export 与 Project Command/Revision/ownership 契约不变，无数据迁移。 |
| `2.4.0` | 2026-08-27 | `cf7ecec + 本次单视图投影提交` | 今日贴图工具优化汇总：局部重绘有序栈保持单一显示所有权；投影橡皮 mask 在预览/切层/工具切换后持续生效，眼睛连续点击不被晚到 effect 复活，并新增安全“清理蒙版”；`ALG-PROJ-002/003` v3、`ALG-PROJ-005` v2、`ALG-UV-004` v3 统一 GPT2/远端单视图的 capture mask/depth 表面锁定、预览/投影边缘去污染和有底层时的 3.5% 距离场宽带过渡。实时、渐进预览与 GPU UV bake 同义；Project/Layer Schema、Revision、ownership 与资产类别不变，旧工程无需批量迁移。 |
| `2.4.1` | 2026-08-27 | `本次保存调度提交` | 新增 `SAVE-SCHEDULER` v1.0.0：自动保存改为 2 秒尾随、10 秒最长等待和视口繁忙 1 秒有界重试；项目内存 `editVersion` 取代时间戳/ID 启发式，确保保存途中继续修改同一图层、蒙版或参数时不会误报 Saved。继续沿用单项目串行队列、Project Command v1、Revision CAS、verified assets 与 ownership；Project/Layer Schema 和旧工程资产均不迁移。 |
| `2.4.2` | 2026-08-27 | `本次投影橡皮性能提交` | `ALG-ERASE-001` v1.1.0：普通 projected 橡皮对齐蒙版画笔的 latest-sample-per-frame 输入调度，将一帧最多 96 次 BVH/三画布重复处理收敛为一次表面命中和连续段栅格；低分辨率持久提交等待 120ms 无输入 idle，高分辨率补缝继续 3000ms 后运行。UV 橡皮、局部重绘 coverage、覆盖公式、1K/2K/4K/8K 输出、Project/Layer Schema、Revision 与资产协议不变，无迁移；回退仅恢复投影橡皮密集采样和即时提交。 |
