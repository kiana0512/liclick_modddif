# Cloud Web 性能基线与收敛预算

日期：2026-08-21

## 当前构建基线

Cloud 生产构建当前约 3.06 MB 原始 JavaScript，共 50 个按路由/Worker 拆分的脚本。新增 Auto UV 内核位于独立的约 55 KB Worker，约 225 KB xatlas WASM 不计入 JavaScript 总额且仅在进入 UV 任务时加载。主要债务为：

| 边界 | 当前原始大小 | 阶段一硬上限 | 目标 |
| --- | ---: | ---: | ---: |
| Application shell | 254 KB | 270 KB | 小于 180 KB |
| Editor route | 486 KB | 510 KB | 小于 350 KB |
| High bake snapshot | 691 KB | 720 KB | 小于 450 KB |
| Shared 3D pipeline | 947 KB | 980 KB | 拆为稳定引擎、格式加载器和按需算法块 |
| 全部 JavaScript | 3.06 MB | 3.15 MB | 小于 2.4 MB |

当前上限是防止继续恶化的 ratchet，不代表最终合格。CI 在 Cloud 构建后检查真实最终产物；预算只能随可验证的拆分和删除向下调整，不能通过提高阈值掩盖回归。

共享 3D 图依赖由 Rollup 自动选择 facade 名；加入浏览器 GLTF 导出后名称从 `projectPipeline-*` 变为 `exportUtils-*`。门禁接受这两个生成名之一，但仍要求恰好一个共享块，且 980 KB 单块上限和 3.15 MB 总上限均未提高。

## 运行时审计结论

- `ViewportCanvas.tsx` 超过一万行，同时承担 renderer、投影、局部重绘、GPU 资源、性能实验和输入协调，是首要拆分对象。
- 当前活动编辑器使用连续 `frameloop`；切换 demand-render 前必须为实时投影合成、性能采样、自动旋转和绘制状态补齐显式失效信号，不能直接改一行造成静态画面不刷新。
- 全分辨率工作已有可取消的 Heavy Task Scheduler、Worker 和帧预算 governor，应迁移进按项目生命周期创建/销毁的 Engine Session，而不是推翻有效优化。
- Project/React UI 只提交 Command 和展示进度；GPU Texture、RenderTarget、ImageBitmap、Worker、WASM Memory 与 OPFS 临时对象由 Engine Session 统一拥有和释放。

## 下一阶段可验证退出条件

1. 增加 Engine Session 资源注册表和项目切换泄漏测试。
2. 将 `ViewportCanvas` 的投影、局部重绘和性能诊断拆为独立子系统，保持视觉 golden/交互测试一致。
3. 用显式 invalidation 把空闲视口切到 demand-render；空闲 30 秒 GPU frame 数接近零。
4. 所有重任务记录 queue delay、first-result、P95 frame、long task、GPU/CPU 内存和取消完成时间。
5. 每一轮只降低一个已测预算，并保留桌面兼容和 Cloud 构建双验证。
