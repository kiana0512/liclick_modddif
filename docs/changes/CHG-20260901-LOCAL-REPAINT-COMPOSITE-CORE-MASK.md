# CHG-20260901 局部重绘核心蒙版清理

## 变更身份

- 主模块：`M08` 局部重绘；协作界面：`UI-05` 生成面板。
- 算法：`ALG-LR-012` v1.1.0。
- 主实现：`apps/web/src/workers/localRepaintGenerationInput.worker.ts`。

## 问题

视口表面画笔生成的原始 mask 包含抗锯齿弱像素、受几何可见性影响的短断段和微小孤岛。旧 Worker 直接用这些连续强度混合当前效果图与 clay 预览，使 ModelView 的 Image 1 出现细碎白灰斑块；这些碎片继续被远端 mask 外扩，容易诱导模型保留白模残影。

## 实现

1. 保留原始作者 mask 不变，它继续是 Qwen 定位、Capture、Generation 画笔授权、历史恢复和回贴 coverage 的权威来源。
2. Worker 另行构造 ModelView 合成核：像素强度 24 为候选、96 为强核，以 8 邻域保留含强核的连通域。
3. 对候选域执行 `clamp(0.012×mask短边, 2, 6)px@2K` 闭运算，填平小于 `max(64px², bbox×0.05%)@2K` 的封闭孔，并丢弃小于 `max(24px², bbox×0.02%)@2K` 的微小孤岛。不使用凸包或包围盒填充，不跨越明显结构间隙。
4. 白灰几何融合图使用全不透明核及约 1.5px@2K 的窄边羽化，避免将弱 mask 当作半透明白模。
5. ModelView 专用 `submittedMaskUrl` 改为从清理后核执行既有 24–64px@2K 外扩和 4–10px 羽化，保留足够重采样上下文，但不再放大微小噪声。

## 影响、迁移与回滚

- 仅修改 Worker 的 ModelView 派生输入；React、Zustand、GPU、shader、UV raster、投影、返图直出和 export compositor 不变。
- Project/Layer/Generation/Capture Schema、Project Command、Revision CAS、ownership、对象存储类别与已有资产无变化，无批量迁移。旧 Generation 仍按已持久化的双 mask 读取。
- 回滚只需恢复 Worker 使用原始连续强度融合 clay，并从原始二值 mask 外扩。不删除任何图层、Generation、mask 或 Revision。

## 验证

- `pnpm --filter @liclick/web test:local-repaint-generation-input`：覆盖闭运算、连通弱边保留、孤立弱噪声/微小强孤岛删除、小孔填充及作者/远端 mask 分离。
- `pnpm typecheck`
- `pnpm --filter @liclick/web build`
