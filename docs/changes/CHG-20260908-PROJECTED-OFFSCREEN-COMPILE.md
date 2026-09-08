# CHG-20260908-PROJECTED-OFFSCREEN-COMPILE

## 范围与版本

UI-06 → 主模块 M06，协作 M08/M13；ALG-PROJ-007 v2.1.5。基于 master 55602ef，保留局部重绘直接擦除修复。只调整离屏 UV 采样预热的程序准备时序。

## 实际性能证据

perf_3c6a4f18，collector 2.2.0，采集 release-9fc2f706，161.072 秒、9516 帧。平均 59.08 FPS，P95 16.8ms，最大帧 466.6ms；20 帧超过 33.4ms，14 帧超过 50ms。原始 droppedFramePercent 60.74% 使用过严的 16.67ms 阈值，不能解释为真实丢失 60% 帧。

40.688s、87.507s、150.677s 出现三次 440–467ms 脚本停顿；前两次归因于 bakeHighSnapshot 的 sampler warmup continuation，第三次归因于 Three compileAsync 的 Promise continuation。三次均在 projected-material-precompile 完成后、projectedUvSamplerPrewarmCount 和正式驻留发布前。公开构建脚本对应 sourceCharPosition 与原始诊断时间线共同定位到 prewarmProjectedUvSamplers 的首次离屏 draw。

Three 的 WebGLPrograms 根据当前 render target 选择 outputColorSpace 和 toneMapping；先对默认 framebuffer compileAsync，不能准备随后离屏 LinearSRGB/NoToneMapping 的程序。首次 gl.render 因此同步链接第二个程序。原 source GPU 上传 stripe 最大约 2–3ms，不能把所有后台数组等待都算作主线程阻塞。

剩余热点：三次返图后约 108–110ms 的 source preparation continuation，首次落笔约 200ms；本变更不猜测或修改这些独立路径。GPU query P95 9.57ms，但 query 返回时间不代表对应主线程时点。JS heap 约 1.44GiB 起、1.28GiB 终，峰值 1.64GiB；此样本不能证明泄漏。未出现 runtime error。

## 修复

- compileForRenderTarget 在 compileAsync 同步选择程序时绑定目标，随即在 finally 恢复原 framebuffer、cube face 和 mip，绝不持有到 await/rAF 后。
- UV sampler warmup 先异步准备真正的离屏程序，再检查取消，保留原 normal-preview 两状态、每张纹理预热、GPU fence 和交互避让。
- 性能事件新增可选 detail.target（viewport/offscreen），便于后续录制区分两次准备；报告 Schema 2 不变。

## 对应路径审计与回退

GPU：仍完整编译和执行同一个材质；不跳过采样预热、就绪检查或质量门禁。CPU/Worker：不改变解码、数组打包和上传。Shader：源码、uniform 及颜色/投影/深度/法线/蒙版公式不变。持久化/UV/export：不改图层、分辨率、资产、Project Command 幂等性、Revision CAS 或 ownership。无 Schema/数据迁移。

回退本变更的编译 helper 调用即可恢复原时序，会重新引入首绘同步链接停顿；保留所有资产和效率组部署配置。异步链接失败仍向上传播，不把失败标记为 ready。

## 验证记录

真实 WebGL 隔离场景：14 层、混合 live/array、深度/法线/surface-lock；调用生产 material 创建、Worker/纹理上传、compileAsync、offscreen draw/readback 与屏幕 draw/readback。每个变体用不同冷 shader cache key，避免第二次借用第一次程序缓存。

| 指标 | 原时序 | 新时序 |
| --- | ---: | ---: |
| 屏幕程序异步准备 | 543.4ms | 541.3ms |
| 离屏程序异步准备 | 无 | 521.0ms |
| 首次离屏同步 draw | 554.7ms | 1.0ms |
| 测试过程最大 rAF 间隔 | 550.5ms | 33.4ms |
| 离屏 draw 前/后程序数 | 1/2 | 2/2 |
| WebGL error | 0 | 0 |

正常/法线预览及最终屏幕总计 180224 字节逐像素相等，95712 非零颜色字节，避免空图误判。编译总工作量未消失，本优化减少同步阻塞，不承诺每台用户设备同样比例提升。

自动回归覆盖 framebuffer 在未完成 Promise、同步异常及异步拒绝时的精确恢复；验证离屏编译等待和取消门禁存在。投影层回归、类型检查通过；完整回归/Cloud 构建结果以本次完成记录为准。

独立浏览器第二次冷程序复测：首绘 546.6ms → 1.1ms，最大 rAF 533.7ms → 33.2ms，像素仍逐字节一致，控制台无 error/warn。Cloud build:release 与包体门禁通过（80 chunks / 3134388 bytes）；修改文件 lint 0 errors，SceneRoot 有 1 条既有 unused warning。没有调整包体上限。

最终验证：完整 Web regression 88 contracts 全部通过；Cloud boundary 与 Project repository boundary 通过。性能安全测试同步加载真实 compileForRenderTarget helper，继续执行上传空闲、冷程序等待、交互空闲、取消和失败不发布断言；初次全套运行发现测试 fixture 未注入新 helper，修正后全套通过。渲染验证入口 http://127.0.0.1:5198/gpu-test，使用已有 CUA 浏览器；页面身份、非空内容、无框架错误覆盖层、控制台健康、按钮交互、截图与像素证据均通过。生产原用户工程、其他 GPU/浏览器尚未验证。

测试入口为隔离浏览器 /gpu-test，不访问用户工程，不执行付费生成。最初测试脚本对大像素数组使用展开 push 导致测试脚本栈溢出，改为循环追加后通过；生产实现无该错误。尚未在原用户工程复测，需上线后新录制确认 440–467ms 热点是否消除。
