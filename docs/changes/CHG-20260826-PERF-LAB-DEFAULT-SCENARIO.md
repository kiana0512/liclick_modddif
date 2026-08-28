# CHG-20260826-PERF-LAB-DEFAULT-SCENARIO

> 状态：Reverted（P0 数据安全事故，已由 `CHG-20260826-PERF-LAB-READONLY-DATA-SAFETY` 取代）
> Owner：Codex / LI3D 维护组
> Reviewer：待同事复核
> 日期：2026-08-26
> 分支：main
> 基线 commit：`bbfc21822f9595a21d35067072d9d56d9c4fd257`
> 最终 commit/tag：本次发布提交（见 Git 历史）

## 1. 问题与证据

> 历史警告：本文记录的默认合成场景方案不得重新启用。该方案实际覆盖了真实项目运行态并被自动保存，违反项目数据隔离契约。

- 实际现象：`?perfLab=1` 只打开性能 HUD，不创建性能调试模型；调试者还必须知道并追加未公开的 `perfScenario`。
- 二次反馈：投影预览失败后相同签名被每次渲染重新提交，错误 Toast 的自动关闭计时持续重置，表现为一直弹出。
- 期望结果：一个稳定 URL 同时进入调试台与可重复基准负载，本地和 A100 行为一致。
- 复现步骤：打开任一 `/project/<id>/texture?perfLab=1`，观察 `body[data-perf-scenario]` 未建立。
- 根因：HUD 与合成基准使用两套独立查询参数入口。

## 2. 范围

- 变更等级：Patch
- 主模块 ID：M13
- 影响模块 ID：M03、M15
- 源码：`perfScenarioPolicy.ts`、`PerfScenarioLoader.tsx`、`App.tsx`、`SceneRoot.tsx`
- 明确不做：不修改投影、UV、局部重绘算法；不写入真实项目；不恢复旧本地组件。

## 3. 当前契约与方案

- 契约名/版本：`PERF-LAB-ENTRY/1.1.1`
- 输入：URL 查询参数 `perfLab`、可选 `perfScenario`。
- 解析优先级：合法显式场景优先；否则 `perfLab=1` 解析为 `100-layers`；其他情况关闭。
- 默认输出：1 个浏览器内合成立方体、100 个投影层、1 张 1024×1024 精确图层栈纹理、性能 HUD 和帧采样结果。
- 兼容：既有四个 `perfScenario` 值保持；未知显式值在 `perfLab=1` 时回落默认场景。
- 失败策略：同一失败签名不再重提；保留上一份有效材质，错误仅写 console，不产生用户 Toast；输入签名改变后才允许新任务。
- 数据升级：Patch；不改 Project/Layer 持久化 Schema。

## 4. 风险与回退

- 风险：调试 URL 会用隔离合成工程替代当前页面内存中的项目视图，因此只允许显式 `perfLab=1` 启用。
- 性能影响：普通 URL 不解析出场景，不创建模型、图层或采样器。
- 回退：撤销本变更，恢复显式 `perfScenario` 才加载基准的旧入口。
- 数据兼容：无持久化迁移。

## 5. 验证

| 验证项 | 修改前 | 修改后 | 结果 |
| --- | --- | --- | --- |
| `perfLab=1` 场景解析 | `undefined` | `100-layers` | 通过 |
| 显式场景覆盖 | 支持 | 保持支持 | 通过 |
| 普通 URL | 不加载 | 不加载 | 通过 |
| 预览失败提示 | 重复 Toast | 无 Toast、console 诊断 | 通过 |
| Web typecheck | 未执行 | 通过 | 通过 |

执行命令：

```text
corepack pnpm --filter @liclick/web test:performance-lab-metrics
corepack pnpm --filter @liclick/web typecheck
```

## 6. 结论

- 发布决定：完成生产构建、浏览器验证与 A100 健康检查后发布。
- 遗留：真实账号下的业务项目不得在性能实验室模式保存；UI 后续可增加更明显的“隔离基准”标识。
