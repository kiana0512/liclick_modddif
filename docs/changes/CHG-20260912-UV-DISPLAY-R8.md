# CHG-20260912-UV-DISPLAY-R8

## 范围与版本

- 主模块：M07 UV 投影转换与常驻显示。
- 协作模块：M06 投影视口、M08 局部重绘、M09 GPU/Worker 基础设施、M15 构建门禁。
- 算法版本：`UV-DISPLAY-MASK-WORKER` v1.2.0、`SHADER-TEMPLATE-FORMAT` v1.3.0。
- 生产前提：Resident Top-K 与本次 R8 上传继续使用项目既有 WebGL2 路径，不新增实验性浏览器 UV/PBR 内核。

## 问题

v1.1.0 已把 4K rendered-color mask 的整图 RGBA 展开移出 UI 线程，但 Preview Bitmap Worker 在每个上传条带仍把一字节 mask 扩成 `R=mask/G=0/B=0/A=255` 的四通道 `ImageData`，再创建 `ImageBitmap`；GPU 端也分配完整 RGBA8 纹理。所有消费 shader 实际只采样 `.r`，因此其余三通道造成额外条带分配、Worker 到 GPU 上传量与显存占用。

## 修改

1. Worker 的 mask 条带直接复制为单通道 `Uint8Array`，按原 Y 翻转行序转移 ArrayBuffer，不再创建 RGBA `ImageData` 或 `ImageBitmap`。普通颜色预览仍沿用原 RGBA ImageBitmap 路径。
2. `createWorkerBackedMaskPreviewTexture` 创建 `THREE.RedFormat + UnsignedByteType` DataTexture；原 shader、采样坐标、线性过滤和 `.r` 读取不变。
3. 分条上传按条带类型分别调用 RGBA TexImageSource 或 WebGL2 `RED + Uint8Array` 重载。单通道路径临时设置 `UNPACK_ALIGNMENT=1`，并在每次提交后恢复 active texture、binding、flip、premultiply 与 alignment，避免奇数宽度或共享 R3F GL 状态污染。
4. Resident UV 缓存预算按单通道 mask 的实际一字节/像素计量；无 rendered-color 时的 1×1 中性 mask 同样使用 RedFormat。
5. 构建期 shader 去缩进白名单增加 `ViewportCanvas.tsx`。测试逐 token 比较 TSX 转换前后内容，并逐个确认发生变化的模板由 vertex/fragment Shader 属性或明确 GLSL 变量拥有；普通 UI 模板不参与。

## 量化结果

- 4K mask 像素数：16,777,216。
- 单个 GPU mask 名义容量：RGBA8 64 MiB → R8 16 MiB，减少 48 MiB（75%）。
- Worker 条带数组与 Worker→GPU 源数据：4 bytes/texel → 1 byte/texel，减少 75%；实际总耗时仍受驱动、条带调度和同帧其他 GPU 工作影响，不把名义带宽比例冒充端到端加速。
- Shader 格式门禁的受控源缩进移除量：12,368 → 14,930 字节。
- release 总 JavaScript：`3,219,113 / 3,222,000` 字节，余量 `2,887` 字节；原预算不变。

## 验证

- Resident UV Worker 回归逐字节验证 3×2 奇数宽 mask 的两个 Y 翻转条带，确认输出仍为原 `.r` 字节且释放后拒绝读取。
- Preview upload 回归覆盖 RGBA ImageBitmap 与 R8 typed-array 两条路径的成功、取消、分配失败、首/后续/迟到条带失败、提交失败和 drain 取消；确认条带所有权、无未处理拒绝、计数归零及全部 GL 状态恢复。
- 图层显隐、display preview queue/readback、投影性能安全与 TypeScript 回归通过。
- 本机缺少仓库 Playwright 包，自动真实 WebGL 像素读回未执行；4517 已提供给人工真实工程验收。此限制必须保留，不将静态/模拟回归表述为浏览器像素证明。

## 不变项

- 不降低 1K/2K/4K 分辨率，不关闭 QA、Top-K、接缝、补边或 Resident UV 呈现屏障。
- 不改变 GPU/CPU/Worker 的 UV 颜色求解、coverage/rendered-color 字节、Y 方向、图层顺序、显隐、交互和导出结果。
- Project/Layer Schema、Command 幂等性、Revision CAS、ownership、verified assets 与 Cloud 生产边界不变。

## 迁移与回滚

无 Schema、项目、对象资产或持久缓存迁移。回滚时恢复 mask 条带 RGBA `ImageData/ImageBitmap`、RGBA DataTexture 与四字节缓存计量，并从 shader 构建白名单删除 `ViewportCanvas.tsx`；不得通过降低分辨率、跳过 QA 或提高包体预算替代回滚。
