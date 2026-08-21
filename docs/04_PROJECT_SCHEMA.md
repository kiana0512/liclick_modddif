# Project Schema

当前工程由 `project.liclick.json` 加项目资产目录组成。运行时 `Project` 的权威 TypeScript 定义是 `apps/web/src/types/project.ts`；`packages/core` 的旧 schema 和 Prisma schema 都不能替代它。

## Top-level Project

当前主要字段：

```ts
type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  thumbnail: string;
  objects: SceneObject[];
  references: ReferenceImage[];
  captures: Capture[];
  generations: Generation[];
  layers: Layer[];
  bakedTextures: BakedTexture[];
  bakeWorkspace?: ProjectBakeWorkspace;
  pipeline?: ProjectPipelineState;
  workspaceName?: string;
  workspaceMode?: 'none' | 'file-system-access' | 'download-fallback' | 'local-server';
  folderId?: string | null;
  currentMode?: string;
  activeObjectId?: string;
  activeLayerId?: string;
  workspaceVersion?: string;
  lastSavedAt?: string;
  dirty?: boolean;
  deletedObjectIds?: string[];
  assetManifest?: AssetManifest;
  settings: ProjectSettings;
};
```

## Object And Asset Records

- `SceneObject` 保存源路径/格式、mesh/UV/material 元数据、原始与归一化包围盒、import normalization transform 和 user transform。
- `ReferenceImage` 可有 `objectId`，并用 `referenceGroupId`、`referenceRole`、`derivedFromReferenceId`、`referenceSource` 和 `generationId` 表达单视图/多视图配对。
- `Capture` 保存对象、完整相机、尺寸、Color/Mask/Depth/Normal URL 与 `depthEncoding`。
- `Generation` 保存 mode、prompt、reference/capture、状态、result URL 和灵活 metadata；Texture Map metadata 包含 workflow、batch、view、对象矩阵、任务身份和投影提交状态。
- `Layer` 保存 projected/uv/patch/normal 类型、role、图像/Mask/Depth/Normal、相机/对象矩阵、可见性、opacity、strength、blend、adjustments、bake/merge revision。局部重绘可同时保存当前 harmonized source、`localRepaintRawSourceUrl` 和累计 projection-space mask。
- `BakedTexture` 保存输出图、分辨率、源图层集合、coverage/report 和 cache identity。

## Bake Workspace

`bakeWorkspace` 是独立模型烘焙模块的持久草稿：

- 每个 bake set 区分 high/low/cage/color/normal/roughness/metallic 资产。
- 保存分辨率、quality、projection/cage、match、sampling、padding、normal orientation、device、UDIM、backface 和通道开关。
- 高模是 bake-only asset，不会自动加入贴图编辑器 `objects`。

## Pipeline Revisions

`pipeline.version = 1` 保存 `texture -> retopology -> uv -> bake` 的追加式 checkpoint：

- revision 记录 stage、source mode、parent、输入/输出资产、settings、status 和时间。
- 已发布 revision 不原地改写；上游重新发布时通过 `staleRevisionIds` 标记下游旧结果。
- Pipeline 是工程流转/溯源数据，不替代 `layers`、`bakeWorkspace` 或远端 job history。

## Workspace Layout

```text
workspace/
  users/<userId>/
    projects/<projectSlug>/
      project.liclick.json
      assets/
        models/
        references/
        captures/
        generations/
        layers/
        baked/
      exports/
      thumbnails/
      autosave/
```

具体用户目录可能因本地组件/主服务模式而有差异，但公开资产必须落在服务端允许的 project-relative 路径内。Blob/data URL 会尽可能物化为二进制文件，避免项目 JSON 膨胀。

## Save And Compatibility

- local-server 工程使用 1.5 秒 debounce autosave，并保留滚动 autosave。
- 浏览器 File System Access/JSON 下载与导入是回退路径；Blob URL 本身不能跨会话持久化。
- 旧工程缺少 multiview pair、pipeline、bakeWorkspace 或新 layer 字段时保持兼容默认值。
- 当前服务端读入项目 JSON 时没有统一使用完整共享 runtime schema。新增字段必须同时检查 Web 类型、序列化/资产物化、服务端保存和恢复测试，不能只更新 `packages/core`。

## Database Boundary

`apps/server/prisma/schema.prisma` 定义未来 User/Session/Project/Asset/GenerationJob 数据库模型。当前项目 runtime 仍以文件和 JSON 为准，详见 [23_DATABASE_SCHEMA.md](23_DATABASE_SCHEMA.md)。
