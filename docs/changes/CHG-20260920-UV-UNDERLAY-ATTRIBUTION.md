# Resident UV underlay 颜色归属移出主线程

- 主模块 M07，协作 M06/M09/M15；`UV-UNDERLAY-ATTRIBUTION/1.0.0`。
- L1 调度与资源所有权优化；本地修改，未提交、推送或部署。
- 目标：减少投影转 UV 在 underlay 合成阶段占用 UI 主线程的整图遍历，同时保持完整分辨率、逐字节输出、QA 和既有失败边界。

## 问题与实现

Resident UV 在已有 rendered-color attribution mask 且需要叠加 underlay 时，原流程在主线程先遍历整张前景复制旧 alpha，再等待既有 WebGPU/CPU Worker 完成 source-under 合成，随后再次遍历整图，按新 coverage 反推原渲染颜色的贡献：`coverage > 0 ? round(mask * previousAlpha / coverage) : 0`。4K 单层因此额外分配约 16 MiB alpha 临时数组，并在 UI 线程执行两次 16,777,216 像素循环；循环虽分片让步，仍扩大了长帧和交互抖动。

`compositeRgbaUrlUnderWithWebGpu` 现在可选接收与像素数等长的 attribution mask，并把其 ArrayBuffer 与 RGBA 一起转移给原合成 Worker。WebGPU 成功且经过既有 CPU 抽样验证后，Worker 用原前景 alpha 与已验证输出 alpha 执行同一整数公式；按 262,144 像素分片并检查取消。CPU 交互路径及 WebGPU 不可用/失败 fallback 在原 source-under 合成循环内保存旧 alpha 并同时更新 mask，不增加第二次遍历。更新后的 buffer 与 RGBA 一并转回，由后续 underlay 继续接管所有权。

该参数只允许 source-under；若与 source-over 同时使用或长度与 `width * height` 不符，客户端在转移所有权前拒绝。opacity 为 0 时沿用既有直接返回并保留 mask 身份。取消、Worker 错误或过期请求不发布部分结果；发布路径仍在 RGBA 与 mask 都完成后一次性交接。没有增加 Worker、网络请求、纹理解码或并发槽。

## 正确性、性能与稳定性验证

- `test:underlay-reuse` 直接执行生产 Worker CPU 路径，覆盖 source-under attribution 精确公式、零 coverage、opacity 0、不变像素和 buffer 返回。旧实现不能返回更新后的 mask，新实现通过。
- 投影 underlay 缓存、合并最终准备、Resident UV 显示/可见性调度、投影可靠性/性能保护、原生 UV 合并、自动合并导出及实时位图生命周期专项回归通过。
- Edge 152 隔离夹具执行实际生产 WebGPU Worker；512 与 4096 尺寸的 RGBA 和 attribution mask 均与冻结旧公式逐字节一致，差异均为 0。贡献组合 65/128/257/512/4096 及 archive restore 继续零差异。未操作用户工程。
- 同一 Edge 会话预热 2 轮后，旧主线程双遍历与新 Worker 路径交错各测 8 轮。512 中位数 `6.6→6.0ms`、P95 `7.4→6.6ms`，帧间隔约 `16.2→16.1ms`；4096 中位数 `132.8→112.8ms`、P95 `135.4→117.5ms`，采样最大帧间隔 `33.4→16.8ms`。这是隔离 underlay 阶段的单机样本，不等同于真实工程总耗时或长期帧率。
- Web 全量回归 150/150、生产 Web build/typecheck、改动文件 lint 和 diff whitespace 检查通过。原包体及 256-byte 总量余量门禁通过：109 chunks、`3,253,249/3,256,500` bytes，hot chunk `714,739/715,000`；未提高预算。

## 对应实现审计

- GPU：WebGPU RGBA 合成、上传、读回、抽样验证和 source-under shader 不变；attribution 在已验证读回后由 Worker CPU 更新。
- CPU/Worker：CPU fallback 复用原像素循环，公式、round 和零 coverage 语义不变；GPU 路径在 Worker 分片更新并保留取消检查。主线程删除旧 alpha 临时数组和两次整图遍历。
- shader：投影 raster、Top-K/quality、gutter、颜色空间、alpha 与图层顺序不变。
- persistence/export：压缩缓存和导出继续接收相同 RGBA/R8 mask 字节；缓存 key、作者资产、完整分辨率和 QA 不变。
- 多 underlay：每轮接收上一轮返回的 mask，再按同一顺序处理下一层；不并行重排图层。

## 迁移、回滚与限制

无 Project Schema、Command 幂等、Revision CAS、ownership、verified assets、缓存 key 或历史资产迁移。算法契约版本记录执行位置和所有权改变，不改变持久化像素语义。

独立回滚可移除 WebGPU composite API/Worker 的可选 mask 参数，恢复 Resident 主线程旧 alpha 快照与归属更新循环；历史缓存和作者资产无需改写。回滚会重新引入 4K 主线程双遍历与约 16 MiB 临时数组。

本轮只优化 underlay rendered-color attribution 热点，没有宣称整个投影转 UV 已无卡顿。尚未在用户真实多层工程做端到端 P95/P99、输入延迟及 30 分钟 soak；后续仍需按来源准备、GPU raster/resolve、readback、gutter、编码、上传和发布继续逐阶段量测，不能以降低分辨率、关闭 QA 或改变像素结果换取速度。
