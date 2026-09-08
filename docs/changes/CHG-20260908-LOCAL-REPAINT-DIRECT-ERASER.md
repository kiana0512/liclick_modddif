# CHG-20260908-LOCAL-REPAINT-DIRECT-ERASER

> 状态：Verified  
> Owner：Codex  
> Reviewer：维护者体验验收  
> 日期：2026-09-08  
> 分支：`codex/transform-gizmo-center`  
> 基线 commit：`e307f71`  
> 最终 commit/tag：待提交

## 1. 问题与证据

- 实际现象：局部重绘生成并回贴后，直接点橡皮擦无法落笔；切到画蒙版再切回橡皮擦才恢复。
- 期望结果：生成结果完成后可立即用橡皮擦编辑当前重绘层。
- 复现步骤：完成一次局部生图并回贴 → 不切换其他工具 → 点击橡皮擦 → 在当前结果上拖动。
- 代码证据：生成阶段的热 source 尚无 `projectionLayerId`，切换橡皮擦触发持久行预热后重新发布同一来源，改变 source key；pointer-down 的 exact overlay/resident mask 门禁因此拒绝首次输入。

## 2. 范围

- 变更等级：L1
- 主模块 ID：M08
- 影响模块 ID：M05、M06、M15
- 修改文件：`ViewportCanvas.tsx`、局部重绘层保留回归、维护文档。
- 明确不做：不修改笔刷像素、投影公式、持久化格式、生成服务或其他图层选择逻辑。

## 3. 当前契约与根因

- 当前输入：当前活动 projected repaint row、运行时 source、实时 composite、工具状态。
- 当前状态转换：`inpaint-apply` 完成后切换 `eraser`，持久行预热判断 source 是否需要冷恢复。
- 当前输出：继续使用已准备的实时蒙版，或在冷恢复时发布带当前行 ID 的 source。
- 根因：旧判断只接受 `source.projectionLayerId === activePaintLayer.id`，没有识别刚发布的新行已由相同 source/composite 热持有。

## 4. 方案

- 修改点：计算当前 source key；在既有 generation/capture/target 身份匹配基础上，同时要求 composite 的 `layerId` 和 `sourceKey` 匹配当前行，满足时跳过重复恢复。
- 保持不变的行为：显式 `projectionLayerId` 的恢复、历史行选择、跨对象/跨 Generation 隔离、GPU 驻留就绪门禁。
- 失败/fallback 行为：热所有权证据不足时继续走原冷恢复路径，不假定可编辑就绪。
- 旧工程兼容：旧项目重开无实时 composite，仍使用原持久 source 恢复。
- 数据或版本升级：`ALG-LR-007` Patch，v2.2.2；无 Schema 迁移。

## 5. 风险与回退

- 主要风险：错误保留其他重绘行 source。通过 source 身份、composite 行 ID 和 source key 三重检查限制。
- 性能/显存/内存影响：不新增纹理或缓存；减少一次重复 source 发布和资源重绑。
- 回退步骤：恢复 `ViewportCanvas.tsx` 原显式 `projectionLayerId` 单条件判断。
- 回退后数据是否兼容：兼容；会恢复首次擦除需切换工具的问题，不删除用户数据。

## 6. 验证

| 验证项 | 修改前 | 修改后 | 结果 |
| --- | --- | --- | --- |
| 直接切换身份契约 | 热 source 被重复恢复 | composite 明确拥有当前行时保留热 source | 通过 |
| 历史行隔离 | 按 projection row 恢复 | 保持 | 通过 |
| 有序合成 | 既有行为 | 不变 | 通过 |
| 投影显隐 | 既有行为 | 不变 | 通过 |
| TypeScript | - | 无错误 | 通过 |
| Cloud 构建/包体 | - | 80 chunks / 3,133,658 bytes | 通过 |

执行命令与结果：

```text
pnpm --filter @liclick/web test:local-repaint-layer-retention  PASS
pnpm --filter @liclick/web test:local-repaint-ordered-composition  PASS
pnpm --filter @liclick/web test:projection-layers  PASS
pnpm --filter @liclick/web typecheck  PASS
pnpm --filter @liclick/web exec eslint src/engine/viewport/ViewportCanvas.tsx scripts/test-local-repaint-layer-retention.mjs  0 errors / 6 existing warnings
pnpm -r build  PASS
pnpm run check:cloud-artifact  PASS（192 files / 24.94 MiB）
pnpm run check:web-bundle-budget  PASS（80 chunks / 3,133,658 bytes）
```

未覆盖项：维护者真实项目中的鼠标操作体验；未执行付费生成。

## 7. 文档与评审

- [x] 已更新唯一准则中的当前实现/参数/文件位置
- [x] 已更新 `CHANGELOG.md`
- [x] 已判断并更新算法/Schema/Workspace 版本
- [x] 已检查 diff 范围
- [ ] Reviewer 已检查真实输出，而不仅是 typecheck

## 8. 结论

- 合并/发布决定：本地修复和自动化验证完成，等待维护者体验验收与发布指令。
- 遗留问题：在生产模型上验证生成完成后无需工具往返即可完成首笔擦除。
- 关联 ADR/后续 CHG：`CHG-20260908-REPAINT-TOOL-HANDOFF-PROFILE`。
