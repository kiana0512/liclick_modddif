# 底图复用与留边优化

日期：2026-09-15。主模块 M07；协作 M06（Resident UV 显示）、M09（合并/导出）。
状态：本地实现与验证完成，未提交、推送或部署。维护责任：M07。

## 算法与调用边界

- `ALG-UV-006` Under composition / 底图合成：v2.1.1，缓存实现 Patch，像素语义不变。
- `ALG-UV-005` Topology-constrained postprocess / 拓扑约束后处理：v2.0.6，缓存实现 Patch，像素语义不变。
- `ResidentProjectedUvDisplay` → `compositeRgbaUrlUnderWithWebGpu` → `webGpuRgbaComposite.worker`。只有显式传入内容身份的调用启用底图复用；既有合并、PNG 编码和未带版本的 URL 调用继续重新读取。
- `bakeProjectedLayerToTexture` 的三处 GPU/CPU 分支使用同一协作式留边函数；`uvBakePostprocess.worker` 的同步入口继续使用同一生成器内核。面板与 store 不承载算法。

## 修改与不变量

### 底图

Worker 只持有一份解码 RGBA，最多 64 MiB（4096²×4 字节）。身份由层 ID、contentRevision、完整图片 URL、宽高组成；opacity 不影响解码缓存，每次仍按新 opacity 合成。不同身份替换旧项，超过上限的图片按完整尺寸处理但不缓存。多底图交替会发生缓存淘汰，本次未增加多层缓存池。

缓存保存原有 OffscreenCanvas 分条 drawImage/getImageData 的输出；色彩转换、缩放、行顺序和 Alpha 规则完全沿用原路径。单位为像素和 8-bit straight RGBA，opacity 为 0..1；`Aout=Af+Au(1-Af)`、RGB 权重与取整未变。命中跳过 fetch、解码和像素读回，GPU 上传/运算/读回仍照常执行。

正常 under 合成将缓存视为只读。source-over 会交换前后景，因此返回独立副本以防 CPU 写入或 transferable 分离缓存。release 清空缓存并推进代次，旧排队/正在解码的请求不能在 release 后重新登记。解码失败与取消不登记，bitmap 在 finally 关闭；沿用既有 Worker release/终止生命周期，不持久化缓存。

### 留边

把最多 262144 个边界种子的队列换成每 texel 一位的邻接资格位图：仅保留一个不可变拓扑对象，最多 2 MiB；超过 4096² texel 不建缓存，输出尺寸不变。身份仍检查 WeakRef 拓扑引用与宽高。

热轮按原行序枚举资格位；用原 coverage 的 Uint32 视图跳过整块未覆盖像素，无额外拷贝。不对齐的子数组使用逐字节路径，尾部不足八个像素照常处理。coverage 每轮重新读取，不能将位图误当作最终显隐结果。拓扑外已覆盖的像素仍可作为来源。

八邻点顺序、第一来源优先、迭代轮数、RGB-only 的 alpha=0/coverage=2 与其余 Alpha 行为保持。原约 8ms 协作让出/取消继续有效。这里只替换起始候选扫描，传播和接缝/洞修复算法不变。

内存取舍：新增最多 64 MiB 解码缓存；留边从最多 1 MiB 种子变成最多 2 MiB 位图。现有完整 UV 结果缓存、GPU buffer 和分辨率预算不扩大。

## 实测

### 4K 留边隔离对照

脚本 `apps/web/scripts/benchmark-uv-gutter-reuse.mjs` 从固定提交 `6dcdec1` 加载修改前真实内核。Node 24.15，4096²、六个矩形 UV 岛、8px 留边，交替执行三组冷/热轮。输入复制不计入计时；调度回调为空，不能代表真实视口呈现等待。

| 轮次 | 冷：原/新（ms） | 热：原/新（ms） |
| --- | --- | --- |
| 1 | 112.32 / 114.90 | 110.62 / 40.33 |
| 2 | 102.61 / 112.29 | 105.35 / 27.51 |
| 3 | 100.58 / 102.03 | 105.52 / 28.37 |

热轮中位 105.52→28.37ms，约减少 73%。冷轮中位 102.61→112.29ms：首次完整建立位图有成本。每轮 RGBA/coverage 字节差为 0，填充数均为 251136。

### 浏览器 4K 底图

脚本 `apps/web/scripts/run-underlay-reuse-browser.mjs` 在独立 Edge headless 页面使用实际 Worker、WebGPU、OffscreenCanvas 和合成 API；合成同一份 4096² 合成 PNG 底图，opacity=0.7，GPU 开启 `perfWebGpuAb=1` 精确 CPU 对照。逐字节比较有缓存/无缓存输出，交替运行三对。

| 路径 | 无缓存三轮（ms） | 有缓存三轮（ms） | 中位原/新（ms） |
| --- | --- | --- | --- |
| WebGPU Worker | 507.8 / 484.2 / 487.1 | 373.6 / 729.5 / 347.3 | 487.1 / 373.6 |
| CPU Worker（交互保护） | 3175.6 / 3161.5 / 3137.3 | 2462.7 / 2482.0 / 2472.6 | 3161.5 / 2472.6 |

全部缓存前后 RGBA 字节差为 0，GPU/CPU 校验差也为 0。GPU 有一轮明显波动，不能隐藏该样本；只确认复用有效，不承诺固定提速比例。计时包括消息、解码（未命中时）、计算、读回和既有预算等待，GPU 还包含显式 QA。未测真实用户工程点击到正确画面呈现的优化后延迟，不可与之前生产页约 1095ms 的记录直接相减。

## 验证与对应实现审计

- 新增测试先在旧代码得到预期失败：重复底图读取两次；超过旧种子上限的热轮仍读取 topology 589824 次。修改后两项通过。
- `test-underlay-reuse`：真实 Worker 队列/CPU blend，浏览器 I/O 替身；转移所有权、内容 revision/URL/尺寸、不透明度、source-over、取消、失败重试、release/in-flight release、单项淘汰和 >64 MiB 完整处理通过。
- `test-uv-gutter-reuse`：密集拓扑、不同 coverage/几何引用、不对齐 coverage 子数组与尾部通过。
- `test-uv-gutter-cooperative`：600 组冻结核 RGBA/coverage/count 对照、500 组修补与40组变换网格、接缝复用及事件循环门禁通过。
- `test-uv-postprocess-scheduling`、`test-native-uv-merge`、`test-fbx-temporary-uv`、`test-model-export-texture-orientation`、`test-resident-uv-policy`、`test-resident-uv-display`、`test-preview-upload-cleanup`、`test-projection-reliability` 通过。
- 既有 `run-resident-uv-browser.mjs` 1K 隔离显隐测试通过：重复状态像素一致、合并边界、几何模式、交互、岛边界，page errors 为空。
- 完整 TypeScript 检查（`tsc --noEmit --incremental false`）、修改文件 ESLint、Vite production build 通过。标准增量检查因旧 tsbuildinfo 写入权限失败，改用不写缓存的完整检查；Vite 临时目录/构建输出写入经工具权限审核后完成。构建输出在 `.codex-tmp/underlay-reuse-build`，原 chunk-size 提示保留，未放宽预算。这不是最终提交 SHA 的 prepush/部署门禁。

GPU/CPU：合成公式及 GPU QA 保留，GPU 上传仍消费原 RGBA；CPU 的前景写入与缓存只读隔离。Worker：增加解码缓存生命周期，取消门禁增强；同步/协作留边共用内核。Shader：未修改。持久化/导出：不缓存到磁盘、不改变 Project Command 幂等、Revision CAS、ownership、verified assets；原合并与 PNG 编码调用保持现有语义，UV_MERGE_COMPOSITION_VERSION=10 不变。

## 迁移与回滚

无 Schema、资产或工程迁移。图像像素语义不变，已有派生缓存无需失效。回滚这四个源文件的本次差异并重新构建即可恢复原解码和候选扫描；Worker 重启自然清空内存缓存，禁止删除项目数据。用户实际工程、长期缓存命中率和最终点击延迟须在上线版本继续验收；本次未连接或修改真实项目数据。
