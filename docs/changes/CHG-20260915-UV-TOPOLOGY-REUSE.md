# UV 拓扑准备复用

2026-09-15；主模块及维护责任 M07，协作 M06/M09。关联算法 `ALG-UV-005` v2.0.8（实现 Patch，像素语义不变）。本地修改，未提交或线上部署。

## 原因与目标

用户工程“新项目1”、base.obj、2K 最新优化前记录：总重算 1063.6ms，gutterMs=701.3ms，其中 gutterTopologyWaitMs=679.1ms；拓扑准备 uvTopologySerializeMs=831.9ms，GPU raster 已命中缓存。完整拓扑时间与其他阶段重叠，不可相加。

模型 UV/index 原始源为 36000000 字节，超过原始快照 32 MiB 上限。先前大模型快照改进会为其无损压缩；之后每次显隐仍需解压全部块并逐字节比对。目标是复用同一拓扑，同时保留实际内容校验。

## 实现

- `webGpuUvTopologyRaster.ts` 共用原顺序的网格枚举。小源保留原始字节快照；大源直接读取索引引用的 UV，与已经保留的 Float32 三角形输入逐位核对，避免第二份完整三角形分配和压缩/解压。
- 普通非归一化 Float32 UV 使用原始位快速比较；其余格式及不相同的原始位使用与原序列化相同的 getX/getY→Float32 转换，兼容交错、归一化、Float64、半精度、NaN 和 signed zero。每 8192 个顶点检查 4ms 任务预算，继续协作让出主线程。
- 顶点流长度或有效 UV/index 内容变化即重新准备并更新原有 revision/Worker 缓存身份；不依赖 needsUpdate。未引用的 UV 或产生相同 Float32 输入的等价几何变化可以安全复用。位置/世界变换不影响 UV 拓扑。辅助绘制网格仍按原规则排除。
- 冷轮大源序列化完成后再次核对当前输入；发现变化即走原错误处理，避免登记不一致数据。热轮仍需线性扫描，不是零成本或 O(1) 版本判断。
- `snapshotUvSeamGeometry` 增加可选 compressOversize，默认 true；只有拓扑调用传 false。接缝消费者原有大模型压缩快照及预算不变。小源快照仍最多 32 MiB；大源不额外保留快照，不提高缓存上限。

## 对应路径审计

GPU topology Worker、WGSL、Canvas2D CPU gold、兼容 raster 与逐像素 QA 不变；同一 Float32 输入和尺寸继续使用原缓存键，未改 mask 光栅规则、留边资格/颜色传播和完整分辨率。接缝压缩默认行为通过共享模块回归。当前 Resident 默认跳过接缝的既有策略保留，显式 UV 合并/导出继续走原后处理。

Project Command、Revision CAS、ownership、verified assets、Schema、持久派生缓存键及 UV merge 像素版本不变，无数据迁移。

## 验证与测量

- 新增 `test:uv-topology-reuse`：旧实现因建立超限压缩快照而失败，修改后通过。覆盖同一 mask/无重复 Worker dispatch、无版本 UV/index 修改、signed zero、辅助网格/移除、NaN、Float64、归一化、半精度及交错属性。
- `test-resident-uv-display`、`test-uv-seam-large-cache`、`test-uv-gutter-cooperative`、`test-uv-gutter-reuse`、`test-uv-gutter-timings`、`test-uv-postprocess-scheduling`、`test-native-uv-merge`、`test-model-export-texture-orientation` 通过。完整非增量 TypeScript 与修改源/测试 ESLint 通过。
- 既有 `run-resident-uv-browser.mjs topology-reuse` 在 2K 独立浏览器运行：17 次显隐检查，page errors=[]，画面还原 finalDiff 最大 0，UV 岛边缘 maximumDifference=0。使用隔离模型，不操作用户工程。
- 本地 Vite production build 已更新 `apps/web/dist`，入口为 `index-Dj7XIQys.js`；保留旧哈希资源供已打开标签页使用。另在临时干净输出目录执行同配置构建与原包体门禁，通过 96 个 JS 块、3246064 / 3247500 字节，未放宽预算。仅本地构建，未线上部署。
- `benchmark-uv-topology-reuse.mjs <已有 OBJ 路径>` 读取用户当前原始模型，按生产 OBJLoader 与 MeshBVH maxLeafTris=12 重排索引。比较修改前文件（自 6dcdec1 后未变）和当前文件，两侧使用相同的当前快照模块；交替运行顺序，包含协作任务等待。

| 准备阶段 | 修改前 ms | 修改后 ms |
| --- | ---: | ---: |
| 首次 | 2729.1 | 184.6 |
| 热轮 1 | 1079.1 | 102.8 |
| 热轮 2 | 1048.4 | 78.2 |
| 热轮 3 | 1061.5 | 87.9 |
| 热轮中位 | 1061.5 | 87.9 |

每轮完整 24000000 字节三角形输入差异为 0，修改后热轮返回同一缓存数组。该 Node 隔离基准衡量真实模型的拓扑准备，不包含浏览器绘制/GPU 合成，不代表用户点击的端到端延迟。后者需刷新本地构建后触发新重算，再读取阶段记录。

## 回滚

仅恢复本次拓扑准备逻辑与快照可选参数，删除本次专项测试/基准及 package 测试入口；保留先前底图、留边、计时、接缝工作。没有资产或工程数据迁移。
