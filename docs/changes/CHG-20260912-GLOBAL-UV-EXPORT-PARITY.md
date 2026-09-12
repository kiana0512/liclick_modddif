# CHG-20260912-GLOBAL-UV-EXPORT-PARITY

- 模块：M05、M07、M11
- 规则：`UV-LAYER-OBJECT-APPLICABILITY` v1.0.0

无 `objectId` 的历史/global UV 层原本在常驻显示与 FBX 中适用于当前对象，但标准 GLB/GLTF/OBJ 导出在共享筛选后又执行严格对象 ID 筛选，导致格式间 BaseColor 不一致。对象适用规则现统一为“无对象 ID 或与目标对象相等”，标准导出不再二次丢弃 global UV。

不改层顺序、像素混合、分辨率、GPU/CPU/Worker/shader、QA、持久化或 Schema，无迁移。回归覆盖 global/对象/其他对象/隐藏 UV，以及 FBX、GLB/GLTF/OBJ、ZIP、自动颜色和原生 UV 合并。回滚为恢复标准导出的二次严格筛选；无数据回滚。
