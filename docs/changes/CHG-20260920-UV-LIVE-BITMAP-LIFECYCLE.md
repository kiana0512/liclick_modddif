# 实时 UV 合成输入位图失败清理

- 主模块 M07，协作 M03/M08；`UV-COMPOSITE-BITMAP-LIFETIME/1.0.2`。
- L1 资源生命周期修订；本地修改，未提交、推送或部署。
- 目标：修复异常后的资源累积，同时保留正常速度、完整分辨率和正确输出。本次不是投影转 UV 总耗时优化的完成验收。

## 问题与边界

SceneRoot 的实时 Canvas/Image 输入先在主线程并行 createImageBitmap，再交给 UV Worker。Promise.all 首个失败会提前退出，已经成功及稍后才成功的位图都可能失去所有者；composing guard 提前释放还允许下一轮和遗留解码重叠。此前 1.0.1 只覆盖 Worker 内的 URL 解码，未覆盖这个入口。

引擎层 prepareUvCompositeBitmaps 接收已经启动的 bitmap/opacity Promise 数组。成功时仍用 Promise.all 并行收集，保持数组次序、原始位图及透明度，随后由原 Worker 队列接管所有权。仅失败时给每个在途 Promise 安装清理处理：成功项立即 close，失败项被消费，等待全部终态后重新抛出第一次错误（包括 undefined rejection）。不等待下一帧、不串行解码、不复制或读回像素、不增加网络请求。原生解码不可取消；若原生解码不结束，本轮失败屏障仍需等待，这是显式边界，不声称新增超时恢复能力。

静态 URL 与实时位图在 SceneRoot 统一调用原本同一个 Worker 派发函数，删除没有其他调用者的 URL 转发包装。探针复用同一 dataset 引用，三个计数含义保持。算法实现位于 engine/layers，视口只负责来源适配。

## 正确性、性能与稳定性验证

- 新增 `test:uv-live-bitmap-lifecycle` 执行真实引擎函数及 SceneRoot 实时来源适配表达式。旧实现复现“失败时在途解码未结束就退出”；修复覆盖早/晚成功清理、undefined 错误、同步异常、缺失来源、多个失败、空输入、并行启动、乱序完成后恢复输入顺序、完整尺寸/透明度/位图身份及 Worker 转移所有权。
- 已验证 UV 队列背压与构造/派发失败恢复、Worker 生命周期、Resident UV、投影可靠性/性能保护、UV 合并与颜色导出，以及 Cloud/Repository 边界。
- Edge 152 隔离浏览器夹具使用实际 OffscreenCanvas/createImageBitmap/生产 Worker，1K×13 层与 4K×4 层，对照旧 Promise.all 路径：完整 RGBA SHA-256 一致，差异 0；实际原生位图的迟到失败清理通过，无未处理页面异常。未操作用户项目。
- 先进行了每轮完整像素校验；首轮 4K 时序有明显波动（新路径最大 37.6ms），因此不能将该轮作为稳定性能结论。调整采样，把昂贵整图哈希限于首尾轮，预热 2 轮后交错执行两种路径各 40 次：1K 中位数均 0.7ms，P95 均约 1.7ms；4K 中位数 2.4→2.5ms，P95 2.8→2.9ms。该次隔离阶段的 P95 差异约 +3.6%，低于 5% 退化门禁；不宣称获得提速，也不将其等同于真实工程总耗时、GPU 完成耗时、输入帧率或长期稳定性。
- Web 全量回归 150/150、Cloud 参数 Web build（含类型检查）、改动文件 lint 和 diff whitespace 检查通过。原包体门禁（含总 JS 256-byte reserve）通过：109 chunks、3,252,925/3,256,500 bytes，hot chunk 714,997/715,000；相对本轮修改前总量仅 +2 bytes，但热点包仅剩 3 bytes，后续构建仍须实测。未提高预算。测试夹具与原始浏览器结果位于执行机器 `C:/Users/rentian/.codex/tmp/uv-live-qa*`，不是生产资源。

## 对应实现审计、迁移与回滚

GPU/shader/质量合成/投影和 UV 坐标、RGBA、Y 翻转、alpha clamp、图层顺序及分辨率均保持；Worker 绘制与成功释放、CPU fallback、纹理上传、持久化/export 继续消费相同输入结果。保留既有 Worker URL 生命周期修复、队列背压和取消规则。

无 Project Schema、像素算法版本、缓存 key、Command 幂等、Revision CAS、ownership、verified assets 或历史资产迁移。契约版本仅记录资源生命周期改变。回滚本卡所述主线程 helper、SceneRoot 接入及测试，保留此前独立修复；回滚会重新引入主线程失败泄漏，不改写历史结果。

## 后续投影转 UV 迭代

仍需在真实 4K/多层工程分别测量来源准备、GPU raster/resolve、读回、补缝、编码、发布，以及视口 P95/P99/输入延迟和 30 分钟 soak。本次没有变更 GPU 缓存预算或把图层加载改成串行；成功路径的多图解码峰值、缓存总量与失败超时恢复须独立验证后迭代，不能用降分辨率、关闭 QA 或像素变化换速度。
