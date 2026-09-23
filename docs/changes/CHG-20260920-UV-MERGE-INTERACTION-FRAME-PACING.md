# 4K 投影转 UV 交互帧调度

- 主模块 M07，协作 M06/M09/M15。
- 算法契约：`UV-PREVIEW-DETACHED-UPLOAD/1.0.0`、`UV-PERSISTENT-MERGE-READ/1.1.0`、`UV-BAKE-FRAME-PACING/1.0.0`。
- 变更级别 L1；本地修改，未提交、推送或部署。
- 目标：在完整 4K、原像素公式和全部 QA 保持不变的前提下，让旋转/缩放优先于投影转 UV 的缓存读取、后处理、派生缓存写入和预览上传。

## 复现与修复

真实 4517“测试合集”4K S4 首轮复现到 detached 预览上传 `116.8ms` 最大帧、全流程 `8%` 错失刷新率。每个 detached renderer 原来可在一次浏览器任务内提交 8 个 128K 像素条带；多个 renderer 共用物理 GPU，交互结束后会同时恢复。现在保持 128K 条带和完整 RGBA，只把每个 detached renderer 的恢复批次收紧为 1 个条带后让步。没有缩小贴图、跳过条带或减少目标 renderer。

冷运行还定位到持久化合并缓存的 `Response.arrayBuffer.then` 在主线程产生 `53–54ms` 长任务。缓存命中读取、SHA-256、尺寸/元数据验证改由独立 Worker 完成；验证通过后把同一 ArrayBuffer 转移给主线程构造 ImageData。Worker 不可用或异常时保留原读取路径，但先等待视口交互空闲。来源字节、几何哈希和 1 MiB 派生缓存拷贝也在安全边界检查交互；缓存写入每 4 MiB 跨一次真实浏览器绘制，其余 1 MiB 边界保持轻量 task yield。

4K 最终透明 texel 清理和 CPU postprocess 原先使用 `scheduler.yield()`。Chrome 可在真正绘制前连续执行多个 continuation，使约 8ms 的小段合并成 `107–242ms` 帧。现在这些长循环在预算片之间等待真实 paint；遍历范围、判断、舍入、RGBA/coverage 更新顺序不变。墙钟时间可能增加少量帧等待，换取输入随时可抢占。

## 正确性与实测

- 修改前同一 4K 投影对象：交互保护 `P95 16.8ms / 最大 16.9ms`；全流程 `P95 16.8ms / 最大 116.8ms / 8%`；最卡阶段 `gpu-detached-texture-upload-submit`；输出 17.77 MiB、覆盖率 66.39%、WebGPU 拓扑最终差异 0。
- detached 批次收紧后的热缓存复测：交互与全流程均 `P95 16.8ms / 最大 16.8ms / 0%`，原 `116.8ms` 上传峰值未再出现。
- 冷缓存复测暴露并修复主线程 64 MiB 缓存读取；移入 Worker 后页面空闲窗口为 `60 FPS / P95 16.8ms / 最大 17.3ms / 0%`，不再出现 `Response.arrayBuffer.then` 主线程长帧。
- 另一真实 4K 投影对象的交互保护为 `P95 16.8ms / 最大 16.9ms`，WebGPU 拓扑最终差异 0、RGBA A/B 差异 0。该轮进一步暴露 postprocess continuation 聚集并据此增加真实 paint 边界。
- `test-preview-upload-cleanup` 覆盖 RGBA/R8、成功/取消/失败、GL 状态恢复、所有权、方向和 detached 每条带让步；`test-persistent-merge-preparation` 覆盖来源/几何键、并发界限、损坏拒绝、4K 精确 RGBA、交互门控和 4 MiB paint cadence；projection safety、typecheck、改动文件 lint 和生产 build 通过。
- Cloud Web 包体门禁保持原预算：与后续生图结果交互修复合并后的最终生产构建为 111 个 JS chunk、`3,256,244/3,256,500` bytes，保留 256-byte release reserve；Editor `498,762/499,024`、hot chunk `714,739/715,000`。Web 全量回归 `151/151` 通过，未提高预算。

## GPU / CPU / Worker / shader / 持久化 / 导出审计

- GPU：WebGL `texSubImage2D` 参数、条带字节、纹理尺寸、采样方向和提交顺序不变；只改变不同 renderer 恢复批次的让步频率。
- CPU：透明 texel、coverage、gutter、seam 与 source-under 公式不变；只把 cooperative continuation 改为可见绘制边界。
- Worker：新增只读派生缓存 Worker，执行原 SHA-256、长度、分辨率和 JSON 元数据检查；成功时零拷贝转移精确缓存 buffer，失败不发布部分数据。
- shader：投影 raster、深度、Top-K、质量合成、WebGPU 校准和最终差异门禁不变。
- persistence/export：Project Command 幂等、Revision CAS、ownership、verified object assets、作者层和导出路径不变。新增 Worker 只读取可丢弃派生缓存；缓存格式、key 和历史资产不变。

## 迁移、回滚与限制

无 Project Schema、Command、缓存格式或历史资产迁移。旧派生缓存可直接由 Worker 校验读取；无效条目仍按原规则 miss 并精确重算。

可独立回滚：detached 批次恢复为 8；移除 persistent read Worker 并恢复主线程读取；postprocess/透明清理及缓存写入恢复 `scheduler.yield()`。回滚无需改写工程或资产，但会重新引入已复现的 53–242ms 主线程长帧和 116.8ms 上传峰值。

本轮没有宣称整个编辑器已无卡顿。多模型工程首次恢复仍测到 JSON/React/渲染初始化长帧；运行中的生图任务与工程恢复并行还出现过 1.2–2.15s 峰值和接近 1 GiB JS 堆，需作为独立问题继续定位，不能用降低输出质量或停用 QA 规避。
