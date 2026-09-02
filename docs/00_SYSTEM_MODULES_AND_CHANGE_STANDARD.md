# LI3D Cloud 系统模块、算法与变更管理唯一准则

> 文档版本：`2.13.12`
>
> 生效日期：`2026-09-02`
>
> 代码盘点基线：`66f976e + 本次局部重绘实时显示权修复`
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
| --- | --- | --- | --- |
| `M01` | Cloud 工程与工作区 | 项目 CRUD、Project Command、Revision、冲突与保存状态 | `workspaceApiClient.ts`、projects routes、ProjectRepository |
| `M02` | 输入与资产 | 模型/参考图接收、格式解析、预处理、直传、ownership | loaders、asset transfer contracts/services |
| `M03` | 场景、相机与捕获 | 对象归一化、相机、Color/Mask/Depth/Normal 捕获 | `engine/scene`、`engine/capture`、viewport |
| `M04` | 生成编排 | 单视图、多视图、提示词智能润色、参考图配对、任务身份、轮询/取消/恢复 | `GeneratePanel.tsx`、generation/modelview clients |
| `M05` | 图层领域 | Layer 类型/角色、顺序、显隐、调整、合并事务 | `types/layer.ts`、`layerStore.ts` |
| `M06` | 实时投影 | 捕获空间重投影、深度/法线门控、Top-3/Overlay 预览 | `engine/projection` |
| `M07` | UV 合成与发布 | UV 栅格、权重合成、后处理、PBR 显示固化、PNG 发布 | `engine/bake`、`engine/layers` |
| `M08` | 局部重绘 | 选择蒙版、效果/白灰几何融合输入、ModelView 四输入、返图直出、表面画笔回贴 | `GeneratePanel`、`localRepaint`、`ViewportCanvas`、`localRepaintGenerationInput.worker` |
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
| --- | --- | --- | --- |
| `UI-01` | 工程头 | 返回项目、重命名、Saved/Saving/Failed；调用 `M01/M12` | Project Command/Revision |
| `UI-02` | 贴图/UV/烘焙 | 工作流导航；调用 `M10/M12`，不在标签按钮内执行算法 | route + Pipeline stage |
| `UI-03` | 工作区/下载/分辨率 | 场景、贴图、法线、导出、1K/2K/4K/8K | settings + export intent |
| `UI-04` | 对象面板 | 选择、显隐、聚焦、变换、复制、删除、导入、排列 | SceneObject + Project document |
| `UI-05` | 生成面板 | 多视图、单视图、局部重绘与提示词智能润色；提交/恢复任务并创建 Layer | Prompt + Capture + Generation + projected Layer |
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

`UI-03` 导出菜单以文字可用性表达能力：支持项使用普通文字且不附加勾选状态；当前模型、对象、贴图或浏览器不满足导出条件时，条目保留但置灰并通过 title 提供原因，不显示叉号或其他状态图标。此规则只改变菜单呈现，不改变 `ALG-OUT-001`、导出格式、UV 合并、文件编码、权限或下载行为。

`UI-13 → UI-14` 的 UV/烘焙交接只把最新 `uv-model/low-model` 写入 Bake Set 的 `low`；UV 输入的 `high-model/model` 仅保留为 Pipeline 来源证据，不得自动写入或恢复为烘焙高模。烘焙页固定从资产阶段开始，高模由用户显式导入并保存为 Bake 专用 `high/highObject`；若 UV 低模已就绪，手动高模复用该 Bake Set objectId 后进入对齐阶段。历史工程中引用 Pipeline 高模资产的旧自动快照在读取时忽略但不删除；用户曾显式导入且不属于 Pipeline 的高模继续恢复。Project Pipeline、Bake Workspace Schema 与 Revision 协议版本不变，无批量迁移；回退可恢复旧自动高模 hydration，已有低模、高模与历史资产均不得删除。

`2568e40` 基线的新选择契约：贴图工作区优先显示用户显式选择的模型；所选 ID 缺失时回退到活动模型；点击空白视口不清空贴图模型选择。超过 20,000 三角面的 Auto UV 错误使用醒目的警告呈现。对应测试为 `test:multi-model-restore-policy`。

## 4. 工程保存、Ctrl+S 与数据格式

### 4.1 Ctrl+S 一句话答案

Ctrl+S 保存的是结构化 `Project` JSON 文档及其引用的不可变资产，不是单一 JSON 文件下载，也不是本地组件保存。Cloud 主链路通过版本化 `ProjectCommand` 写入权威 Repository；大二进制先通过签名 URL 进入对象存储。

### 4.2 精确调用链

```text
window keydown
 → shortcutMatches(event, 'project.save')
 → EditorPage.manualSaveHandlerRef
 → flushProjectLayerSync → getProjectSnapshot(refreshThumbnail=false)
 → prepareProjectForWorkspaceSave
      ├─ models/references/captures/generations/layers/baked 分三并发槽持久化
      └─ Project 中只保留稳定资产 URL/ID，不保存 Blob URL 或 File
 → LatestProjectSaveExecutor（正在执行 + 最新待保存快照；同一编辑器串行）
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
| --- | --- | --- |
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

### 4.5 浏览器保存调度 `SAVE-SCHEDULER` v1.1.0

编辑器保存调度由独立 `ProjectSaveCoordinator` 负责：普通编辑采用 2 秒 trailing debounce；持续编辑从首个待保存变更起最多等待 10 秒；视口交互、性能只读事务或图层同步抑制期间每 1 秒重试。Ctrl+S、生成/导入等既有即时保存事件仍直接进入同一项目串行保存队列，不等待自动保存窗口。

v1.1.0 合入远端保存优化：`LatestProjectSaveExecutor` 允许正在执行的写入完成，其后只保留最新待保存快照，合并过时请求的等待者；保存前先同步延迟图层编辑再冻结 editVersion，操作序号防止旧回包覆盖当前 Saving/Saved 状态。相同资源按项目/类别/文件名与源 URL 缓存稳定资产地址（最多 512 个槽、每槽 8 项）。Ctrl+S 不再同步读取 WebGL 或编码缩略图，缩略图刷新保留在导航/导入入口。

隔离开发的文件型 Repository 增加用户/项目目录缓存和候选定位，只在旧快照缺少投影图像时修复资产引用；主文档写入成功后，历史 autosave 快照由后台 latest-pending 队列保存，仍保留最多 5 份。此优化不替代生产 PostgreSQL 的不可变 Revision，也不将文件型 Repository 变成生产回退。

每个项目维护不写入 Project JSON 的单调 `editVersion`。获取保存快照时同时冻结该版本；资产上传和 Project Command 完成后，只有当前版本仍等于保存版本，前端才清除 dirty、删除意图并显示 Saved。保存途中发生任何持久编辑时，服务器返回的 Revision 仍被接收用于后续 CAS，但页面保持 Unsaved 并自动提交最新快照。该规则替代仅比较 `updatedAt`、对象 ID 和图层 ID 的旧判断，能够识别同一图层内容、蒙版、显隐或参数变化。

此版本不改变 Project Command v1、Revision CAS、Project/Layer Schema、资产类别、ownership 或对象存储校验；旧工程无需迁移，已保存 Project、Revision 与资产不需要改写。最低回归覆盖 2 秒尾随、10 秒最长等待、过期回包不得清除 dirty、最新回包能够标记 Saved，以及 Web typecheck/build。

仅回退 v1.1.0 时应恢复 v1.0.0 的串行 FIFO、资源持久化和同步备份路径，保留 2 秒尾随、10 秒最长等待与 editVersion CAS 保护，不退回旧快照 ID 启发式；已上传资产与 Revision 无需迁移。

## 5. 图层类型、角色与效果

Layer 的 `type`、`role`、`blendMode`、`visibility policy` 是四个独立维度，禁止用名称字符串代替结构化语义。

| 截图/产品名称 | type | role/识别条件 | 当前效果与合成位置 |
| --- | --- | --- | --- |
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

### 5.1 当前图层橡皮 `ALG-ERASE-001` v1.3.0

橡皮采用 Modddif 式“编辑当前图层覆盖”语义，不对最终合成画面做破坏性擦除。快捷键为贴图工作区 `E`，目标由 `engine/paint/eraserTargetPolicy.ts` 唯一判定，React 和 Zustand 不得复制类型分支。

| 图层目标 | 编辑数据 | 结果 |
| --- | --- | --- |
| 普通/合并 UV | 当前图层 Straight-RGBA alpha coverage | 擦除后露出下方可见图层；空 UV 不可擦 |
| 普通 projected | UV0 keep mask，`maskSpace='uv'` | 原投影图像、相机、深度/法线不变，只缩小该层投影覆盖 |
| projected/UV 局部重绘 | 已保存的作者 coverage/mask | 保留生成源图与几何授权，只编辑该重绘层的可见范围 |
| content-aware underlay | 只读计算结果 | 必须先显式创建普通 UV 可编辑副本；原 underlay 不变 |
| normal/patch | 无 | fail-closed；normal 禁止颜色橡皮，patch 先合并为 UV |

覆盖公式为 `effectiveCoverage = authoredCoverage × editKeepCoverage`。UV 图层在提交时把 keep coverage 合入该层 alpha；projected 图层把它保存为 UV0 灰度 keep mask；局部重绘沿用独立作者 mask。GPU 实时材质、GPU UV bake、CPU UV rasterizer、UV Worker source-over、图层合并和模型导出都消费同一结果。交互笔画预览可使用 512/1024 代理，但持久遮罩、延迟补缝和输出必须使用项目选择的 1K/2K/4K/8K，不得以旧 2K 上限作为最终结果。

v1.2.0 的交互调度只优化普通 projected keep-mask：原始鼠标/压感笔事件在每个显示帧仅保留最后一个表面命中，512 代理画布用连续笔刷段补齐帧间路径；复用 pointer-down 画布边界，停止逐帧上传仅用于延迟细化的 projection texture。抬笔后等待 48ms 无输入窗口，再让出一个任务执行持久画布、历史瓦片和图层发布，不再等待可能延迟数秒的 requestIdleCallback；切层/切模型时优先完成旧笔画提交，再释放旧 live mask，交接期间不接收新笔画。高分辨率投影补缝仍在 3000ms 交互空闲后运行。普通/合并 UV 橡皮继续使用密集 BVH/UV 重采样，局部重绘作者 coverage、最终分辨率和覆盖公式均不变。

图层显隐操作同步读取 LayerStore 权威状态，不以延迟 React 快照推导下一次眼睛状态；隐藏活动层会退出画笔/橡皮并选择仍可见的图层。清理 projected eraser mask 时同时取消待提交细化、清除 live surface preview 和 GPU eraser uniform，避免清理后残留遮挡。live eraser 纹理不再参与完整投影材质结构签名，工具切换与清理只更新驻留 uniform；晚到材质不能复活已经关闭的 UV 图层。

v1.3.0 历史事务修复（UI-06/UI-10 → M12 历史与画笔集成）：每次抬笔立即占据一个 runtime 历史位置，图像解码和 48ms idle 提交只填充该位置的前后瓦片，不再次入栈或清空 redo。`engine/paint/paintHistoryBoundary.ts` 统一工具栏与快捷键：等待当前手势和已登记的提交，再按请求顺序执行撤回/重做；等待期间仅拒绝新绘制手势，不阻塞浏览器线程。提交失败移除本笔占位；项目历史重置与清理蒙版通过版本检查淘汰晚到提交。

撤回/重做在同一任务中恢复持久瓦片、将当前及同层重建实例的 live eraser multiplier 重置为白色中性值、上传纹理并 invalidate；保持驻留 shader 结构，重新绑定 image/mask URL 和 contentRevision，随后同步 Project layers。此处中性白值是内部 keep-mask，不是编辑结果中的白模。后台细化仍采用项目原始分辨率和 3000ms idle；`engine/paint/refineStrokeHistory.ts` 从最早瓦片检查点按笔画顺序重放，分别更新每笔的 before/after。已撤回笔画仅更新 redo 检查点，不重新显示；新分支清除不再属于历史的笔画。每四个瓦片让出执行权，完成后无 await 地原子发布全部像素与历史；切换、撤回或新笔画使旧任务失效时不发布半成品。

审计：GPU live 纹理与持久 UV0/alpha 同步恢复；shader、CPU rasterizer、UV Worker、GPU bake 的覆盖公式与 UV/export 消费契约不变。历史事务仅驻留内存，回退只还原提交边界、即时预览复位和逐笔细化实现，已有图层资产仍兼容。新增 `test:paint-history-transactions` 执行真实历史 store/撤回回调和细化函数，覆盖快速三笔撤回重做、按住画笔时撤回、失败占位、项目重置、同层 runtime 重建、重叠擦除/画笔覆盖、新 UV 岛、redo 归属与中途取消；与历史粒度、输入延迟、目标策略、投影显隐和局部重绘兼容回归一起验证。真实模型连续操作及保存重开仍需交互验收，不以数值回归替代视觉结果。

Layer 以可选 `eraserAlgorithmVersion=1` 标记首次采用该语义的内容修订；未带字段的旧图层按原 image/mask 读取，首次擦除时惰性升级，不执行批量迁移。项目保存继续使用 Project Command v1、Revision CAS 与现有 verified layer asset 上传，未引入新的命令或资产类别。高分辨率提交失败时保留上一持久版本并显示错误，禁止静默写入低分辨率结果。

回退时可移除 UI-10 入口、`texture.eraser` 快捷键和目标策略调用；额外字段会被旧代码忽略，已有 image/mask 仍是合法 Layer 资产。内容填补转换创建的是独立 UV 行，因此回退不会修改或删除原 underlay。

## 6. 投影算法登记（关键）

| ALG ID / 名称 | 版本 | 调用者 | 核心定义 | 失败/回退 |
| --- | --- | --- | --- | --- |
| `ALG-PROJ-001` 捕获锁定矩阵重投影 | `2.0.0` | 实时材质、UV bake、画笔 | `clip=Pcap·Vcap·(Mcap·inverse(Mcurrent))·worldCurrent` | 缺矩阵/相机时层不可靠，禁止偷偷用当前相机 |
| `ALG-PROJ-002` 连续 Coverage 门控 | `3.0.0` | projection shaders | 普通层=`opacity×sourceAlpha×mask×angle×visibility×facing×edgeFade`；surface-locked depth 命中层以捕获 mask/depth 覆盖为权威 | coverage≤0.02 丢弃，不用二值膨胀掩盖 |
| `ALG-PROJ-003` 深度-法线表面可见性 | `3.0.0` | preview/GPU UV | linear-view depth + 3×3 支持；surface-locked 深度邻域支持在 0→0.05 内转为完整可见性，可靠 depth 命中不再被插值 mesh normal 二次衰减 | 缺 depth 才走角度退化，不伪造可见性 |
| `ALG-PROJ-004` Top-3 颜色一致性合成 | `2.0.0` | 普通多视图 | 每 texel 保留 score 最高 3 个；线性 RGB 离群降权 | WebGPU parity 不通过使用 CPU exact 输出 |
| `ALG-PROJ-005` Priority 单视图覆盖 | `2.0.0` | single-view layer | 核心沿用 priority coverage/quality；若同对象已有可见 projected/UV 底层，源图轮廓距离场在画幅 3.5% 宽度内由 0.12→1.0，之后再与捕获 mask/depth 相乘 | 无底层时保持不透明源；不越过捕获/深度边界 |
| `ALG-PROJ-006` Literal Overlay | `2.0.0` | 局部重绘 | 用户 authored coverage 直接 source-over，不再乘质量 feather | mask/source 未就绪不发布半层 |
| `ALG-PROJ-007` GPU 驻留与分块 | `2.1.0` | ProjectedLayerMaterial / SceneRoot / PreviewCompositor | 每个 array stripe 上传前解除 PBO 绑定并在 finally 恢复；只对可见工作区当前对象预热，隐藏对象取消未完成 array 构建；array 失败时允许预算内精确 direct stack，否则渐进合成自动退避重试，总尝试最多 4 次 | 保留上一有效材质或合法 UV bootstrap；晚到发布不得复活隐藏 UV；不降低生产 UV 输出尺寸 |

### 6.1 当前生产常量

| 参数 | 当前值 | 语义 |
| --- | ---: | --- |
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

`ALG-PROJ-007` v2.1.0 仅改变 GPU 资源生命周期、失败恢复与权威显示状态，不改变投影矩阵、coverage、深度/法线门控、颜色空间或 UV 合成公式。Worker packing 与 512px stripe 继续保持最终输出尺寸，CPU/GPU UV raster、shader coverage 和导出仍消费相同 image/mask/depth。失败自动重试间隔为 250/500/1000ms；取消、签名变化或成功发布时清理定时器及计数。

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
| --- | --- | --- |
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
 → 同相机捕获 2K flat BaseColor 干净效果图、2K clay-target 白灰几何图和原始 RGB selection mask
 → Worker 从原始 mask 派生双阈值连通、闭运算补断、微小孤岛过滤与小孔填充的合成核，用全不透明核+窄边羽化将 clay 融入效果图
 → ModelView 专用 mask 再从合成核自适应外扩 24–64px@2K 并羽化 4–10px；未修改原始作者 mask
 → 若材质参考是单图，先生成 durable 多视图配对
 → Qwen 只看干净效果图 / 完整多视图 / 未外扩原始 mask；留空先输出一句中文修复要求，再用 Klein 2–3 段模板转换；有用户文字直接转换
 → ModelView 四输入（效果+蒙版内白灰几何融合图 / 材质参考 / 外扩羽化 RGB mask / Qwen 最终 prompt）与 1K linear-view depth guard 并行
 → 远端单张 PNG 直接作为新结果，不再执行浏览器校色或接缝融合
 → 保存 direct result、mask、capture 与工作流版本元数据
 → 用户用表面画笔决定实际回贴 coverage
 → 1024 live GPU overlay；停笔后两帧内先发布完整 projected repaint 图层行
 → “局部重绘”页签始终显示当前 Generation 的完整远端返回图；实际 coverage 只在 3D 视口实时 overlay 与图层预览呈现
 → 3000ms 空闲窗口只用于 latest-wins 后台持久化/自动保存合并，不阻塞图层面板
```

### 8.2 算法登记

| ALG ID / 名称 | 版本 | 输入与规则 |
| --- | --- | --- |
| `ALG-LR-001` 冻结视角选择重投影 | `2.0.0` | 累积多相机表面选择在生成瞬间重投影为 2048 方形 mask；相机/对象矩阵冻结 |
| `ALG-LR-002` ModelView 四业务输入直出 | `3.1.0`；workflow `2026.08.28-cd48a78-truev3-gguf-mask-4input-rseed-r1` | 远端字段固定为必填 2K 效果/白灰几何融合 `image`、必填 `material_image`、必填同尺寸外扩羽化 RGB `mask`与必填 Qwen 解析后 `prompt`；mask 红通道白色可编辑、黑色保留，禁止 alpha-only；不提交 `viewport_reference`、`seed`、`noise_seed`或 workflow 节点参数；返回 PNG 以 `resultComposition=direct-v1` 直接持久化和投影 |
| `ALG-LR-003` 并行深度保护 | `2.0.0` | 1K linear-view depth 与远端请求并行；失败保留生成结果但明确 warning，几何保护降级 |
| `ALG-LR-004` 历史增强边界谐调 | `14.0.0-compatible` | 仅读取/重建旧 v6-v14 Generation 和图层；新 `direct-v1` 任务不调用 |
| `ALG-LR-005` 历史兼容边界谐调 | `5.0.0-compatible` | 仅保留旧 v3-v5 全幅合成与 legacy 切换的读取兼容；新 `direct-v1` 任务不调用 |
| `ALG-LR-006` 表面画笔重投影 | `2.0.0` | raycast 命中表面，投射到 frozen source UV；最小绝对 face-on 0.08；世界半径 0.004-0.12 包围盒比例；texture radius 1-72 |
| `ALG-LR-007` 低延迟实时覆盖 | `2.1.3` | 应用画笔激活期间，当前编辑层由 mutable depth-aware GPU overlay 独占显示并逐笔消费 live canvas；同 ID resident row 保持驻留但临时静音，其他历史局部重绘层不受影响。退出画笔、切层或切换 Generation 时，先解除当前层静音并让 resident row 完整呈现一帧，再经两帧屏障隐藏 overlay。进入画笔的显式预热阶段仍把持久 mask URL 提升为稳定 live canvas URL；pointer-up 保留已有 `contentRevision`，只更新累计 CanvasTexture 与图层保存快照。source、capture projector、depth/normal/surface-lock、图层顺序、颜色、blend、1024 live 上限与排队进度规则不变 |
| `ALG-LR-008` 延迟投影持久化 | `2.2.5` | interactive UV bake 固定关闭；生图前 Project Command snapshot 后台执行；Generation、对象、目标层与 GPU-ready 标记共同识别驻留 source；成功生图以 success revision 触发新 source 后台解码、目标层绑定与 GPU 预热，使应用画笔首次点击直接进入驻留快路径；若首次点击早于任务锁或 Generation store 发布完成，内存请求跨越该过渡窗口并在 ready 后自动执行，按钮以旋转图标和流动进度条反馈等待；排队请求绑定确切 Generation/目标层，旧 GPU 事件不得解锁新请求；刷新或 renderer effect 取消后，被动恢复的旧 source 不得阻止最新 Generation 接管，source 已选中但 GPU-ready 缺失时通过显式 prepare revision 重新执行解码、纹理上传与目标层绑定，并仅由 ready/failed 事件结束等待，不使用超时冒充完成；pointer-up 两帧内发布权威图层行，发布后按真实 LayerStore 行判断驻留，不依赖旧 preview revision；后台构建只等待真实指针交互，不等待蒙版工具退出；idle 3000ms 仍仅合并持久化，needsRebake=true |
| `ALG-LR-009` Inward Crossfade 栈合成 | `1.0.0` | 连续重绘层向内部交叉淡化，避免普通 alpha stacking 在边缘重复显露接缝 |
| `ALG-LR-010` Provider 兼容编辑 | `1.0.0-compat` | `LocalRepaintDialog` 的 image/edit/protect/hole masks 独立路径，不得与四输入主路径混改 |
| `ALG-LR-011` 生图透明显示副本 | `1.0.0` | UI-05 重绘效果图和 UI-10 普通投射图层缩略图优先使用 capture linear-view depth 清除明确无几何覆盖的背景，按精确 alpha bounds 仅裁切一次并保留 6% 留白；几何覆盖区的 RGB/alpha 原样保留。深度不可用时只清除与画布边缘连通的近黑外背景，不做第二次 matte、侵蚀或分位裁边。局部重绘图层不走整图副本，继续使用用户涂绘 mask，只显示笔刷授权区域 |
| `ALG-LR-012` 远端重绘输入融合 | `1.1.0` | 专用 Worker 从原始连续 mask 派生 ModelView 合成核：候选/强核阈值为 24/96，8 邻域保留含强核的连通域，应用 `clamp(0.012×mask短边, 2, 6)px@2K` 闭运算、小于 `max(24px², bbox×0.02%)@2K` 的孤岛过滤和小于 `max(64px², bbox×0.05%)@2K` 的封闭孔填充；`composite=current×(1-a)+clay×a` 使用全不透明核和约 1.5px@2K 窄边羽化。远端 mask 从清理后核再按 `clamp(0.25×核短边, 24, 64)px@2K` 外扩、`clamp(0.2×外扩, 4, 10)px@2K` 羽化。Qwen、Capture、Generation 画笔授权与历史恢复仍使用未外扩、未清理的原始作者 mask |

局部生图远端接收生成阶段的 RGB selection mask，但仍不接收 UV 图集、表面深度或用户最终回贴 coverage。远端 latent mask 不承诺蒙版外像素逐点不变；浏览器继续用同一 `allowedMaskUrl`、capture camera 和 depth guard 限制 3D 写回，用户通过表面画笔决定最终图层 coverage。这些几何授权契约与旧版保持一致。

`ALG-LR-002` v3.1 在 Node 控制面转发前用 Sharp 校验 `image/mask` 尺寸一致且 mask 红通道非空；缺少蒙版、alpha-only/全黑蒙版或尺寸不同均以 422 fail-closed，不进入 GPU 队列。原始作者 mask 与远端外扩 mask 分别持久到 Generation metadata：前者写入 `maskUrl/authoredMaskUrl` 并与 Capture、Qwen、交互画笔及历史恢复绑定，后者只写入 `submittedMaskUrl` 并作为 ModelView 真实提交蒙版。读取双蒙版历史任务时优先使用 `authoredMaskUrl`，没有该字段的旧工程才回退 `maskUrl`。新任务的幂等后缀仍为 `inpaint:4input-rseed-r1`；同一 client generation ID 的网络重放复用键，修改任一输入必须创建新 ID。远端单视图类型已与局部重绘拆分，仍只提交白模与材质参考两张图，不接收 mask。

迁移：Project Command、Revision、Capture/Generation/Layer Schema、对象存储类别与 ownership 均不升级；旧 v5-v14 结果继续使用已持久化 harmonized/raw 元数据，不批量重算。新任务以 `resultComposition=direct-v1`、`rawResultUrl=resultUrl` 识别并直接投影。回退可恢复旧三输入 workflow 与浏览器 harmonization；已保存的 direct PNG 仍是合法 Generation 资产，禁止删除历史图层或改写 Revision。

`ALG-LR-012` v1.1.0 只改变 ModelView 生成输入的派生蒙版：原始作者 mask 仍是编辑意图、Qwen 定位、Capture、Generation 画笔授权、历史和回贴 coverage 的唯一权威来源，不被清理或覆写。清理后核只用于白灰几何融合图与 `submittedMaskUrl`，不使用凸包或包围盒填充，不跨越大于闭运算直径的结构空隙。GPU、shader、UV raster、投影、返图直出、输出分辨率和 export compositor 无变化；Project/Layer/Generation/Capture Schema、Revision、ownership 与已有资产无迁移。回退时只恢复 Worker 使用原始连续蒙版融合并从原始二值核外扩，不删除任何工程数据。

`ALG-LR-007/008` v2.0.2/v2.2.0 与 `ALG-PROJ-007` v2.0.1 不改变投影矩阵、深度编码、face-on 阈值、1024 实时上限、最终 UV 分辨率或颜色合成公式。GPU 继续消费同一 source/mask/depth；CPU、Worker、UV raster、shader 门限与 export compositor 没有算法分叉。生图前 snapshot 与 Generation 最终写回仍进入同一 critical save queue，沿用 Project Command v1、Revision CAS、ownership 与 verified object asset；只把提交前的网络等待移出用户可见关键路径，失败由即时保存恢复。多层恢复的 Worker bitmap 在整组 striped upload 期间固定，缓存上限从 18 调整到 24，并只为当前选中对象预热隐藏 UV 行；其他模型的可见 exact/proxy 仍驻留，不降低图片尺寸或跳过 QA。旧工程无需批量迁移，重开时按现有 Layer/Generation/Capture 字段重建资源。回退可恢复提交前 save barrier、mask URL 严格相等判断、旧 overlay 可见分支和 18 项缓存；已有 projected layer、mask、capture、Generation、对象资产与 Revision 无需删除或改写。

本次连续重绘修复属于 UI-06/UI-10 → M08 显示生命周期：旧 preview 无 revision 不能继续排除已发布行；已发布行在 pointer idle 期间预热，真实拖动、落笔和压力测试仍暂停重任务。source 切换/清空逐帧等待实际模型全部非 overlay 网格的材质绑定包含旧 layerId；最长等待 10 秒，取消或超时保留旧显示，不阻塞主线程、不清空旧图层。异步材质发布读取最新显示所有者，避免晚到任务重新静音旧层。GPU 仅调整驻留和交接顺序，CPU/Worker/shader/UV/export 的像素、蒙版与颜色公式、分辨率均不变；Project Command/Revision、资产和 ownership 无变化，无迁移。回退仅恢复 M08 驻留判定与 source 交接流程，不删除工程或资产。回归覆盖首次发布、跨源切换、部分网格就绪、已释放材质、取消及超时；真实用户工程连续笔画帧率仍需登录现场验证。

`ALG-LR-007` v2.0.5 的视角选择属于 UI-06/UI-10 → M08 的纯展示状态：点击底部选择工具退出绘制并恢复 OrbitControls 输入，同时隐藏红色选择蒙版；`paintMaskDataUrl`、`paintMaskHasContent`、revision、capture 和历史均保持不变。再次进入加/减蒙版画笔会恢复蒙版展示。该 flag 不进入 Zustand preferences、Project、Layer、Generation、Capture、对象存储或 Revision；GPU 只切换已有 mask overlay 的可见性，CPU/Worker/shader/UV/export、投影矩阵、颜色和分辨率没有分叉。旧工程无需迁移；回退只移除按钮与 presentation flag，不删除蒙版或资产。

`ALG-LR-007` v2.0.6 / `ALG-LR-008` v2.2.2 仅修正 UI-05/UI-10 → M08 的连续生图 source 生命周期：生图成功时记录一次性 pending Generation，并用成功 revision 显式触发后台预热。当旧 source 仍占有 renderer 时，只允许与 pending Generation 完全相同的新结果执行一次交接；source 发布或已经驻留后立即消耗 pending 身份，之后的后台扫描继续保护用户主动选中的历史结果。本次不改动 GPU/CPU/Worker/shader、投影矩阵、深度编码、颜色合成、1024 实时上限、最终 UV/export 或 Project/Layer/Generation/Capture Schema，不新增持久字段。旧工程无需迁移或缓存失效；回退时移除 pending Generation 标记和背景 source 决策函数，即恢复旧的不同目标层一律保护分支，无需删除已有图层、蒙版或生成资产。

`ALG-LR-007` v2.0.7 / `ALG-LR-008` v2.2.3 修正 UI-10 → M08 的画笔启用请求生命周期：局部生图成功后，远端完成回调、编辑器任务锁释放和 Generation store 发布结果可能发生在相邻的不同 React 提交中。应用画笔的首次点击若落在这个窗口，不再被底部工具条捕获阶段丢弃，而是登记一个仅驻留内存的一次性请求；按钮立即显示旋转图标和不确定进度条，待任务解锁且结果 ready 后自动重放并进入 `inpaint-apply`。只有局部生成成功过渡可排队，内容识别修补、项目生成和快照准备等其他互斥操作仍 fail-closed；生成失败、切换工程/模型或开始下一次生成会清除请求。本次不改变 GPU/CPU/Worker/shader、投影矩阵、深度编码、颜色合成、1024 实时上限、最终 UV/export、Project/Layer/Generation/Capture Schema、Revision、ownership 或资产，无数据迁移。回退时移除 activation request policy、EditorPage 一次性请求状态、BottomToolDock 排队放行与进度条，即恢复统一交互锁；已有图层、蒙版和 Generation 无需删除或改写。

`ALG-LR-008` v2.2.4 修正 UI-10 → M08 的排队转圈竞态。等待状态从无身份的 boolean 升级为内存中的 Generation/目标层请求；生成完成回调会把过渡期请求升级为确切 Generation，互动 ready/failed 事件仅能更新同一请求，防止上一轮 GPU 晚到事件错误解锁。预载、后台 source 发布和点击激活共用显式 preferred Generation；无 preferred 时按 `completedAt/startedAt` 确定选最新结果，不再依赖数组顺序。后台预热取消、跳过和失败均结束诊断 stage；生图任务已结束且解锁后，8 秒 watchdog 若发现对应 GPU-ready 驻留标记则自愈并自动重放，否则释放转圈并提示重试，不会无限占用画笔按钮。本次不修改图层数组、已有局部重绘显示权、蒙版、GPU shader、CPU/Worker、投影/UV/export、分辨率或 Project/Layer/Generation/Capture Schema、Revision、ownership 与资产，无数据迁移。回退时恢复 boolean 请求、移除 Generation 选择函数与 watchdog 即可；已有图层、蒙版和 Generation 无需删除或改写。

`ALG-LR-008` v2.2.5 取代 v2.2.4 的超时补救，修复 UI-10 → M08 的真实加载链路。浏览器诊断确认：刷新或连续生成后，最新 Generation 已成为候选，但 renderer 仍可能保留上一 Generation 的 GPU-ready 标记；被动恢复 source 因缺少一次性 pending 标记而错误保护旧结果，或最新 source 已写入 Zustand 但其 renderer effect 在发布 ready 前被取消，导致按钮永久等待。新逻辑允许 `autoActivate=false` 的被动恢复 source 被最新 Generation 接管，并增加仅驻留内存的 GPU prepare revision；后台发现“source 身份正确但 GPU-ready 不匹配”或用户点击该 source 时，会立即重启同一 source 的图片解码、蒙版准备、纹理上传和目标层绑定，由精确 Generation/目标层的 ready/failed 事件完成或失败，不再使用计时器释放或伪造成功。实测刷新后后台 Generation 与 GPU-ready 一致，驻留点击路径响应约 7.1ms。已有局部重绘图层、历史蒙版和显示权在 renderer handoff 期间持续保留；不修改 shader、CPU/Worker 算法、投影/UV/export、分辨率、Project/Layer/Generation/Capture Schema、Revision、ownership 或资产，无数据迁移。回退时移除 `localRepaintGpuPrepareRevision`、被动 source 接管分支和显式 prepare 请求，并恢复 v2.2.4 watchdog；已有工程数据无需改写。

`ALG-LR-007` v2.0.8 修正 UI-06 → M08 的双表示显示权：当活动局部重绘上方存在可见的 `single-view-priority-v1` 图层时，专用 GPU overlay 按顺序规则保持隐藏，实时 source/mask 由 ordered projected stack 合成；此时同 ID 的 resident binding 不得再因 renderer preview marker 被静音。只有专用 overlay 实际负责显示时才静音 persisted twin，从而避免笔画已经写入 LayerStore、右侧缩略图已更新，但 overlay 与 resident row 同时透明导致视口无反馈。GPU/CPU/Worker/shader、投影矩阵、coverage、深度编码、颜色合成、1024 实时上限、最终 UV/export、Project/Layer/Generation/Capture Schema、Revision、ownership 与资产均不改变，旧工程无需迁移。回退时仅恢复 resident binding 对 preview ID 的无条件静音；不得删除已有图层、蒙版或生成资产。

`ALG-LR-007` v2.0.9 修正 UI-06 → M08 的实时 mask 所有权：ordered projected stack 使用打包快照，无法在每个指针采样后读取正在变化的 live canvas；因此应用画笔激活期间，无论活动重绘上方是否存在 `single-view-priority-v1`，均由专用 GPU overlay 临时接管反馈，并在同一状态提交中静音同 ID resident binding。离开应用画笔或刷新恢复后仍由 ordered stack 按原图层顺序显示持久结果。此变更不改 source/mask 内容、投影矩阵、coverage、深度编码、颜色公式、1024 上限、CPU/Worker/shader、UV/export、Project/Layer/Generation/Capture Schema、Revision、ownership 或资产，无数据迁移。回退时移除 live feedback 对专用 overlay 的强制接管即可；已有图层、蒙版和生成资产无需删除。

`ALG-LR-007` v2.1.0 修正 UI-06 → M08 的当前层二次编辑和异步质量交接：复杂 depth-aware GPU overlay 在部分真实工程中可完成绑定但被 capture visibility 全部裁为透明；旧流程仍立即静音同 ID persisted twin，因而当前层旧笔画与新笔画同时消失，只有等待 ordered stack 重打包后手动开关预览才恢复。新流程在预热阶段创建 renderer-only 简化 mesh preview，每个有效采样只上传最大 1024 的 inward-crossfade live mask，并以同一 capture projector matrix 采样生成 source；它不读取 depth/normal，不参与持久 Layer、缩略图、UV 或 export，只保证编辑时的即时近似反馈。SceneRoot 将可见 projected 层的 `contentRevision` 纳入展示失效签名，pointer-up 发布后自动触发正式材质重建；离开应用画笔时逐帧确认当前 layerId 已进入真实背景材质，再关闭简化 preview 并解除同 ID resident 静音。静音门禁限定为“快速 preview 实际可见或 ordered stack 明确接管”，未就绪、eye-off、取消或 10 秒超时继续显示当前正式层；其他局部重绘 layerId 不变。最终 source、作者 mask、capture depth、`surface-locked-v1`、coverage/颜色公式、1024 live 上限、最终分辨率、CPU/Worker/UV/export、Project/Layer/Generation/Capture Schema、Revision、ownership 和资产均不改变，无数据迁移。回退时移除 `liveLocalRepaintFastPreview`、恢复 v2.0.9 的专用 overlay 所有权，并移除 projected contentRevision 展示失效通知；不得删除已有图层、蒙版、Generation 或资产。回归覆盖当前层二次进入、未就绪不静音、只静音同 ID twin、快速/复杂 twin 不并绘、正式层驻留后自动交接和 contentRevision 重建；真实浏览器已验证再次进入时快速 preview ready/visible 且复杂 overlay hidden。

`ALG-LR-007` v2.1.1 修正 UI-06 → M08/M06 的实时 coverage 所有权。v2.1.0 的无深度快速 mesh 与正式 surface-locked 图层同时存在，重进画笔时会先静音正式行；快速 mesh 又缺少 capture depth/normal 门控，因此可能出现当前层旧笔画消失、live 笔画无反馈或深红色投影块。新流程删除该 duplicate mesh：已有正式行保持可见，并在其共享 projected shader 内将预留 live sampler 精确绑定到当前 layerId，使用 capture/projector UV 直接替换该行打包 mask；其他图层、resident source、depth/normal/surface-lock、inward crossfade、图层顺序和颜色运算均不变。mask texture 与 layer binding 未变化时不重复 invalidate；离开工具只在正式行仍驻留后清除 override。首次尚无持久行时保留原 depth-aware exact overlay，发布后按 layerId 交接。SceneRoot 只有在当前工具真实拥有预览显示权时才允许静音 resident row，晚到 marker 不能隐藏正式层。本次只改变 GPU shader uniform 绑定与视口生命周期；CPU/Worker/UV/export、1024 live 上限、最终分辨率、Project/Layer/Generation/Capture Schema、Project Command/Revision、ownership 和资产均不改变，无数据迁移。回退可关闭 projection-space override 并恢复 v2.0.9 的 exact overlay 接管，不应恢复 v2.1.0 的无深度快速 mesh；已有图层、蒙版、Generation 和资产无需删除或改写。回归覆盖正式行绑定、仅当前 layerId mask 替换、新行 exact overlay、退出交接、无 duplicate mesh 与晚到静音门禁；真实浏览器验证进入局部重绘和切换画笔时当前层持续可见、override 已绑定、无深红块。

`ALG-LR-007` v2.1.2 修正 UI-06 → M08/M06 的首笔发布热路径。旧实现 pointer-up 立即把 renderer exact overlay 判为非所有者，并把持久 mask URL、`contentRevision` 等结构字段写回 LayerStore；正式 projected material 尚未包含该行时会先出现空白帧，URL/sampler 或 revision 变化又会触发完整投影栈重建。新实现以“材质已驻留且 live override 已绑定”取代“LayerStore 已存在该行”的交接条件：SceneRoot 在最终材质挂载后发出驻留通知，视口先解除 preview marker 对 resident row 的静音，保留 exact overlay 覆盖一个完整呈现帧，再在下一帧撤下 overlay。已保存行在画笔预热进度阶段把持久 mask 复制到稳定 live raw/blend canvas URL，落笔后地址不再变化；交互提交保留原 `contentRevision`，项目保存仍按 live registry revision 将 raw/blend mask 转为验证资产。GPU 只改变 URL 切换时机、uniform 绑定和两帧显示屏障；CPU/Worker/shader coverage、投影矩阵、depth/surface-lock、UV raster、最终分辨率与 export compositor 不变。Project/Layer/Generation/Capture Schema、Project Command/Revision、ownership 和资产类别不升级，旧工程在首次进入画笔时惰性提升，无批量迁移。回退可恢复 pointer-up URL 切换、revision 递增和 `hasPersistedLayer` 交接判定；不得删除已保存蒙版、Generation、Layer 或资产。回归与浏览器验收必须证明预热后首笔前后 `projectedMaterialBuildRevision` 不变、结构差异为空、override 持续绑定且测试笔画可撤销。

`ALG-LR-007` v2.1.3 修正 UI-06 → M08 的实时显示权冲突。策略层原本已规定 `inpaint-apply` 时专用 overlay 接管，但视口生命周期仍会在 resident live-mask override 已绑定时隐藏 overlay，并清除已持久层的 preview owner，导致 live canvas 正常更新而视口继续显示旧打包 mask。新逻辑让应用画笔激活态无条件优先于 resident override：depth-aware exact overlay 保持可见，SceneRoot 仅静音同 ID resident twin；其他历史局部重绘层、普通投影层和 UV 层继续按原顺序显示。退出画笔、切层或切换 Generation 后才允许 resident row 接管，并沿用一帧呈现加两帧屏障撤下 overlay。该修复不修改作者 mask、source、capture depth、surface-lock、投影/颜色公式、1024 live 上限、CPU/Worker/shader/UV/export、最终分辨率、Project/Layer/Generation/Capture Schema、Revision、ownership 或资产，无数据迁移。回退时恢复 resident override 对 overlay 的优先隐藏及已持久层 preview owner 清理分支；已有图层、蒙版和 Generation 无需删除或改写。

UI-05/UI-13 的贴图驻留边界要求所有挂到页面根节点的生成面板 Portal 同样受 `EditorPage.isActive` 门禁。进入 UV 时贴图编辑器可继续保留引擎与面板状态，但“局部生图”固定按钮、生成取消确认和结果大图预览均不得越过隐藏工作区显示；回到贴图页后按原状态恢复。此修复仅改变 React 展示生命周期，不改变局部生成算法版本、任务状态、GPU/CPU/Worker/shader、输入蒙版、Project/Layer/Generation/Capture Schema、对象资产或 Revision，无数据迁移；回退只移除 Portal 活跃态门禁。

`ALG-LR-011` 只生成最大 1024 的内存 UI 显示副本，不回写 `Layer.imageUrl`、Generation、对象存储或 Project Revision。GPU/CPU/Worker/shader、投影矩阵、UV raster、持久化与 export compositor 均继续消费原始 source/mask/depth，因此无需数据迁移。回滚只需移除 UI-05/UI-10 显示副本调用；已有图层与资产不变。测试必须证明透明显示不替换投影源、黑色材质与几何边缘不被扣除、普通投射层不再出现黑底、局部重绘层仍仅显示用户涂绘区域。

## 9. 内容识别补缝

| ALG ID / 名称 | 版本 | 定义 |
| --- | --- | --- |
| `ALG-CA-001` 覆盖缺口检测 | `1.0.0` | 从投影 coverage/confidence 构造待修复 mask，排除已有可靠投影 |
| `ALG-CA-002` UV 表面拓扑 | `1.0.0` | UV 三角形 region、可选物理 seam link、normal dot 门限；预热并缓存 |
| `ALG-CA-003` 表面约束传播 | `1.0.0` | Worker 在同一表面/region 内传播颜色，不跨无关 UV island |
| `ALG-CA-004` Underlay 原子发布 | `1.0.0` | 生成 `uv + content-aware-underlay`，GPU 预热后一次发布，合并时永远在投影之下 |

本地兼容填充的搜索半径为 `clamp(ceil(max(ROI.w,ROI.h)×0.2),16,48)`，迭代 2 次；它不能冒充远端生成或覆盖有效投影颜色。

## 10. 生产 Auto UV、拓扑与 PBR Bake

| 流程 | 正式算法/服务 | 输入 | 产物与门禁 |
| --- | --- | --- | --- |
| Auto UV | Asset V4 `uv.production-service` | 模型资产 + 参数 | 可轮询 Job、UV 模型/报告；严格 UV QA 失败不得发布 |
| 自动拓扑 | Asset V4 `RETOPOLOGY_PROCESS_V2` | 高模 + mixed_game_ready metadata | final FBX/GLB、诊断产物；坐标/质量门禁失败不得标成功 |
| PBR Bake | Substance Worker `bake.production-substance` | high/low/cage/color + BakeDraftSettings | BaseColor、Normal、AO、Curvature、WorldNormal、Thickness、Position，可选 Roughness/Metallic |

任务必须支持 Job ID、queued/running/cancelling/succeeded/failed/cancelled、真实进度、Worker ID、账号历史、取消、恢复和已验证 artifact。服务不可用时 UI 阻断并显示真实错误。浏览器 local UV/PBR 测试内核不得成为正式 fallback。

Bake 设置包含 resolution、frontal/rear distance、distance/cage、cage inflation、always/by-name、sampling、padding、DirectX/OpenGL、GPU/CPU、UDIM、hit strategy、ignore backfaces、dehighlight 和 enabledChannels。输出进入对象存储并追加 Pipeline bake Revision。

## 11. 输入、捕获、生成与输出算法

| ALG ID | 名称 | 当前规则 |
| --- | --- | --- |
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
| `ALG-GEN-005` 提示词智能润色 | `1.9.0`；UI-05 经同源 `/api/liclick/prompt-polish` 分流。普通单/多视图保持莉刻 `data-analysis` A2A；局部重绘空输入仍先由 `qwen3-vl-plus` 输出一句中文修复要求，显式输入跳过诊断，两者再进入统一 Qwen → Klein 转换模板。服务端用未外扩原始 mask 定位，并从干净 Image 1 自动裁出带上下文的第四图供 Qwen 看清选中部件；完整参考图仍只提供有证据的结构/材质，第四图不改变编辑范围或 ModelView 输入。模板先用 Image 2、第四图和 mask 外邻域共同确定真实结构与材质；仅当三者证明选区为未完成的白灰占位时，要求 Klein 用明确目标材质完整替换 clay/primer/flat placeholder/untextured surface，真实浅色材质不受此规则影响。模板以 100–180 词、2–3 段英文为生成目标；段数、词数、语言和 Markdown 偏差只记脱敏告警，不阻断也不触发格式修正。若首段缺少明确 mask 范围，服务端确定性追加固定保护句。仅最终正文写入 Generation，诊断不持久化、不回填文本框；显式输入一次 Qwen，空输入诊断加转换两次，共用 65 秒 deadline。模板策略进入所有局部重绘指纹，升级后首次重新解析、后续继续复用 |
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

### 11.1.1 同源开发工作区资产兼容

远端 `e866612` 的资产修复仅适用于页面与 workspace API 同源且主机是 loopback 的隔离开发环境（4517）：已持久的 `/workspace` 资产直接复用，Blob 通过带认证的同源上传服务保存，不先尝试不存在的对象存储 upload-intent。普通生产 Cloud 继续走签名上传、ownership、checksum 与 verified assets；不得新增 localhost/4618 守护组件、安装器、凭证托管或端点切换。此修复让既有多视图结果保存/自动投影正常推进，不改变 Qwen 或 ModelView 输入契约。

### 11.2 单视图投影源、迁移与回退

- 面板返回图与投影源分离：面板可使用裁切显示副本；投影源必须保持捕获原尺寸，避免改变 projector UV。capture mask 是几何 footprint 权威，投影 PNG Alpha 只在 `projectionEdgeBlendMode=distance-field-v1` 时表达编辑器生成的轮廓过渡。
- 生成结果轮廓先依据 capture mask 从主体内部回拉 RGB，再把清理后的 RGB 向 mask 外扩散；外扩像素不会扩大几何覆盖。浏览器编码需要的非零外侧 Alpha 最终仍会乘独立 mask，因此不会投影到背景。
- 新建单视图检测同对象是否已有可见普通 projected/UV 底层。有底层时持久化 `ignoreSourceAlpha=false` 并使用距离场；无底层时 `ignoreSourceAlpha=true`，保持单层完整覆盖。旧图层缺少显式 false 时继续按旧逻辑读取，不批量改写 Project。
- 迁移：Project Command、Revision、ownership、Capture/Layer 字段和资产类别均不升级；旧项目直接兼容。要让已有单视图获得新轮廓过渡，需要重新生成或重新创建投影层。
- 回退：停止生成 `distance-field-v1` Alpha并恢复 `ignoreSourceAlpha=true` 即可；已保存 PNG、mask、depth 均仍为合法资产。不得删除用户历史图层或重写 Revision。

### 11.3 提示词智能润色 `ALG-GEN-005` v1.9.0

- UI 与触发：普通生成仍保留手动智能润色图标。局部生成有用户输入时直接进入 Klein 模板转换；留空（包括纯空白）先执行独立诊断，再转换。诊断限定蒙版内人工接缝、突兀色差、纹理断裂、重影、投影重复/拉伸/错位及已有文字的重复、扭曲、缺笔或错位。真实面板接缝、焊缝、开口、零件边界与正常明暗必须保留，不新增部件、改整体配色或重设几何；文字拼写只采用原图/对应参考中清楚可辨的证据，不猜测品牌。最终英文结果才写入 Generation.prompt 和既有 metadata，诊断句只作服务端中间值，用户文本框保持原文。
- 一句话诊断：第一阶段不发送 Klein 转换模板，只输出 4–120 字符、以“修复”开头的一句中文要求，例如“修复控制面板下方的接缝和色差”。允许逗号合并确定问题；禁止分析过程、标题、列表和 JSON。无明确缺陷时固定返回“未发现明确异常，保留现有外观。”。诊断使用 max_tokens=512、temperature=0.2；空值、多句、换行、超长、截断或 content_filter 回复直接阻断，不裁剪后继续。第二阶段将该句作为用户要求，沿用四图和 v1.7.0 转换模板，只扩写句中目标，不重新寻找问题；无缺陷句仅转换为保留原貌的要求。
- Qwen 视觉契约：两阶段均使用 Image 1 干净当前效果图、Image 2 完整选中多视图、第三张未外扩原始作者 mask，以及服务端从干净 Image 1 自动生成的第四张选区上下文裁切；只编码一次并复用。第四图按第三图包围盒定位，四周上下文为 `max(16, round(max(width,height)/32))px`，在 2048 输入上约 64px；它只放大 Image 1 的未修改真实画面，不是新参考视角，不能扩大编辑范围。Qwen 不接收 clay 白灰几何融合图，也不接收远端专用外扩/羽化 mask；原始 mask 与 Image 1 像素对齐，参考图不要求像素对齐。mask 白色只表达原始编辑区域。
- 编码与安全：Image 1 以 512px tile 组成真实 2K，保留材质、灯光、背景和网格，仅隐藏作者叠加层；Image 1 与第四张裁切进入 Qwen 前为 JPEG quality 95 / 4:4:4，原始 mask 为 quality 100 / 4:4:4，参考图为 quality 85 / 4:2:0，最长边均不超过 2048。浏览器只调用同源 Cookie API，仍只提交 `currentEffectImage/maskImage/referenceImage`；服务端不得在缺图时降级为文件名推断，并负责从已规范化的 Image 1 和 mask 派生第四图。API Key 只在 Node 控制面。
- 模板与输出：system content 使用经真实 Klein 工作流验证的通用 Qwen → Klein 模板。Qwen 必须先把原始 mask 的像素位置对应到 Image 1，确认真实被选部件，再从 Image 2 的完整/多视图中只取同一部件有证据的结构、配色、材质和功能边界，并转换到 Image 1 的相机、透视、轮廓、遮挡、光照与磨损。目标外观必须由 Image 2 对应部件、第四张干净局部和 Image 1 的 mask 外邻域共同锚定；若这些证据表明选区内纯白、浅灰或均匀光滑区域是未完成材质/几何占位，最终英文需先正面描述真实结构、底色、材质、粗糙度与旧化，再用一句明确约束完整替换 clay/primer/flat placeholder/untextured surface。真实浅色材质和金属高光不得因颜色被误删。修缝必须区分非物理纹理边缝与真实装配间隙、焊缝、开口、硬边和接触阴影；除非用户要求或图像证据明确支持，不得发明 brushed steel、clean metal、new weld bead、chamfer 或无缝铸造结构，也不得向最终 Klein 提示词输出像素坐标或包围盒。
- 输出与软校验：模板仍要求 100–180 个英文单词、2–3 段完整英文正文；首句先明确实际部件及目标动作/材质，随后限定只修改独立 mask 选区。段数、100–200 词观测范围、英文、Markdown、完整段落及首段 mask 表达只用于脱敏质量告警，不再拒绝非空正文，也不为表现格式发起第二次 Qwen 调用。服务端仍识别 `only ... mask`、`confine/restrict/limit ... within/to the mask` 或 mask 外保持 unchanged/protected/preserved 等等价表达；缺少明确范围时只在首段末尾确定性追加 `Confine all edits to the independent mask region and keep every area outside it unchanged.`，已有等价要求时不重复。只无损归一 2/3 个单行段落、CRLF 和连续编号，不截句、不删除意图。显式输入固定一次 Qwen 调用；空输入固定为一次诊断加一次转换。两阶段共用默认 65 秒 deadline。只有空正文、超过 12000 字符、上游 `finish_reason=length/content_filter`、图片格式、HTTP、认证、网络或超时错误阻断；日志只记录问题代码，不记录诊断、提示词正文、图片或凭据。
- 复用、并发与回退：前端用项目/对象/参考 ID、原始提示词、mask revision、冻结相机/对象矩阵和图层 content revision 构造指纹；先查内存六项 LRU，再查已持久化 Generation，命中时不再调用 Qwen。等待 Qwen 期间 mask revision 变化则阻断提交。回退可关闭生成时自动解析并恢复手动入口；既有 Project/Layer/Capture 与历史结果无需迁移或删除。
- 测试：`test:prompt-polish` 以模拟上游响应覆盖独立诊断模板、一句话验证、空串/纯空白两阶段、无缺陷保留、四图顺序、选区包围盒/裁切、超时复用、诊断异常阻断、显式输入跳过诊断、183/201 词、单段、混合语言和 Markdown 的单次软放行、mask 范围确定性补全/去重、空结果/截断/content_filter/超长硬阻断及日志脱敏；不代替真实模型效果验收。`test:local-repaint-generation-input`、`test:local-repaint-performance-merge`、`test:local-repaint-result-composite` 锁定 Qwen/ModelView 角色分离、Worker 外扩羽化和内部 prompt 复用。
- v1.4.1 影响与回退：仅调整 M04 控制面润色适配器和测试；GPU/CPU/Worker/shader、投影、导出、分辨率、作者/远端 mask、Project/Layer/Generation/Capture Schema 和 Revision 不变，无数据迁移。回退只恢复润色适配器，不删除历史提示词、图层或资产。
- v1.4.2 影响、复用与回退：UI-05 → M04 / `ALG-GEN-005` 仅在空输入时注入受限诊断规则；用户显式编辑和普通润色保持不变。空输入指纹增加 `autoDiagnosisPolicy=seam-local-artifacts-v1`，使旧内存/历史诊断提示词不再命中；显式输入指纹不变，不删除历史记录。三图、四段/130–220词校验、模型参数、GPU/CPU/Worker/shader、UV、导出、分辨率与原始/远端蒙版规则均不变。无 Schema、资产或 Project Revision 迁移；回退恢复旧空输入规则并移除指纹中的策略版本即可。回归覆盖空串/纯空白、真实接缝保护、保守保留、手动要求及缓存隔离。

- v1.5.0 影响、迁移与回退：仅 M04 / UI-05 控制面新增一句话诊断阶段，转换模型/参数/四段规则及普通润色不变。空输入指纹更新为 `autoDiagnosisPolicy=one-sentence-diagnosis-to-klein-v2`，旧缓存不命中但历史记录保留；显式输入指纹不变。诊断不新增 API 返回字段或持久化字段。GPU/CPU/Worker/shader、投影/UV/export、分辨率、作者/远端 mask、Schema、Project Command/Revision/ownership 和历史资产均不变，无数据迁移。回退恢复单次空输入模板和上一策略版本即可，不删除任何工程数据。

- v1.6.0 影响、迁移与回退：仅 M04 / UI-05 的 Qwen → Klein system content、最终格式校验/修正提示及局部提示词缓存指纹变化；普通单/多视图润色、空输入诊断规则、三图顺序与编码、ModelView 输入、作者/远端 mask、GPU/CPU/Worker/shader、投影/UV/export、分辨率、Schema、Project Command/Revision/ownership 和历史资产均不变。所有局部重绘指纹新增 `promptTemplatePolicy=qwen-to-klein-grounded-2to3-v3`，因此旧模板缓存仅在升级后首次失效，生成的新结果仍按相同指纹复用；无批量数据迁移或历史删除。回退时恢复 v1.5.0 模板、四段校验/修正提示并移除该策略字段即可，已有 Generation 和图层继续可读。

- v1.7.0 影响、迁移与回退：仅 M04 服务端新增由原始 mask 推导第四张干净选区裁切，UI-05 将所有局部指纹策略升级为 `qwen-to-klein-selection-crop-v4`。浏览器 API 请求结构、用户输入逻辑、ModelView 的“效果图与白灰几何预览融合图 + 外扩/羽化 mask”、作者 mask、GPU/CPU/Worker/shader、投影/UV/export、分辨率、Schema、Project Command/Revision/ownership 和历史资产均不变。旧模板缓存仅在升级后首次失效，无批量迁移或历史删除。回退时停止生成/发送第四图并恢复 v3 指纹即可，已有 Generation 和图层继续可读。

- v1.7.1 影响、迁移与回退：仅 M04 的最终提示词格式验收范围和 mask 范围语义正则变化；system 目标、诊断、四图、缓存指纹、ModelView、作者/远端 mask、GPU/CPU/Worker/shader、投影/UV/export、分辨率、Schema、Project Command/Revision/ownership 和历史资产均不变，无缓存失效或数据迁移。回退时恢复 180 词硬上限与旧 scope 正则即可。

- v1.7.2 影响、迁移与回退：仅 M04 在 Qwen 输出归一化后、格式校验前增加 mask 范围固定句补全；不改变 system 目标、诊断、四图、调用次数、缓存指纹、ModelView、作者/远端 mask、GPU/CPU/Worker/shader、投影/UV/export、分辨率、Schema、Project Command/Revision/ownership 或历史资产，无缓存失效和数据迁移。回退时移除 `ensureLocalRepaintMaskScope` 调用即可。

- v1.8.0 影响、迁移与回退：仅 M04 将最终提示词格式判断从阻断校验改为脱敏观测，并移除格式修正 Qwen 调用；独立 mask 范围确定性补全、system 生成目标、诊断、四图、缓存指纹、ModelView、作者/远端 mask、GPU/CPU/Worker/shader、投影/UV/export、分辨率、Schema、Project Command/Revision/ownership 和历史资产均不变，无缓存失效或数据迁移。回退时恢复格式失败分支和第二次 Qwen 请求即可。

- v1.9.0 影响、迁移与回退：仅 M04 的 Qwen → Klein system content 与 UI-05 的局部提示词缓存策略变化。策略指纹升级为 `qwen-to-klein-material-grounding-v5`，旧模板结果只在升级后首次失效，新的 Generation 仍按既有上下文指纹复用。诊断次数、四图、ModelView 效果/白灰几何融合图、作者/远端 mask、GPU/CPU/Worker/shader、投影/UV/export、分辨率、Schema、Project Command/Revision/ownership 和历史资产不变，无批量迁移。回退时恢复 v1.8.0 system content 和 v4 指纹即可，不删除任何提示词、Generation、图层或资产。

## 12. 状态、Revision 与并发

Project Revision 协议版本 1，ID 为 `revision-*`，number 从 1 连续增加，记录 parentRevisionId/savedAt。Project Command 协议版本 1，当前 kind 为 replace-project-document、rename-project、move-project。命令 ID 重放且 SHA 相同返回同一结果；同 ID 不同内容返回 `409 PROJECT_COMMAND_ID_REUSE_CONFLICT`；expected revision 不匹配返回 `409 PROJECT_REVISION_CONFLICT`。

Pipeline Revision 与 Project Revision 不同：前者记录 texture/retopology/uv/bake 业务产物来源和 stale overlay，追加后不可原位改写；后者是整个 Project 文档的存储并发版本。任何维护说明不得混称为“版本”。

## 13. 身份、安全、容量与性能

### 13.1 客户端性能录制 `ALG-PERF-SESSION-001` v1.0.0

A100 发布同时显式配置 `LICLICK_PERFORMANCE_LAB_ENABLED=true` 与构建变量 `VITE_LICLICK_PERFORMANCE_LAB_ENABLED=true` 后，`perfLab=1` 才按需加载云端记录桥；本地默认关闭且不生成/上传统计。既有“开始人工录制/结束并分析”状态从 `data-perf-manual-local-repaint-recording` 驱动一次完整会话。每次开始必须创建新的 `perf_<UUID>`，允许同一用户连续录制多次；结束后由 Worker 计算 SHA-256、写入 IndexedDB 待传队列并按 start → chunk → complete 顺序重试。采集不得写 Project/Scene/Layer Store，也不得触发 Project Command 或 Revision。

| 契约 | 当前版本/规则 |
| --- | --- |
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

### 13.2 当前用户莉刻账号绑定 `LICLICK-ACCOUNT-BINDING` v1.1.0

莉刻生图、编辑、轮询与通用提示词润色必须使用当前飞书 Session 用户独占的服务器端账号绑定。浏览器只通过同源、带 Cookie 的 Cloud API 发起绑定和查询状态；OAuth 临时状态、token 与 `atlas_home_dir` 只由 A100 控制面保管，禁止写入浏览器、Windows 本地组件或项目文档。

| 契约 | 当前版本/规则 |
| --- | --- |
| 身份来源 | 当前飞书 Session 的 `user_id` 与 email；绑定成功时 Atlas email 必须与飞书 email 完全一致，否则拒绝并清理临时凭据 |
| 凭据隔离 | 每个用户写入独立、服务器托管的 Atlas home，并只把该目录绑定到同一 `cloud_users.id`；不得使用共享 `ATLAS_TOKEN_FILE`、默认 home 或其他用户目录作为回退 |
| 强制门禁 | 生图、编辑、任务轮询和通用润色在未绑定时统一失败为 `409 LICLICK_PERSONAL_ACCOUNT_REQUIRED`；底层 Atlas 调用同时 fail-closed，防止绕过路由后落入共享凭据 |
| 任务所有权 | 只允许轮询当前 Session 用户已登记且携带同一用户个人 Atlas home 的任务；未知远端 task ID 固定返回 404，不得用当前或默认凭据探测 |
| 解绑 | 只清除当前用户数据库绑定及其受管目录，不退出飞书、不删除其他用户凭据、不触碰 Project/Layer/Capture/Generation 数据 |
| 浏览器拓扑 | 继续使用 browser zero-install + LI3D Cloud；禁止恢复 localhost/4618、安装器、端点切换或本地凭据托管 |

v1.1.0 将“登录 LI3D”与“关联当前用户莉刻账号”串为同一安全流程。飞书/IDaaS 完成身份校验后，服务端为当前用户启动 Atlas SkillHub 2.9.1 的 loopback-only `authenticate` bridge；浏览器只接收同源关联回调页面，回调中的身份令牌立即转交本机回环监听器，页面随后清除 URL fragment。Atlas 运行时负责加密 token cache 写入，LI3D 禁止自行落明文 token；写入完成后还必须通过 secure cache 读取、有效期检查、`gateway list-tools --service liclick` 可用性检查以及 Atlas email 与飞书 Session email 一致性检查，全部通过才绑定独立 `atlas_home_dir`。运行时缺少 `readCache` 或 `authenticate` 时固定返回 `ATLAS_RUNTIME_INCOMPATIBLE`，不得回退共享账号、默认 home 或手写明文缓存。失败、超时、身份不一致或回调任务不匹配时终止子进程并删除未绑定临时目录；既有合法个人绑定继续复用。该升级不改变 Project/Layer/Capture/Generation Schema、Revision、ownership、图层资产或莉刻任务格式，无数据迁移；回退只能关闭自动关联入口并要求用户重新授权，不得恢复共享凭据。

迁移策略为：既有用户若没有独立 `atlas_home_dir`，一律视为未绑定并由本人重新完成莉刻授权；不自动认领 A100 共享凭据，也不迁移历史共享账号任务。该变更不修改 Project Command、Revision CAS、Project/Layer/Capture/Generation Schema、对象 ownership 或已验证资产。发布后应从 A100 运行配置移除共享 `ATLAS_TOKEN_FILE` 并撤销旧共享 token；回滚不得恢复共享回退，只能临时关闭莉刻入口并保留用户绑定数据，待兼容版本恢复。

- 同源 Session Cookie；浏览器不保存长期对象存储密钥。
- 所有项目、Job、Asset 查询同时带 user_id 和资源 ID。
- OAuth state 使用数据库原子消费，拒绝重放。
- App 默认最多 256 在途请求；过载返回 503 + Retry-After。
- PostgreSQL 默认每副本 20 连接，副本数服从数据库预算。
- 大文件直传对象存储；GPU 任务进入独立集群队列，不占用 App Server GPU。
- Engine Session 管理项目级 CPU/GPU lane、任务取消和资源释放。
- 交互期间 Worker/GPU 重任务受 frame budget/heavy task scheduler 约束，但不得静默降低最终分辨率或关闭可见性检查。
- 性能实验室入口契约 `PERF-LAB-ENTRY/2.0.0`：项目贴图路由追加 `?perfLab=1` 时，只为当前真实项目打开性能 HUD、人工录制、帧时间与算法基准按钮。入口不得创建合成 Project、不得调用 `replaceCurrentProject`、不得写 Scene/Layer Store、不得改变活动对象或活动图层、不得触发项目保存；`perfScenario` 不再是编辑器路由契约。合成压力数据只能进入独立测试 Harness，且不得挂载真实项目持久化服务。投影预览失败保留上一份有效材质并写入 console；渐进预览按 `ALG-PROJ-007` v2.1.0 对相同签名执行有界退避恢复，禁止弹出用户 Toast 或无限自动重算。
- P0 数据安全门禁：任何调试、性能、演示或测试模块不得向真实 Project/Layer/Capture/Generation 持久化路径写入数据。回归测试必须静态断言编辑器不挂载场景替换加载器，并验证 `perfLab=1` 仅返回布尔诊断开关。若发生污染，先停自动保存、备份原文件，再依据 Generation.metadata.projectedLayerId、textureBatchId、Capture.camera 与本地资产重建，禁止直接删除整个项目。

## 14. 变更分级与修改上限

| 等级 | 示例 | 必须动作 |
| --- | --- | --- |
| Patch | UI 文案、错误呈现、无语义回归测试 | 模块测试 + typecheck |
| Minor | 新 Layer role、兼容参数、非默认算法能力 | ALG/Schema Minor、迁移与回退说明、对应矩阵测试 |
| Major | 投影矩阵、权重模型、深度编码、颜色空间、UV 合并语义、持久化契约 | ADR、显式批准、版本升级、旧工程迁移、CPU/GPU/Worker/export 全链验证 |

默认一次修复只跨一个大模块，不超过 5 个源码文件或 300 行净变化。跨两个以上大模块、修改投影/UV/局部重绘阈值、Project/Layer/Capture/Generation 契约、默认分辨率、目录移动或兼容删除，必须先提交证据化方案并获得批准。

## 15. 模块验收矩阵

| 模块 | 最低自动验证 |
| --- | --- |
| M01/M12/M14 | contracts、project pipeline persistence、revision conflict、Postgres Repository、asset transfer |
| M02/M03 | model import、FBX repair、placement/camera、capture 对照 |
| M04 | generation polling/conflict/auth continuation、单/多视图 |
| M05/M06 | projection layers、multi-model restore、眼睛、相机旋转、对象 transform 后对齐 |
| M07 | projection、UV merge、backpressure、CPU/GPU parity、export orientation |
| M08 | local repaint material reference、seam、ordered/inward composition、bake batching、layer retention |
| M09 | content-aware topology/repair、island 不串色、取消 |
| M10 | 真实 UV/retopology/Substance smoke、QA failure、artifact ownership、Bake alignment |
| M11 | GLB/FBX/OBJ/BaseColor 方向、重开与下载 |
| M13/M15 | cloud boundary、repository boundary、auth、scheduler、bundle budget、release readiness |

本基线合入验证：`pnpm --filter @liclick/web test:multi-model-restore-policy` 通过；contracts build 与 Web typecheck 通过。红色历史流水线状态不能以本地测试替代，推送后仍需核对 GitLab CI。

GitLab CI 依赖安装必须把 pnpm store 与 Prisma engine cache 放入 `$CI_PROJECT_DIR` 下的项目级缓存目录。Prisma engine 下载发生瞬时网络错误时，允许完整的 `pnpm install --frozen-lockfile` 最多重试 3 次并采用有界退避；禁止通过 `--ignore-scripts`、跳过 Prisma engine、放宽测试或使用未冻结 lockfile 伪造通过。此策略只提高 M15 发布验证的网络容错，不改变生产 Prisma schema、数据库协议、Project Command/Revision 或浏览器运行时。

M15 lint 发布修复（2026-08-31）：根工作区显式声明与锁文件一致的 `@eslint/js@9.39.4`，避免依赖提升差异导致 ESLint 配置加载失败。M04 / `ALG-GEN-005` 的提示词终端转义清理由 Node `stripVTControlCharacters` 实现，替代触发 `no-control-regex/no-useless-escape` 的手写正则；保留全部 lint 门禁。回归覆盖 ANSI 颜色、C1 CSI、OSC 标题/超链接清理，以及中文、标点、URL 与段落保留。诊断/转换模板和调用链、算法版本 v1.5.0、GPU/CPU/Worker/shader/UV/export、Schema 与资产均不变，无迁移。回退仅还原依赖声明、锁文件和清理实现，不修改密钥或工程数据。

M15 体积修复：锁定 `terser@5.51.2` 两轮安全压缩，保留日志和属性名；JS 总量实测 3,067,290 字节，原门禁不变。新增真实构建等价性回归；业务、算法、数据均不变，无迁移。回退仅恢复压缩配置和依赖，发布仍须全 CI 验证。

## 16. 固定审计卡格式

以后新增或修改算法必须记录：ALG ID、中英文名称、SemVer、状态（production/experimental/deprecated/disabled）、所有调用 UI/use case、输入、输出、单位、颜色空间、矩阵空间、常量、CPU/GPU/Worker/shader 对应实现、持久化字段、回退、迁移、测试、负责人和变更单。

回答维护问题的固定顺序：`UI ID → 大/小模块 → ALG ID/版本 → 输入 → 公式/阈值 → Layer 输出 → 资产/Project 输出 → 回退 → 测试`。例如“Ctrl+S 怎么保存”必须回答 Project Command、Revision、对象存储和 PostgreSQL，而不是只说“保存 JSON”。

## 17. 当前架构债务

| 优先级 | 债务 | 处理原则 |
| --- | --- | --- |
| P0 | 远端 main 含错误顺序的旧文档提交 | 由 Maintainer 受控重置为干净链；禁止把旧正文再合入 |
| P0 | `EditorPage.tsx`、`GeneratePanel.tsx` 仍承担大量编排 | 按用例迁入 application 层，不在拆分时改变算法 |
| P1 | 投影核心常量没有独立持久化版本 | 增加 projectionAlgorithmVersion 和旧工程策略 |
| P1 | 代码仍有 local-server/workspace 迁移期字段和错误文案 | 只做受控 schema/UI 清理，不得恢复本地组件拓扑 |
| P1 | 生产 UV/拓扑/Bake 尚需更多真实资产矩阵 | 失败门禁保持 fail-closed，模拟结果不得升级状态 |
| P2 | delete/duplicate 尚未统一为 Project Command | 先扩展契约和事务测试，再迁移调用者 |

## 18. 修订历史

| 版本 | 日期 | 基线 | 变更 |
| --- | --- | --- | --- |
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
| `2.5.0` | 2026-08-28 | `本次 ModelView 四输入提交` | `ALG-LR-002` v3.0.0：局部重绘对齐 `2026.08.28-cd48a78-truev3-gguf-mask-4input-rseed-r1`，输入改为 2K flat BaseColor 当前效果图、多视图材质参考、同尺寸 RGB mask 和可空提示词；Node 控制面 fail-closed 校验尺寸与红通道，远端 PNG 以 `direct-v1` 直出，不再执行新任务的浏览器校色融合。旧 v5-v14 读取兼容、单视图两图契约、capture/depth/allowed-mask 投影保护、图层/橡皮/保存与 Project Command/Revision/ownership 均不变，无数据迁移。 |
| `2.5.1` | 2026-08-28 | `本次重绘预览同步提交` | `ALG-LR-007` v2.0.3：生成面板“重绘效果图”在用户尚未应用画笔时继续显示远端候选整图；同 Generation 的局部重绘图层首次发布后，改为订阅该图层 image、实时/持久化 mask 和 contentRevision，并按与图层面板相同的 destination-in 语义显示实际覆盖区域。投影、UV、深度、保存、Layer/Generation Schema 与历史资产不变，无迁移。 |
| `2.5.2` | 2026-08-28 | `本次重绘显示职责修正提交` | 撤回 `2.5.1` 对生成面板的错误职责变更：“重绘效果图”恢复为始终显示当前 Generation 的完整远端返回图，不再订阅画笔图层或裁切为局部块；表面画笔 coverage 仍仅由 3D 视口实时 GPU overlay 与局部重绘图层预览呈现。未改动视口 overlay、投影、UV、深度、保存、Layer/Generation Schema 与历史资产，无迁移。 |
| `2.6.0` | 2026-08-28 | `fe39f74 + 本次智能润色提交` | 新增 `ALG-GEN-005` v1.0.0：UI-05 提示词窗口右上角增加单一智能润色图标；普通生成走保留原意/语言的通用 `data-analysis` A2A，局部重绘走 FLUX.2 Klein 四段英文专用模板并执行词数/格式 fail-closed 校验。同用户任务串行，前端对项目、页签和原文变化执行 stale-result 防覆盖，并支持恢复原文。润色只更新现有提示词文本和保存链路，不改变 Project/Layer/Generation/Capture Schema、Revision、资产、投影、UV、橡皮或历史工程，无数据迁移。 |
| `2.6.1` | 2026-08-29 | `本次多模态润色提交` | `ALG-GEN-005` v1.1.0：局部重绘智能润色冻结当前相机，提交 2K flat 当前效果图、同相机 RGB 白色蒙版和用户当前选中的完整参考图三个 A2A FilePart；服务端 fail-closed 校验三图、使用请求独占临时目录并全路径清理，禁止缺图时降级为文件名推断。晚到结果新增蒙版 revision 与精确参考图 ID 保护；普通润色、局部生图四输入、Project/Layer/Generation/Capture Schema、Revision、资产、投影、UV、橡皮与历史工程均不改变，无数据迁移。 |
| `2.6.2` | 2026-08-29 | `本次通用多模态润色修正提交` | `ALG-GEN-005` v1.2.0：修正 A2A 附件按位置解析导致 mask 被误识别为 Image 2 的根因，固定为 Image 1 当前干净视口效果图、Image 2 完整选中参考图、Image 3 白色蒙版；当前效果图改为保留材质/灯光/背景的视口捕获，参考图使用独立高质量预算。局部模板改为按用户要求和视觉证据通用判断编辑类型，仅在可辨时转写文字，不绑定具体物体、品牌或任务；三图必填、四段英文校验、临时目录清理、stale-result 保护及局部生图四输入均保持。无 Schema 或项目数据迁移。 |
| `2.6.3` | 2026-08-29 | `本次 Qwen3-VL 局部润色提交` | `ALG-GEN-005` v1.3.0：仅局部重绘智能润色改为 Node 后端直连公司 `qwen3-vl-plus` OpenAI-compatible 代理，以 system content 固化 FLUX.2 Klein 四段模板，并按当前效果图、完整参考图、无损白色蒙版顺序提交三张 `image_url`；返回仍为纯文本并继续执行 130–220 词 fail-closed 校验。普通单/多视图仍走莉刻 `data-analysis`，局部生图、Project/Layer/Generation/Capture Schema、Revision、资产、投影、UV 与历史工程不变；回退只需恢复局部润色适配器。 |
| `2.6.4` | 2026-08-29 | `本次 Qwen3-VL 视觉输入兼容修复` | `ALG-GEN-005` v1.3.1：对齐 Qwen 插件的视觉编码契约，局部重绘三图进入代理前统一转换为最长边 2048、JPEG quality 85，透明区域落黑；修复真实 4K WebP/无损 PNG 素材触发上游 400/413/415 后被压成通用不可用提示的问题，并为这些状态提供明确错误映射。三图语义顺序、system content、四段英文校验、单/多视图莉刻链路、局部生图、Project/Layer/Generation/Capture Schema、Revision、资产、投影、UV 与历史工程均不变，无数据迁移。 |
| `2.6.5` | 2026-08-29 | `本次当前视角效果图质量修复` | `ALG-GEN-005` v1.3.2：修复 Image 1 当前视角效果图原先按 512px 渲染后放大到 2048px造成的模糊，改为真实 2K、512px 分块采集；仅该图在 Qwen 边界提升到 JPEG quality 95 / 4:4:4，参考图和蒙版维持 quality 85 / 4:2:0。单/多视图、三图顺序、模板、局部生图输出、Project/Layer/Generation/Capture Schema、Revision、资产、投影、UV 与历史工程均不变，无数据迁移。 |
| `2.7.0` | 2026-08-29 | `本次局部重绘自动解析与远端输入融合提交` | `ALG-GEN-005` v1.4.0 / `ALG-LR-002` v3.1.0 / `ALG-LR-012` v1.0.0：局部生成时自动调用 Qwen，有用户文字则优化，留空则先分析原始 mask 区域问题；结果只进入 Generation 不回填文本框，上下文未变时复用。Qwen 仅看干净效果图、完整多视图和未外扩 mask；ModelView 改收效果/蒙版内 clay 白灰几何融合图与 8–24px@2K 自适应外扩、4–10px 羽化 mask。原始作者 mask 和远端 mask 分离持久；返图直出、capture/depth 回贴保护、Project Command/Revision 与历史资产兼容不变，无数据迁移。 |
| `2.7.1` | 2026-08-29 | `本次远端蒙版外扩加倍提交` | `ALG-LR-012` v1.0.1：仅将 ModelView 使用的远端 mask 自适应外扩从 8–24px@2K 加倍为 16–48px@2K，羽化继续为 4–10px，原始核心继续强制 255；Qwen 仍使用未外扩作者 mask，融合图、提示词解析、返图直出、capture/depth 回贴保护及历史资产兼容均不变，无数据迁移。 |
| `2.7.2` | 2026-08-29 | `本次局部重绘画笔授权修复提交` | `ALG-LR-012` v1.0.2：修复远端生成后只出现“局部替换”图层但模型笔画无效的问题；远端 16–48px 外扩 mask 仅用于 ModelView，Capture、Generation `maskUrl`、画笔与恢复改绑未外扩作者 mask，外扩版本独立存入 `submittedMaskUrl`。已生成双蒙版任务优先读取 `authoredMaskUrl`，无需重新生图；Qwen、融合图、返图直出、深度保护和历史资产格式不变，无批量迁移。 |
| `2.8.0` | 2026-08-31 | `66bab93 + origin/master 8ac0379` | 合入远端 7 个优化提交，保留 AGENTS.md：`ALG-ERASE-001` v1.2.0 的 48ms 提交/切层交接、显隐权威状态与清理蒙版；`ALG-PROJ-007` v2.1.0 的 PBO 修复、活动对象预热和有界预览重试；`SAVE-SCHEDULER` v1.1.0 的最新快照队列、资产缓存及后台开发备份；同源 loopback 开发资产上传修复。Qwen、16-48px 外扩、作者/远端蒙版分离与画笔恢复保持本地契约，Project/Layer/Revision/ownership/输出分辨率无变化或迁移。 |
| `2.8.1` | 2026-08-31 | `本次局部润色格式修复提交` | `ALG-GEN-005` v1.4.1：修复“智能润色返回的格式不符合要求”阻断局部生成；无损兼容四段单换行/编号，停止删句压缩。异常回复在原超时内带三图修正一次，保持四段/130–220词强校验。真实 Qwen 复现中英混写及超长，并验证修正成功；回归覆盖成功、失败和超时边界。仅控制面改动，无 Schema 或资产迁移；回退润色适配器即可。 |
| `2.8.2` | 2026-08-31 | `本次连续重绘驻留交接修复` | `ALG-LR-007` v2.0.4 / `ALG-LR-008` v2.2.1：已发布重绘行按 LayerStore 判定驻留，移除蒙版工具选中态造成的后台饥饿；新 source 或清空 source 前保留旧 overlay，等待背景实际绑定后交接，逐帧取消及 10 秒超时保留显示。异步发布读取最新所有者。新增回归，不改变生成输入、投影/UV/shader/颜色/分辨率或持久化，无迁移；真实工程帧率待用户登录后验证。 |
| `2.8.3` | 2026-08-31 | `本次局部重绘页签文案调整` | M04 / UI-05：将“重绘效果图”页签统一命名为“局部重绘”，同步结果提示及空态文案；内部 repaint 标识、生成与预览逻辑不变。无算法或 Schema 版本变化、无迁移；回退仅恢复界面文案。 |
| `2.8.4` | 2026-08-31 | `本次局部重绘空输入诊断范围收窄` | `ALG-GEN-005` v1.4.2：仅空输入自动诊断收窄至人工接缝和投影引起的局部异常；保留真实结构、有效内容及不确定区域，不主动补字、增件或重设计。空输入缓存增加策略版本以避开旧诊断结果，显式要求与普通润色不变；三图、生成、蒙版、GPU/CPU/Worker/shader/UV/export、Schema、Revision 和历史资产均不变，无迁移。 |
| `2.9.0` | 2026-08-31 | `2009a6c + 本次一句话诊断与转换分离` | `ALG-GEN-005` v1.5.0：空输入先由 Qwen 输出一句中文修复要求，再以该句调用 Klein 四段英文转换模板；覆盖有证据的接缝、色差、投影和已有文字异常，转换不新增目标。显式输入跳过诊断，全流程共享 65 秒，最终格式最多修正一次；空输入缓存策略升级，诊断不持久化。三图/生成/蒙版/GPU/CPU/Worker/shader/UV/export、Schema 和历史资产不变，无迁移；模拟回归验证，不启动服务或调用真实生图。 |
| `2.9.1` | 2026-08-31 | `13d4321 + 本次 lint 修复` | M15 发布修复：显式补齐 `@eslint/js` 依赖；M04 提示词 ANSI 清理改用 Node 内置实现并补充回归，修复 CI 正则规则错误。全部质量门禁保留，`ALG-GEN-005` v1.5.0 与业务/Schema/资产契约不变，无迁移。 |
| `2.9.2` | 2026-08-31 | `707f009a + 本次构建体积修复` | M15：锁定 Terser 生产安全压缩，保留诊断和属性名，新增真实构建等价性回归。编辑器与 JS 总量回到原有体积上限内；不提高门禁，不删除功能，不改变业务算法、Schema 或资产，无迁移。 |
| `2.10.0` | 2026-08-31 | `add3b82 + 本次橡皮历史事务修复` | UI-06/UI-10、M12、`ALG-ERASE-001` v1.3.0：抬笔预登记历史，撤回等待手势与提交；即时同步持久瓦片和 GPU live mask；细化逐笔重放并原子发布，redo 检查点不串笔。增加真实回调/数值时序回归。原输出分辨率、覆盖公式和资产/Project Schema 不变，无迁移。 |
| `2.10.1` | 2026-09-01 | `本次视角选择工具提交` | UI-06/UI-10、M08、`ALG-LR-007` v2.0.5：贴图底部工具条新增选择/旋转视角按钮；点击退出画笔并隐藏蒙版展示，拖拽恢复 OrbitControls；返回蒙版画笔自动恢复展示。作者蒙版、历史、生成输入、GPU/CPU/Worker/shader/UV/export、Project/Layer/Generation/Capture Schema、Revision 与资产不变，无迁移。 |
| `2.10.2` | 2026-09-01 | `本次驻留工作区 Portal 门禁提交` | UI-05/UI-13、M04：UV 路由保留贴图编辑器状态时，将 `isActive` 传入生成面板并门禁其全部根节点 Portal，移除 UV 页泄漏的“局部生图”固定按钮及相关弹层；返回贴图页后原状态恢复。生成算法、蒙版、任务、GPU/CPU/Worker/shader、Schema、资产与 Revision 不变，无迁移。 |
| `2.10.3` | 2026-09-01 | `本次导出能力状态样式提交` | UI-03、M11：导出菜单移除支持项勾选和不支持项叉号；不可用格式继续保留并以灰色禁用文字及原因提示表达，支持格式维持普通可点击文字。`ALG-OUT-001`、导出格式、UV 合并、文件内容、Schema、资产与 Revision 不变，无迁移。 |
| `2.10.4` | 2026-09-01 | `本次 UV 到烘焙资产角色修复` | UI-13/UI-14、M10：UV 发布与历史交接只自动填充低模，烘焙页不再把 UV 输入或 Pipeline 来源高模自动导入；高模保持空白并由用户选择，选择后复用低模 Bake Set ID 自动配对。旧 Pipeline 自动高模快照只在读取时忽略，不删除资产；显式 Bake 高模继续恢复。Pipeline/Bake Workspace Schema、Revision 与烘焙算法不变，无批量迁移。 |
| `2.10.5` | 2026-09-01 | `本次 Qwen → Klein 模板替换` | M04/UI-05、`ALG-GEN-005` v1.6.0：局部重绘转换模板改为先按 mask 定位真实部件、再用 Image 2 对应视角交叉核对并适配 Image 1；输出改为 100–180 词、2–3 段英文，取消固定开头和四段堆叠。同步更新 fail-closed 校验、一次格式修正及所有局部缓存指纹。空输入诊断、三图输入、ModelView、蒙版、投影/UV、Schema、Revision 和资产不变，无迁移。 |
| `2.10.6` | 2026-09-01 | `本次远端蒙版融合范围调整` | M08/UI-05、`ALG-LR-012` v1.0.3：仅将 ModelView 专用远端 mask 自适应外扩从 16–48px/短边20%提高为 24–64px/短边25%@2K，羽化仍为4–10px且原始核心保持255；Qwen、Capture、Generation、局部重绘画笔及历史恢复继续绑定未外扩作者 mask。返图直出、投影/UV、Schema、Revision和已有资产不变，无迁移；回退仅恢复 Worker 参数。 |
| `2.10.7` | 2026-09-01 | `6382583 + 本次 Qwen 选区原图上下文裁切` | M04/UI-05、`ALG-GEN-005` v1.7.0：服务端按未外扩原始 mask 包围盒从干净 Image 1 派生第四张上下文裁切，2K 默认约保留 64px，用于诊断、转换和一次格式修正时辨认真实选中部件。浏览器仍提交原三图，第四图不改变编辑范围、ModelView 输入或远端 mask；缓存策略升级为 `qwen-to-klein-selection-crop-v4`。Schema、Revision、资产及历史工程不变，无迁移；回退移除第四图并恢复 v3 指纹即可。 |
| `2.10.8` | 2026-09-01 | `6dd8667 + 本次局部重绘提示词格式容错修复` | M04、`ALG-GEN-005` v1.7.1：模板仍要求 100–180 词，服务端最终验收上限调整为 200 词，修复格式修正结果为 183 词时的误拒绝；新增 confine/restrict/limit 及 mask 外保持不变等明确范围表达识别，201 词及以上继续 fail-closed。诊断、四图、缓存、ModelView、mask、Schema、Revision 和资产不变，无迁移；回退恢复旧上限与正则即可。 |
| `2.10.9` | 2026-09-01 | `bb9e50a + 本次局部重绘蒙版范围确定性补全` | M04、`ALG-GEN-005` v1.7.2：Qwen 输出归一化后若首段缺少明确 mask 范围，服务端确定性追加固定保护句再执行完整格式校验，修复第二轮只剩 `masked_scope` 时的误失败；已有等价范围不重复。诊断、四图、缓存、ModelView、作者/远端 mask、Schema、Revision 和资产不变，无迁移；回退移除补全函数即可。 |
| `2.11.0` | 2026-09-01 | `bb9e50a + 本次局部重绘提示词软校验` | M04、`ALG-GEN-005` v1.8.0：模板格式约束改为脱敏质量告警，不再因段数、词数、语言、Markdown 或范围措辞拒绝非空正文，也不再二次调用 Qwen 修格式；mask 范围固定句仍确定性补齐。仅空结果、12000 字符上限、上游截断/content_filter、视觉输入和传输类错误阻断。四图、诊断、缓存、ModelView、mask、Schema、Revision 和资产不变，无迁移。 |
| `2.12.0` | 2026-09-01 | `4cbce31 + 本次局部重绘核心蒙版清理` | M08/UI-05、`ALG-LR-012` v1.1.0：ModelView 白灰几何融合不再直接混合细碎的原始抗锯齿 mask；Worker 新增 24/96 双阈值连通、2–6px@2K 闭运算、微小孤岛过滤、小孔填充及窄边羽化，并从清理后核生成既有 24–64px/4–10px 外扩羽化远端 mask。原始作者 mask 仍独立用于 Qwen、Capture、Generation、画笔、历史和回贴；GPU/shader/UV/export、Schema、Revision 与资产不变，无迁移。 |
| `2.13.0` | 2026-09-01 | `本次 Qwen → Klein 材质证据锚定提交` | M04/UI-05、`ALG-GEN-005` v1.9.0：通用模板改为先以 Image 2 对应部件、第四张干净选区裁切和 mask 外邻域共同确定真实结构与材质；仅在视觉证据证明白灰均匀表面为未完成占位时，要求 Klein 用明确目标材质完整替换 clay/primer/flat placeholder/untextured surface，同时保护真实浅色材质。禁止仅凭“修缝”发明拉丝钢、干净焊缝、倒角或无缝铸造，并禁止输出像素坐标；缓存策略升级为 v5。四图、诊断、ModelView 输入、mask、GPU/CPU/Worker/shader/UV/export、Schema、Revision 和资产不变，无迁移。 |
| `2.13.1` | 2026-09-01 | `1063a6c + 312e236 集成提交及后续省略式删除修复` | M13/M04、`LICLICK-ACCOUNT-BINDING` v1.0.0、`ALG-GEN-005` v1.9.2：合入当前飞书用户独立莉刻账号绑定，生图、编辑、轮询与通用润色使用用户独占 Atlas home 并 fail-closed；未知远端任务禁止探测。同时将“没有文字/不要文字”等确定识别为蒙版内无文字约束，并将“去除，保留某材质”等省略删除对象的表达解释为“蒙版内容即删除目标”；清除 Qwen 的保留/重建文字冲突句，禁止把选区误认成控制面板、标签或零件，也禁止从材质参考复制文字、数字、Logo、标签及伪文字，缓存策略升级为 v7。Project/Layer/Capture/Generation Schema、Revision、ownership 与资产不迁移。 |
| `2.13.2` | 2026-09-01 | `本次连续重绘单击接管修复` | UI-05/UI-10、M08、`ALG-LR-007` v2.0.6 / `ALG-LR-008` v2.2.2：生图成功记录一次性 pending Generation 并以 success revision 触发后台解码、目标层绑定和 GPU 预热；只有该新结果可以从上一代驻留 source 一次性接管，使第二次及后续生图的应用画笔首次点击即可直接绘制，同时保留历史结果编辑保护。GPU/CPU/Worker/shader、投影/UV/颜色公式、分辨率、Schema、Revision 与资产不变，无迁移。 |
| `2.13.3` | 2026-09-01 | `本次局部重绘即时点击排队与进度反馈修复` | UI-10、M08、`ALG-LR-007` v2.0.7 / `ALG-LR-008` v2.2.3：修复生图完成瞬间首次点击被工具条残余任务锁吞掉的问题；首次点击在成功回调、任务解锁与 Generation store ready 的短窗口内登记一次性内存请求，按钮立即显示旋转图标和流动进度条，结果就绪后自动进入画笔，无需第二次点击。其他互斥操作仍 fail-closed；失败、切工程/模型或新生成会清除请求。GPU/CPU/Worker/shader、投影/UV/颜色公式、分辨率、Schema、Revision、ownership 与资产不变，无迁移。 |
| `2.13.4` | 2026-09-01 | `本次局部重绘画笔视口反馈修复` | UI-06、M08、`ALG-LR-007` v2.0.8：修复有序投影栈接管活动局部重绘时，专用 overlay 与同 ID resident binding 被同时静音，造成画笔已更新右侧图层但视口无反馈的问题；显示权改为互斥兜底，ordered stack 接管时保留 resident binding，可见 overlay 接管时才静音 persisted twin。投影/coverage/颜色与分辨率、CPU/Worker/shader/UV/export、Schema、Revision、ownership 和资产不变，无迁移。 |
| `2.13.5` | 2026-09-01 | `本次局部重绘实时画笔反馈修复` | UI-06、M08、`ALG-LR-007` v2.0.9：修复持久层虽然可见，但 ordered projected stack 仍只读取上一次打包 mask，导致画笔实时 canvas 更新必须刷新后才显示的问题；应用画笔激活期间由专用 GPU overlay 临时接管，并同步静音 resident twin，离开工具或恢复后仍按原图层顺序显示。投影/coverage/颜色与分辨率、CPU/Worker/shader/UV/export、Schema、Revision、ownership 和资产不变，无迁移。 |
| `2.13.6` | 2026-09-01 | `本次局部重绘双阶段预览与当前层交接修复` | UI-06、M08、`ALG-LR-007` v2.1.0：修复当前局部重绘层二次进入画笔时先被静音、复杂实时 overlay 无输出导致旧笔画和新笔画同时消失，以及等待后仍需手动开关预览的问题。新增 renderer-only 简化 source+live-mask mesh preview 立即反馈；只有其实际可见时才静音当前同 ID persisted twin，其他重绘层不受影响；projected `contentRevision` 自动触发正式材质重建，离开画笔且确认正式层驻留后自动交接。最终 depth/surface-lock、coverage、颜色、1024 live 上限、UV/export、Schema、Revision、ownership 和资产不变，无迁移。 |
| `2.13.7` | 2026-09-01 | `本次局部重绘正式材质实时蒙版修复` | UI-06、M08/M06、`ALG-LR-007` v2.1.1：删除会与正式图层争夺显示权且缺少 depth/normal 的快速 duplicate mesh；已有局部重绘层始终保留在原 ordered projected material，以 projection-space live sampler 只替换当前 layerId 的 authored mask，使旧笔画与新笔画立即同屏反馈，同时继续使用正式 source、capture depth、surface-lock、图层顺序与颜色。无持久行的新结果仍用 depth-aware exact overlay，发布后自动交接；SceneRoot 晚到 marker 不再误静音正式层。CPU/Worker/UV/export、1024 live 上限、最终分辨率、Schema、Revision、ownership 与资产不变，无迁移。 |
| `2.13.8` | 2026-09-01 | `本次局部重绘首笔原子交接修复` | UI-06、M08/M06、`ALG-LR-007` v2.1.2：持久蒙版 URL/sampler 切换提前到画笔预热进度阶段，pointer-up 不再递增 projected 结构 `contentRevision`；新行 exact overlay 保留到 SceneRoot 最终材质驻留、live override 绑定并完整呈现一帧后，再通过两帧屏障原子撤下。修复首笔结束后短暂消失并伴随整栈重建卡顿的问题。项目保存继续把 live raw/blend mask 按 revision 持久化；CPU/Worker/shader coverage、depth/surface-lock、UV/export、最终分辨率、Schema、Project Revision、ownership 与资产类别不变，旧工程惰性提升，无批量迁移。 |
| `2.13.9` | 2026-09-01 | `本次飞书登录安全关联莉刻账号修复` | M13、`LICLICK-ACCOUNT-BINDING` v1.1.0：飞书/IDaaS 登录成功后自动进入同源莉刻账号关联，服务端通过 Atlas SkillHub 2.9.1 loopback-only `authenticate` bridge 转交回调令牌并由运行时写入加密缓存；绑定前强制校验 secure cache、有效期、莉刻网关工具、Atlas/飞书 email 一致性与 OAuth 任务归属。禁止 LI3D 写明文 token，运行时不兼容、失败或超时时 fail-closed 并清理临时目录，不回退共享账号。Project/Layer/Capture/Generation Schema、Revision、ownership 与资产不变，无迁移。 |
| `2.13.10` | 2026-09-02 | `本次局部重绘画笔激活转圈自愈修复` | UI-10、M08、`ALG-LR-008` v2.2.4：将画笔排队从 boolean 改为 Generation/目标层级内存请求，过渡期在生成回调时绑定确切结果，旧 GPU 事件不再误解锁；预载、后台预热和点击共用 preferred/时间排序的确定性 Generation 选择。预热取消/跳过会结束 stage；生图结束解锁后 8 秒 watchdog 会按 GPU-ready 标记自愈重放，否则释放转圈并提示重试。已有局部重绘图层和显示权持续保留；GPU/CPU/Worker/shader、投影/UV/export、分辨率、Schema、Revision、ownership 与资产不变，无迁移。 |
| `2.13.11` | 2026-09-02 | `本次局部重绘 GPU 加载链路修复` | UI-10、M08、`ALG-LR-008` v2.2.5：移除 8 秒 watchdog，修复刷新/连续生成后最新 source 与旧 GPU-ready 分离的根因。被动恢复的 `autoActivate=false` source 允许最新 Generation 接管；source 已匹配但 renderer 未 ready 时，通过内存 prepare revision 显式重跑解码、蒙版、GPU 纹理和目标层绑定，并由精确 ready/failed 事件结束等待。真实工程刷新后最新 Generation 与 GPU-ready 一致，驻留点击约 7.1ms；历史局部重绘图层和显示权持续保留。shader、CPU/Worker 算法、投影/UV/export、分辨率、Schema、Revision、ownership 与资产不变，无迁移。 |
| `2.13.12` | 2026-09-02 | `本次局部重绘实时显示权修复` | UI-06、M08、`ALG-LR-007` v2.1.3：应用画笔激活时由 depth-aware exact GPU overlay 独占当前编辑层显示，已持久 resident twin 保持驻留但临时静音；退出后经原子呈现屏障交回 resident row。修复 live canvas 和图层缩略图已更新但视口仍显示旧 mask 的冲突，其他历史局部重绘层保持显示。投影/颜色公式、作者 mask、CPU/Worker/shader/UV/export、分辨率、Schema、Revision、ownership 与资产不变，无迁移。 |
