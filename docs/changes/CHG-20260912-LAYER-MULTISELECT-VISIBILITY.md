# CHG-20260912-LAYER-MULTISELECT-VISIBILITY

- 主模块：M05；协作：UI-06、M06、M07
- 交互契约：`LAYER-MULTISELECT-VISIBILITY` v1.0.0
- 问题：多选图层批量关闭后，LayerStore 会把 active layer 切换到其他可见层；面板旧同步 effect 随即把选择收敛成新的单层，用户无法用同一组隐藏图层的眼睛批量重新打开。仅用背景色表达选择时，active 与 selected 也不够清楚。
- 修改：多选集合长度大于 1 时，不因外部 active layer 变化自动收敛；点击任一已选图层的眼睛继续对该集合应用同一个目标可见状态。selected 行增加洋红内描边，active 行保留蓝色底边。
- 边界：单选、Ctrl/Meta 切换、Shift 范围选择、拖动排序、生成锁与删除锁不变；没有引入隐藏的“部分选中”状态。
- 投影/UV：只更正批量显隐操作的选择寿命，不改变最终 visible 值、图层顺序、投影、UV 合成、接缝、分辨率、QA、Worker/shader、持久化或导出。
- 迁移：无 Layer/Project Schema、Command、Revision、ownership 或资产迁移。
- 回滚：恢复 active layer 驱动的单选收敛并移除 selected 内描边；已有工程数据无需改写。
- 验证：静态契约覆盖多选保留与 selected 边界；浏览器烟测覆盖两层多选、批量关闭、选择不丢、批量重新打开及未选层不受影响。
