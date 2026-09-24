# 交错投射与局部重绘的实时显示修复

## 范围与契约

- UI-06/UI-09/UI-10 → M07（视口 UV 显示），协作 M08。
- `UV-REPAINT-PREVIEW-BINDING` v1.0.2，UV 重绘预览绑定 / UV repaint preview binding；production。负责人：Codex。
- 输入：当前对象的可见 UV、投射图层及当前绝对 `order`、preview ID。输出：顶层 UV 独立采样器的所属图层，以及排除该层后的下方 UV 栈。
- 无新增常量、阈值或像素公式；UV 坐标、矩阵空间、sRGB、透明度和分辨率沿用既有实现。

## 根因与修改

触发顺序：单视图 ModelView 投射 P1 → 局部重绘 R1 → 单视图 ModelView 投射 P2 → 局部重绘 R2。最终从上到下为 R2、P2、R1、P1。

`layerStackPreviewSignature` 与 `uvLayerStackPreviewSignature` 故意使用同类图层的相对顺序，避免另一类图层插入后重复合成像素。`useStableValueBySignature` 因此可能保留绝对 `order` 已过期的对象。P2 刚创建时为 order 0；R2 插入后 P2 实际为 order 1，但稳定内容缓存中的 P2 仍为 order 0。

旧的顶层判定读取稳定缓存，误认为 R2 并不位于 P2 上方，取消顶层独立 GPU 采样器，把 R2、R1 一起送入 CPU/Worker 合成。CPU 镜像在笔画提交后才更新，合成又等待交互结束，导致松手才显示；重新发布下层 revision 还会让整组组合纹理等待更新。

修复只让 `SceneRoot` 的顶层判定及 memo 依赖读取当前 `visibleUvLayers`、`visibleProjectedLayers`。像素缓存继续复用原相对顺序签名。其余三个 `getTopUvPreviewLayer` 调用方已使用当前 store 图层，无需修改。上一轮材质重建补丁已移除，由这个根因修复替代。

## 六路径审计

| 路径 | 审计结果 |
| --- | --- |
| GPU | `UvRepaint.stamp` 仍写原 RenderTarget；当前顶层直接由 `liveUvOverlayMap` 采样，两 UV 层时下层由 `uvOverlayMap` 采样。 |
| CPU | 仅修正显示归属判断读取的数据；提交镜像、相对内容缓存及像素公式不变。 |
| Worker | `compositeUvLayers` 与位图上传不变；正确分离顶层后，两层场景不再错误走双层 CPU 快照。 |
| Shader | `createUvOverlayPreviewMaterial`、投影材质与颜色/coverage/层序公式不变。 |
| 持久化 | 无 Project/Layer/Generation/Capture Schema、Project Command、Revision CAS、ownership 或资产变化。 |
| 导出 | `getVisibleUvLayerStack`、UV merge、导出方向及合成结果不变。 |

## 验证

- 新回归直接执行 `SceneRoot` 的顶层判定回调，构造当前四层顺序和仍保留 order 0 的投射缓存：旧代码断言失败（顶层为 undefined），修复后通过。另覆盖新投射插入已有重绘上方的反向变化。
- 4517 内置浏览器旧构建验证：重建投射先到、重绘后插入的状态后，`useLiveUvOverlayMap=0`，两层走非 RenderTarget 合成纹理。
- 新构建在独立工程副本验证；复用已有生成资产准备 P2、R1、P1，再通过 UI 新建 R2，未重新调用远端 ModelView。新顶层 `useLiveUvOverlayMap=1` 且绑定 RenderTarget；切到 R1 后下层同样绑定 RenderTarget，顶层保持原纹理。
- 模型截图区域为 x=480、y=220、380×310，变化统计阈值为任一 RGB 通道差 >2。R2 鼠标按住时已有 1500 像素改变；与松手后稳定画面差异为 0。R1 后轮笔画排除画笔圆环区域 x=495..555、y=366..429 后，按住时已有 1320 像素改变；松手前后仅 2 像素变化、最大通道差 8；后续 4 张截图与稳定画面差异为 0。这是采样帧验证，不代表完整 30/60fps 录屏。
- 下层连续截图曾发生浏览器工具超时，重置工具、确认鼠标释放后改用串行截图完成上述验证；未把超时采样计入结果。
- Web typecheck、构建及相关模块回归通过；最终命令结果以本次任务记录为准。

## 迁移与回退

无需数据迁移、重新生成或重烘焙。刷新 4517 可加载新构建。回退只恢复顶层判定对稳定数组的引用及版本注释，不删除任何工程、图层或资产。
