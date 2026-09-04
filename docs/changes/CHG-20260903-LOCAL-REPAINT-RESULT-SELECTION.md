# 局部重绘结果图层自动选择

- 日期：2026-09-03
- 范围：UI-06/UI-10 → M08
- 契约：`LOCAL-REPAINT-RESULT-SELECTION` v1.0.0

## 问题

局部重绘正式结果已经插入可见图层栈首位时，`LayerStore.setLayers` 会正确选中新结果；发布代码随后却无条件恢复生成前的旧图层，导致新结果出现后高亮仍停留在旧图层。

## 修改

- 首次发布新的局部重绘结果行时，不再恢复旧选择，新结果保持为活动图层并高亮。
- 对已经发布结果的后台结构刷新仍恢复刷新前选择，避免异步保存或资源更新抢走用户正在编辑的其他图层。
- 空白目标图层创建、Generation 准备和 GPU 预热继续保持旧选择；只有结果真正进入可见图层栈才切换。
- 不自动展开折叠的图层面板。

## 边界与回退

不改变投影、蒙版、合成、GPU/CPU/Worker/shader、UV/export、Project/Layer/Generation/Capture Schema、Revision、ownership 或资产，无数据迁移。回退时恢复首次发布后的旧选择即可，已有图层数据无需处理。

## 验证

`test:local-repaint-layer-retention` 同时锁定首次发布选中新结果、已发布结果刷新保持选择，以及内部隐藏目标创建不抢占选择。
