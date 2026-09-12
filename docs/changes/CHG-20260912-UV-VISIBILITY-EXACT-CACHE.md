# CHG-20260912-UV-VISIBILITY-EXACT-CACHE

## 范围

- UI-06 → M06/M09；`UV-DISPLAY-DERIVED-CACHE` v1.2.0。
- 优化图层眼睛开启/关闭后的 UV 展示同步和已完成组合复用。
- 不改变投影转 UV 的 GPU/CPU/Worker/shader、Top-K、接缝、gutter、分辨率、QA 或导出像素。

## 问题与修复

旧展示缓存只以有序图层 ID 作为组合键。图层图片、透明度、混合参数、顺序或内容修订改变但 ID 不变时，旧像素仍可能命中。异步合成新显隐组合期间，展示层还会保留上一组合，并可能把该旧纹理登记到新的显隐键，导致后续开关继续命中错误结果。

现在缓存键沿用完整 UV 组合签名，覆盖图片 URL、role、显隐、透明度、混合/调整参数、内容修订和有序位置。只有请求键对应的精确纹理完成后才允许写入缓存；精确缓存命中可同步复用并跳过展示等待。新组合尚未完成时只允许保留同一精确键的上一份纹理，不再跨状态显示旧组合。取消、失败或晚到结果不能登记为当前状态。

## 持久化、迁移与回滚

缓存只属于当前 renderer 生命周期，不进入 Project、Layer、Command、Revision 或对象存储。Project Command 幂等、Revision CAS、ownership 和 verified assets 不变，无 Schema、资产或旧工程迁移。

回滚可恢复仅 ID 的展示键和旧展示保留逻辑；这会重新引入跨状态错误命中，不需要改写用户数据。

## 验证

- `test:uv-merge-layer-preview` 覆盖完整缓存身份、精确命中优先、跨键禁止保留和仅精确结果入缓存。
- `test:projection-layers` 继续覆盖同步显隐、双击往返、关联重绘行原子显隐和 no-op 数组稳定。
- 完整 Web 123 项回归、typecheck、零警告 lint 和生产构建通过。
- Cloud/performance-lab 正式构建总 JavaScript 为 3,221,860 bytes；总量门禁按本次参考复用与精确缓存集成的有界增量调整为 3,224,000 bytes，shell/editor/high-bake/shared-pipeline 独立门禁保持不变。
