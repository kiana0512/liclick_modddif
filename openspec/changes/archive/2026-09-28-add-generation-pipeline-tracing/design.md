# Design

## Context

2026-09-28 取代旧重型诊断设计。主模块 M13/M15，无业务算法变更。设计修订时代码为恢复后的旧实现；当前实施与验收见 implementation-status.md。

可复用：pipelineTrace.ts 的 VITE 静态门、活动 session、start/stop、traceSync/traceAsync；vite.config.ts 已有缺省 false 的常量替换。缺口：启动器尚无 --DEBUG；Node 环境变量门不是编译裁剪；旧核心仍耦合存储、续接、Detail 采样。

## Goals / Non-Goals

目标：显式录制本地阶段与函数耗时；正式构建无本次 Trace 运行时开销；DEBUG/off 只留轻量判断。

不做 Perfetto、CPU profile、GPU query、内存台账、traceparent、跨端时钟握手、诊断 SQL/API/上传、刷新续接或全仓自动插桩。仅借鉴 UE scope 与编译门控。

“每个函数”指覆盖清单内生图流程自有业务函数的每次调用；不含第三方库内部、React render、像素/顶点循环和所有底层工具函数。清单必须列源码、函数名、阶段、调用者和排除项，不以阶段汇总冒充函数覆盖。

## Decisions

### 1. 编译能力门

启动器解析 --DEBUG，在调用构建前映射到既有 VITE_LICLICK_PIPELINE_TRACE_ENABLED；不传给 Node 作为原生参数，不引入自定义宏预处理器。移除旧 DETAIL 构建门和 Basic/Detail 档位。

普通构建默认 false；正式发布强制 false 并拒绝 --DEBUG，不得被遗留环境变量打开。构建写入能力标识，SkipBuild 必须验证标识匹配，否则拒绝启动并提示重建。启动已编译产物时修改变量不等于裁剪。

Web/Worker 调用点使用静态门与运行时门，关闭分支不创建计时参数、闭包、ID、时间戳或额外 Promise。不能只在包装函数内部 return 就宣称裁剪。

首版移除本次 Node/Blender Trace、路由、repository、上下文和脚本注入；Node 正式产物不得残留本次诊断模块。服务端业务不改，浏览器记录请求/等待。既有 Performance Lab 不受新开关影响，不把已有诊断代码全部删除。

### 2. 运行时 API

沿用 startPipelineTrace()、stopPipelineTrace()、getPipelineTrace()，统一小写 stop；不增加可独立写入的 trace=true/false。显式开始/停止统一处理记录、未结束调用和迟到回调，比两个状态源更简单。

- 初始 off；重复 start 幂等，不清掉活动记录。
- stop 立即拒绝新事件，开放记录标 interrupted，返回只读快照；重复 stop 保留上次结果。
- 下一次 start 创建新 session；旧回调不能写入新 session。
- 刷新、换工程、退出登录后 off，不持久化开关、不自动续录。
- 中途开始只观测后续函数，不补造已开始步骤；stop 不取消业务请求、Promise 或 Worker。
- DEBUG/off 只做调用点条件判断，不读 Trace 时钟、不分配诊断数据/闭包、不启动 timer/rAF/Observer、诊断 Worker 或上传；不加逐帧检查。

### 3. 数据与计时

精简现有 sync/async/begin-end，不另建框架。数据仅包含 session/operation/span/parent 的本地关联、静态阶段/函数名、producer、kind、开始/结束/耗时、终态和可选视角/attempt 序号。禁止采集参数、返回内容、异常消息、原始业务 ID/用户路径、prompt、图片或凭据。

实施选择：用已有 TypeScript AST 和 Vite 对明确函数清单做 DEBUG 构建期插桩，列表见 coverage.md；不是全仓自动插桩，不新增宏预处理器或依赖。正式构建先用现有 esbuild 消除静态门，再由 Rollup 检查无 Trace 模块残留。异步函数直接返回 Promise 时旁路监听完成，保留原值/业务 await；非 async 返回 Promise 的函数仍只测同步调用边界。

同一 producer 用 performance.now 单调钟。同步为 scope wall，异步为含 await 的 elapsed wall，均不是 OS CPU 时间。父函数包含子函数，累计用于热点排序，不相加成流程总耗时；不计算 self/关键路径。

并发显式传父上下文，不用跨 await 的全局 currentSpan。操作→阶段→函数，生成附带批次/视角/尝试；失败尝试保留。合并保存只计一次实际保存，通过同一 span 引用关联请求方。

业务执行一次，返回/异常/取消保持；需原 Promise 身份的入口采用旁路 begin/end。诊断异常不得遮蔽业务结果。

Worker 只在 DEBUG 且 recording 时传轻量上下文与本地计时。主线程往返 wall 和 Worker 自身 wall 分列，不跨时钟相减，不推断精确排队时间。编译关闭裁剪附加协议，运行时 off 保持原消息和 Transferable。

### 4. 覆盖边界

| 阶段 | 函数边界 |
| --- | --- |
| 打开/新建 | create/fetch、解析、hydrate、模型恢复、材质 ready |
| 导入 | 读取、解析、检查、归一化、挂接 |
| 减面 | 确认等待、导出/准备、上传、服务等待、下载/解析/验证、保存 |
| 参考图 | 读取/解码、角色选择、上传、保存；已有六视图不新增 Generation |
| 每次 Generation | 校验、输入准备、各通道捕获、读回、编码、上传、提交、轮询、结果解析/解码、QA |
| 回贴/呈现 | 回贴准备、图层提交、UV 合成、材质 ready、保存 |
| 保存 | 排队/合并、序列化、资产验证、提交、ACK |
| 恢复/校验 | 显式录制后同页面重开工程、恢复与校验 |

只测已有边界，不为计时重构业务算法。GPU 提交/编译/完成等待函数是 CPU 侧调用 wall，不称为 GPU 执行。远端统一显示服务等待（内部不可见）。

轮询请求、既有等待、重试、人工确认分开；不增加业务轮询。CLI command/poll/idle 是观察数据，工具停顿不能拉长已结束函数。

刷新会清空未导出的记录并回到 off，不承诺刷新冷启动前段。要观察打开/恢复，应先开始再在同一页面打开工程；不为诊断重提业务。

### 5. 本地查看与容量

一个懒加载阶段/函数列表，查看各次调用及按 producer/kind 分组的次数、累计、平均、最大耗时，支持失败筛选。普通 JSON 包含版本、单位、记录与截断计数；无 Perfetto、火焰图或外部 viewer。

展示列分为模块、阶段、类型（阶段/函数）、命名空间、函数、执行位置、计时方式及统计值。函数命名空间从固定源码路径生成，完整源码位置放在展开详情；缺少函数元数据的阶段记录不猜测函数名。支持模块筛选，模块归属为静态阶段映射，未知显示未分类。

每 session 最多 10,000 条含开放记录，静态名称最长 128 字符。满后不新增、增加 dropped 并标 truncated；原开放记录仍可结束。新 session 释放旧内部缓存，不累积历史。统计和 JSON 序列化只在停止或显式查看/导出时执行；无定时 flush、存储或上传。

### 6. 验证与代码收敛

正式产物：检查 Web/Worker/Node 内容和引用图，确认本次 collector、面板、导出、事件表、诊断消息、策略头和调用分支被移除；不能只搜索变量名或验证 UI 隐藏。既有 Performance Lab 不属于新增残留。

DEBUG/off：与编译关闭构建同输入对照，确认无 Trace 时钟/诊断分配/后台网络，允许轻量判断；测空闲和热点，附条件、样本量与噪声，稳定可复现退化必须修复，不提前宣称实测零开销。

DEBUG/on：验证有界记录和业务等价，报告计时附加成本；不继承旧 Basic/Detail 2%/5% 和上传/内存预算。原包体、交互、质量门禁保持。

复用轻量核心，删除旧重型模块、孤儿调用及对应测试；还原仅为旧 Trace 改写的路径，不覆盖 master 后续独立修改。按 work-inventory 分离测试资产和其他报告。

CPU/Worker 审计输入输出和取消；GPU/shader 不加 query、不改公式；persistence 保持 Command/CAS/ownership；业务 export 字节不变。

## Risks / Trade-offs

函数覆盖依赖埋点清单；wall 适合定位慢点但不是硬件 profiler；无跨刷新历史；Node 原有环境分支不具备裁剪能力，因此本次移除服务端诊断，不增加另一套服务端构建工具。

## Migration Plan

本轮仅重写文档并重置任务。实施时移除未发布 Trace SQL/API，不执行 DROP TABLE；其他环境已存在的诊断数据保留，清理另行审查。旧诊断 JSON 不承诺导入兼容，既有业务报告/项目/资产不迁移。回退关闭 DEBUG 或回退诊断代码，不改变数据或恢复退役组件。
