# CHG-20260903-LOCAL-REPAINT-SELECTION-INDEPENDENCE

- UI-10 → M08；ALG-LR-008 v2.4.1；日期 2026-09-03；3 个运行时源文件。
- 用户确认每个 Generation 自动创建独立重绘图层正确，要求去除对当前图层选择的依赖。

## 根因和修改

pointer-down 只豁免蒙版绘制，遗漏 inpaint-apply，导致隐藏投影层或未选择时误弹普通画笔的 UV 图层提示。现有重绘分支已依据 source、composite、exact overlay 和 Session 验证资源，现绕过普通图层 gate 后仍执行这些检查。

ensureLocalRepaintSessionLayer 创建/复用隐藏 draft 时曾将其设为 active，面板随后把隐藏 draft 重定向到普通投影层。默认改为保持选择，并在保存快照前恢复；GPU 蒙版 promotion、重绘行发布和去重也保持选择，包含 undefined。独立目标创建、同 Generation 累积、新 Generation 新目标不变。

## 审计与验证

- GPU/CPU/Worker/shader：仅修正输入准入和选择状态，source/coverage、depth、mask、shader、UV bake 与导出公式和分辨率不变。
- 持久化：重绘继续写自身目标与结果层，普通 UV/投影层不成为写入目标；Project Command 幂等、Revision CAS、ownership、verified assets 和 Schema 不变。
- 真实 Zustand/domain 调用测试 UV、隐藏投影、undefined 三种选择下的创建/复用和发布恢复；执行真实 pointer-down 条件确认重绘可通过、普通画笔/橡皮擦仍检查目标。layer-retention 回归通过。
- 回退仅恢复旧选择及 pointer gate；无数据迁移，不删除已有重绘图层或资产。
