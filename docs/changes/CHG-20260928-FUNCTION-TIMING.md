# CHG-20260928-FUNCTION-TIMING

## 范围与原因

M13/M15，FUNCTION-TIMING/1.0.0，experimental/disabled。按用户 2026-09-28 授权，将旧重型 Trace 收敛为阶段与自有业务函数计时。无业务算法变更；不新增生产数据契约。

## 使用

```powershell
corepack pnpm dev:4517 --DEBUG
```

启动器重建 DEBUG 前端后运行原本机 4517 服务；依赖原有本机配置/登录，不新增组件或凭据存储。界面右下角“函数计时”默认关闭，点击开始后执行操作，再停止查看阶段/函数表格或下载 JSON。调试自动化使用 window.__li3dPipelineTrace.start()/stop()/reports()，无需服务端诊断接口。

普通启动：corepack pnpm dev:4517。复用产物：corepack pnpm start:4517 --DEBUG；SkipBuild 若能力不匹配会拒绝启动，须重新构建。正式 build:release 拒绝 DEBUG 参数并强制关闭，即使环境遗留开启变量也不生效。

## 实现与测量口径

界面整理（M13/M15，Patch）：以局部 CSS Module 实现深色面板、记录概况、模块/阶段筛选、函数/阶段标签和数值对齐；“耗时排行”与“调用明细”分视图，明确两种排序口径。原始开关对照放入验收页折叠区，正常产品不显示测试日志。录制面板增加清晰启停按钮，源码详情继续按需展开。计时、聚合、Schema 和导出格式不变；样式随 DEBUG 入口加载，回退仅还原两个 UI 组件和样式文件。

显示修订（M13/M15，Patch，无算法/Schema 变化）：统计表拆分模块、阶段、记录类型、命名空间、函数、执行位置、计时方式和耗时列；命名空间由固定源码路径生成，源文件放在逐次记录详情。阶段记录无函数元数据时明确显示“阶段 / —”，不猜测调用函数。模块按阶段归属映射，UV 合成单独归 M07，未知项显示未分类；支持模块筛选。阶段/函数范围可能重叠，不相加为总延迟。回退只还原展示层；类型检查、字段拆分测试和 lint 验证。

- VITE 静态门 + 单一 start/stop 状态。明确清单内 23 个业务函数由已有 TypeScript/Vite 在 DEBUG 编译时插桩；原有阶段上下文探针保留，覆盖清单见 OpenSpec coverage.md。
- 函数记录静态源码位置与名称。async 直接返回 Promise 时旁路监听完成，不替换业务返回值、不新增业务 await；异常/取消继续按原路径传递。
- 使用单调钟。同步为 scope wall，异步含等待；Worker 本地耗时和主线程往返分列，不跨时钟相减、不冒称 CPU/GPU 执行时间。关联仅在本地，不发送 Trace HTTP headers。
- 最多 10,000 条记录；超限有 dropped/truncated，开放记录在停止时 interrupted。每次开始新 session；停止后迟到结果不写入新 session。刷新/换工程/退出登录关闭，不跨刷新保存。
- 本地表格提供阶段筛选、调用次数、累计/平均/最大耗时、失败筛选与普通 LI3D-FUNCTION-TIMING v1 JSON。累计包含嵌套，不能当作总体流程耗时。
- 移除本次 Perfetto、CPU profile、GPU query、资源台账、时钟校准、诊断数据库/API/上传/续传、Node/Blender 采集。既有 Performance Lab 手动录制不变；Trace 类型也从共享 contracts 移至 Web 内部，服务端无本次新增依赖。

## 六路审计

| 路径 | 结果 |
| --- | --- |
| CPU | 仅计时边界；返回/异常/取消与执行次数回归 |
| GPU | 移除新 query/device capability，不改已有渲染公式或分辨率 |
| Worker | 原算法/Transferable 保持；仅录制请求携带上下文并返回独立计时 |
| shader | 无新增或修改 shader 算法；只观察 CPU 调用边界 |
| persistence | 原 Command/CAS/ownership/verified assets 不变，诊断仅内存 |
| export | 模型/贴图导出协议不变；诊断 JSON 独立下载 |

## 验证记录

- Web 156 项回归通过；新计时测试覆盖默认关闭、截断、隐私、异常、stop/restart、Promise 返回边界、Worker 本地时间和 Generation 保存 ACK。
- 全仓 typecheck、Web lint 通过；启动器拒绝 DEBUG/SkipBuild 模式不符，发布入口拒绝 --DEBUG。
- 带正式发布元数据并故意残留 DEBUG 环境的 build:release 通过；构建阶段验证无本次 Trace 模块残留，trace-build.json 为 false。Cloud artifact 与部署模拟通过。工作区未提交，不能当作远端 CI 已通过。
- 正式总 JS 3,269,919 / 3,271,000 bytes；shell 261,273 / 265,000；editor 498,352 / 499,624；high-bake 716,105 / 716,300。预算未修改。
- 本机真实 Bicycle 的 compiled-off / DEBUG-off / DEBUG-on 导入一致，均 1,857,094 triangles、相同归一化包围盒；DEBUG-off 无记录，on 有函数名与阶段记录。小样本并有热缓存/并发测试影响，不声明稳定 P95 或性能提升。
- 同一 Bicycle 的三模式 2048×2048 真实捕获 PNG SHA-256 均为 2509df5bc66bdbccb9834dc43ad3a9b813530699d684903545217c1158dcbe87；on 包含 13 条记录，其中 1 条编码 Worker 记录，函数结束与异步返回一致。
- 使用已成功结果形状的固定夹具执行 persistProjectionCommit 三模式回放：sync→save→ACK 顺序、保存内容及原异常一致；这是检查点回放，不冒充再次实际远端生成。
- 本机证据在 .codex-tmp/slim-trace-three-mode.json 及对应本地夹具目录，不作为仓库内已提交附件。未再次付费生图；真实服务生成质量不属于此次计时语义对照。

## 迁移与回退

无需业务数据迁移。删除未发布的旧诊断 SQL 文件不执行 DROP TABLE，已存在测试诊断数据保留。旧 PIPELINE-TRACE JSON 不导入新版；旧 Performance Lab v2 不变。

回退使用非 DEBUG 构建，或还原本次计时/启动器改动；保留用户项目、模型、参考图、生成结果和本地报告。不提交、不推送、不部署。
