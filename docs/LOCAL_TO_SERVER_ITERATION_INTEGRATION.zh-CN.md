# Li3D 8 月 19 日至 20 日优化内容与服务器版本对接方案

> 文档主体：说明从 2026-08-19 到 2026-08-20 本地版本完成了哪些优化，以及如何将这些优化接入 `D:\Li3D`，同时不改变服务器现有登录、账号和莉刻生图逻辑。

## A. 本轮迭代成果总览

本轮迭代主要围绕纹理工作流的速度、稳定性和局部重绘质量展开。与 8 月 19 日开始时相比，当前本地版本重点改善了以下问题：

| 方向 | 优化前的主要问题 | 当前优化结果 |
| --- | --- | --- |
| 内容识别填补 | 处理耗时长，个别结果刷新或切换后丢失 | 增加投影烘焙缓存、异步编码与预览缓存，修复填补结果丢失 |
| 局部重绘性能 | 首笔、蒙版准备、图层增多后的投影与烘焙容易卡顿 | 蒙版准备和图像处理移入 Worker，增加批量烘焙及帧预算调度 |
| 局部重绘稳定性 | 刷新、切层、再次生图时旧图层可能暂时消失或覆盖不完整 | 稳定图层预览权威，保留历史重绘显示，修复覆盖不完整和白膜消失 |
| 投影质量 | 边缘梳齿、暗部被误抠、局部内容投到模型背面 | 修复边缘采样和暗部误抠；当前工作区已增加前表面深度限制，阻止穿透 |
| 生成任务 | 远端未接单时前端可能一直显示运行，停止弹窗和恢复状态不准确 | 修复任务卡死、停止状态、刷新恢复、重复提交和项目任务归属处理 |
| 编辑器交互 | 生图时操作锁过严，视角方块左右方向不符合用户视角 | 优化任务期间交互范围，修正 ViewCube 方向和用户视角左右语义 |
| 引导与生成输入 | 新手引导缺少重新选择多视图的说明；GPT 返回图可能与白模位置不齐 | 新增多视图重试引导；使用更短、更严格的像素配准提示词 |

## B. 2026-08-19 已完成优化

### B.1 纹理工作流与 GPU 绘制交互

对应提交：`4876a493561be9b166ac72e6c5afa5f7a6b8845f`

- 重构重任务调度，降低生成、捕获和烘焙时对主线程交互的阻塞。
- 优化 GPU UV 烘焙、视图捕获和 PNG 编码流程。
- 增加白膜材质，准备多视图快照时保持模型白膜稳定显示。
- 优化模型导入进度、项目默认命名和预览纹理缓存。
- 调整编辑器交互状态，减少生成过程中无必要的全局锁定。

### B.2 局部重绘捕获、蒙版与预览修复

对应提交：`d45764a32ec5021872e81ff9fec1f7a8a70cb1d7`

- 将局部重绘蒙版准备拆到 Worker，降低画笔和生成准备阶段卡顿。
- 修复捕获、遮罩、投影材质和实时投影画布之间的状态同步。
- 优化局部重绘结果预览，减少切换或重载后的显示异常。
- 修正 ViewCube、视口交互和预览纹理缓存相关问题。

### B.3 内容识别填补速度优化

对应提交：`553348f2d1bd1621d471a6320550080f347ec4b2`，同轮同步提交：`589fe107114149ab7a244b4fc2391e6da21ef217`

- 增加内容填补投影烘焙缓存，避免相同投影数据重复计算。
- 优化可见表面完成策略，只处理实际需要补齐的区域。
- 优化预览纹理缓存，降低图层刷新和重复加载成本。
- 将 PNG 编码和像素处理进一步移入 Worker。
- 使用浏览器调度工具分片处理重任务，减少长时间占用主线程。

### B.4 贴图工作流和编辑器交互

对应提交：`5197929310c7d8a159586e6411d64955066e4c94`

- 优化生成面板、图层面板、多视图参考选择和底部工具栏流程。
- 增加橡皮擦性能监控工具，用于记录实际操作卡顿。
- 优化自动烘焙进度显示和投影图层预览。
- 调整局部重绘参数、对话框和工作区交互。
- 多视角快照准备阶段减少模型与背景反复闪烁。

### B.5 白膜、重绘覆盖和任务状态修复

对应提交：

- `6f7c38d945ba59fd9e18a5485d9f95ff8b56ece1`：修复准备与生成过程中白膜消失。
- `28b3473c91478524829e71f75dda70e32a0c4e97`：修复局部重绘结果覆盖不完整。
- `7568a5ad629b1fc054f42cba00d53d142f4ffa5b`：修复局部任务卡死和停止弹窗状态。

实际改善：

- 生成过程中模型白膜保持可见。
- 局部重绘结果不再因边缘处理只显示部分区域。
- 远端未接取、任务失败或停止后，前端能退出错误的“任务正在运行”状态。
- 生成任务身份、项目归属和轮询状态更加稳定。

### B.6 橡皮擦、持久化与视角方向

对应提交：`8465e10508a589b8e2ea3a363fd5210f317c688d`

- 修复多个局部重绘图层之间橡皮擦只作用于最新图层的问题。
- 修复刷新或退出项目后，橡皮擦误删整个图层及预览恢复异常。
- 完善局部重绘图层持久化，保留投影和图层状态。
- 修正右上角 ViewCube 方向，左右以用户观察视角为准。
- 增加视角方向自动化测试。

说明：后续考虑到当前橡皮擦稳定性和开放风险，界面入口已暂时隐藏；底层历史修复代码仍保留，待完整回归后再开放。

## C. 2026-08-20 已完成优化

### C.1 内容填补结果丢失修复

对应提交：`b4606e883669cad5f43f67d14ef041c1ecb669c7`

- 修复内容识别填补图层在刷新、预览纹理切换或缓存重建后丢失的问题。
- 调整投影图层可见性和预览纹理缓存的生命周期。
- 保持内容填补结果在项目恢复后的显示一致性。

### C.2 帧预算与复杂模型性能优化

对应提交：`82dc9b53a298337363620d2b8ee7710f347ec4b2`

- 增加帧预算调度器，在保证视口响应的前提下执行后台重任务。
- 优化大型 FBX 的兼容修复和模型加载路径。
- 优化预览纹理缓存和 SceneRoot 更新频率。
- 完善性能实验室指标与时间线，便于定位第一笔绘制和图层切换卡顿。

### C.3 局部重绘与生成任务流程

对应提交：`4af2bb5d54447ac1e008763c0c2c7c420f0bfff7`

- 优化局部重绘捕获、结果预览和 GPU 覆盖同步。
- 增加投影预览图层权威状态，避免材质、预览和持久化图层互相覆盖。
- 修复项目路由重新进入时的加载与生成状态恢复。
- 优化对象面板统计信息弹窗，避免长路径撑宽和 UI 拉伸。
- 放宽生成过程中的普通编辑限制，同时继续锁定会破坏任务输入的局部生图与内容填补操作。

### C.4 边缘融合实验与橡皮擦入口隐藏

对应提交：`0483ee7436cc7ab36d61a514d885c27c672e100f`

- 增加局部重绘边缘融合框架、Worker 和兼容模式。
- 尝试仅在边界带处理接缝，保留内部生成结果。
- 保留旧版处理路径，允许在增强方案异常时回退。
- 暂时隐藏橡皮擦工具入口，不对普通用户开放。

最终状态说明：增强融合经过验证后发现部分复杂纹理会出现中心残余和整体发糊，当前默认行为已经回退到兼容路径；实验代码保留用于后续继续优化，但不作为本轮上线默认效果。

### C.5 项目缩略图和历史重绘显示

对应提交：

- `fdfe987b028b7d59075c21a386857472137d2600`：修复非 PBR 显示模式下项目缩略图缺失。
- `542d37a423cedad38b31057961c115896aed07b6`：新一轮局部生图期间，保持上一轮局部重绘图层可见。

实际改善：

- 平面、法线等非 PBR 视图不再导致项目卡片缩略图空白。
- 点击第二次局部生图时，历史局部重绘不会在任务期间暂时消失。
- 生成结束前后图层显示保持连续，减少用户误判图层丢失。

### C.6 投影边缘和图层切换稳定性

对应提交：`546dae7dcb5f17c288644290a8d1267566e06102`

- 修复投影边缘梳齿和黑边问题。
- 稳定材质切换、眼睛开关和图层重新激活后的显示。
- 调整投影材质、预览合成器和烘焙采样的一致性。
- 补充投影图层可见性与深度约束测试。

### C.7 局部重绘投影融合与批量烘焙

对应提交：`f979c7b7b6fafb0c8e1050452c279b99c22c0991`

- 将多个局部重绘投影按批次处理，减少“每个图层、每个面逐个重复烘焙”的开销。
- 优化 GPU UV 烘焙器、质量融合 Worker 和投影叠加合成。
- 优化图层较多时的自动烘焙速度和进度更新。
- 保持边缘融合仅作用于边界带，避免整块图层透明度羽化。

### C.8 暗部误抠修复与默认融合回退

对应提交：`a276e6c9fbd55489aff921ea6afe57a727ff29f3`

- 停止在纹理上贴阶段根据深色连通区域进行二次抠图。
- 修复黑色、深灰色金属或阴影区域被错误转成透明的问题。
- 保留生成结果的原始纹理内容，只使用必要的投影范围限制。
- 将容易产生中心残余的增强融合从默认路径回退，保持可随时恢复的兼容实现。

## D. 当前工作区尚未提交的最后优化

以下内容已经在 `D:\Li3D-1` 实现并通过当前工作区验证，但尚未形成提交；服务器对接时需要一并纳入，并单独形成提交，便于回退。

### D.1 阻止局部重绘穿透模型

涉及文件：

```text
apps/web/src/engine/viewport/SceneRoot.tsx
apps/web/src/engine/viewport/ViewportCanvas.tsx
apps/web/src/engine/bake/bakeProjectedLayerToTexture.ts
apps/web/scripts/test-projected-layer-visibility.mjs
```

优化内容：

- 局部重绘继续忽略生成图源 Alpha，避免暗部或透明信息再次抠掉纹理。
- 同时保留捕获深度作为前表面约束，避免画笔投影到模型背面。
- 实时预览、持久化图层和最终烘焙统一使用同一深度规则。
- 法线限制仍不用于局部重绘，避免内陷、曲面和低模区域出现画不上去的死区。

### D.2 GPT 材质迁移提示词精简与位置锁定

涉及文件：`apps/web/src/components/panels/GeneratePanel.tsx`

优化内容：

- 将冗长提示词压缩成少量高优先级约束。
- 明确参考图一是不可修改的像素定位模板。
- 锁定模型包围框、中心、宽高、外轮廓、内部孔洞、姿态、透视和裁切。
- 参考图二只提供 Base Color 材质，不采用其构图、背景、多视图排版和额外几何。
- 减少 GPT 因规则过多而忽略“大小位置必须对齐”的情况。

### D.3 新手引导增加多视图重试步骤

涉及文件：

```text
apps/web/src/components/editor/TextureOnboardingTour.tsx
apps/web/src/components/panels/GeneratePanel.tsx
```

优化内容：

- 在“生成纹理”之后新增“更换多视图重试”。
- 提示用户效果不满意时，可先清空当前模型全部图层，再选择另一张多视图重新生成。
- 该步骤只做说明，不自动删除用户图层。
- 用户点击“下一步”后进入单视图引导，再进入局部重绘引导。
- 引导版本升级并迁移旧版完成进度，避免已有用户重新从头开始。

当前工作区已执行并通过：

```text
@liclick/web typecheck
@liclick/web test:projection-layers
@liclick/web production build
```

## E. 本轮服务器替换需要带入的内容

迁移到 `D:\Li3D` 时，优先带入以下产品优化：

1. 内容填补缓存、丢失修复和 Worker 性能优化。
2. 帧预算调度、预览纹理缓存和复杂模型加载优化。
3. 局部重绘捕获、蒙版、预览、投影和批量烘焙优化。
4. 历史重绘可见性、图层切换、项目恢复和任务状态修复。
5. 投影边缘、暗部误抠和前表面深度限制。
6. ViewCube、生成锁定范围、统计弹窗和新手引导等交互优化。
7. 精简后的 GPT 材质迁移提示词。

不作为默认上线内容：

- 橡皮擦工具入口继续隐藏。
- 增强型边缘多频段融合继续保留为实验/兼容能力，不设为默认。
- 不恢复深色连通区域转透明或纹理上贴二次抠图。

## 1. 对接目标

将本地开发目录 `D:\Li3D-1` 的产品功能、界面和 3D/纹理处理能力迁移到服务器目录 `D:\Li3D`，最终由服务器目录承载新版功能。

本次迁移必须保持 `D:\Li3D` 当前服务器版本的以下逻辑不变：

1. 飞书 / IDaaS / Atlas 登录方式及全局登录门禁。
2. 浏览器账号、服务器会话和本地组件身份校验。
3. 个人莉刻账号绑定、邮箱归属校验和解绑流程。
4. 莉刻生图、任务查询、任务恢复、任务取消和局部重绘调用链路。
5. 服务器当前使用的环境变量、Cookie、回调地址、跨域配置和部署密钥。

不允许通过整目录镜像覆盖完成迁移，也不允许用本地开发环境的登录配置替换服务器配置。

## 2. 当前基线

编写本文档时观察到：

| 目录 | 用途 | 分支 | HEAD | 工作区状态 |
| --- | --- | --- | --- | --- |
| `D:\Li3D-1` | 待迁移的本地开发版 | `master` | `a276e6c9fbd55489aff921ea6afe57a727ff29f3` | 有未提交功能修改 |
| `D:\Li3D` | 当前服务器目录版 | `master` | `d55010c71676113d927b1d06cbf5f8c071b2c3e6` | 有大量已修改和未跟踪文件 |

因此，不能只依据两个 HEAD 做对接。服务器工作区里的未提交文件也是当前服务器能力的一部分，必须先完整备份，再参与合并。

## 3. 总体策略

采用“本地开发版作为产品功能主体，服务器版覆盖受保护链路，交界文件人工合并”的方式：

```text
D:\Li3D-1 产品功能代码
          +
D:\Li3D 服务器鉴权、账号与莉刻调用链路
          ↓
独立集成目录验证
          ↓
构建、接口回归、真实账号小流量验证
          ↓
替换服务器运行版本
```

禁止事项：

- 禁止执行 `robocopy /MIR`、目录同步软件的“删除目标多余文件”模式或直接清空 `D:\Li3D`。
- 禁止直接用 `D:\Li3D-1\apps\server` 覆盖服务器的 `apps\server`。
- 禁止覆盖服务器 `.env`、密钥、会话数据、工作区、数据库和本地组件设置。
- 禁止把开发登录、Mock 登录或本机端口写入服务器生产配置。
- 禁止在未通过登录和真实莉刻任务回归前切换生产入口。

## 4. 对接前备份

### 4.1 服务器目录必须保留的快照

在任何复制或合并前，保存以下内容：

- `D:\Li3D` 整体源代码快照，包括未跟踪文件。
- `git status --porcelain=v1` 输出。
- `git diff --binary` 补丁。
- 当前环境变量文件、部署脚本、服务启动参数和反向代理配置。
- `workspace`、数据库、用户会话、本地设置及任务记录的独立备份。

建议备份名称包含时间，例如：

```text
D:\Li3D-backup-YYYYMMDD-HHmm
D:\Li3D-server-before-integration.patch
D:\Li3D-server-untracked-files.txt
```

补丁只能覆盖 Git 已跟踪文件，不能代替完整目录备份。

### 4.2 建立独立集成目录

不要直接在 `D:\Li3D` 上试合并。先建立例如 `D:\Li3D-integration` 的独立目录：

1. 以 `D:\Li3D-1` 为产品功能主体复制到集成目录。
2. 不复制 `node_modules`、`dist`、临时输出、缓存和本地运行日志。
3. 从 `D:\Li3D` 将下面的受保护文件覆盖或人工合并到集成目录。
4. 仅在集成目录完成构建、测试和真实服务器验证。

## 5. 服务器受保护文件清单

以下文件不能从 `D:\Li3D-1` 直接覆盖，默认以 `D:\Li3D` 当前工作区内容为准。

### 5.1 服务端登录和会话

```text
apps/server/src/auth/authTypes.ts
apps/server/src/auth/authMiddleware.ts
apps/server/src/auth/currentUser.ts
apps/server/src/auth/sessionService.ts
apps/server/src/auth/webOAuthService.ts
apps/server/src/auth/atlasAuthService.ts
apps/server/src/auth/devMockAuthService.ts
apps/server/src/routes/auth.ts
apps/server/src/routes/identity.ts
apps/server/src/services/localIdentityProofService.ts
apps/server/src/services/identityTelemetryService.ts
```

需要保持的行为：

- `GET /api/auth/provider-status` 返回真实登录提供方状态。
- `GET /api/auth/me` 使用服务器会话判断当前用户。
- `GET /api/auth/feishu/start` 启动飞书、IDaaS 或 Atlas 登录。
- `GET /api/auth/feishu/poll/:loginId` 完成轮询登录。
- 飞书 OAuth callback、browser handoff 和刷新后会话恢复保持有效。
- `POST /api/auth/logout` 能清理当前会话。
- 所有前端鉴权请求继续使用 `credentials: 'include'`。

### 5.2 前端全局登录

```text
apps/web/src/components/auth/AppAuthGate.tsx
apps/web/src/components/auth/UserMenu.tsx
apps/web/src/stores/authStore.ts
apps/web/src/services/authApiClient.ts
apps/web/src/services/feishuLoginFlow.ts
apps/web/src/services/identityApiClient.ts
apps/web/src/services/localIdentityProofApiClient.ts
apps/web/src/services/workspaceApiBase.ts
```

特别说明：当前 `D:\Li3D` 中的 `AppAuthGate.tsx` 在本地开发版不存在，迁移时必须保留并继续接入应用根节点。

### 5.3 个人莉刻账号绑定

```text
apps/server/src/routes/localLiclickAccount.ts
apps/server/src/services/localLiclickAccountService.ts
apps/web/src/services/liclickAccountApiClient.ts
apps/web/src/services/liclickAccountBindingFlow.ts
apps/web/src/services/localTextureRuntimeClient.ts
apps/web/src/hooks/useLocalTextureRuntime.ts
apps/web/src/hooks/localTextureRuntimePolicy.ts
```

必须保留的接口和约束：

| 接口 | 用途 |
| --- | --- |
| `GET /api/local-liclick-account/status` | 查询个人莉刻账号状态 |
| `POST /api/local-liclick-account/bind/start` | 启动账号授权 |
| `GET /api/local-liclick-account/bind/poll/:loginId` | 轮询授权结果 |
| `POST /api/local-liclick-account/unbind` | 解绑个人账号 |

个人莉刻账号必须继续与飞书登录用户的企业邮箱做归属校验；未绑定、过期或邮箱不匹配时不能提交生成任务。

### 5.4 莉刻生成和局部重绘

```text
apps/server/src/routes/liclick.ts
apps/server/src/routes/localLiclick.ts
apps/server/src/services/liclickGenerationService.ts
apps/server/src/services/liclickErrorMessage.ts
apps/web/src/services/liclickApiClient.ts
apps/web/src/services/imageEditProvider.ts
```

必须保持的接口：

| 方法与路径 | 行为 |
| --- | --- |
| `GET /api/liclick/status` | 检查莉刻服务与工具能力 |
| `POST /api/liclick/generate-image` | 提交纹理生成任务 |
| `GET /api/liclick/generate-image?projectId=...` | 恢复项目中的任务列表 |
| `GET /api/liclick/generate-image/:jobId` | 查询生成任务 |
| `DELETE /api/liclick/generate-image/:jobId` | 取消生成任务 |
| `POST /api/liclick/edit-image` | 提交局部重绘任务 |
| `GET /api/liclick/edit-image/:jobId` | 查询局部重绘任务 |
| `DELETE /api/liclick/edit-image/:jobId` | 取消局部重绘任务 |

继续保留的业务约束：

- 生成前必须完成全局登录和个人莉刻账号校验。
- 登录完成后应继续原来的生成动作，而不是要求用户再次点击。
- 一个项目已有运行中任务时应恢复该任务，不能重复提交。
- 任务归属必须校验当前用户和项目。
- 刷新页面后可以依据项目 ID 恢复轮询。
- 局部重绘继续通过服务器/本地组件既有莉刻链路调用，不改为浏览器直接访问第三方服务。
- 保留服务器当前的错误映射、超时、取消和远端结果下载逻辑。

## 6. 必须人工合并的交界文件

下列文件既包含新版产品功能，又直接连接服务器登录或生图逻辑，不能整文件选一边。

### 6.1 `apps/web/src/App.tsx`

合并规则：

- 路由、页面和新版功能采用 `D:\Li3D-1`。
- 鉴权初始化、`getAuthMe`、`getProviderStatus`、身份状态恢复和 `AppAuthGate` 采用 `D:\Li3D`。
- 未登录时必须停留在全局登录门禁，登录后回到原访问路径。
- 纹理本地组件门禁与全局登录门禁的先后关系沿用服务器版本。

### 6.2 `apps/web/src/components/panels/GeneratePanel.tsx`

合并规则：

- 新版布局、多视图、提示词、引导和纹理功能采用 `D:\Li3D-1`。
- 以下调用链采用 `D:\Li3D`：
  - `runFeishuLoginFlow`
  - `ensurePersonalLiclickAccountForUser`
  - `createLiclickApiClient`
  - 登录后继续生成
  - 运行中任务恢复、轮询和取消
- 不得把服务器调用改回仅本机可用的 URL 或绕过账号校验。

### 6.3 `apps/web/src/routes/EditorPage.tsx`

合并规则：

- 新版局部重绘、蒙版、投影和图层能力采用 `D:\Li3D-1`。
- 局部生图前继续调用 `ensurePersonalLiclickAccountForUser`。
- 局部生成继续使用 `liclickImageEditProvider`，并保留任务恢复和取消逻辑。

### 6.4 服务入口与配置

以下文件必须逐段合并，不能直接覆盖：

```text
apps/server/src/config.ts
apps/server/src/index.ts
apps/server/src/localComponent.ts
apps/server/src/routes/httpUtils.ts
apps/server/.env.example
apps/web/worker/sites-worker.js
apps/web/vite.config.ts
apps/web/package.json
apps/server/package.json
package.json
```

合并时保留服务器的路由注册、CORS 请求头、Cookie 策略、OAuth/IDaaS 配置、莉刻路由、本地组件能力和测试脚本；再加入本地开发版新增的非鉴权功能依赖。

## 7. 不随代码覆盖的服务器数据和配置

以下内容只能由服务器运维配置管理，不能从 `D:\Li3D-1` 复制：

```text
apps/server/.env
secrets/
workspace/
output/
tmp/
数据库文件及 Prisma 运行数据
用户会话文件
本地组件设置与个人莉刻凭证
反向代理和 TLS 配置
部署机服务启动脚本中的环境变量
```

至少冻结下列配置项的当前服务器值：

- `AUTH_MODE`
- `SESSION_COOKIE_NAME`、`SESSION_SECRET`、`SESSION_MAX_AGE_DAYS`、`SESSION_COOKIE_SECURE`
- `FEISHU_OAUTH_*`
- `IDAAS_*`
- `LICLICK_ENABLE_ATLAS_LOCAL_LOGIN`、`ATLAS_*`
- `LICLICK_PUBLIC_WORKSPACE_URL`、`LICLICK_FRONTEND_URL`、`LICLICK_ALLOWED_ORIGINS`
- `LICLICK_API_BASE_URL`、`LICLICK_API_TIMEOUT_MS`
- `LICLICK_WORKSPACE_DIR`、`LICLICK_LOCAL_SETTINGS_PATH`

文档、日志和提交中不得记录真实 Secret、Token、Cookie 或个人账号凭证。

## 8. 推荐实施步骤

### 阶段 A：冻结基线

1. 停止对 `D:\Li3D` 的并行修改。
2. 完成服务器目录、未提交补丁、未跟踪文件和数据备份。
3. 记录服务器当前启动命令、端口、域名、登录回调地址和健康状态。
4. 对受保护文件生成 SHA-256 清单，作为合并后的比对依据。

### 阶段 B：建立集成版本

1. 复制 `D:\Li3D-1` 到独立集成目录。
2. 从 `D:\Li3D` 恢复第 5 节中的受保护文件。
3. 按第 6 节逐个合并交界文件。
4. 合并依赖和脚本，不复制服务器 `.env`。
5. 检查所有 `/api/auth`、`/api/identity`、`/api/local-liclick-account` 和 `/api/liclick` 调用仍指向服务器既有接口。

### 阶段 C：静态检查

建议执行：

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @liclick/server typecheck
corepack pnpm --filter @liclick/web typecheck
corepack pnpm --filter @liclick/server build
corepack pnpm --filter @liclick/web build
```

如果依赖确实发生变化，应先人工审核 `package.json` 和 lockfile，再决定是否允许更新锁文件。

### 阶段 D：自动化回归

在集成目录运行服务器版本已有的关键测试：

```powershell
corepack pnpm --filter @liclick/web test:generation-auth-continuation
corepack pnpm --filter @liclick/web test:generation-polling
corepack pnpm --filter @liclick/web smoke:sites-auth
corepack pnpm --filter @liclick/server test:liclick-errors
corepack pnpm smoke:auth
corepack pnpm smoke:identity
corepack pnpm smoke:local-liclick-callback
corepack pnpm smoke:web
```

`test-global-auth-gate.mjs` 当前存在于服务器目录但没有对应 package script，也应直接运行：

```powershell
node apps/web/scripts/test-global-auth-gate.mjs
```

### 阶段 E：真实环境验收

使用测试账号完成一次端到端验证：

1. 未登录访问项目页时显示全局登录门禁。
2. 飞书 / IDaaS 登录成功后返回原项目地址。
3. 刷新页面后会话仍有效，退出登录后会话失效。
4. 飞书邮箱与个人莉刻账号不一致时阻止生成并给出明确提示。
5. 绑定正确莉刻账号后能提交生图任务。
6. 提交后能显示计时和运行状态，远端能接收到任务。
7. 刷新页面后能恢复任务轮询，不重复提交。
8. 能正常取消生成任务。
9. 单视图、多视图、局部生图各完成一次，并正确写入项目图层。
10. 莉刻任务失败时前端能退出运行态，不会永久卡在“任务正在运行”。

### 阶段 F：切换服务器版本

1. 先构建集成版本产物。
2. 停止服务器进程，避免切换期间继续写任务状态。
3. 保留旧版本目录，不直接删除。
4. 将服务器环境变量和持久化目录挂接到新版本。
5. 启动后先验证 `/api/health`、`/api/auth/provider-status` 和 `/api/liclick/status`。
6. 完成一个真实登录和一个小规模生图任务后再开放访问。

## 9. 验收门槛

满足以下全部条件才可认为对接完成：

- [ ] 新版界面、引导、图层、投影、局部重绘和性能优化可用。
- [ ] 未登录用户不能进入业务工作区。
- [ ] 服务器当前飞书 / IDaaS / Atlas 登录方式未发生变化。
- [ ] Cookie、Session、回调地址和跨域行为未发生变化。
- [ ] 个人莉刻账号绑定及邮箱校验未被绕过。
- [ ] 纹理生成和局部重绘仍走服务器既有莉刻链路。
- [ ] 运行中任务可恢复、可查询、可取消。
- [ ] 自动化测试、前后端 typecheck 和生产构建全部通过。
- [ ] 刷新、退出重进、登录过期和莉刻失败场景均已验证。
- [ ] 旧版本目录和数据备份可用于快速回退。

## 10. 回退方案

发现登录、账号或生图链路异常时，不在生产目录继续热修，直接执行回退：

1. 停止新版本服务。
2. 将服务入口切回备份的 `D:\Li3D` 旧版本目录。
3. 恢复原环境变量、反向代理和持久化目录挂接。
4. 启动旧版本并验证登录、账号状态和一笔测试任务。
5. 保留失败集成版本、服务日志和浏览器网络日志，回到独立集成目录修复。

回退不应删除新版本产生的任务或项目数据；如果新旧版本存在数据结构变化，必须先写独立的数据兼容与回滚方案。

## 11. 最终建议

本次需求表面上是“用本地版本替换服务器目录”，实际上是一次带有两套身份和任务状态的集成迁移。最安全的落地方式不是文件夹覆盖，而是：

1. 本地开发版提供新版产品和渲染功能。
2. 服务器目录提供鉴权、账号、莉刻调用和部署契约。
3. 在独立目录完成交界文件合并。
4. 通过真实登录与真实莉刻小任务后再切换运行目录。

这样既能完整带入当前本地迭代，又不会破坏服务器已经可用的登录方式、账号绑定和莉刻生图链路。
