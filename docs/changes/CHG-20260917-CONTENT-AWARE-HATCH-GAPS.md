# 放大视图深色斜线缺口修复

主模块 M07，协作 M05/M06/M08/M09。`LOCAL-BOUNDARY-REPAIR/1.3.0`，`ALG-CA-001` v1.1.0。

## 问题与根因

用户在复杂模型上放大观察时，圆环、螺栓和曲面交界仍出现深色斜线。该斜线是投影材质对低覆盖 texel 的空洞提示，不是模型原纹理。

生产缺口扫描虽使用与实时 shader 相同的可见空洞 alpha 上限，但随后又按贴图尺寸过滤小连通分量。4K 下，面积不足 256 texel 且包围盒跨度不足 48 texel 的缺口会被拒绝；这与编辑器“连一 texel 裂缝也应保留”的覆盖契约冲突，直接留下放大可见的短裂缝和三角缺口。

## 修改

- 生产可见表面策略将最小缺口分量设为 1 texel，并关闭长缝例外门槛。通用 `buildContentAwareRepairMask` 默认噪声过滤保持不变，只有正式可见表面完成策略采用该行为。
- 最终写入仍必须位于严格 UV 像素中心 `coreMask`，且必须有有效 region；模型外背景、真实几何空隙和保守拓扑 halo 不会因为本次修改获得输出 alpha。
- 正式局部边界传播仍固定 `maxSeamCrossings=0`。编辑器预热与实际拓扑构建不再生成或传递必然不会被消费的 seam links；同 region、来源 alpha、颜色门槛和不可达缺口策略不变。
- Jacobi 局部混合在一次完整写回没有产生任何字节变化时停止；此时已达到字节级固定点，继续迭代只能产生相同 RGBA。非固定点仍保留原最多 64 轮和原舍入顺序。

## 验证

- 内容填补专项 31/31：覆盖 4K 单 texel 深色斜线、严格 UV core 外真实空洞、跨 region/跨 seam 禁止借色、全局平均禁用、不可达中心、覆盖裙边、取消、确定性和 v1.2.0 黄金像素。
- 拓扑分类回归通过：24 组有/无 seam-link 构建的 `coreMask`、`regionIds`、`conflictMask` 完全一致，无 seam 模式返回空 link 表。
- Edge 真实浏览器 2048²：Worker/主线程完整字节差 0，修复 262,144 texel，无全局兜底。
- Edge 真实浏览器 4096²：Worker 完成 524,288 texel，中心 RGB `[140,80,95]`，无全局兜底；本合成渐变夹具约 2.78 秒，不能据此宣称复杂项目已达到交互帧预算。
- Web 全回归 147 项通过；正式 release 构建、Cloud 产物边界、包体预算（含 256-byte 余量）、Cloud 部署模拟和本地集成 Web 冒烟通过。lint 为 0 error，保留 `GeneratePanel.tsx` 两个与本次无关的既有 unused warning。

## 影响范围

GPU 投影 shader、空洞斜线阈值、投影合成顺序、UV 分辨率、输出尺寸、PNG、导出、QA、Layer/Project Schema、Project Command、Revision CAS、ownership 和 verified assets 不变。旧内容填补资产不重写；用户再次执行内容填补时，新策略只新增能够从同 region 原始可靠边界到达的稀疏 underlay texel。

## 迁移与回滚

无数据库、Schema、工程或对象资产迁移。回滚时恢复生产策略的分辨率相关连通分量门槛、重新启用编辑器 seam-link 构建/传递，并移除字节固定点提前结束；已有工程和资产全部保留。回滚会重新引入放大视图短缺口未补全和无效 seam 拓扑成本。
