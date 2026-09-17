# LI3D 全仓性能稳定性与风险热点审计：2026-09-17

审计运行时代码基线：`master`（含本文件同次内容填补候选变更），Node.js `v24.15.0`，pnpm `9.15.4`。本文件记录本次静态审计、回归证据和已落地的小范围稳定性修复；不代表生产环境压测，也不把文件体积或静态调用点直接等同于线上瓶颈。提交与远端推送状态以本轮最终交接为准；本文不把远端流水线已触发或页面图标状态写成 CI 已通过。

## 1. 范围与结论

- 扫描 843 个受 Git 跟踪的 TS/TSX/JS/MJS/CJS/CSS/GLSL/JSON/SQL 源文件，共 186,328 个非空行；另有 320 个 Markdown 文档。
- Web 有 154 个独立 `test-*.mjs` 文件，Server 有 25 个；按当前静态口径，146 个测试读取实现文件，89 个使用 `new Function` 执行隔离实现片段。覆盖面强，但对重构形状敏感，不能把“测试多”直接解释为真实浏览器性能已通过。
- 本轮没有证据支持大规模拆文件、替换投影/UV 内核或降低质量。最高风险集中在少数巨型编排文件、GPU/CPU/Worker/shader 多实现一致性、Server 历史目录同步 I/O、测试基础设施偶发失败和文档当前/历史状态混用。
- 按“先稳定、后优化”原则，基础审计先修复四个确定性服务端风险并修正一个既有冒烟前提；随后针对用户真实放大截图，补充修复内容填补把已显示为深色斜线的小缺口误判为噪声的问题。后者会增加应有的稀疏 underlay 输出 texel，但不改变有效投影像素、分辨率、QA、投影 shader、导出合成、Project Command、Revision CAS、ownership、verified assets 或 Schema。

## 2. 已验证门禁

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| 全仓 TypeScript | 通过 | 6 个 workspace package 通过 |
| 全仓 lint | 通过 | 0 error；Web 保留 2 个既有 unused warning |
| 生产依赖审计 | 通过 | 268 个生产依赖，high 及以上为 0 |
| Contracts | 通过 | 9 项 |
| Web 回归 | 通过 | 147 contracts |
| Server 回归 | 通过 | 25/25；新增 Asset 历史刷新协调器契约，并保留导入 UV、Bake、PostgreSQL、ownership 等既有回归 |
| Cloud boundary | 通过但范围有限 | 只扫描 `apps/web/src`、`apps/server/src`、`packages/contracts/src`；不等于全仓没有历史 4618/安装器代码 |
| Project repository boundary | 通过 | 业务层未扩散文件系统 Project Repository |
| 生产构建与包体 | 通过 | 当前 release 候选 108 个 JS chunks，共 3,227,295 bytes；Cloud 产物 221 个文件、25.04 MiB；现有各分包预算均未提高，额外 256-byte reserve 检查通过；Editor route 尚余 4,249 bytes，仍需保持警惕 |
| 本地 API / 集成 Web 冒烟 | 通过 | API 启动、鉴权、工程/资产、CORS/HEAD/隔离与集成 SPA/API 边界通过；旧资产恢复夹具修正后重跑通过 |
| Cloud 部署模拟 | 通过 | OAuth/PKCE、代理路径、对象直传重试、幂等、优雅停机和重启恢复通过 |
| 模型导入独立浏览器回归 | 通过 | `check:import-uv-browser` 使用实际 Playwright 浏览器执行；除 Float32 UV、indexed/小面积、确认/取消/Escape/切工程、失败 QA、修复文件再加载和释放外，也覆盖严格 150 万面减面阈值、>200 万面可处理、保留 UV 绕过、减面与 UV 分步授权及两阶段重载；该脚本不在默认 Web 147 项内 |
| Cloud release readiness | **未通过，禁止据此发布** | 仓库矩阵仍有 8 项 required capability 为 `in_progress`：真实 SSO、真实贴图工作流、生产 UV/Bake/拓扑、工具箱能力、交互性能、生产数据面 |

## 3. 本轮小范围稳定性修复

### 3.0b 内容填补余量的按需物理缝 fallback

- 主模块：`M07`，协作 `M05/M06/M08/M09`；契约 `LOCAL-BOUNDARY-REPAIR/1.4.0` / `CONTENT-REPAIR-SEAM-FALLBACK/1.0.0`。
- 风险：严格同 region 策略会让“本 UV 岛完全空白、但同一真实网格表面的相邻 UV 岛已有可靠颜色”的区域永久没有 donor；直接启用全局平均或无界跨 seam 会造成跨材质污染。
- 修复：保留首轮 no-seam 快路径；只有首轮确有 residual 才按需构建同 Mesh/同材质/法线兼容的物理 seam links，第二轮最多跨一条 seam 且只写 residual mask。首轮 buffer 原地回传、收缩和 Worker 内合并，不复制一套 4K continuation RGBA+mask。
- 并发/性能边界：工作仍在浏览器 Worker，服务器控制面与生产计算服务不增加请求扇出；无 residual 时不构建 seam 拓扑、不加载 6.68 KB fallback chunk。复杂残余模型会多一次拓扑与 Worker pass，这是明确的质量换时延边界。
- 质量边界：不保证孤立且无可靠 donor 的区域达到字面 100%；跨 Mesh、跨材质、硬法线不兼容和第二条 seam 仍 fail-closed，不用全局平均色掩盖。
- 证据：专项 33/33、拓扑、UV seam/gutter 冻结核、单视图 completion、TypeScript、生产构建及 256-byte 包体预留通过；Edge 2048² Worker/主线程首轮字节差 0，零拷贝 residual + 单物理缝第二轮余量 0、控制台 0 error；Editor route 494,775 / 499,024 bytes，release 总 JS 3,227,295 / 3,256,500 bytes。
- 变更卡：[CHG-20260917-CONTENT-REPAIR-BOUNDED-SEAM-FALLBACK](changes/CHG-20260917-CONTENT-REPAIR-BOUNDED-SEAM-FALLBACK.md)。

### 3.0a 内容填补 Worker 结果内存

- 主模块：`M07`；契约 `LOCAL-BOUNDARY-REPAIR/1.3.1` / `CONTENT-REPAIR-WORKER-RESULT/1.0.0`。
- 风险：正式发布只读取稀疏 RGBA 与统计，旧 Worker 协议仍把两张完整 byte mask 转移并驻留在 UI 线程；4K 增加约 32 MiB 瞬时保留，连续填补、上传和 PNG 编码重叠时扩大 GC/内存压力。
- 修复：生产调用显式关闭诊断回传；诊断与测试默认契约不变，Worker 内部仍完整计算 mask、checksum 和 QA 统计。
- 证据：专项 32/32；Edge 2K 精简 Worker/主线程 RGBA 字节差 0；Edge 4K 精简 Worker 修复 524,288 texel，真实空洞透明、无全局兜底。本次不宣称 4K 计算耗时已经解决。
- 变更卡：[CHG-20260917-CONTENT-REPAIR-WORKER-RESULT](changes/CHG-20260917-CONTENT-REPAIR-WORKER-RESULT.md)。

### 3.0 放大视图内容填补深色斜线

- 主模块：`M07`，协作 `M05/M06/M08/M09`；契约 `LOCAL-BOUNDARY-REPAIR/1.3.0` / `ALG-CA-001` v1.1.0。
- 风险：正式缺口扫描在 4K 下会拒绝面积不足 256 texel 且跨度不足 48 texel 的连通分量；这些 texel 已被实时 shader 显示为深色空洞斜线，因此在圆环、螺栓和曲面交界放大后形成明确的未补全区域。
- 修复：正式可见表面策略保留严格 UV core 内全部斜线缺口；真实几何空隙、core 外 halo 和跨 region 写入仍禁止。生产传播固定不跨 seam，因此不再构建/传递 seam links；字节级固定点允许安全结束局部混合。
- 性能边界：Edge 4K 合成渐变夹具 Worker 约 2.78 秒，未证明复杂真实工程达到帧预算；本次只删除无效 seam 工作并改善平坦区域收敛，不降低分辨率、迭代精度或 QA。
- 变更卡：[CHG-20260917-CONTENT-AWARE-HATCH-GAPS](changes/CHG-20260917-CONTENT-AWARE-HATCH-GAPS.md)。

### 3.1 Bake 历史列表异步化与并发合并

- UI/模块：任务历史 → `M13`，协作 `M10`。
- 契约：`BAKE-HISTORY-LIST/1.1.0`。
- 风险：`listNormalBakeJobs` 原来在 HTTP 请求内使用 `readdirSync`，并对每个未缓存任务同步 `readFileSync + JSON.parse`；输出构建还同步执行 `exists/stat`。多个用户同时打开历史页时，会重复扫描同一目录并阻塞 Node 事件循环，连带影响登录、保存和健康检查。
- 修复：目录枚举、未缓存 Job JSON 和产物 metadata 改为 `fs.promises`；并发请求共享同一次目录扫描与最多 8 路有界读取；批次内按持久化 owner 建索引；单请求逐任务检查输出，避免 100 条历史一次扇出数百个文件操作。
- 保持不变：owner 校验、无 owner 旧任务拒绝、未终态远端监控恢复、输出 URL、任务 JSON 格式和历史排序。
- 并发冒烟：10 个身份、34 个归属任务、1 个无 owner 任务、40 个同时鉴权请求全部保持 owner 隔离；匿名/跨账号下载门禁继续通过。
- 变更卡：[CHG-20260917-BAKE-HISTORY-CONCURRENCY](changes/CHG-20260917-BAKE-HISTORY-CONCURRENCY.md)。
- 回滚：恢复同步 `listNormalBakeJobs` 与路由同步调用即可；不需要迁移或删除任何 Bake Job。

### 3.2 资产传输回归端口抖动

- 模块：`M15`，契约 `ASSET-TRANSFER-TEST-PORT/1.0.0`。
- 风险：Windows 可能让 `listen(0)` 返回 Fetch 规范禁止的端口。本轮首次完整 Server 回归拿到 `6000`，Node Fetch 在发包前以 `bad port` 拒绝，形成与资产签名/校验无关的偶发红灯。
- 修复：测试监听器最多重试 10 次，并拒绝 WHATWG Fetch 禁止端口；真实上传、checksum、幂等完成、ownership、下载与删除断言保持不变。
- 生产影响：无。此变更只稳定测试夹具，不放宽生产 URL、对象存储签名或浏览器安全策略。

### 3.3 Bake 产物验收异步文件 I/O

- 主模块：`M10`，协作 `M13/M15`；契约 `BAKE-ARTIFACT-IO/1.1.0`。
- 风险：远端产物下载处于异步函数，但缓存 `stat`、Base Color 存在检查和 PNG 24-byte 文件头读取仍使用同步文件 API；共享卷抖动时会阻塞同一 Node 进程的其他用户请求。
- 修复：改为 `fs.promises.stat/access` 与异步 `FileHandle.read/close`；缓存异常仍按未命中重新下载，PNG 必须完整写入并验证尺寸后才发布 output。
- 保持不变：SHA-256、MIME、通道选择、分辨率、失败门禁、任务 JSON、远端幂等性和资产 URL。
- 变更卡：[CHG-20260917-BAKE-ARTIFACT-ASYNC-IO](changes/CHG-20260917-BAKE-ARTIFACT-ASYNC-IO.md)。

### 3.4 本地 API 冒烟旧资产夹具修正

- 完整构建后的 `smoke-local-server` 暴露出既有夹具错误：缺失引用修复只识别旧版确定性 `<layer-id>.png` 文件，但夹具上传的是当前 UUID 防冲突文件，却错误要求服务端猜回该随机 URL。
- 修正：夹具显式种入旧版确定性 image/mask/depth 文件，再删除项目引用并验证三项恢复；当前 UUID 上传、正常保存、volatile 保护、外部 workspace URL 保持、CORS/HEAD/隔离断言仍保留。
- 生产影响：无。没有放宽资产推断、ownership 或 verified asset 门禁；避免用不可能满足的测试前提掩盖真实冒烟结果。

### 3.5 UV/拓扑历史远端刷新有界化

- 主模块：`M13`，协作 `M10/M15`；契约 `ASSET-HISTORY-REFRESH/1.0.0`。
- 风险：原 `refreshedAssetHistory()` 对最多 100 条活动记录直接 `Promise.all`。同一用户多个标签页或多个用户同时打开历史时，远端 Asset 查询按“请求数 × 活动任务数”放大，且每个查询最长 2.5 秒。
- 修复：进程全局最多 8 路、单用户最多 4 路；同一用户同一 Job 的并发刷新共享 in-flight Promise。HTTP 请求最多等待 2.75 秒，预算结束后返回当前持久记录，剩余刷新继续在有界队列完成。
- 真实 HTTP 冒烟：临时自签 CA、严格 TLS 的 Asset 模拟器下，两个身份、12 个活动任务、16 个同时历史读取测得全局 8/8、单用户不超过 4、每个活动 Job 仅一次远端访问；终态更新、重启恢复、legacy deny 和 ownership 隔离通过。
- 保持不变：历史 limit/排序、可信远端 kind 恢复、终态判断、失败保留、产物过滤、PostgreSQL/本地持久化、Asset API/TLS 与 ownership。
- 变更卡：[CHG-20260917-ASSET-HISTORY-REFRESH-CONCURRENCY](changes/CHG-20260917-ASSET-HISTORY-REFRESH-CONCURRENCY.md)。

## 4. 当前热点与处理优先级

| 优先级 | 模块/热点 | 证据 | 当前处理原则 |
| --- | --- | --- | --- |
| P1 | `M03/M08` `ViewportCanvas.tsx` | 15,396 行；约 46 个 effect、71 个 callback、31 个 state | 暂不大拆。先用 Performance Lab 在固定真实项目记录 input-to-present、LoAF、React commit 与 GPU 阶段，再按单一用例迁出；任何拆分须保持画笔/橡皮、GPU/CPU/Worker/导出等价 |
| P1 | `M06` `ProjectedLayerMaterial.ts` + `SceneRoot.tsx` | 5,437 + 5,231 行；材质驻留、上传、编译、生命周期高度耦合 | 禁止凭文件大小重写。只在真实 profile 锁定上传、编译或发布阶段后做单点修复，并跑 WebGL 像素 parity、取消和资源释放回归 |
| P1 | `M04/M12` `EditorPage.tsx` + `GeneratePanel.tsx` | 7,894 + 5,769 个非空行；页面仍承担跨任务编排 | 不在本轮拆层。优先减少可测的重复序列化、重复捕获或无关订阅，不移动算法常量到 React/Zustand |
| P1 | `M07` UV 合成与回读 | 两个核心 Bake 文件各约 2.1K 行，且有 CPU/GPU/Worker/shader/export 对应实现 | 所有性能修改必须做完整字节/像素 parity、4K、取消和资源所有权检查；不得降分辨率或跳过 QA |
| P1（本轮已修确定性缺口与结果驻留） | `M07` 内容识别填补 | 4K 分量门槛会丢弃已显示为深色斜线的小缺口；旧发布结果额外驻留约 32 MiB 诊断 mask；复杂 4K Worker 仍为秒级 | 已保留全部严格 core 斜线 texel、移除无效 seam 工作并停止生产回传未消费 mask；继续以真实工程记录总耗时、未达 texel、内存峰值和最大帧，不用降低分辨率掩盖热点 |
| P1 | `M10/M13` Bake Job 文件持久化 | 历史并发请求已共享扫描，列表 metadata 与产物验收已异步化；但远端轮询状态通过 `persist()` 同步 `mkdirSync/writeFileSync` 重写 `job.json`，任务与共享卷增多时仍可阻塞同进程其他用户请求 | 下一补丁优先做同 Job 串行、可等待、崩溃一致的异步持久化；不得丢终态、重排状态或牺牲重启恢复，先加故障注入和写入顺序回归 |
| P2（已修复，待生产观测） | `M13` UV/拓扑历史远端刷新 | 已使用全局 8、单用户 4、同 Job in-flight 合并和 2.75 秒响应等待预算；严格 TLS 多身份冒烟通过 | 生产记录队列深度、等待预算命中率、远端 P95/P99 和持久记录滞后；不因本地模拟通过而宣称生产容量完成 |
| P1 | `M10/M13` Bake 下载与 ZIP | 历史输出 metadata 已异步，但单文件下载和 ZIP 归档仍通过 `getNormalBakeOutputPath` / `bakeArchiveService` 使用同步 exists/stat；多用户集中下载时共享卷延迟仍进入 HTTP 热路径 | 改为异步 metadata/打开文件并保留普通文件、owner、成功终态、通道及归档字节门禁；与 Job 持久化分开提交 |
| P1 | `M15` Cloud boundary 覆盖范围 | 门禁报告 0 legacy，但仓库仍跟踪 Photoshop UXP `127.0.0.1:4618` 和历史本地脚本 | 这些文件不得进入生产依赖图。后续应把“生产根通过”和“全仓仍有历史代码”分开报告，避免 0 legacy 被误读为全仓清零 |
| P2 | `M15` 测试形状耦合 | 按当前静态口径，146 个测试读取实现文件、89 个使用 `new Function` | 保留现有快速门禁，同时逐步补真实模块/API/浏览器路径；大重构前先识别会因文本形状而误报的测试 |
| P2 | 文档状态漂移 | 旧交接包仍写 `codex/modernization`，当前代码在 `master`；8K 和生成提供方描述混用历史状态 | 当前真值统一指向系统准则和本审计；日期快照加历史标记，不反写历史事实 |

## 5. 热点文件基线

| 文件 | 行数 | 风险性质 |
| --- | ---: | --- |
| `apps/web/src/engine/viewport/ViewportCanvas.tsx` | 15,396 | 高频输入、绘制、蒙版、历史、GPU 资源和 UI 生命周期集中 |
| `apps/web/src/routes/EditorPage.tsx` | 7,894 | 工程恢复、保存、Merge、路由编排集中 |
| `apps/web/src/components/panels/GeneratePanel.tsx` | 5,769 | 捕获、远端生成、恢复、局部重绘编排集中 |
| `apps/web/src/engine/projection/ProjectedLayerMaterial.ts` | 5,437 | shader、纹理数组、上传、预热和发布集中 |
| `apps/web/src/engine/viewport/SceneRoot.tsx` | 5,231 | R3F 生命周期、材质切换、驻留与选择耦合 |
| `apps/web/src/routes/BakeWorkspacePage.tsx` | 4,220 | 生产 Bake 工作流与资产状态集中 |
| `apps/server/src/services/storageManagementService.ts` | 1,597 | 扫描、分类、隔离、purge 与数据库分页集中 |
| `apps/server/src/services/substanceBakeService.ts` | 1,396 | 远端任务、下载、恢复与文件持久化集中 |

行数只用于确定审查面，不是性能结论。以上文件在没有 profile、正确性对照和回滚卡时不得因为“太大”直接重写。

## 6. 后续最小步路线

1. 固定真实工程、浏览器、显卡和操作脚本，分别录制模型切换、投影显隐、画笔/橡皮、4K Merge、局部重绘回贴；输出 P95/P99/最大帧、LoAF、React commit、GPU 上传/编译阶段。
2. 单独处理 Bake `job.json` 同步持久化：同 Job 顺序写入、终态可等待、异常不发布半写 JSON，并保持重启恢复；随后再独立异步化下载/ZIP 的 exists/stat。
3. 为 Asset 与 Bake 历史接口补充任务数量、队列深度、等待预算命中率、共享扫描耗时、请求 P95/P99、事件循环延迟和共享卷队列观测；若 Bake 仍随历史总量线性失控，优先复用既有 PostgreSQL user/created_at 索引设计，不先引入新 Schema。
4. 仅对 profile 命中的单个阶段提交补丁；每次保持一个主模块/算法 ID，并执行对应 CPU/GPU/Worker/shader/persistence/export 审计。
5. 暂不拆 `ViewportCanvas`、`EditorPage`、`GeneratePanel`；等单点行为有稳定回归与性能样本后，再做不改变语义的 application/use-case 提取。

## 7. 迁移与回滚

本轮没有数据库、Project、Layer、Generation、Capture、Bake Workspace 或对象资产迁移。服务端回滚只需恢复 Bake 历史逐请求同步扫描、产物同步 metadata 读取、Bake 产物同步验收和旧测试端口分配逻辑；内容填补回滚恢复旧分量门槛、seam-link 构建/传递和固定迭代轮数即可。历史任务、Revision、对象存储和用户工程均保留。若回滚，会重新引入共享卷抖动、多用户并发下的事件循环阻塞，以及放大视图短斜线缺口未补全。
