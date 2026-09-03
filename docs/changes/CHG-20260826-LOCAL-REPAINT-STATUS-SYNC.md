# CHG-20260826-LOCAL-REPAINT-STATUS-SYNC

## 状态

Verified

## 范围

- 主界面：`UI-05` 生成面板、`UI-10` 底部工具条
- 主模块：`M08` 局部重绘
- 算法：无语义变更；只修正既有局部生图任务状态呈现

## 问题

底部工具条在局部生图请求桥接建立后立即转圈，但左侧生成面板只检查已创建的 Generation 行。在蒙版捕获、视角捕获和提交准备阶段，Generation 行尚不存在，因此左侧仍显示“局部生图”。

## 修改

`GeneratePanel` 将 `previewIsGenerating` 与 `tab === 'repaint' && submissionActive` 合并为 `generateActionRunning`。同步提交锁建立后，左侧 CTA 立即显示旋转图标和“生成中...”；Generation 行创建后继续由原后台状态接管。失败、取消和 `finally` 路径仍释放原提交锁，不新增持久字段或任务状态。

## 迁移与回退

- 无数据迁移、Project Command、Revision 或资产格式变化。
- 回退只需移除 `generateActionRunning` 的同步提交锁分支和对应回归断言。

## 验证

- `pnpm --filter @liclick/web test:local-generation-self-lock`
- `pnpm --filter @liclick/web test:local-generation-entry-alignment`
- `pnpm --filter @liclick/web typecheck`
