# UV Bake And Merge Notes

当前代码仍保留通用 GPU-first projected-to-UV bake engine，但产品行为已经从早期“全局 Auto UV bake”演进为多种显式用途。不要再用旧的开关模型描述现状。

## Current Entry Points

| Entry | Trigger | Result |
| --- | --- | --- |
| Merge selected layers to UV | 用户在 Layers 面板执行 | 把选中 Projected/UV sources 合成新 `merged-uv` layer |
| Merge into blank UV layer | 用户选择目标空白 UV layer | 更新目标 UV layer 并消费 source visibility |
| Local repaint UV commit | 用户确认局部重绘 | 创建/更新 `local-repaint-overlay` UV layer |
| Content-aware repair | 用户触发，或 multiview 完成后自动尝试 | 分析 projected coverage，生成/更新 repair underlay |
| Textured model/BaseColor export | 用户导出 | 若没有与当前 visible stack 完全匹配的 cache，则按需 bake，再叠加 visible UV layers |

新增 Projected Layer 本身只进入实时 shader preview。当前没有用户可操作的全局 Auto UV bake toggle，也没有“关掉后才只看实时投影”的双模式。

## Key Files

- `apps/web/src/engine/bake/bakeProjectedLayerToTexture.ts`：投影到 UV 的统一入口。
- `apps/web/src/engine/bake/gpuUvBakeRenderer.ts`：GPU UV-space renderer。
- `apps/web/src/engine/bake/uvRasterizer.ts`：CPU/parity triangle rasterization。
- `apps/web/src/engine/bake/imageSampler.ts`：图像、Mask、Depth、Normal sample。
- `apps/web/src/engine/bake/dilation.ts`：基础 padding utility；生产 merge 还使用拓扑约束的 gutter/seam 处理。
- `apps/web/src/engine/projection/ProjectedLayerMaterial.ts`：实时 projected stack 与 UV overlay preview。
- `apps/web/src/engine/export/texturedExportUtils.ts`：精确 cache 查找、export-on-demand bake 与 UV flatten。
- `apps/web/src/routes/EditorPage.tsx`：手动 merge、局部重绘 UV commit、内容补缝和 progress 编排。
- `apps/web/src/components/panels/LayersPanel.tsx`：选择、可见性和 merge UI。

## Projection Bake

GPU 路径把目标 mesh 绘制到 UV-space render target。每个 fragment 重构 world position/normal，并通过 source layer 保存的 projector camera 执行：

- frustum 和 image bounds；
- source alpha 与 projection mask；
- linear-view depth 和 normal visibility；
- backface/facing；
- opacity、strength、HSL 与 Blend/Overlay 规则。

CPU path 用 barycentric rasterization 产生同类结果，用于 parity/coverage 验证和必要 fallback。GPU 失败时是否允许同分辨率 CPU fallback 由调用路径和资源条件决定；不能承诺所有 8K 场景都能无成本回退。

## Merge Semantics

- Merge 输出 straight RGBA，不把 PBR 灯光/曝光错误固化进 BaseColor；特殊 `renderedColor` repair layer 有单独权重语义。
- Selected UV sources 作为 underlay 与 projected result 合成，避免 repair layer 在 merge 后消失。
- 最终图片编码后先预热 GPU texture，再原子创建/更新 UV layer 并切换 source layer visibility。
- `uvMergeVersion` 和 source `contentRevision` 参与兼容/cache 判断。
- 合并目标是 Layer，不等同于独立 Model Baking 工作台的 PBR bake job。

## Export Cache

导出 cache 必须匹配：

- project/object；
- visible projected source ids、revisions 和参数；
- output resolution/alpha/options；
- layer stack signature。

如果不存在精确 cache，GLB/FBX/OBJ 或 BaseColor 准备过程调用 projection bake。之后把 visible UV layers 叠加在 imported/baked base 上，并为导出 clone 应用 `Liclick_BaseColor` material。

## Orientation

当前 UV/Three.js/glTF 路径使用 `texture.flipY = false`。PNG、live preview、GLB、FBX 和 OBJ 必须作为一组验证；不能只通过浏览器截图判断 orientation 正确。

## Limits

- 一次处理活动对象与一个 `uv` attribute；无 UDIM。
- Texture editor 的 projection bake 主要生成 BaseColor RGBA。
- 大分辨率成本包括纹理 decode/upload、UV rendering、readback、PNG encoding、workspace upload 和 preview prewarm。
- 复杂几何/多层场景会受 WebGL texture size、sampler/array、显存与浏览器内存限制。
- Seam/gutter 算法是面向当前 mesh/UV 的工程实现，不是完整 DCC baker 替代品。

## Manual Verification

1. 导入带 UV 的 GLB/glTF。
2. 创建单视图和多视图 Projected Layers，确认新增层后仍是实时投影。
3. 选择多层执行 Merge to UV，确认 source 显隐、UV layer 和 PBR/Flat preview 一致。
4. 对 UV repair/local repaint layer 再次 merge，确认未被漏合成。
5. 导出 BaseColor、GLB、FBX、OBJ，确认缓存命中/按需 bake 后的结果一致。
6. 用侧视模型验证 `flipY`、seam、mask permission 和 depth visibility。
