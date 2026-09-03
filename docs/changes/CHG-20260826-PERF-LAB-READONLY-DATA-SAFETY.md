# CHG-20260826-PERF-LAB-READONLY-DATA-SAFETY

> 状态：Verified locally / CI pending
> 等级：P0 数据完整性修复
> 日期：2026-08-26
> 分支：main
> 取代：`CHG-20260826-PERF-LAB-DEFAULT-SCENARIO`

## 1. 事故

`?perfLab=1` 曾挂载 `PerfScenarioLoader`，直接替换 Scene、Layer 与 Project Store。编辑器的正常自动保存随后把 `Perf Model` 和 `Perf Layer` 写入真实项目，使真实模型和投影层索引被覆盖。该行为违反 M01/M05/M13 的数据所有权边界，定级 P0。

## 2. 根因

- 性能 HUD 与合成压力数据共用真实项目编辑器路由。
- 合成场景调用 `replaceCurrentProject`，但没有独立 Repository 或保存隔离。
- 设计文档错误地把“浏览器内合成”当成“不会持久化”，缺少自动保存链路审计。

## 3. 修复契约

- `PERF-LAB-ENTRY/2.0.0`：`perfLab=1` 只启用现有 `PerformanceTestHud`。
- 删除 `PerfScenarioLoader`、合成场景 URL 解析和 `perfScenario` 路由保留。
- 性能入口不得调用 Project/Scene/Layer 写 API；压力数据只能位于无真实 Repository 的独立 Harness。
- 投影预览失败仅写日志并保留上一份有效材质，不显示用户 Toast。

## 4. 数据恢复

污染文件先备份。依据未丢失的 Generation、Capture 与资产重建 8 个完整六视图批次，共 48 个投影层；保留 2 个真实局部重绘层，并补回仍有原始 GLB 资产的 `002_vial.glb`。项目恢复结果为 9 个模型、50 个真实图层、0 个 `Perf Model`、0 个 `Perf Layer`。

## 5. 验证与回退

- `test:performance-lab-metrics` 断言 `perfLab=1` 只返回诊断开关，并静态断言 EditorPage 不挂载场景替换器。
- Web typecheck、生产构建、投影图层测试必须通过。
- 回退只允许关闭性能 HUD；禁止恢复合成场景加载器。
