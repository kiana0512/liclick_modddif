# Spec Delta

## Purpose

默认关闭、可编译裁剪的阶段和业务函数计时；取代本未归档变更的旧重型诊断要求。

## ADDED Requirements

### Requirement: DEBUG 构建与正式裁剪
启动器 SHALL 在构建前将 --DEBUG 映射到 Trace 能力；普通构建默认关闭，正式发布 MUST 强制关闭并拒绝 DEBUG 参数。Web/Worker/Node 正式产物 SHALL 无本次 Trace 实现、入口、调用分支、参数构造、诊断协议或采样策略头；Node 旧 Trace SHALL 移除，不能用 runtime if 代替裁剪。既有 Performance Lab SHALL 独立保持。

#### Scenario: 正式构建存在遗留环境变量
- **WHEN** 正式构建环境含开发 Trace 变量
- **THEN** 仍构建关闭的产物，产物与引用检查确认无本次 Trace 残留

#### Scenario: 预构建能力不匹配
- **WHEN** --DEBUG 与 SkipBuild 产物能力标识不符
- **THEN** 拒绝启动并提示重建，不以运行时变量伪装编译能力

### Requirement: 默认关闭与显式启停
DEBUG 构建 SHALL 默认 off，统一用 startPipelineTrace()/stopPipelineTrace() 和只读 getPipelineTrace()，MUST 不另设可写布尔开关。off SHALL 仅有轻量条件判断，无 Trace 时钟读取、诊断参数/闭包分配、后台任务或网络。

#### Scenario: 未开始录制
- **WHEN** DEBUG 下正常执行业务但未 start
- **THEN** 无记录或诊断后台活动，业务照常执行

#### Scenario: 重复启停与迟到结果
- **WHEN** 停止在途录制后开始新 session，旧函数随后返回
- **THEN** 旧开放记录 interrupted，迟到结果不污染新记录，业务不取消；重复 start/stop 不重复建会话或丢失停止结果

### Requirement: 阶段和业务函数覆盖
系统 SHALL 记录覆盖清单内生图链路自有业务函数的每次调用，包含静态函数名、阶段、开始/结束/耗时、终态及操作关联。清单 SHALL 覆盖工程、导入、减面、参考图、每次 Generation、回贴、呈现、保存和显式录制后的恢复校验，列明源码、调用者及排除项；UI 与自动化共用埋点。系统 MUST 不宣称自动覆盖第三方库或全仓函数。

#### Scenario: 已有六视图输入
- **WHEN** 导入已有六视图并保存
- **THEN** 可展开读取/解码/角色选择/上传/保存函数，不补造参考图 Generation

#### Scenario: 多视角重试
- **WHEN** 多视角出现 QA 失败和重试
- **THEN** 视角/attempt 关联准确，失败保留，保存完成以业务 ACK 为准

### Requirement: 计时和并发语义
系统 SHALL 使用 producer 本地单调钟，同步显示 scope wall、异步显示含 await 的 elapsed wall；MUST 不称为 CPU/GPU 执行时间，不累加父子/并发耗时为总延迟。并发 SHALL 显式传上下文。业务执行次数、返回、异常、取消及必要的 Promise 身份 MUST 保持；诊断故障不得影响业务。

#### Scenario: 工具延后查询
- **WHEN** 函数完成后三十秒才查询记录
- **THEN** 已完成时长不增加，工具间隔不计入业务

#### Scenario: Worker 与远端处理
- **WHEN** 调用 Worker 或远端服务
- **THEN** 主线程往返与 Worker 本地耗时分列，不跨时钟相减；远端仅显示请求/等待，不伪造内部排队或推理时间

#### Scenario: 并发异常
- **WHEN** 并发函数中一个抛错
- **THEN** 各自终态和父关联正确、结束一次，原异常传递，另一任务不受影响

### Requirement: 本地有界记录
系统 SHALL 仅在内存保存每 session 最多 10,000 条含开放记录，静态名称最长 128 字符；超限 SHALL 计 dropped 并标 truncated，原开放项仍可结束。MUST 不记录参数/结果、异常消息、原始业务 ID/路径、提示词、图片或凭据，不新增诊断上传/数据库或无限历史缓存。

#### Scenario: 容量已满
- **WHEN** 记录达到上限
- **THEN** 停止新增并显示丢弃计数，已有记录仍可结束，业务继续

#### Scenario: 刷新或身份切换
- **WHEN** 刷新、换工程或退出登录
- **THEN** 回到 off，不承诺保留未导出数据，不自动续录或重提业务

### Requirement: 本地查看和 JSON
系统 SHALL 提供懒加载阶段/函数展开列表、次数/累计/平均/最大耗时和失败筛选，按 producer/kind 分组；导出 SHALL 为带版本和单位的普通 JSON。统计和序列化 SHALL 在停止或显式查看/导出时执行，不依赖 Perfetto。

#### Scenario: 查看慢函数
- **WHEN** 停止录制并展开阶段
- **THEN** 可查看每次调用与聚合，缺失/中断不显示为零耗时成功

### Requirement: 缩减范围与行为验证
本能力 MUST 不引入 Perfetto、CPU profiler、GPU 时间戳、内存台账、跨端校准、traceparent、诊断 SQL/API/上传队列或刷新续传。系统 SHALL 分别验证正式裁剪、DEBUG/off、DEBUG/on；像素、分辨率、QA、Command/CAS/ownership 与既有门禁保持。关闭档性能结论 SHALL 注明条件、样本量和噪声。

#### Scenario: 三种模式对照
- **WHEN** 相同输入对照三种模式
- **THEN** 业务输出和失败语义一致；正式产物无本次 Trace，off 无诊断计时/分配/后台活动，on 记录有界，稳定可复现的关闭档退化修复后才通过
