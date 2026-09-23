# LI3D 全仓性能审计：2026-09-07

> 历史审计快照：本文件的文件数、测试数、Git 基线和“当前”判断只对应 2026-09-07。2026-09-17 的现状、热点优先级和最小稳定性修复见 [PERFORMANCE_STABILITY_RISK_AUDIT_2026-09-17.zh-CN.md](PERFORMANCE_STABILITY_RISK_AUDIT_2026-09-17.zh-CN.md)。

扫描基线：master `db68dd8` 加本地图片 decode 与项目列表查询补丁。随后按维护者要求快进到 master `5c672ca`，保留其图片解码修复及统一提示词；本地补充两种生成入口的实际 bitmap 调用回归，并继续优化烘焙 I/O。审计版本 1.1。release 未改动。本报告是全仓静态筛查与重点路径审计，不表示逐行人工审查完成，也不表示全部操作已达到零掉帧。

## 范围与证据口径

TypeScript AST 扫描覆盖 apps/web/src、apps/server/src、packages、根 scripts 中的 JS/TS 系列文件：443 文件、139,359 行，无语法解析错误。分布：Web 321 文件/112,773 行；Server 65/19,819；packages 24/978；scripts 33/5,789。排除 node_modules、dist、二进制资产；应用级测试目录、SQL、PowerShell 与部署配置不计入这些数字。SQL 索引和 CI 发布门禁另行核对。

扫描记录 324 处 store 订阅、82 处并发聚合、72 处同步像素读取/编码、326 处序列化/克隆、10 处帧回调、75 处同步 I/O/压缩候选。数量是静态调用点，不是实测热点数量；Worker、初始化与前台交互必须分开判断。没有发现无 selector 的整个 Zustand store 订阅，不应据此把所有 selector 都认定为高效。

浏览器证据沿用本轮已完成的九模型/4K/1280×720/双面板/36 次同序选择。decode 补丁后两次为 58.5/58.6 FPS、P95 16.8ms、峰值 50ms；React Scheduler MessagePort 曾出现 49.3ms LoAF。没有新的生产 GPU 采样、付费生成或正式导出基准；静态调用链不能直接解释这些长帧。

## 模块覆盖与下一步验证

| 模块 | 本轮检查入口/范围 | 判断与下一步 |
| --- | --- | --- |
| M01 工程 | postgresProjectRepository、项目摘要及旧工程默认值 | 已修复列表完整 JSON 传输；公共响应深度对照通过。保存协议不变。 |
| M02 导入/资产 | 资产传输、模型相关大组件及并发调用扫描 | 大模型加载/并行解码仍需冷启动内存采样；不得跳过 verified asset 校验。 |
| M03 场景 | SceneRoot/ImportedModel、ViewportCanvas、选择与帧回调 | project 对象级订阅及各模型图层签名计算是优先候选；需 React commit 归因和每模型重渲染次数。 |
| M04 生成 | GeneratePanel、服务层序列化/并发调用筛查 | 返图 JSON/图像处理须分开计时；未重跑付费生成，不给服务端推理提速结论。 |
| M05 图层 | LayersPanel、SceneRoot 图层订阅 | 已有小图缓存；继续核对选择变化时无关模型/行的重算。禁止延迟真实显隐或混用作者 mask。 |
| M06 投影 | SceneRoot、ProjectedLayerMaterial、预热/纹理生命周期相关调用 | 首次编译和后续 React 工作需独立测量；保留 CPU/Worker/shader/UV/export 等价边界。 |
| M07 UV/PBR | gpuUvBakeRenderer | 已有分条异步读回和转换 Worker，不能把异步总时长当主线程阻塞；下一步量化上传、fence、转换峰值。 |
| M08 重绘 | ViewportCanvas 共享加载器与解码回归 | 原图 decode 屏障已实现；不承诺稳定 FPS 增益，完整分辨率和原像素路径不变。 |
| M09 接缝 | runSurfaceAwareRepair、Worker 入口 | 默认 Worker，终态与取消清理可见；复制输入/transfer 的大图峰值仍需实测，不能 detach 调用方持有资产。 |
| M10 生产计算 | substanceBakeService 产物下载/粗糙度阶段 | 整图读写已改为异步；原字节、完整写入后尺寸校验、错误不发布的回归通过。24 字节 PNG 头读取和小型任务记录仍为同步，未宣称完全消除阻塞。 |
| M11 导出 | engine/export/exportZip、服务端 exportService | 浏览器 ZIP 全文件同步 CRC 后再复制所有 chunk，可能造成长任务与内存峰值；服务端 .liclick3d 入口尚为 coming-soon，不能计作生产 ZIP 优化目标。 |
| M12 状态/历史 | projectSaveCoordinator、序列化/克隆筛查 | 已有 2 秒 trailing、10 秒 maxWait 和仅保留最新 pending 的串行保存；保留 CAS/失败传播，后续测量快照构造成本。 |
| M13 平台 | telemetryClient、认证与同步 I/O 候选 | 遥测队列上限 200、批量 20、8 秒发送超时；localStorage 同步序列化仍需测量。认证缓存不得破坏证书轮换/过期检查。 |
| M14 数据 | PostgreSQL 列表、部分索引、assetTransferService | 新查询只返回摘要 JSON；沿用 user_id 与 deleted_at 谓词及现有部分索引。 |
| M15 工程质量 | 回归套件、包体、Cloud/repository 边界、master CI 规则 | 同步前正式 Web 包体仅余 3 bytes；同步提示词精简后为 3,130,643 bytes。后续前端改动仍须连同发布身份构建，不提高预算掩盖膨胀。 |

## 已实施：项目列表传输裁剪

主模块 M14，协作 M01；查询契约 `PERF-PROJECT-LIST-001` v1.0.0，图像算法版本不变。`apps/server/src/repositories/postgresProjectRepository.ts` 的 list 原先 SELECT 完整 document_json，再由 Node 取七项摘要字段。新查询在 PostgreSQL 中用 jsonb_build_object 返回 id/name/folderId/createdAt/updatedAt/thumbnail/revision，仍从同一 JSON 取值，保留 slug、用户过滤、软删除过滤、updated_at DESC 和原 URL/默认值处理。

PGlite 实际 SQL 回归构造含 2 MiB 捕获元数据的工程，与旧完整 SELECT 映射得到的公共摘要深度比较：数据库响应 JSON 从 **2,099,910 bytes 降到 921 bytes（约 99.956%）**。完整 load 仍返回全部捕获和图层，其他用户返回空列表，缺失可选字段的旧工程仍得到相同默认值。这是固定测试夹具的传输体积，不是线上延迟或数据库 CPU 提升比例；PostgreSQL 仍可能解压读取 JSONB，且列表仍没有分页。

既有 `apps/server/sql/001_project_documents_postgres.sql` 已有 `(user_id, updated_at DESC) WHERE deleted_at IS NULL` 索引，本轮不增加重复索引。未来大账号列表应单独评估分页与摘要持久列，不在本次引入 Schema 或写入双份摘要的一致性负担。

## 按优先级继续拆解

后端追加审计：`bakeArchiveService` 流式 CRC 已改为索引读取，16 MiB/64 KiB 分块累计 CPU 中位 46.90→25.60ms；真实慢 Writable 背压、文件流、完整 ZIP 字节和 400 组分块边界对照通过。测试命令 `node apps/server/scripts/test-bake-archive.mjs --benchmark`。`listNormalBakeJobs` 每次同步枚举目录并按需 loadJob，存在历史任务较多时的阻塞风险；但 getNormalBakeJob 会检查 owner 并恢复监控，不能用未经失效设计的目录缓存替换。`identityTelemetryService.ingest` 受 runExclusive 保护，在追加去重事件后执行 persistAggregates，聚合成本应结合历史事件量测量，不能跳过重放/身份迁移。`postgresControlRepository` 的任务历史已按用户和 LIMIT 查询；鉴权用户查询与身份字段不应仅为减少 JSON 而裁掉。前端静态文件服务存在多次同步 stat，但生产 nginx 与本地集成进程须区分优先级。这些是代码风险定位，不是线上压测结论。

1. **模型切换的 React 工作量**：`2dc1c02` 推送后的本地补丁已将 ImportedModel 当前工程订阅缩窄为实际消费的 id/captures/bakedTextures，使用已安装 useShallow 保持相同引用。九模型×100 次无关改名/时间/activeObjectId 更新不再使订阅失效；捕获/贴图/工程身份/移除/恢复仍触发更新。需要后续浏览器 commit/FPS 对照，不把订阅失效减少等同于所有组件渲染消失。
2. **浏览器 ZIP 导出**：`2dc1c02` 推送后的本地补丁已移除构造 Blob 前的整包 JS 复制，16 MiB 文件夹具减少 16,777,979 bytes 显式复制；固定时间戳下完整 ZIP 逐字节与冻结旧实现一致，TypedArray/DataView 偏移和发布后输入修改隔离通过。随后 CRC 改为索引读取，Node 24 / 三轮预热、七轮交替、16 MiB 隔离中位 80.55→26.25ms（约 67% CPU 用时减少），标准向量和 400 组独立 oracle 对照通过；执行 `node apps/web/scripts/test-export-zip.mjs --benchmark` 可复测。此为隔离 CPU 结果，不是浏览器 FPS；同步循环仍待拆分，须保持调用方 buffer 生命周期与输入快照一致性，不能仅给函数加 async。
3. **烘焙产物同步 I/O**：粗糙度分支整张 PNG 读写已改为 fs.promises 并等待完成。回归执行编译后真实阶段，验证读取/远程调用/写入/尺寸检查/输出发布顺序及五类错误；待量化同进程请求延迟和大批次内存。保留 24 字节 PNG 头校验以及任务记录同步写入，未改变远端推理或取消协议。
4. **大数据序列化与恢复**：区分 API JSON、自动保存快照、历史克隆、遥测小批量与 Worker 传输；记录字节数、调用频率和 P95，不因出现 JSON.stringify 就统一改动。
5. **首次编译/上传与多模型驻留**：记录 CPU 提交、GPU fence、解码和显存生命周期。保持生产 shader、QA、原始分辨率、遮罩与导出结果；不得用隐藏模型或降低质量使帧指标好看。

## 验证、迁移与回退

推送前远端再新增 `c0c15cb`：本地提交已 rebase 到该提交，运行时显隐判断修正保留，交接测试冲突整合为真实 helper + 同/跨对象/隐藏/未指定 visible/legacy 用例。86 项 Web 与 12 项 Server 全回归发生在此次重放前；重放后两项相关交接回归通过，不混淆两个验证时点。

最终 master 集成：合入 `4fe9a58`，修正旧交接测试夹具以覆盖上游新增的可见性/对象身份门禁；原同对象 resident 等待断言继续保留。前端 86 项、后端 12 项回归通过；完整 Cloud 发布构建、artifact/包体、全仓 lint（零错误）、部署策略 5 项测试及边界检查通过。正式构建 80 chunks / 3,131,704 bytes。新增优化按 ZIP、模型订阅、服务端归档分开提交；本节更新覆盖前文各阶段“仍在本地”的状态描述，实际推送与 CI 结果见本次任务最终回复。未变更 release。

CRC 索引读取追加验证：86 项 Web 回归通过，正式身份构建 80 chunks / 3,131,527 bytes，通过原门禁，目标 lint 与 Cloud/repository 边界通过。本轮性能数字为可复测的 Node 隔离 CRC 耗时，未补录浏览器 FPS；仍属未推送的本地后续优化。

`2dc1c02` 推送后新增的 ZIP/模型订阅补丁：86 项 Web 回归通过，正式构建 80 chunks / 3,131,497 bytes，typecheck/目标 lint/Cloud 与 repository 边界/diff 通过。4517 工程恢复和杯子/桶切换的贴图呈现正常，最终桶/Saved，浏览器 error 为空；初次切换窗口仍有 83ms 峰值，未做严格 FPS 因果对照。这两项补丁尚未推送，不属于 `2dc1c02` 的 CI。GitLab 双重验证待维护者完成，按其要求先继续性能，不报告未核实的流水线结果。

后端完整回归 **11 contracts 通过**，覆盖 PostgreSQL 仓储/控制面/soak、资产传输、项目流水线、任务历史等。本轮共享图片 decode 补丁的 Web **84 contracts 通过**，正式发布参数构建 80 chunks / 3,133,997 bytes，通过原 3,134,000-byte 门禁；这些是本地验证，不能代替新提交的远端 CI。

同步 `5c672ca` 后重新验证：正式发布身份构建 80 chunks / **3,130,643 bytes**，门禁通过；包含异步粗糙度回归的后端 11 contracts、前端完整 84 contracts 均通过，修改后端文件 lint、Cloud/repository 边界和 diff 检查通过。4517 健康检查 HTTP 200，前端 dist 已更新；正在运行的后端进程不会因编译自动加载本地服务端补丁，需后续重启才能使用新服务端代码。未触发新 CI 或生产部署。

本次查询不修改 GPU/CPU/Worker/shader、投影/UV/repaint/export 算法、像素、分辨率或 QA；不修改 Command 幂等性、Revision CAS、ownership、verified assets、Schema 或工程数据，无迁移。回退仅恢复列表 SELECT 完整 document_json 与对应类型；保存和历史无需恢复操作。decode 回退与证据见唯一维护准则中的 CHG-20260907-REPAINT-IMAGE-DECODE。
