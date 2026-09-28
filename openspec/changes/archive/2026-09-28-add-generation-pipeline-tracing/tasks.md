# Tasks

2026-09-28 轻量版替代旧清单，全部重新待验收。旧勾选不继承，以下已完成项按轻量版实现与本地证据重新确认；见 implementation-status.md、coverage.md 和 CHG-20260928-FUNCTION-TIMING。

## 1. 范围收敛
- [x] 1.1 对照 master 独立修改列出保留/删除文件，防止还原覆盖其他工作。
- [x] 1.2 移除本次 Perfetto/profile/GPU/内存/时钟校准、Node/Blender Trace、SQL/API/上传/续传及孤儿代码和测试；验证既有 Performance Lab 保持，不执行数据库删除。
- [x] 1.3 建立阶段到自有业务函数的源码/调用者/排除项覆盖清单。

## 2. 双开关
- [x] 2.1 启动器接入 --DEBUG 与构建能力标识；验证默认关闭、发布强制关闭、遗留变量和 SkipBuild 不匹配拒绝。
- [x] 2.2 静态保护 Web/Worker 埋点与附加协议，Node 移除本次诊断；验证正式产物与引用图无残留，原预算通过。
- [x] 2.3 精简 start/stop/get API；验证默认 off、重复幂等、中途启停、迟到回调隔离且业务不取消。
- [x] 2.4 验证 DEBUG/off 无 Trace 时钟/参数/闭包分配或后台任务，空闲/热点对照记录噪声，修复稳定退化。

## 3. 函数计时
- [x] 3.1 精简 sync/async/begin-end 与数据格式；验证执行一次、返回/异常/取消/必要 Promise 身份及诊断故障隔离。
- [x] 3.2 接入工程/导入/减面/参考图/保存函数；验证等待分列、已有六视图不新增 Generation、保存 ACK。
- [x] 3.3 接入捕获/编码/上传/请求/轮询/解码/QA/回贴/呈现及 Worker；验证视角/attempt、重试失败和本地 duration。
- [x] 3.4 验证显式开始后的同页面重开/恢复、自动化查询间隔，以及刷新 off 不补造前段。

## 4. 查看和交付
- [x] 4.1 实现 10,000 条上限、dropped/truncated 和隐私白名单；验证超限、停止、工程/用户隔离。
- [x] 4.2 精简阶段/函数表格与普通 JSON；验证按口径聚合，不累加嵌套为总时长，无 Perfetto 依赖。
- [x] 4.3 Bicycle 三模式对照，复用已有结果测回贴保存，不为性能对照重复付费；回放不称为真实推理验收。
- [x] 4.4 完成 CPU/GPU/Worker/shader/persistence/export 审计、相关回归、typecheck/lint/原包体门禁；更新维护文档和状态，新验收完成后才归档。
