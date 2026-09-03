# CHG-20260903-LOCAL-REPAINT-PREWARM-LATENCY

- 状态：首批修复已更新 4517；后续真实项目验证与单层材质交接修复见 CHG-20260903-LOCAL-REPAINT-PARALLEL-PREPARE
- Owner：LI3D Texture；日期：2026-09-03
- UI-10/UI-06 → M08；ALG-LR-008 v2.3.1，production；ALG-LR-007 显示公式/所有权不变
- 范围：4 个运行时源码文件，保留工作区已有场景选择改动

## 问题与证据

新建顶层结果只有 renderer preview，尚无正式 Layer 行。`getOrderedLocalRepaintPreviewLayer` 仅让 priority 下方的 preview 进入背景投影栈，但 Viewport 无条件循环等待新 layerId 的 resident binding；不存在的行无法绑定，耗尽 10 秒后才继续 exact overlay 编译。按钮点击还会无条件递增 GPU prepare revision，使正在执行的后台解码/准备取消并重跑。

现有源码仍在 apply 时使用 depth-aware exact overlay，历史维护文档的“全量单共享显示”描述未与源码同步。本次校正文档并沿用现行显示路径，没有修改 overlay 使用、静音、交接、shader 或图层排序。

## 修改

1. 域策略根据已发布可见图层或实际 ordered preview 判断是否需要等待 resident。新建顶层直接继续必要的 exact overlay 准备；其他路径保留原 10 秒等待和就绪检查。
2. Session 登记实际解码/GPU effect 的活动任务。点击/后台扫描复用同 Generation/目标的活动工作；finally 与 effect cleanup 幂等释放，残留 preparing 状态不会冒充活动任务。
3. 增加只读诊断 `localRepaintResidentWaitMs` / `localRepaintResidentWaitRequired`，用于真实项目确认等待阶段。

## 对应路径审计

| 路径 | 影响 |
| --- | --- |
| GPU / UI | 准备等待条件与任务生命周期；高清 source、作者 mask、capture depth、overlay 编译继续执行 |
| CPU / Worker | 不改 falloff、蒙版处理、CPU rasterizer 与 UV Worker；仅避免点击重启工作 |
| Shader / UV / Export | 无公式、颜色空间、矩阵空间、geometry/depth 阈值或输出尺寸变更；仍消费原资产 |
| Layer / 保存 | 无新持久字段；两帧发布与 3000ms 后台合并不变；Project Command v1、Revision CAS、ownership、verified assets 不变 |

## 验证与限制

- 实际 viewport resident 等待代码在模拟帧时钟下执行：新建顶层且永不绑定为 0ms；已发布行在 48ms 绑定时等待 48ms；ordered preview 在 64ms 绑定时等待 64ms；未就绪的已发布行仍到 10000ms 退出。模拟数值只证明调度，不代表真实 GPU 性能。
- Session 回归覆盖活动复用、解码/GPU 重叠、重复清理、取消/失败允许重试、跨 Generation 旧清理不释放新任务。
- `test:local-repaint-performance-merge`、`ordered-composition`、`material-reference`、`seam-harmonization`、`inward-crossfade`、`bake-batching`、`layer-retention`、`result-composite` 均通过；Web typecheck 与 `corepack pnpm --filter @liclick/web build` 通过。定向 ESLint 无错误，现有警告保留。
- 浏览器连接没有打开的项目页，未测真实工程点击到 ready、首笔、连续重绘与保存重开；未部署，不声明端到端缩短秒数或生产验收完成。

## 迁移与回退

无 Schema、资产或工程数据迁移；任务登记只存在于内存，随 effect 清理释放。回退本次等待条件与复用判断即可恢复旧调度，不删除或重写 Generation、Layer、蒙版、Revision 或对象资产。
