# Projected Layer Visibility, Blend, And Depth

当前投影 visibility 已支持 Mask、linear-view Depth、Normal、backface、frustum 和对象矩阵补偿。旧的“multiview 仍是未来能力”和“depth 只是 grayscale approximation”不再成立。

## Per-fragment Rules

1. 用保存的 camera projection/view matrix 投影当前 world position。
2. 应用 capture object matrix 到当前 object matrix 的 delta。
3. 拒绝 `clip.w <= 0`、NDC/frustum 外和 image UV 外样本。
4. 应用 image-edge feather 与 source alpha。
5. 读取 capture mask。
6. 将 projected view depth 与 `depthEncoding='linear-view'` 的捕获深度比较；在邻域内允许有限 tolerance。
7. 以 depth 作为前表面权限；角度过渡使用插值后的顶点法线。捕获 Normal 只作为显式启用的辅助校验，不再作为普通投影或局部重绘的默认 alpha 权限。
8. 应用 backface policy、minimum facing、opacity、strength 和 HSL。
9. 计算连续 coverage 与 quality；surface-locked local repaint 保留 authored alpha/mask 的硬权限，但 depth 邻域和角度边缘连续衰减，禁止按三角形阈值二值化。
10. 无有效投影样本时投影贡献为零，露出既有底层显示；投影边缘不写白色、灰色或其他填充占位色。

## Blend And Overlay

- `Blend` 适合多视图重叠：按质量保留强候选并组合，不简单依赖 layer order。
- `Overlay` 按图层栈顺序覆盖 Blend base。
- UV overlay 使用独立 sampler/合成路径，不把“未 flatten 的 UV layer”伪装成 baked BaseColor。
- 大 stack 可使用 texture arrays 和 compact shader；系统还有 sampler budget 与 live-preview guard。

## Resident Preview And Eye Toggle

- 保存的全部 Projected Layer 在一套最终 texture-array material 中常驻；隐藏图层仍保留 sampler，只把 opacity uniform 设为 0。
- 首帧不再发布单视角“快速材质”，也不会在稍后用另一套 resident material 覆盖。因此相同图层不会经历“首帧正确、随后梳齿化”的二次状态。
- 图层眼睛、opacity、显示模式和灯光是同步 uniform 更新，不触发图片解码、纹理数组重建、shader 重编译或材质替换。
- Color、Mask、Depth、Normal 数组使用独立预算。14 视角的 authored linear-depth 可保留 2K 精度；大纹理在 worker 中准备并按不超过 1M pixel 的 stripe 上传，每次提交后让出一帧。
- 有效的 authored `linear-view` Depth 在该预览生命周期内保持权威；只有缺失或 legacy depth 才会后台修复，修复默认只生成 Depth，不生成会暴露三角面的 flat Normal。

## Multiview Reuse

多视图已复用同一套 visibility：每个 camera view 形成独立 Projected Layer，实时预览和 UV bake 都按 view coverage/quality 组合。批次结束后的 content-aware repair 根据 UV coverage 检测空洞，生成 repair layer，而不是把坏视角无条件铺满模型。

## UV Bake Rules

UV-space bake 对每个 texel 重构 world position/normal，并使用与实时预览一致的 Mask/Depth/backface/frustum/source-alpha 和连续角度 coverage。Normal visibility 是 opt-in；surface-locked local repaint 默认以 Depth 为前表面权威。Blend sources 先进入质量合成，Overlay sources 再按顺序应用。Padding/seam repair 只能扩展已确认的 UV coverage，不能绕过 authored mask permission。

## Remaining Limits

- Linear-view depth 仍是分辨率有限的 PNG 资产，不是逐像素 ray cast；薄壳、重叠面、透明面和极端 grazing angle 需要人工验证。
- 插值顶点法线用于平滑角度过渡；错误/破损 mesh normal 仍可能影响角度 coverage，但不会再通过默认 flat-normal 阈值把边缘切成三角梳齿。
- 纹理数组和 compact shader 缓解 sampler 限制，但显存、WebGL compile 和 texture upload 仍限制超大多视图栈。
- Local repaint 的 authored mask 是硬权限边界；任何新 repair/merge 优化都必须验证未选区域 bitwise/visual 不被改写。
