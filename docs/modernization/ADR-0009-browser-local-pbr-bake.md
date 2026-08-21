# ADR-0009：浏览器本地 PBR Bake

状态：已接受，Normal/AO 真实纵向切片已接入；完整生产质量与硬件矩阵仍在进行中。

## 问题

旧 Bake 页面依赖远端 Substance/3090 服务，既会把高低模计算转移到服务器，也无法满足纯浏览器、用户本机算力和零安装目标。旧流程还会把 OBJ 派生的 GLB 再按普通 GLB 米制放大 100 倍，导致同一模型被误判为高低模不匹配。

## 决策

- 高模、低模解析、UV 光栅化、BVH 构建、射线投射、AO、厚度与 Padding 全部在浏览器 Worker 中执行；计算服务器没有 fallback。
- 当前真实输出通道为 Normal（DirectX/OpenGL）、AO、World Normal、Position、Thickness。Base Color、Roughness、Metallic、Curvature 在有真实内核前保持禁用，不用占位图冒充结果。
- Worker 使用紧凑的原生三角形 median BVH，并通过原地 quickselect 建树，避免重复打包 Three.js/BVH 依赖和递归排序分配。Worker 构建产物为 10.95 KB；Web JavaScript 总量保持在既有 3,150,000 字节门禁以下。
- Worker 属于项目 Engine Session 的 CPU lane，可取消、切页释放；当前界面与持久化设置固定显示 CPU Worker，不虚报 GPU。
- 每张 PNG 在浏览器编码后通过签名 URL 直接上传对象存储，项目仅保存不可变资产引用、尺寸和本地 Job ID。刷新后从项目 Bake Set 恢复结果。
- 云端资源读取先向同源项目 API 进行 Cookie 鉴权并换取短期签名 URL，再以 `credentials: omit` 访问对象存储，禁止把 Li3D 会话 Cookie 带到数据平面。
- Auto UV 派生模型显式继承源模型的厘米/单位元数据。OBJ→GLB 仍为 1 cm/单位；普通未知 GLB 才使用 glTF 米制默认值。

## 当前实测证据

远端部署模拟器中的真实浏览器流程已经完成：

1. 开发身份登录，导入无 UV 的 OBJ 四边形；
2. xatlas WASM Worker 生成 UV GLB，源 OBJ 和输出 GLB 均完成对象直传；
3. Bake 恢复高模与低模，并通过 UV0、中心、尺寸和形状对齐检查；
4. 用户本机 CPU Worker 在 1024×1024 下输出 Normal、AO、World Normal、Thickness、Position 五张 PNG；
5. 统计为 1,046,529 个覆盖像素、0 个未命中投射样本；
6. 五张 PNG 完成 SHA-256 校验和对象直传，项目 Revision 到 58，Bake manifest 有 5 个条目；
7. 重新加载 `/project/:id/bake` 后仍显示五张 1024×1024 PNG，证明结果不是内存占位；
8. 云构建、远端代理、直传重试/幂等、签名下载解析、服务重启恢复和 JavaScript 预算门禁通过。

可重复测试：

- `pnpm --filter @liclick/web test:local-pbr-bake`
- `pnpm --filter @liclick/web test:browser-asset-kernel-matrix`
- `pnpm --filter @liclick/web test:bake-model-alignment`
- `pnpm simulate:cloud-deployment -- --serve`
- `pnpm check:web-bundle-budget`

第二个命令使用闭合非平面几何同时验证 Normal、AO、World Normal、Position、Thickness 五通道、Padding、厚度灰度范围以及 DirectX/OpenGL 法线方向。机器证据位于 `quality/evidence/browser-local-pbr-bake-e2e.json` 与 `quality/evidence/browser-compute-kernel-matrix.json`。

## 尚未宣称完成

- 复杂生产模型、多个子网格/材质槽、非平面高低模、背面、穿插、退化面和重叠 UV 对照。
- World Normal、Position、Thickness 已完成简单真实浏览器 E2E，但仍缺生产模型参考图像阈值；Curvature 尚未实现。
- 2K 大模型耗时、取消、低内存、Worker 崩溃恢复和目标硬件性能矩阵。
- GPU/WebGPU Bake 后端、UDIM、多 atlas、cage 模式和跨浏览器兼容矩阵。

因此 `bake.browser-local-pbr` 从 `failed` 提升为 `in_progress`，不会因简单四边形的 Normal/AO 纵向切片通过就提前标为 `passed`。
