# LI3D PBR 资产 Manifest 与 Release 规范 v0.1

状态：设计基线

版本：0.1

建立日期：2026-07-20

上游文档：`docs/39_PBR_3A_MODULE_2_3_AND_DCC_PIPELINE_V0_1.md`

## 1. 目的

本规范定义模块 1、模块 2、模块 3 之间的稳定资产边界，使高模、低模、PBR 贴图、任务结果和 DCC 交付能够：

- 被准确识别，不依赖文件名猜测。
- 被版本化，不覆盖历史成功结果。
- 被校验，能够发现缺失、损坏和错误替换。
- 被追溯，能够知道结果来自哪个模型、参数、工具和任务。
- 被恢复，关闭 LI3D 或重启电脑后仍能继续。
- 被不同 DCC 适配，而不污染模块 2 的标准 Release。

本文定义目标 Schema，不表示仓库当前类型已经实现这些字段。

## 2. 与现有项目格式的关系

当前 `project.liclick.json` 已包含：

- 项目基础信息。
- 对象、参考图、捕获、生成、图层和浏览器 UV Bake 结果。
- `workspaceVersion`。
- 按 `models/references/captures/generations/layers/baked` 分类的浅层 `assetManifest`。

v0.1 不删除或重命名这些字段。模块 2、3 采用兼容扩展：

1. `project.liclick.json` 保存轻量索引和当前指针。
2. 大型资产、Release Manifest、Job 和 Report 存为项目内独立文件。
3. 旧 `assetManifest` 继续服务模块 1 和旧项目。
4. 新 PBR 数据通过 `pbrPipeline` 索引进入。
5. 加载旧项目时，缺少 `pbrPipeline` 等价于尚未使用模块 2、3。

建议未来的项目顶层扩展：

```json
{
  "workspaceVersion": "0.6.0",
  "pbrPipeline": {
    "schemaVersion": "0.1",
    "activeAssetId": "asset_...",
    "activeDraftId": "draft_...",
    "activeReleaseId": "release_...",
    "assetIndexPath": "pipeline/assets/index.json",
    "releaseIndexPath": "pipeline/releases/index.json",
    "deliveryIndexPath": "pipeline/deliveries/index.json"
  }
}
```

`workspaceVersion` 与 `pbrPipeline.schemaVersion` 分开演进。前者代表整个 Workspace，后者只代表 PBR Pipeline Schema。

## 3. 核心身份模型

```text
Project
  -> PipelineAsset
      -> Draft
          -> Job
              -> Attempt
      -> Release
          -> Delivery
```

### 3.1 Project

LI3D 用户项目，继续由 `project.liclick.json` 表示。

### 3.2 PipelineAsset

同一件逻辑资产。例如“箱子”“角色头部”“岩石 A”。资产可以经历多个 Draft 和 Release。

### 3.3 Draft

可编辑工作版本，保存当前选择的高模、低模、贴图候选、预检结果和未发布任务结果。

### 3.4 Job

一次冻结输入和参数后的可执行任务，例如 Bake、Comfy 或 DCC Transfer。Job 的详细规范见 `docs/41_PBR_JOB_STATE_LOG_AND_ERROR_SPEC_V0_1.md`。

### 3.5 Attempt

Job 的一次实际执行。重试必须创建新 Attempt，不能覆盖上一次退出码、日志和输出。

### 3.6 Release

通过验收后发布的不可变 PBR 资产版本。模块 3 默认只消费 Release。

### 3.7 Delivery

某个 Release 面向特定 DCC、版本和 Target Profile 生成的交付版本。

## 4. ID 规范

ID 是不透明标识，不在业务逻辑中解析时间或含义。建议前缀：

| 实体 | 前缀示例 |
| --- | --- |
| PipelineAsset | `asset_` |
| Draft | `draft_` |
| Release | `release_` |
| Job | `job_` |
| Attempt | `attempt_` |
| Delivery | `delivery_` |
| File | `file_` |
| Report | `report_` |
| Receipt | `receipt_` |

规则：

- ID 在所属 Workspace 内唯一。
- ID 一旦写入不得复用。
- 文件重命名不改变 File ID；文件内容改变必须产生新 File ID 和新哈希。
- Release ID 一旦发布不能指向另一组内容。
- UI 可以显示短 ID，但日志和 manifest 保存完整 ID。

## 5. 项目目录规范

建议目录：

```text
workspace/projects/<projectSlug>/
  project.liclick.json
  assets/
    models/
    references/
    captures/
    generations/
    layers/
    baked/
  pipeline/
    assets/
      index.json
      <assetId>/
        asset.json
        drafts/
          <draftId>/
            draft.json
    releases/
      index.json
      <releaseId>/
        manifest.json
        models/
        textures/
        previews/
        reports/
    deliveries/
      index.json
      <deliveryId>/
        manifest.json
        payload/
        receipts/
  jobs/
    bake/<jobId>/
    comfy/<jobId>/
    dcc/<jobId>/
  temp/
    <jobId>/
  exports/
  thumbnails/
  autosave/
```

规则：

- Manifest 中只保存项目根目录下的相对路径。
- 不在可移植 Manifest 中写入 `C:\Users\...` 绝对路径。
- 原始外部路径可以出现在本机 Source Locator 中，但导出或分享时必须可脱敏。
- `temp/` 中的文件不是正式资产，可以按恢复策略清理。
- `pipeline/releases/` 和 `pipeline/deliveries/` 不允许普通任务原地覆盖。

## 6. 通用文件记录 FileRecord

每一个正式模型、贴图、报告和交付文件都必须有 FileRecord。

```json
{
  "id": "file_...",
  "logicalRole": "texture.baseColor",
  "relativePath": "pipeline/releases/release_.../textures/asset_BaseColor.png",
  "mediaType": "image/png",
  "sizeBytes": 67108864,
  "sha256": "lowercase-hex",
  "createdAt": "2026-07-20T12:00:00.000Z",
  "createdBy": {
    "kind": "job-attempt",
    "id": "attempt_..."
  },
  "sourceFileId": "file_..."
}
```

必需字段：

- `id`
- `logicalRole`
- `relativePath`
- `mediaType`
- `sizeBytes`
- `sha256`
- `createdAt`
- `createdBy`

可选字段：

- `sourceFileId`：从另一文件转换而来。
- `originalName`：用户输入文件名。
- `sourceLocator`：本机原始来源，默认不进入可移植包。
- `metadata`：按媒体类型扩展。

### 6.1 文件角色

建议角色：

```text
geometry.high
geometry.low
geometry.cage
texture.high.baseColor
texture.baseColor
texture.ambientOcclusion
texture.normal
texture.roughness
texture.metallic
texture.orm
texture.height
preview.thumbnail
preview.pbr
report.preflight
report.bake
report.comfy
report.delivery
log.user
log.technical
log.audit
manifest.release
manifest.delivery
```

文件角色是业务真相。文件名仅供人阅读，不参与角色判断。

## 7. GeometryRecord

```json
{
  "id": "geometry_...",
  "role": "low",
  "fileId": "file_...",
  "format": "fbx",
  "units": "centimeter",
  "upAxis": "Y",
  "frontAxis": "-Z",
  "handedness": "right",
  "objectCount": 1,
  "meshCount": 1,
  "vertexCount": 12000,
  "triangleCount": 21000,
  "materialSlots": [],
  "uvSets": [],
  "udims": [1001],
  "boundingBox": {},
  "transforms": {},
  "triangulated": true,
  "normalData": {}
}
```

### 7.1 角色

- `high`
- `low`
- `cage`

### 7.2 坐标和变换

必须区分：

- `sourceTransform`：输入文件原始变换。
- `importNormalizationTransform`：LI3D 为显示而使用的归一化变换。
- `userTransform`：用户在 LI3D 中的编辑变换。
- `bakeTransform`：正式烘焙时使用的世界变换。
- `exportTransform`：目标 DCC 交付变换。

`bakeTransform` 必须显式确定，不能把显示归一化变换错误当成烘焙空间。

### 7.3 包围盒

```json
{
  "min": [0, 0, 0],
  "max": [1, 1, 1],
  "center": [0.5, 0.5, 0.5],
  "size": [1, 1, 1]
}
```

预检和 Bake Job 快照同时保存高低模包围盒，便于发现之后文件被替换。

### 7.4 UV Set

```json
{
  "index": 0,
  "name": "UV0",
  "tileMode": "single",
  "udims": [1001],
  "overlapRatio": 0,
  "outsideTargetRatio": 0,
  "checkedAt": "ISO-8601",
  "checkerVersion": "..."
}
```

未知值使用 `null` 或省略，不能伪造为 0。

## 8. TextureRecord

```json
{
  "id": "texture_...",
  "role": "normal",
  "fileId": "file_...",
  "width": 4096,
  "height": 4096,
  "bitDepth": 8,
  "channels": ["R", "G", "B", "A"],
  "colorSpace": "linear",
  "normalOrientation": "directx",
  "uvSet": 0,
  "udim": 1001,
  "materialSlotIds": ["material_..."],
  "source": {
    "kind": "substance-bake",
    "jobId": "job_...",
    "attemptId": "attempt_..."
  }
}
```

### 8.1 贴图角色

- `highBaseColor`
- `baseColor`
- `ambientOcclusion`
- `normal`
- `roughness`
- `metallic`
- `orm`
- `height`

### 8.2 色彩空间

- BaseColor：`srgb`。
- AO、Normal、Roughness、Metallic、ORM、Height：`linear`。
- 未知来源使用 `unknown` 并阻止无提示发布。

### 8.3 Normal

Normal 必须记录：

- `normalSpace`: `tangent` 或 `object`。
- `normalOrientation`: `directx`、`opengl` 或 `not-applicable`。
- `tangentBasis`: 已知时记录，例如 `mikktspace`。
- `greenChannelFlippedFrom`: 如果由另一方向转换而来，记录源 Texture ID。

### 8.4 ORM

ORM 必须记录通道映射，不能只依赖名称：

```json
{
  "packing": {
    "R": "ambientOcclusion",
    "G": "roughness",
    "B": "metallic",
    "A": "unused"
  }
}
```

## 9. MaterialSlotRecord

```json
{
  "id": "material_...",
  "name": "Material_9",
  "sourceIndex": 0,
  "meshIds": ["mesh_..."],
  "textureBindings": {
    "baseColor": "texture_...",
    "ambientOcclusion": "texture_...",
    "normal": "texture_...",
    "roughness": "texture_...",
    "metallic": "texture_..."
  }
}
```

第一版如只支持单材质槽，Manifest 仍使用数组，并通过 Capability 和预检明确限制，避免未来破坏 Schema。

## 10. Source 与数据血缘

每个正式结果必须能追溯到直接来源。

```json
{
  "source": {
    "module": "module-1",
    "projectId": "...",
    "assetId": "...",
    "versionId": "...",
    "files": ["file_..."],
    "receivedAt": "ISO-8601"
  }
}
```

转换链示例：

```text
高模颜色贴图
  -> Substance BaseColor Bake Candidate
  -> Comfy Clean BaseColor Candidate
  -> 用户选择
  -> Release BaseColor
  -> Blender Delivery BaseColor
```

每个箭头通过 `sourceFileId`、Job ID、Attempt ID 或 Release ID 表示。

## 11. PipelineAsset Schema

```json
{
  "schemaVersion": "0.1",
  "id": "asset_...",
  "projectId": "project-id",
  "name": "箱子",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "source": {},
  "draftIds": ["draft_..."],
  "releaseIds": ["release_..."],
  "activeDraftId": "draft_...",
  "activeReleaseId": "release_..."
}
```

PipelineAsset 本身不复制完整文件清单，只维护身份、来源和索引。

## 12. Draft Schema

Draft 是可变工作状态。

```json
{
  "schemaVersion": "0.1",
  "id": "draft_...",
  "assetId": "asset_...",
  "revision": 12,
  "status": "editing",
  "inputs": {
    "highGeometryId": "geometry_...",
    "lowGeometryId": "geometry_...",
    "cageGeometryId": null,
    "highBaseColorTextureId": "texture_...",
    "userMetallicTextureId": "texture_...",
    "userRoughnessTextureId": null
  },
  "selectedCandidates": {},
  "preflightReportId": "report_...",
  "jobIds": [],
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "updatedBy": {}
}
```

### 12.1 Draft revision

- 每次持久化影响输入、选择或发布结果的修改都递增 `revision`。
- Job 提交时记录 `draftRevision`。
- Job 完成时如果当前 Draft revision 已改变，结果仍可保存为 Candidate，但不能无提示替换当前选择。
- 发布时必须记录发布所依据的 Draft revision。

## 13. Candidate

Job 成功输出先注册为 Candidate，不直接成为 Release。

```json
{
  "id": "candidate_...",
  "role": "baseColor",
  "textureId": "texture_...",
  "jobId": "job_...",
  "attemptId": "attempt_...",
  "status": "available",
  "qualityChecks": [],
  "createdAt": "ISO-8601"
}
```

Candidate 状态：

- `available`
- `selected`
- `rejected`
- `superseded`
- `invalid`

删除 UI 选择不能删除 Candidate 历史记录；清理文件需要独立、可审计的垃圾回收策略。

## 14. Release Manifest

Release 是模块 2 的正式输出。

```json
{
  "schemaVersion": "0.1",
  "kind": "li3d-pbr-release",
  "id": "release_...",
  "projectId": "project-id",
  "assetId": "asset_...",
  "name": "xiangzi-pbr-v001",
  "version": 1,
  "status": "published",
  "sourceDraft": {
    "id": "draft_...",
    "revision": 12
  },
  "geometry": {
    "low": "geometry_..."
  },
  "materials": [],
  "textures": [],
  "files": [],
  "reports": [],
  "provenance": [],
  "validation": {
    "status": "passed",
    "blockingIssueCount": 0,
    "warningCount": 1,
    "confirmedWarningIds": []
  },
  "publishedAt": "ISO-8601",
  "publishedBy": {}
}
```

### 14.1 Release 不可变规则

- `published` 后禁止修改 Manifest 内容和文件。
- 发现问题时创建新的 Draft 和 Release。
- 可以增加外部索引、评论或弃用标记，但不能改写原始 Release。
- `deprecated` 不等于删除；历史 Delivery 仍引用原 Release。

### 14.2 发布前置条件

- 低模存在且哈希有效。
- BaseColor 和 AO 存在。
- Normal 若被选择则必须记录方向。
- Metallic 缺失时必须是用户确认的业务状态，不能伪造默认贴图。
- 所有选择贴图通过文件和尺寸验证。
- 阻塞预检问题为 0。
- 必需 Job 有终态记录。
- 所有 Manifest 相对路径都在项目目录内。

### 14.3 发布事务

发布采用以下顺序：

1. 冻结 Draft revision 和所有选择。
2. 建立 `releaseId` 临时目录。
3. 复制或硬链接获准使用的文件。
4. 对目标文件重新计算 SHA-256。
5. 写入 Release Manifest 临时文件。
6. 深层验证 Manifest。
7. 原子 rename 为正式 Release 目录。
8. 原子更新 Release index。
9. 最后更新 `project.liclick.json` 当前指针。

中途失败不得留下 `published` Release。

## 15. Delivery Manifest

Delivery 是目标专用派生物。

```json
{
  "schemaVersion": "0.1",
  "kind": "li3d-dcc-delivery",
  "id": "delivery_...",
  "releaseId": "release_...",
  "target": {
    "host": "blender",
    "hostVersion": "detected-version",
    "connectorId": "connector.blender",
    "connectorVersion": "...",
    "protocolVersion": "...",
    "profileId": "blender-pbr-default"
  },
  "conversions": [],
  "files": [],
  "transferJobId": "job_...",
  "receiptIds": [],
  "createdAt": "ISO-8601"
}
```

### 15.1 ConversionRecord

```json
{
  "type": "normal-orientation",
  "inputFileId": "file_...",
  "outputFileId": "file_...",
  "parameters": {
    "from": "directx",
    "to": "opengl"
  },
  "tool": {
    "id": "li3d-texture-converter",
    "version": "..."
  }
}
```

所有目标转换均产生新文件，不改写 Release 文件。

## 16. Target Profile

Target Profile 使不同 DCC 的差异数据化。

```json
{
  "id": "blender-pbr-default",
  "host": "blender",
  "modelFormat": "glb",
  "units": "meter",
  "upAxis": "Z",
  "frontAxis": "-Y",
  "normalOrientation": "opengl",
  "textureNaming": "li3d-standard",
  "packing": {
    "mode": "separate"
  },
  "materialTemplate": "principled-bsdf"
}
```

规则：

- 内置 Profile 有稳定 ID 和版本。
- 用户自定义 Profile 不能覆盖内置定义。
- Delivery 保存实际 Profile 快照，而不只保存 Profile ID。
- DCC 或插件升级后，旧 Delivery 仍能解释当时使用的配置。

## 17. Connector Manifest 扩展方向

当前 `@liclick/connector-protocol` 的 Manifest 支持 `blender`、`3dsmax`、`photoshop` 和字符串能力列表。模块 3 后续需要兼容扩展：

```json
{
  "id": "connector.blender",
  "name": "LI3D Blender Connector",
  "host": "blender",
  "version": "...",
  "protocolVersion": "...",
  "hostVersionRange": "...",
  "capabilities": [
    "asset.import",
    "material.pbr.create",
    "texture.bind.separate",
    "receipt.report"
  ],
  "install": {},
  "integrity": {}
}
```

需要新增 Maya、Unreal 和自定义目标时，应通过 Schema 版本升级，不直接把任意字符串当成已支持 Host。

## 18. 索引文件

索引用于快速列出，不是实体真相来源。

```json
{
  "schemaVersion": "0.1",
  "items": [
    {
      "id": "release_...",
      "assetId": "asset_...",
      "name": "...",
      "status": "published",
      "manifestPath": "pipeline/releases/release_.../manifest.json",
      "thumbnailPath": "pipeline/releases/release_.../previews/thumbnail.png",
      "updatedAt": "ISO-8601"
    }
  ]
}
```

索引损坏时可以扫描 Manifest 重建。Manifest 损坏时不能只依赖索引恢复为有效 Release。

## 19. Schema 验证

正式实现必须进行深层验证：

- 枚举值。
- ID 格式和引用存在性。
- 相对路径安全。
- 文件大小和 SHA-256。
- 贴图尺寸、色彩空间、通道和 Normal 方向。
- Release 必需角色。
- Draft revision。
- Job、Attempt、Candidate 和 Release 的引用关系。
- Delivery 的 Release 和 Target Profile。

建议在共享包中使用 Zod 定义，并生成 TypeScript 类型。Web 和 Server 不再分别维护互相漂移的浅层类型。

## 20. 路径与安全

- 拒绝绝对路径进入可移植 Manifest。
- 拒绝 `..`、设备路径、UNC 注入和项目目录逃逸。
- 所有写入先解析真实目标并确认位于当前项目目录。
- 外部 Source Locator 不作为静态文件服务路径。
- DCC Connector 只能访问 Delivery 明确列出的文件。
- 本地 API 和 Socket 需要会话令牌、协议版本和请求 ID。
- Manifest 中不得存储 ComfyUI、Atlas、Adobe 或其他服务密钥。

## 21. 迁移与兼容

- 每个独立 Manifest 必须带 `schemaVersion` 和 `kind`。
- Reader 支持当前版本和明确列出的旧版本。
- Migration 创建新文件或原子替换，不原地破坏唯一副本。
- 未知字段默认保留，除非明确无效或不安全。
- 未知枚举值不能静默转换成常用默认值。
- 旧项目没有 PBR 数据时仍可正常打开模块 1。
- 模块 2 首次打开旧项目时创建 PipelineAsset 和 Draft，不篡改原模型记录。

## 22. 最小 API 资源模型

建议资源：

```text
GET    /api/projects/:projectId/pipeline/assets
POST   /api/projects/:projectId/pipeline/assets
GET    /api/projects/:projectId/pipeline/assets/:assetId
POST   /api/projects/:projectId/pipeline/assets/:assetId/drafts
PATCH  /api/projects/:projectId/pipeline/drafts/:draftId
POST   /api/projects/:projectId/pipeline/drafts/:draftId/publish
GET    /api/projects/:projectId/pipeline/releases
GET    /api/projects/:projectId/pipeline/releases/:releaseId
POST   /api/projects/:projectId/pipeline/releases/:releaseId/deliveries
```

这是资源方向，不是对当前 Server 路由的已实现声明。Job API 在 41 号文档定义。

## 23. 验收条件

- 旧项目不含 `pbrPipeline` 时仍能正常打开。
- Draft 修改递增 revision。
- Job 能引用冻结的 Draft revision。
- 同一文件内容可以验证 SHA-256。
- 文件内容变化会产生新 FileRecord。
- Candidate 不会自动覆盖当前选择。
- Release 发布失败不会留下半成品正式目录。
- 已发布 Release 文件不能被后续 Bake 或 Comfy Job 覆盖。
- Delivery 转换不会改变 Release。
- Release Manifest 可以独立解释低模、PBR 贴图、来源和验证结果。
- DCC Receipt 可以追溯到 Delivery 和 Release。
- 所有可移植路径均为安全的项目相对路径。

## 24. v0.1 默认边界

- 一个 PipelineAsset 对应一组高低模。
- 单个低模为首要路径。
- UV0。
- UDIM 1001。
- 单材质槽优先，但 Schema 使用数组。
- BaseColor 和 AO 是 Release 必需贴图。
- Normal 可选，但一旦存在必须记录方向。
- Roughness 和 Metallic 可以处于用户确认的缺失状态，不能伪造内容。
- Comfy 输出先成为 Candidate。
- 模块 3 只消费 Release。
- Delivery 一次面向一个目标 Host 和 Target Profile。

## 25. 后续实现拆分

1. 把本规范转换为共享 Zod Schema。
2. 为现有 `Project` 增加可选 `pbrPipeline` 索引。
3. 增加 Pipeline 目录和安全路径解析器。
4. 增加深层 Manifest Validator。
5. 增加 SHA-256 与文件元数据服务。
6. 实现 Draft revision 和冲突检测。
7. 实现 Candidate 注册。
8. 实现原子 Release Publisher。
9. 实现 Delivery Builder。
10. 增加旧项目迁移与恢复测试。

## 26. 变更记录

### v0.1 - 2026-07-20

- 首次定义 PipelineAsset、Draft、Job、Attempt、Candidate、Release 和 Delivery。
- 定义 Geometry、Texture、Material、File、Target Profile 和数据血缘。
- 定义目录、发布事务、哈希、路径安全、迁移和现有项目兼容策略。

