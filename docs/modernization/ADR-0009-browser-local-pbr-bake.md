# ADR-0009：浏览器本地 PBR Bake

状态：已被 [ADR-0011](./ADR-0011-real-production-compute-services.md) 替代。本文只保留浏览器 BVH 烘焙实验与回归内核的历史证据，不代表当前产品路径。

2026-08-21 产品要求澄清：生产 PBR Bake 必须提交真实 Substance Worker。浏览器 BVH 内核可以继续用于隔离测试、算法对照和将来适合本机执行的轻量任务，但不得作为正式页面的默认执行器，也不得在真实服务不可用时静默回退。

## 问题

旧 Bake 页面依赖远端 Substance/3090 服务，既会把高低模计算转移到服务器，也无法满足纯浏览器、用户本机算力和零安装目标。旧流程还会把 OBJ 派生的 GLB 再按普通 GLB 米制放大 100 倍，导致同一模型被误判为高低模不匹配。

## 决策

- 高模、低模解析、UV 光栅化、BVH 构建、射线投射、AO、厚度与 Padding 全部在浏览器 Worker 中执行；计算服务器没有 fallback。
- 当前真实几何输出通道为 Base Color、Normal（DirectX/OpenGL）、AO、Curvature、World Normal、Position、Thickness。Base Color 使用 BVH 命中的高模三角形重心坐标采样高模 UV0，再写入低模 UV；Curvature 使用焊接顶点的一环 Laplacian 估算有符号几何曲率并按命中三角形重心坐标插值。Roughness、Metallic 只有真实输入或已启用的生成流程才可选，不用占位图冒充结果。
- 浏览器本地内核接受 1K、2K 与 4K；4K 在 Worker 中真实生成 4096×4096 RGBA，不会静默降级。复杂生产模型的七通道峰值内存仍属于发布前性能门禁。
- Worker 使用紧凑的原生三角形 median BVH，并通过原地 quickselect 建树，避免重复打包 Three.js/BVH 依赖和递归排序分配。加入 Base Color 采样后的 Worker 构建产物为 11.77 KB；Web JavaScript 总量保持在既有 3,150,000 字节门禁以下。
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

第二个命令使用平面高低模验证 Base Color 的 UV 采样与传递，使用闭合非平面几何同时验证 Normal、AO、Curvature、World Normal、Position、Thickness 六个几何通道、Padding、厚度灰度范围与 DirectX/OpenGL 法线方向，并以真实 4096×4096 输出验证 4K 上限。机器证据位于 `quality/evidence/browser-local-pbr-bake-e2e.json` 与 `quality/evidence/browser-compute-kernel-matrix.json`。

## 尚未宣称完成

- 复杂生产模型、多个子网格/材质槽、非平面高低模、背面、穿插、退化面和重叠 UV 对照。
- Base Color、Curvature、World Normal、Position、Thickness 已完成内核回归，但仍缺多材质槽生产模型参考图像阈值。
- 2K/4K 大模型耗时、七通道峰值内存、取消、低内存、Worker 崩溃恢复和目标硬件性能矩阵。
- GPU/WebGPU Bake 后端、UDIM、多 atlas、cage 模式和跨浏览器兼容矩阵。

该实验曾使用机器门禁 ID `bake.browser-local-pbr`；当前机器真源已改为 `bake.production-substance`。浏览器几何内核证据只用于回归，不能提高生产 Substance 服务状态。
