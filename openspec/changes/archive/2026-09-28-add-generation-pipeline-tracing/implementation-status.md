# 实施状态

2026-09-28：轻量版已实现并完成本地验收，15 项任务按新版重新确认。按用户要求归档；提交及远端验证结果以 Git 与 CI 为准，本归档不代表生产部署。

## 已实现

- --DEBUG 通过 scripts/launch.mjs 接入本机启动器；普通构建默认关闭，发布入口强制关闭且拒绝额外 DEBUG 参数。SkipBuild 检查产物能力标识。
- Web/Worker 在分块前用已有 esbuild 消除静态门，构建检查模块引用和 Trace 协议字段；Node/Blender、本次 SQL/API/上传、共享 contracts Trace 扩展均移除。既有 Performance Lab 保持。
- 单一 start/stop/get API，默认 off；重复调用幂等、未结束记录 interrupted、迟到结果隔离、切换工程/用户和刷新关闭。
- 明确清单内 23 个业务函数以 DEBUG 构建期插桩记录真实名称；保留阶段/Generation/Worker/保存 ACK 探针。范围及排除项见 [coverage.md](coverage.md)，不是全仓每个函数。
- 本地最多 10,000 条，阶段筛选、各次调用、次数/累计/平均/最大、失败筛选及普通 JSON。无 Perfetto/硬件采样/时钟校准/诊断持久化/续传。
- 自动化输出普通 automation-timings.json，应用记录单独导出；不再安装浏览器性能 Observer，刷新不等待续录。

## 验收证据

- 函数计时专项：异常、取消、单调钟、容量、隐私、快照、Worker 本地时长、启停和迟到隔离、async 直接返回 Promise 的真实完成边界、Generation 保存 ACK。
- 保存检查点 compiled-off/off/on 固定结果回放：sync→save→ACK、保存内容及异常一致；不冒充实际远端推理。
- Web 完整 156 项回归、typecheck/lint、正式发布构建、Cloud artifact、原包体预算与部署模拟通过；最后增量回归再次通过。发布总 JS 3,269,919 / 3,271,000 bytes，详细证据见变更卡。
- 本机 Bicycle compiled-off / DEBUG-off / DEBUG-on：面数 1,857,094、包围盒一致；2K 捕获 PNG 哈希一致。on 包含 13 条记录和编码 Worker 耗时，off 无记录。少量样本含缓存/机器噪声，不声称稳定 P95 或零分支成本。
- 原始本机证据：.codex-tmp/slim-trace-three-mode.json、slim-trace-view.png、slim-off-fixture、slim-on-fixture。未进入仓库；使用方法及审计见 docs/changes/CHG-20260928-FUNCTION-TIMING.md。

## 限制与历史

远端内部不可见；同步/异步 wall 不是硬件执行时间；刷新冷启动前段不补造；function scope 按静态阶段归组，不用全局 async 栈猜测父关系。未重新付费生成完整贴图批次。

旧 Trace/Perfetto/硬件验证不当作本版验收，历史卡保留。旧 stash 的仓库外备份位于 D:/li3d-stash-backups/20260928-104747/，不恢复重型模块。未执行数据库清理或修改业务资产。
