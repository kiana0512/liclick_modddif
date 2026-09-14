# CHG-20260914：图层显隐热路径与捕获深度复用

## 变更身份

- 主模块：M07（投影转 UV）
- 协作模块：UI-06、M06、M08、M09
- 算法：`PERF-UV-SOURCE-PREPARE-001` v1.11.0
- 展示算法：`UV-DISPLAY-DERIVED-CACHE` v1.3.0
- Schema / Project Command / Revision CAS / ownership / verified assets：不变

## 问题

1. 普通投影层已经保存捕获相机、捕获对象矩阵和 `linear-view` 深度，但对象发生后续平移、旋转或缩放后，显式“投影转 UV”仍会为每层重新执行完整深度捕获。
2. 眼睛按钮已经能同步更新常驻材质 uniform，但同一次显隐变更还会通过包含全部可见性的 React 签名触发完整 `ImportedModel` 材质派生。隐藏活动普通层时，通用 active-layer 订阅还会再触发一次无像素意义的模型重渲染。

## 实现

### 捕获空间可见性复用

- 新增纯判定 `canReuseAuthoredProjectionVisibility`。
- 只有同时满足以下条件才复用：存在 depth、编码为 `linear-view`、存在 16 项捕获对象矩阵；请求几何法线校验时还必须存在 normal。
- 旧工程缺捕获矩阵、旧深度编码、缺 depth 或缺所需 normal 时，继续调用 `createRuntimeProjectionDepth`，并把保存的捕获对象矩阵传入重建。
- GPU 与 CPU UV 光栅继续使用 `captureObjectMatrix * inverse(currentObjectMatrix)`。因此当前表面点先应用当前矩阵、再应用该 delta，严格回到原捕获空间；没有改变深度阈值、背面剔除、采样、Alpha 或颜色公式。

### 图层眼睛热路径

- 删除覆盖所有 UV/projected 可见性的重复 React 展示签名。
- 常驻 UV/投影材质命中时只同步 uniform；精确组合不存在、材质未接收同步、可见内容改变、局部重绘路由或多层合成结构改变时，仍显式提升 `uvVisibilityRenderRevision` 并走完整重建。
- `ImportedModel` 不再订阅通用 active layer ID，只订阅会改变画面的“当前局部重绘是否活动”“当前活动 UV mask 层”“当前活动层是否为 projected eraser target”三个窄事实。

## 正确性与全链路审计

- GPU：shader、纹理格式、纹理上传、Top-K/overlay、深度/normal 采样和 GL 状态不变。
- CPU：CPU 兼容光栅与同一矩阵 delta 不变。
- Worker：解码、质量混合、接缝、gutter、PNG 编码和取消协议不变。
- 持久化/导出：不修改 Layer、Project、Revision 或 Asset 字节；正式合并和导出继续消费同一完整分辨率 RGBA。
- 质量：不降分辨率、不省略 QA、不改变透明度、颜色、覆盖率或接缝公式。
- 可执行回归验证两组非平凡当前矩阵、三组局部点均满足捕获空间等价误差 `<= 1e-9`；复用/回退条件采用真实生产函数表驱动执行。
- 图层显隐回归覆盖 570 个常驻组合转换和 60 次保留材质恢复，并验证冷缓存/无材质接收时仍进入重建。

## 迁移与回滚

- 无数据迁移。历史层无需回写；缺少捕获矩阵的行自动保留旧重建行为。
- 回滚时移除 `projectionVisibilityReuse.ts`，恢复 bake 前逐层运行时深度生成条件，并恢复 SceneRoot 的全可见性/active ID 订阅。回滚不会改变已经保存的资源。

## 已知边界

- 捕获空间复用消除的是对象刚性/仿射变换后的冗余深度捕获；旧数据不完整时仍需生成。
- 本地当前“割草机器人”测试工程只有普通 UV/局部重绘层，没有真实 projected 层，无法用该工程完成 S5/S4 的真实投影压测；专项自动化仍覆盖调度和像素语义，正式发布前需在含真实投影栈的 4K 工程执行 S4/S5/S7。
