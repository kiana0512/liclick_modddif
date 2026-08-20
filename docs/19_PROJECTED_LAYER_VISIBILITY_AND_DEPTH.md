# Projected Layer Visibility, Blend, And Depth

当前投影 visibility 已支持 Mask、linear-view Depth、Normal、backface、frustum 和对象矩阵补偿。旧的“multiview 仍是未来能力”和“depth 只是 grayscale approximation”不再成立。

## Per-fragment Rules

1. 用保存的 camera projection/view matrix 投影当前 world position。
2. 应用 capture object matrix 到当前 object matrix 的 delta。
3. 拒绝 `clip.w <= 0`、NDC/frustum 外和 image UV 外样本。
4. 应用 image-edge feather 与 source alpha。
5. 读取 capture mask。
6. 将 projected view depth 与 `depthEncoding='linear-view'` 的捕获深度比较；在邻域内允许有限 tolerance。
7. 用 normal visibility/facing 辅助拒绝错误表面和 grazing noise。
8. 应用 backface policy、minimum facing、opacity、strength 和 HSL。
9. 计算 coverage 与 quality；surface-locked local repaint 使用更严格的 depth/normal 权限。
10. 无有效投影样本时显示 base/imported material。

## Blend And Overlay

- `Blend` 适合多视图重叠：按质量保留强候选并组合，不简单依赖 layer order。
- `Overlay` 按图层栈顺序覆盖 Blend base。
- UV overlay 使用独立 sampler/合成路径，不把“未 flatten 的 UV layer”伪装成 baked BaseColor。
- 大 stack 可使用 texture arrays 和 compact shader；系统还有 sampler budget 与 live-preview guard。

## Multiview Reuse

多视图已复用同一套 visibility：每个 camera view 形成独立 Projected Layer，实时预览和 UV bake 都按 view coverage/quality 组合。批次结束后的 content-aware repair 根据 UV coverage 检测空洞，生成 repair layer，而不是把坏视角无条件铺满模型。

## UV Bake Rules

UV-space bake 对每个 texel 重构 world position/normal，并使用相同 Mask/Depth/Normal/backface/frustum/source-alpha 规则。Blend sources 先进入质量合成，Overlay sources 再按顺序应用。Padding/seam repair 只能扩展已确认的 UV coverage，不能绕过 authored mask permission。

## Remaining Limits

- Linear-view depth 仍是分辨率有限的 PNG 资产，不是逐像素 ray cast；薄壳、重叠面、透明面和极端 grazing angle 需要人工验证。
- Normal 来自当前几何与捕获相机，错误/破损 mesh normal 会影响 visibility。
- 纹理数组和 compact shader 缓解 sampler 限制，但显存、WebGL compile 和 texture upload 仍限制超大多视图栈。
- Local repaint 的 authored mask 是硬权限边界；任何新 repair/merge 优化都必须验证未选区域 bitwise/visual 不被改写。
