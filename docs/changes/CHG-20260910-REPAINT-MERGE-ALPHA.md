# CHG-20260910-REPAINT-MERGE-ALPHA

## 归属与原因

主模块 M07，协作 M05/M06/M08；ALG-LR-013 合并一致性 v1.1.0；维护文档 2.20.5，UV_MERGE_COMPOSITION_VERSION 7，会话投影烘焙缓存 v10。

用户反馈合并 UV 后出现预览没有的黑线。原模型轮廓内缩保存在返图 alpha；预览按图层 ignoreSourceAlpha=false 消费它，但 createProjectionMaskedImage 一律选择 projection-alpha-only，使源 alpha 被 255 替代。实际函数复现：2K 裁切边缘 alpha=0，预览规则仍为 0，旧合并规则变成 255，RGB 为黑色。画笔蒙版是另一份选区，不能替代模型轮廓裁切。

## 修复

- createProjectionMaskedImage 接收可选 ignoreSourceAlpha；false 选择已有 mask-only，true/未指定选择已有 projection-alpha-only，保留旧全帧兼容行为。
- EditorPage 的 UV 合并与 prepareProjectedLayersForExport 透传 layer.ignoreSourceAlpha ?? true。后者覆盖场景/对象 FBX 临时 UV 和其他共用的模型导出预处理。
- 压平公式：裁切返图 source alpha × 画笔蒙版亮度 × 蒙版 alpha；压平后 maskUrl 清空、ignoreSourceAlpha=false，后续不再重复乘画笔蒙版。
- 无新图像扫描、侵蚀或编码步骤；不对源图再内缩一次，不裁 RGB 包围盒、不移动相机。不改透明像素既有清理和 PNG 编解码行为。

## 对称审计

- CPU / Worker：复用已经对称实现的 mask-only 和 projection-alpha-only；协议和转移所有权不变，缓存图像仍通过私有副本交给 Worker。
- GPU / shader / CPU UV raster：不改像素公式，接收已包含正确覆盖的临时图像，保留原深度/背面/面对角/作者 opacity/蒙版规则。版本递增避免会话复用旧合并输出。
- UV / 导出：UV 合并、颜色合并和模型导出共用同一 alpha 选择，底层 source-under 留住原 UV，不将已裁掉的黑像素恢复为覆盖。
- 持久化：无 Schema、Command、Revision CAS、ownership 或 verified object assets 改动；不删除源图层/历史、不改原模型裁切标记版本。7 是新合并结果的算法元数据，非旧资产自动迁移。
- 分辨率/质量：保持原有加载与烘焙分辨率策略，未降低任何输出或质量门禁。

## 验证

- Web 完整回归 109 contracts、TypeScript/Cloud 生产构建、修改范围 ESLint 和 diff 检查通过。Cloud 产物 85 个 JS、3162508 字节，保留 3163000 上限及所有单 chunk 预算，未放宽质量门禁。
- test:model-silhouette-clip：既有外轮廓/孔洞/细几何裁切断言，加两个调用入口和 false/true/undefined 三态模式验证。
- test:fbx-temporary-uv：场景/对象 × 三种 alpha 状态，确认传参正确及 mask 只应用一次；保留既有 live、撤销/并发快照、部分失败清理及源缓存所有权验证。
- verify-repaint-merge-alpha-browser.mjs：真实 Edge 的 CPU 与 Worker，各三种模式，2048×2048。外轮廓 2px、内部孔扩张不丢失，软边 alpha=128 不变成 64，裁掉处合成后显示 UV 底色而非黑色。生产 PNG 与相同 Canvas 编解码基准逐字节一致；alpha 在编码前后完全一致。Canvas 对软边 RGB 有既有预乘取整，测试不将该量化误称为算法不一致。
- 新裁切模式 CPU/Worker RGBA SHA256 均为 94f99c27a2bbeca98b6b93b010e0f8216e924a4bf3a71144bbeaa5046d62c2f6；旧模式与缺省模式均为 0306c162e3b3e97912748901e1527251273bd324af2c5208a3269e109c9575b9。
- 测试使用合成数据，未取得用户鱼模型完整工程，不声称完成该工程端到端视觉验收。

## 迁移与回滚

不自动修改已合并的像素。若黑边已经写进合并 UV，需从撤销/历史恢复合并前图层再合并；不能通过对成品图再裁切可靠还原。撤销本次代码即可回滚，不删除任何资产。用户随后确认与 ADAPTIVE-GAP-DISTANCE 一起提交 master 并部署 A100，按该卡发布备份及回滚规则执行。
