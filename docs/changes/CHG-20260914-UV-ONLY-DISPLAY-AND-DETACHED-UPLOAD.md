# CHG-20260914 UV-only 显示与 detached 上传批处理

## 变更范围

- 主模块：M07；协作 UI-06/M03/M04/M06/M08/M09/M11。
- 算法：`UV-DISPLAY-BUFFER` v1.4.0、`PERF-UV-SOURCE-PREPARE-001` v1.12.0。
- 目标：投影仅作为生成 UV 的输入；提高投影转 UV 与图层切换速度，同时保持结果、生成参考、持久化及导出正确。

## 实现

- SceneRoot 的 PBR/平面显示固定消费最后一张已验证 UV/base buffer；direct、texture-array、数组失败回退和 projected-eraser 特例均不再把投影数据发布进视口材质。
- 显隐或蒙版变化继续进入 Resident UV 的 latest-wins 请求；新结果未完成时保持上一张已验证 UV，完成全分辨率计算、QA 与上传后原子切换。
- 精确 UV bake 模块在工程恢复并空闲后只预加载代码，不创建纹理、Framebuffer 或派生资产。
- Detached renderer 保留 128K 条带，最多连续提交 8 条或累计 4ms 后让出浏览器任务；每条仍检查交互与取消，flush、方向和 GL 状态恢复不变。
- S7 按 UV-only 语义验收：暂停后台发布的交互窗口只要求 resident UV 行立即改变颜色；投影行是待生成输入，其精确像素由 S4 验证。测试仍检查 PBR/Normal/Wire/Flat、全开/全关、局部重绘 overlay、最终恢复与禁止投影材质。

## 正确性审计

- GPU：仍使用原完整分辨率 raster、Top-K、readback、校正、接缝与 gutter；未降低尺寸或跳过 QA。
- CPU/Worker/shader：像素、coverage、rendered-color mask、Y 方向、Alpha 与采样公式不变。
- 生成：单/多视图已有纹理检查仍调用 `captureCurrentColorPreview(..., colorMode: 'flat-target-coverage')`；`captureFlatTarget` 在冻结材质和分块截图前等待 `waitForResidentUvPresentation`，不会把旧 UV 或只含底图的画面提交给后续生图。
- 持久化/导出：投影层、捕获相机、对象矩阵、depth/normal/mask 继续保留；Project Command 幂等、Revision CAS、ownership、verified asset 与所有导出入口未变。

## 验证证据

- 4517 / RTX 4070 Ti SUPER / Edge / 4K A60 工程：S7 800 次操作，P95 `16.8ms`、最大 `33.4ms`、实际错失刷新率 `0.114%`、材质重建 `0`、状态错误 `0`、overlay 错误 `0`；结束后材质为 `LiclickUvOverlayPreview`、纹理 `4096x4096`、`projectedLayerCount=null`。
- 同工程 S2 热缓存：图层保护 P95/最大 `16.8/16.9ms`，发布 P95/最大 `16.8/16.8ms`，掉帧 `0%`。首次精确 4K 派生仍出现约 `116.8ms` 峰值，作为后续冷路径优化项保留。
- 隔离 WebGL：512/13、4K/6、512/13 retained-raster 的当前/对照 RGBA 与 coverage 差异均为 `0`；当前路径未观察到 Long Task。
- 专项：Resident UV、projection visibility、incremental UV/eraser、preview upload 取消/失败/资源清理、flat capture isolation、single-view completion、multiview pairs、TypeScript、lint（0 error，2 个既有 warning）与 production build。

## 迁移与回滚

- Schema/资产/Command/Revision 无迁移；Resident UV 与光栅缓存均为可丢弃派生数据。
- 回滚先停止新的 Resident UV 任务，再恢复 direct/texture-array/eraser 显示门禁，并把 detached 上传恢复为每条带让出一次任务。不得删除投影源、捕获矩阵或已发布 UV；旧新版本均可重新生成派生缓存。
