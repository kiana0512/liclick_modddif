# 资产清理、去重、配额与压缩机制设计

## 1. 文档状态

- 日期：2026-09-14
- 状态：设计冻结；Phase 1 资产盘点/手动隔离与 Phase 1.5 Workspace 主动永久清空已在本地实现并验证，尚未部署或执行生产迁移
- 界面模块：UI-16 首页存储与清理
- 主模块：M14 数据与对象存储
- 协作模块：M01 Cloud 工程与工作区、M02 输入与资产、M10 生产任务与烘焙、M12 状态/历史/版本、M13 Cloud 集成、M15 测试与发布
- 设计算法：
  - STORAGE-INVENTORY-001/3：已实现的双后端引用盘点、候选快照、近期资产保护与单飞调度协议
  - ASSET-CONTENT-DEDUP v0.2.0：用户隔离的内容寻址与双存储适配
  - ASSET-LIFECYCLE-GC v0.3.3：已实现引用标记、扫描候选快照、单飞任务、本地高密度目录快速隔离与显式二次确认的 Workspace 后台物理清空；恢复与 Cloud 物理回收仍待实施
  - ASSET-QUOTA-RESERVATION v0.2.0：配额预留、提交和释放
  - ASSET-ROLE-COMPRESSION v0.2.0：按资产角色生成有版本、跨解码器验证的无损或展示派生物
- 候选协议：Asset Transfer v2
- 候选存储 Schema：Asset Storage Schema v2

本卡定义目标机制、实施门禁并记录 Phase 1 落地边界。生产运行时继续是浏览器零安装、LI3D Cloud 控制面和对象存储/生产计算服务；不得恢复 Windows 本地组件、localhost/4618、安装器、端点切换或本地凭据托管。

### 1.1 Phase 1 实施记录

已实现：共享 Storage Overview/Cleanup Job 契约；4517 Workspace 文件适配器；Cloud PostgreSQL 引用盘点与逻辑隔离适配器；异步扫描、scanId 新鲜度校验、清理幂等键；首页账号菜单摘要与按需加载管理弹窗；`004_asset_storage_v2_shadow.sql` 影子 Schema；本地文件移入用户专属隔离区。大目录盘点采用有界并发 `stat`、流式遍历和实时进度，扫描时原子生成与 scanId 绑定的有界 NDJSON 候选快照，避免把百万路径放入内存或在用户确认后重复全量盘点。清理开始时重新读取当前/历史引用，并对快照候选逐项验证路径、引用、类型和字节长度；扫描后新增文件不进入任务，后来恢复引用或发生变化的候选被跳过，其余候选继续处理。

Phase 1.5 增加 Workspace 隔离区主动永久清空：浏览器要求输入“永久删除”二次确认；服务端创建幂等 purge job，以目录 rename 先把 `storage-quarantine` 原子摘除到 `storage-purge/<jobId>`，HTTP 立即返回，随后异步递归释放文件。服务重启会继续 queued/running purge；扫描通过 cleanup/purge job 账本计算隔离与待释放字节，不再重复 stat 已隔离的百万文件。真实工作区快速隔离 156,104 个文件、137,976,470,315 B 用时 8.55s，后续增量扫描用时 1.3s。

尚未实现且不得误报为已生效：Asset Transfer v2 内容寻址上传、物理 Blob 去重、配额预留、隔离恢复 UI/API、自动到期清理、Cloud 对象存储物理删除 Worker/`DeleteObject`、PNG canonical 优化或 WebP 预览派生。影子 Schema 已加入迁移脚本，但本次没有连接生产数据库、没有执行生产迁移、没有压缩或永久删除任何生产资产；Workspace 永久清空也只会在用户完成明确二次确认后执行。

Phase 1 回滚不需要改写 Project document：移除 UI-16、storage 路由/服务及影子 Schema 调用即可；影子表不被 Asset Transfer v1 消费，可保留为空或在确认无 Phase 1 快照/任务后独立删除。4517 已隔离文件保留原相对路径，必须先按 cleanup manifest 恢复，再移除服务；Cloud 逻辑隔离行可标记 restored_at，不得直接删除对象。

## 2. 问题与证据

当前 Asset Transfer v1 以每次调用新建的 assetId 生成对象键。相同用户、相同字节、相同工程内的重复保存仍会创建新的物理对象。asset_transfers 的 SHA-256 位于 record_json，活动 SQL 没有基于内容身份的唯一约束。工程软删除、失败上传、任务 staging、recoveries 和历史 Revision 也没有统一生命周期。

2026-09-14 只读盘点得到：

| 范围 | 逻辑占用 | 文件数 | 说明 |
|---|---:|---:|---|
| workspace | 1.43 TiB | 1,120,215 | 几乎全部位于单一用户工作区 |
| 测试合集 | 1,333.27 GiB | 1,037,752 | 当前文档、autosave 与根备份只引用约 3.73 GiB / 3,240 项 |
| 割草机器人 | 124.74 GiB | 74,319 | 当前文档与 autosave 只引用约 1.50 GiB / 1,475 项 |

抽样 SHA-256 证明模型、参考图、捕获、生成结果和图层中存在大量完全相同的字节副本。该盘点只用于设计容量和验证 dry-run，不构成删除授权；本地 workspace 也不得被当作生产存储方案。

## 3. 设计目标

1. 相同用户上传完全相同的字节时，只保存一份物理 Blob，同时保留工程内稳定的逻辑 Asset 身份。
2. Project Command 重放、上传完成重放和网络重试不得增加物理占用或产生不同逻辑结果。
3. 只有不被任何保留根引用、超过恢复窗口并完成隔离的 Blob 才能物理删除。
4. 所有配额判断必须原子化，防止并发上传共同越过上限。
5. 压缩不得静默降低分辨率、改变蒙版/深度/法线语义、绕过 QA 或替换生产内核。
6. 任何迁移都可暂停、可重跑、可审计、可回滚，并持续满足 ownership、verified assets 和 Revision CAS。
7. 用户应能看到空间由哪些工程、资产类别、历史和回收站占用，以及删除后的预计释放量。

## 4. 非目标

- 不把浏览器 IndexedDB、Cache Storage 或本地文件目录升级为生产资产源。
- 不在本卡中改变投影、UV、重绘、shader、GPU/CPU/Worker 或 export 的像素算法。
- 不自动把作者原图、模型或正式交付物改成有损格式。
- 不用数据库 ref_count 作为唯一删除依据；引用计数只能作为加速缓存，权威结论来自可重建的引用图。
- 不在第一阶段清理仍由任何现存 Revision 引用的资产。

## 5. 核心模型：逻辑 Asset 与物理 Blob 分离

### 5.0 统一端口与双存储适配

UI-16 和 application/use case 只能调用统一的 AssetStoragePort，不判断 URL、磁盘路径、4517 或对象存储。端口至少提供：读取最新占用快照、请求重新扫描、预览清理候选、创建手动清理任务、查询任务、恢复隔离资产、创建压缩候选和查询兼容验证结果。

基础设施提供两个实现：

| 运行环境 | 适配器 | 权威数据 | 隔离方式 | 最终删除 |
|---|---|---|---|---|
| 4517 集成开发/验收 | WorkspaceFileAssetStorageAdapter | 当前服务的 workspace 文件、Project/Autosave/Revision 元数据 | 原子移动到用户专属 storage-quarantine，保留原相对路径和 manifest | 恢复窗到期后由服务端受控递归删除已核对的单个 job 目录 |
| LI3D Cloud 正式站 | CloudObjectAssetStorageAdapter | PostgreSQL Asset/Reference/Revision + 对象存储 metadata | 数据库状态改为 quarantined 并设置 hold/delete_after；对象仍保留 | 后台服务按 blob_id 调用 DeleteObject，成功后记账 |

4517 只是当前浏览器一体服务的开发/验收对应路径，不是第二套生产运行时。不得恢复 4618、本地凭据、安装器或前端端点切换。适配器由服务端部署配置固定选择，浏览器看不到文件路径、bucket、objectKey 或选择开关。

两端必须返回完全相同的 Storage Overview/Scan/Cleanup/Compression Job 协议，并通过同一组契约测试。相同输入夹具在两端应给出相同的 protected/reclaimable 分类；差异只允许出现在物理隔离和删除实现。

### 5.1 物理 Blob

Blob 表示一份已经校验的不可变字节内容，同一用户范围内按以下身份唯一：

  user_id + sha256 + size_bytes

对象键建议为：

  users/{userStorageKey}/blobs/{sha256-prefix}/{sha256}

去重范围限定在同一 user_id。不得进行跨用户物理复用，避免通过时序、配额或错误信息泄露其他用户是否持有某内容。即使底层对象存储支持全局去重，控制面也必须保持用户级加密/命名和计量隔离。

Blob 状态：reserved、uploading、verified、quarantined、deleting、deleted、failed。只有 verified 可以创建下载链接或成为 Project Revision 的新引用。

### 5.2 逻辑 Asset

Asset 是用户和工程可见的稳定身份，记录 project_id、category、filename、mimeType、来源、创建命令和关联 blob_id。多个 Asset 可以指向同一个 Blob，因此：

- 同一模型可在多个工程中独立命名和管理，但只占一份用户物理空间。
- 删除一个工程只释放其 Asset 引用，不会删除仍被其他工程使用的 Blob。
- 历史 URL 可继续使用 assetId，不向浏览器暴露 Blob 键或哈希存在性。

### 5.3 显式引用

新增可重建的 asset_references，至少表达：

- current-project：当前 Project document 的字段位置
- project-revision：保留的 Revision
- pipeline-revision：UV、重拓扑、Bake 等生产产物
- active-job：进行中或可恢复的任务输入/输出
- upload-intent：尚未完成的上传预留
- pinned：用户或维护者明确长期保留
- legal-hold：运维/合规保留
- derived-from：派生预览或压缩版本对源资产的来源关系

引用行必须带 user_id，并通过数据库外键或仓储层事务验证 project_id/owner_id 所属。任何 API 都不得仅凭 assetId 跨用户解析。

## 6. 候选数据库 Schema v2

### 6.1 asset_blobs

建议字段：user_id、blob_id、sha256、size_bytes、mime_type、object_key、state、verified_at、quarantined_at、delete_after、created_at、updated_at。唯一约束为 user_id + sha256 + size_bytes；object_key 全局唯一。

### 6.2 asset_records

建议字段：user_id、asset_id、project_id、category、filename、blob_id、state、source_kind、created_by_command_id、created_at、deleted_at。asset_id 在用户范围唯一，blob_id 指向同用户 verified Blob。

### 6.3 asset_references

建议字段：user_id、reference_id、asset_id、owner_type、owner_id、owner_revision_id、field_path_hash、retention_class、created_at、released_at。owner_type + owner_id + owner_revision_id + field_path_hash + asset_id 唯一，使索引重建和重试幂等。

### 6.4 asset_upload_intents

从现有 asset_transfers 演进，增加 request_id、blob_id、reserved_bytes、expires_at、completed_at、failure_code。user_id + request_id 唯一；同一请求重放返回同一 intent/asset 结果。

### 6.5 storage_quotas 与 storage_usage_ledger

配额行保存 hard_bytes、soft_bytes、used_verified_bytes、reserved_bytes、updated_at。账本保存 reserve、commit、release、reconcile 等不可变事件及 idempotency_key。配额行可缓存当前值，但每日对 asset_blobs 重算并校正漂移。

### 6.6 asset_gc_runs 与 asset_gc_candidates

记录每次扫描的快照时间、规则版本、候选 Blob、证明摘要、预计字节、隔离时间、删除时间、错误和重试次数。不得只输出日志后立即删除。

## 7. ASSET-CONTENT-DEDUP v0.2.0

### 7.1 上传意图

1. 验证用户、活动工程、category、mimeType、sizeBytes、SHA-256 和 requestId。
2. 在数据库事务中锁定用户配额行。
3. 查询同用户 sha256 + sizeBytes 的 verified Blob：
   - 命中：不预留物理字节，不签发 PUT；创建或重放逻辑 Asset，返回 reuse。
   - 未命中：原子创建 reserved Blob，并预留 sizeBytes。
   - 命中 uploading/reserved：返回同一上传所有者或可等待状态，不再创建第二个物理对象。
4. 只有预留成功才签发 PUT。硬配额失败返回稳定错误，不产生孤儿对象。

mimeType 不作为内容唯一键，但完成时必须与允许的声明及对象 metadata 一致。同 SHA、同大小而声明类型不同应复用字节 Blob，同时让 Asset 保存其声明类型；下载响应类型由经过验证的 Asset 元数据决定。发现哈希与大小冲突时 fail-closed 并告警。

### 7.2 上传完成

1. 以 user_id + request_id/intent_id 加锁读取。
2. HEAD 验证长度、checksum 和受支持的 MIME；校验失败进入 failed 并释放预留。
3. 事务内把 Blob 改为 verified，把 reserved_bytes 转为 used_verified_bytes，并创建 Asset。
4. 同一完成请求重放返回同一 assetId，replayed=true。
5. Project 保存只能引用 verified Asset；保存事务仍执行现有 Revision CAS。

### 7.3 Project Command 幂等

如果上传由 Project Command 触发，requestId 必须由 user_id + project_id + command_id + logical_slot 稳定派生。相同 command_id 但请求摘要不同继续按现有冲突语义拒绝，不得复用旧结果。

## 8. ASSET-QUOTA-RESERVATION v0.2.0

配额至少分两类：

- 物理配额：同用户 verified Blob 的唯一字节，加当前上传预留；决定是否允许新字节进入对象存储。
- 逻辑配额：工程 Asset/Revision/任务数量或逻辑总量；防止零物理增长的重复引用无限放大数据库与 Revision。

默认数值不在设计阶段硬编码。部署配置必须明确：用户软/硬上限、工程逻辑上限、单文件上限、并发预留上限、每日新增上限。现有 160 MiB 单文件限制继续存在，但不能冒充用户总配额。

推荐交互：

- 达到软阈值：允许保存，返回占用摘要和可清理建议。
- 达到硬阈值：拒绝会增加物理字节的上传；同哈希复用、删除和导出仍可用。
- 所有失败/过期 intent 释放预留；reconciler 定期纠正进程崩溃造成的残留预留。
- 系统低空间时优先暂停新写入和清理 staging，不得缩短 current/pinned/合法保留数据窗口。

## 9. ASSET-LIFECYCLE-GC v0.3.2

### 9.1 权威根集合

每次 GC 从一致快照构建根集合：

1. 未删除工程的当前 Project document。
2. 策略要求保留的 project_document_revisions。
3. Pipeline Revision 和已发布 UV/重拓扑/Bake 产物。
4. active、queued、retryable 或仍在恢复窗内的任务输入输出。
5. 未过期上传 intent 与配额预留。
6. pinned、legal-hold 和正在迁移的资产。
7. 已签发下载链接的最大 TTL 安全窗口。
8. 被保留派生物引用的源 Blob，以及保留源引用的必要派生物。

根扫描必须解析全部已登记的资产字段。未知 URL scheme、无法解析的 Revision、引用索引与文档不一致时，本轮对对应用户/工程 fail-closed，不产生删除候选。

### 9.2 两阶段回收

阶段 A：mark 与 dry-run

- 在数据库快照中标记所有可达 Asset/Blob。
- 对未标记对象生成 candidate，记录规则版本、最后引用、项目、类别和预计字节。
- 输出报告，不改变对象可用性。

阶段 B：quarantine

- 再次扫描并确认仍不可达。
- Asset/Blob 标记 quarantined，设置 delete_after；停止为无引用 Asset 新签下载 URL。
- 对象本身暂不删除，允许维护者撤销隔离。

阶段 C：physical delete

- delete_after 到期后第三次确认无根引用、无活动租约、无 hold。
- 使用对象存储 DeleteObject；成功后写 deleted 状态和审计事件。
- 删除操作以 blob_id 幂等；对象已不存在视为成功，但必须记录 reconciliation 结果。

候选默认恢复窗口建议为 7 天，工程回收站建议为 30 天；这两个值只是初始建议，正式启用前由产品/运维批准并写入部署配置。

### 9.3 Revision 保留

第一阶段只回收“不被任何现存 Revision 引用”的 Blob，不改变 Revision 语义。

第二阶段若要释放旧 Revision 资产，必须先建立独立的 Revision 保留政策，例如：当前 Revision、手工命名/固定 Revision、最近 N 个和最近 T 天。删除 Revision document 与释放其引用必须处于同一可恢复工作流；Project Command receipt 在其幂等窗口内引用的 result_revision_id 不能先删。冷归档可替代删除，但不得让 UI 显示可恢复而实际资产已丢失。

### 9.4 工程删除

工程删除继续先软删除。恢复窗口内保留全部 current/revision/pipeline 根；窗口到期后才释放工程引用并进入普通 GC。若 Blob 同时被同用户其他工程引用，只减少逻辑引用，不减少物理 used bytes。

### 9.5 staging 与 recoveries

任务 staging、失败上传和 recoveries 使用独立短生命周期规则，不得混入正式 Asset：

- pending upload：签名过期后进入清理候选。
- failed upload：保留诊断窗口后清理。
- completed job staging：产物完成校验并写入对象存储后释放。
- retryable job/recovery：在任务恢复窗口内保留。

实际 TTL 由配置决定；任务状态未知或控制面不可用时 fail-closed。

## 10. ASSET-ROLE-COMPRESSION v0.2.0

本节算法版本随双适配与解码兼容设计升级为 ASSET-ROLE-COMPRESSION v0.2.0。

### 10.0 “存储压缩”与“图片编码压缩”的边界

存储空间优化依次采用：完全相同字节去重、不可达资产回收、有版本的图片编码派生、最后才评估历史 Revision 结构压缩。不得对所有对象统一再套 gzip/zstd：PNG、JPEG、WebP、ZIP、GLB 往往已经压缩，二次封装收益低，并会破坏 MIME、Range、对象 checksum、CDN 缓存、签名下载和直接导出契约。

HTTP Content-Encoding 只用于 JSON/文本响应，不改变 Asset Blob 身份。对象存储服务端加密、存储类别或底层压缩属于基础设施透明能力，不能改变上传 SHA-256、下载字节和 Asset verified 语义。

### 10.1 不覆盖原始 Blob

所有压缩结果都是带来源和算法版本的新派生 Blob。派生键由 source_blob_id + transform_id + params_hash 唯一确定，并受同一用户去重。原 Asset 只有通过显式、可回滚的迁移命令才可切换到新 Blob；迁移前后均记录像素/结构验证结果。

### 10.2 角色策略

| 角色 | 默认策略 | 禁止事项 |
|---|---|---|
| 模型、作者源纹理、正式交付物 | 原字节保留；可生成显式 KTX2/meshopt/Draco 等交付派生物 | 不静默替换 canonical，不改变 export |
| Capture/Generation/Layer 颜色图 | PNG 可做无损重编码；UI 可生成 WebP/AVIF/JPEG 展示副本 | 不降低 canonical 分辨率，不用展示副本参与投影/UV/export |
| Mask/Alpha | 无损 PNG 或经过逐像素证明的等价编码 | 不使用有损压缩，不改变透明像素下 RGB 契约 |
| Depth/Normal/quality buffers | 保留格式；只有算法级精确迁移并完成 GPU/CPU/Worker/shader/export 审计后才改变 | 不统一转 8-bit 有损格式，不改变通道/范围/颜色空间 |
| Thumbnail/列表预览 | 有界尺寸派生缓存，可重建、可 TTL | 不回写 Project 的 canonical URL |

### 10.3 无损验证

PNG 规范化至少验证：宽高、位深、通道、颜色空间/ICC、Alpha、解码后 RGBA 逐字节一致，以及浏览器、服务端和导出读取一致。透明像素下 RGB 也参与比较。验证失败时保留原 Blob 并记录失败，绝不降级为“看起来一样”。

当前抽样显示 PNG 无损重编码节省约 3% 至 68%，但样本收益不能直接推广为生产承诺。去重和不可达回收应先于大规模重编码。

### 10.4 当前编码兼容基线

仓库当前资产链路明确接受 PNG、JPEG 和 WebP；正式捕获、蒙版、UV 合成、重绘和纹理导出大量固定输出 PNG。AVIF 目前只在静态文件 MIME/下载工具中出现，不是完整的生产导入、GPU、Worker、服务端处理和导出契约，因此 v0.2.0 不生成 AVIF canonical，也不把 AVIF 作为必须可恢复格式。

| 编码 | 读取兼容 | 新 canonical 策略 | 展示派生策略 |
|---|---|---|---|
| PNG | 浏览器、Worker、Sharp、GPU 和导出主路径 | 首选；只做无损 deflate/filter 优化且 RGBA 完全一致 | 可生成 WebP 预览 |
| JPEG | 已支持导入和普通颜色参考 | 原件保留，不二次有损重编码 | 可按明确质量生成小尺寸预览 |
| WebP | 已支持导入、服务端识别和浏览器解码 | 原件保留；lossless WebP 转 canonical 需单独发布门禁 | 首选预览编码，失败回退 PNG/JPEG |
| AVIF | 静态托管可识别，但生产处理矩阵不完整 | v0.2.0 禁止 | 后续独立算法卡验证后再启用 |

### 10.5 资产角色兼容矩阵

| 资产角色 | Alpha/RGB 要求 | v0.2.0 允许的空间优化 | 读取与导出要求 |
|---|---|---|---|
| reference 普通照片 | 保留 ICC/方向和视觉色彩 | 原件去重；另建有损 WebP 小预览 | 生图输入仍按调用方现有明确预处理，不用 UI 预览冒充输入 |
| capture/generation/layer color | straight RGBA；透明像素下 RGB 可能有意义 | PNG 无损重编码；另建 WebP 预览 | Project/GPU/UV/export 默认取 canonical |
| mask/alpha | 每个通道值精确，禁止边缘漂移 | 仅 PNG 无损重编码 | Worker/shader/导出逐字节一致 |
| depth | 通道、量化、near/far 解释精确 | 仅容器级无损重编码 | 不改位深、通道顺序、范围或颜色空间 |
| normal | RGB 方向值和切线空间精确 | 仅容器级无损重编码 | 不做色彩增强、chroma subsampling 或有损编码 |
| baked PBR maps | 各通道语义精确 | 每个 channel 独立无损验证 | ZIP/GLB/FBX 导出文件名、MIME、像素不变 |
| thumbnail/display preview | 非权威，可重建 | 小尺寸 WebP；无支持时 PNG/JPEG 回退 | 只用于列表/大图预览，不进入生产计算 |

### 10.6 解码、颜色和方向门禁

每个候选至少执行两类验证：服务端 Sharp/libvips 解码和真实支持浏览器 createImageBitmap/HTMLImageElement 解码。验证记录必须包含 width、height、bitDepth、channels、hasAlpha、orientation、ICC profile hash、decoded RGBA SHA-256、透明像素下 RGB SHA-256 和编码器版本。

颜色图只有在两端解码 RGBA 与源图一致时才能标记 lossless-equivalent。浏览器与服务端对 ICC、EXIF orientation 或 premultiplyAlpha 结果不一致时，候选不得迁移，只能保留为非权威预览。GPU 上传继续沿用现有 flipY、colorSpace、premultiplyAlpha 设置，压缩层不得猜测或覆盖。

PNG 优化器固定版本、参数和资源上限。编码结果比源文件更大、节省率低于配置阈值、像素不一致、metadata 超限或解码失败时，任务记录 skipped，不替换 Asset。JPEG 不进行 canonical 二次编码，避免 generation loss。

### 10.7 变体寻址与回退

canonical Asset URL 永远返回权威字节，不根据 Accept 头静默变换。展示端通过显式 variant URL 请求 preview-webp-v1，并把 source Blob SHA、transform id、参数 hash 和结果 SHA 纳入 Asset metadata/ETag。这样 CDN、签名 URL、浏览器缓存和 Project Revision 都具有确定身份。

如果预览变体缺失、解码失败或客户端不支持，前端只回退到 canonical URL；不得现场生成不同质量的不可追踪结果。Project JSON 继续保存 canonical assetId，不保存短期签名 URL或预览 objectKey。

### 10.8 压缩迁移的原子性

无损 canonical 优化必须创建新 Blob，不覆盖旧对象。事务只修改逻辑 Asset 的 active_blob_id，并写 source_blob_id、algorithm_version、verification_id 和 rollback_until；旧 Blob 在回滚窗内强制 hold。Project Revision 的 assetId 不变，因此 CAS 和历史 URL 仍稳定。回滚只切回 source_blob_id，不重写 Project document。

4517 对应实现同样先写临时文件、fsync/关闭、重新解码验证，再以 Asset manifest 原子切换 active path；旧文件移动到压缩回滚区。对象存储实现先上传新 Blob、HEAD/checksum 验证，再提交数据库指针。两端都禁止原地覆盖。

## 11. API v2 兼容设计

Asset Transfer v2 的 upload-intent 响应增加 disposition：upload、reuse 或 wait，以及稳定 requestId。旧 v1 URL 和 assetId 继续可读；v1 新写入在过渡期由服务端映射到 v2 Blob/Asset 双写，不要求浏览器一次性切换。

下载流程先验证用户 ownership、活动/保留工程状态、Asset 状态和 Blob verified 状态，再签发短期 GET。工程软删除后只在恢复/维护授权路径允许读取，不再只依据 asset_transfers 中的 projectId。

## 12. 迁移与上线阶段

### Phase 0：只读盘点

- 建立对象、transfer、Project/Revision、任务和对象存储之间的 reconciliation 报告。
- 输出按用户/工程/类别的 physical、logical、reachable、unreachable、duplicate bytes。
- 任何解析错误都阻止该范围产生候选。

### Phase 1：Schema v2 影子写入

- 新建 v2 表和索引，不修改旧读路径。
- 从 asset_transfers 回填 Blob/Asset，使用现有 SHA、长度、MIME 和对象键；缺失信息用 HEAD 校验。
- 同一迁移批次可重跑，使用稳定 migration idempotency key。

### Phase 2：新写入去重与配额

- feature flag 启用 v2 intent，先内部/QA 用户，再小比例用户。
- 对比 v1/v2 记录、对象数和字节，不启用删除。
- 并发、崩溃恢复和同命令重放验收后才扩大流量。

### Phase 3：引用索引

- 对 current Project、全部 Revision、Pipeline 和任务构建 asset_references。
- 双向校验：文档解析结果等于索引；不等时禁止 GC。

### Phase 4：GC dry-run 与 quarantine

- 至少连续两个完整扫描周期候选集合稳定。
- 先对白名单 QA 用户生成报告，经人工抽查可打开、回退、导出。
- 启用 quarantine，但不调用 DeleteObject。

### Phase 5：有界物理删除

- 小批量、速率限制、按用户隔离执行。
- 每批删除前重标记；错误立即停止该用户批次。
- 监控资产 404、下载失败、Revision 恢复失败和对象存储错误率。

### Phase 6：压缩派生物

- 先启用缩略图/展示派生物，再评估 canonical 无损迁移。
- 每种 transform 独立算法版本、样本集、收益门槛和回滚窗口。

## 13. 回滚

1. 关闭 v2 write、GC 和 compression feature flags，旧 v1 读取继续工作。
2. quarantine 中的 Blob 清除 delete_after 并恢复 verified；尚未物理删除的数据立即恢复。
3. 已切换到压缩 Blob 的 Asset 根据迁移账本恢复 source_blob_id；源 Blob 在回滚窗口内必须被 hold。
4. Schema v2 表在确认所有 v2 Asset 已回退前不得 drop。
5. 已物理删除的真正不可达 Blob不从空数据重建；因此物理删除阶段必须依赖对象存储版本控制或独立、经过验证的备份策略。
6. 回滚不得改写 Project Revision、Command receipt 或伪造 verified 状态。

## 14. 验证矩阵

### 14.1 数据库与并发

- 两个并发相同 SHA 上传只能产生一个物理 Blob。
- 相同 requestId 重放返回相同 intent/asset；不同摘要冲突。
- 配额 reserve/commit/release 在进程崩溃和事务回滚下守恒。
- Project Revision CAS 失败不得留下新的引用，但已验证且暂未引用的 Asset 可由 GC 安全回收。
- 跨用户、跨工程访问全部拒绝。

### 14.2 GC

- current、全部保留 Revision、Pipeline、任务、pinned、hold 各自都能单独阻止删除。
- 引用索引缺失、未知 URL、数据库不可用、对象存储 HEAD 异常时 fail-closed。
- dry-run、quarantine、delete 重跑幂等。
- 同 Blob 被两个工程引用时，删除一个工程不删除物理对象。
- 已签发下载链接在最大 TTL 加安全窗口内不被删除。

### 14.3 压缩

- RGBA、尺寸、位深、颜色空间和透明像素下 RGB 对照。
- Chrome/Edge 解码、服务端 Sharp/生产处理、GPU 上传、Worker、shader、Persistence 和 export 对照。
- Mask、Depth、Normal 分别使用专用夹具，不以颜色图测试代替。
- 任何 QA 失败都保留 canonical 原资产并停止迁移。

### 14.4 端到端

- 创建、保存、刷新、历史恢复、复制、删除/恢复工程、生成、局部重绘、UV、重拓扑、Bake 和导出。
- 在上传中断、任务中断、GC 与保存并发、GC 与下载并发下无 404 或错误删除。
- 大工程分页扫描不把完整文档集一次性载入内存。

## 15. 可观测性与管理界面

必须提供：

- 每用户/工程 physical bytes、logical bytes、reserved bytes、可回收 bytes。
- 按 models/references/captures/generations/layers/baked/staging/revisions 分组。
- dedup hit rate、上传避免字节、GC candidate/quarantine/deleted bytes、压缩节省率。
- 最近 GC run、规则版本、失败原因和人工 hold。
- 用户可见的回收站到期时间，以及“清空回收站”的明确二次确认；后台不得暗中缩短期限。

管理 API 默认只读。执行 quarantine/restore/delete 必须有维护角色、审计事件和稳定 idempotency key；批量物理删除不允许从浏览器直接签发。

### 15.1 UI-16 首页入口

入口位于工程列表主界面的用户菜单，在“解除当前用户的莉刻账号”和“日志监测”之间增加“存储空间”行。菜单只显示已用空间、可安全清理空间和“管理”，不在窄菜单内直接执行清理。

点击打开居中的“存储与清理”模态层：

- 顶部说明当前项目、保留历史、运行中任务和 verified 生产产物受保护。
- 两个主指标：已用空间、可安全清理；无总配额时不得伪造百分比或可用空间。
- 分类固定为项目资源、历史版本、任务临时文件、回收站；每行显示物理字节、保护/可清理状态和明细入口。
- 底部显示上次扫描时间、规则版本和扫描是否完整。
- “重新扫描”只创建后台 inventory job，不在 React 中遍历工程或资产。
- “清理无用资源”先打开候选确认，不直接永久删除。

当服务端尚无快照时，菜单显示“存储空间 · 待扫描”，弹窗只允许重新扫描；不得以 0 B 表示未知。当扫描不完整、发现未知 URL/Schema、引用索引漂移或后台不可用时，可清理量显示“暂不可计算”，清理按钮禁用并说明原因。

### 15.2 手动清理流程

1. 用户点击“清理无用资源”。
2. 服务端要求最新完整 scanId 及其原子候选快照；缺失或过期快照要求先重新扫描。
3. 确认页按类别展示数量和预计字节，明确“当前项目和保留版本不会删除”。
4. 用户确认后立即创建 cleanup job；后台读取最新引用并逐项验证扫描快照，扫描后新增文件不处理，后来恢复引用或大小变化的候选跳过，其他候选继续处理。
5. 第一阶段只移入隔离区，默认建议 7 天可恢复；完成页显示实际隔离字节、跳过数量和原因。
6. 用户可在“隔离区”查看并恢复；永久删除由到期后台任务或单独的明确二次确认执行。

手动清理只能选择服务端标记为 reclaimable 的类别。项目资源和保留历史行即使被选中也不得传给删除 API。请求必须包含 scanId 和 idempotency key；相同 key 重放返回同一 cleanup job。

### 15.3 手动图片优化流程

弹窗提供与清理分离的“优化图片存储”操作。预览阶段只报告可优化图片数、预计节省区间、兼容性检查状态和跳过原因；用户确认后创建 compression job。运行期间不锁定工程编辑，单个 Asset 切换必须原子；正在保存、上传、导出或被任务租用的 Asset 本轮跳过。

完成结果分别显示：去重节省、无损编码节省、展示预览节省、因兼容问题跳过。不能把清理候选字节和压缩预计节省相加后重复展示。

### 15.4 首页性能边界

工程页首次渲染只请求一个小型聚合快照，并与工程/文件夹请求并行。菜单关闭时不加载分类明细，打开弹窗后才请求详情；候选列表分页并使用稳定 cursor。不得把 Asset 列表、Project document 或 Revision JSON 序列化到首页，也不得让存储统计订阅编辑器 Zustand store。

## 16. 首个实施变更的建议范围

第一张实现卡只做 Phase 0 + Phase 1：

1. 新增 Schema v2 表和 repository，但保持旧读取。
2. 新增只读 inventory/reconciliation runner。
3. 对现有 Cloud transfer 做可重跑回填和 HEAD 校验。
4. 生成 dry-run 报告，不做 quarantine、DeleteObject、Project Revision 删除或压缩替换。

这样可以先证明引用图、物理计量和迁移正确，再分别提交去重写入、GC 与压缩，保持一张变更卡只解决一个聚焦问题。

## 17. 发布门禁

- 未完成 Schema migration/rollback 演练，不得启用 v2 写入。
- 未完成全引用类型覆盖与两周期稳定 dry-run，不得 quarantine。
- 未验证对象存储版本控制/备份恢复，不得物理删除。
- 未完成角色级像素/通道/导出对照，不得切换 canonical Blob。
- 不允许以降低分辨率、关闭 QA 或删除历史资产来满足空间指标。
