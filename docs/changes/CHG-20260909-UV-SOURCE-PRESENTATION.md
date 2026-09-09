# UV 图片准备与透明像素清理让帧

主模块 M07；PERF-UV-SOURCE-PREPARE-001 v1.0.0，ALG-UV-005 v2.0.2（调度 Patch，像素语义不变）。独立于前一轮后处理分段，本轮只调整 imageSampler、gpuUvBakeRenderer 的图片准备及 bakeProjectedLayerToTexture 的两条透明像素清理循环。

## 证据与处理

在用户「割草机器人」工程 4K S4 复测：面板最大帧 83.4ms、掉帧约 2%；浏览器 Long Animation Frame 记录包含 14 次图片准备（典型 IMG.onload 17–37ms 与 Scheduler.yield 连续运行 19–38ms）和 2 次透明像素清理。阶段标签虽写 gpu-detached-texture-upload-submit，单条上传仅约 0.2ms，不能据阶段标签判定是 texSubImage2D 本身阻塞。

1. 静态图片 onload 后等待原生 decode()，支持缺失/拒绝时保留原 drawable fallback；解码完成前不撤销临时 object URL。随后让出一次绘制，再使用原整图 drawImage/getImageData。live canvas 仍在调用时同步取快照，不新增等待。
2. CPU ImageData 转纹理的整图 putImageData 前后各让出绘制，保留原 Canvas → ImageBitmap、flipY、滤波与 resident 复用路径。未改上传条带大小或 GL 命令。
3. 两条透明像素清理循环原来每 32768 像素调度一次高优先级 continuation，可能多次运行后仍未绘制。现在在相同检查点累计约 8ms 工作后等待实际绘制，短循环不增加逐块 Promise 调度。

## 正确性与对应路径

RGBA、Alpha 阈值 8、透明 gutter coverage=2 规则、未投影填充值 [8,9,13]、尺寸/缩放/平滑配置、缓存 key 与上限保持。GPU/CPU 合成消费者使用同一原始完整像素，Worker/shader、拓扑与混色公式不变；PNG/export 的像素与发布次序不变。Schema、UV_MERGE_COMPOSITION_VERSION=5、Project Command 幂等、Revision CAS、ownership、verified assets 不变，无迁移。所有等待使用现有隐藏页 timer 兜底。

测试执行实际生产函数：冻结 b3431cb 清理核对照全部 RGBA/coverage，含 0/1/7/8/9/128/255 alpha 和三类覆盖值、无覆盖掩码、2K 全扫描及事件循环执行；验证 decode 完成屏障、缺失/拒绝 fallback、加载失败不发布。实际 Edge Canvas 的 8 组 1px 至 4K/缩放图像读取与旧版逐字节零差异，缓存返回原对象，live canvas 调用后改色不改变已取得的快照。

## 原工程测量

原工程 URL：`http://127.0.0.1:4517/project/project-9aa91ef3-f3c9-45c0-b24b-af66caebac28/texture?perfLab=1`。S4 为 14 个普通投影 + 1 个修补底层的只读 benchmark，模拟旋转，未写图层或资产，不代表所有重绘图层组合。

- 本轮基线：面板最大帧 83.4ms，掉帧约 2%，bake 25212ms。
- 图片准备改动：图片准备 LoAF 从 14 条降为 1 条，清理仍有 2 条；面板最大帧 83.4ms、掉帧约 1%，bake 24683ms。
- 加入清理让帧，第一轮：面板最大帧 33.5ms，掉帧取整显示 0%；仍有一次 61.2ms LoAF（36.4ms 脚本）。bake 28602ms，其中接缝和拓扑准备本轮明显更慢。

rAF 帧间隔与 LoAF duration 是不同观测口径，0% 是面板取整，不能宣称绝对零丢帧或所有交互零卡顿。不同轮次缓存、堆、拓扑校准分支有变化，输出大小可能为 22.71/22.76MiB；正确性依据为同输入逐字节对照，不以不同轮次 PNG 大小当作像素证明。暂不宣称总耗时稳定提升。

回滚只恢复上述三个源码文件对应调度增量，不回滚前一轮已验证的 gutter/接缝/补洞优化，不删除工程数据。构建通过，82 chunks / 3,141,631 bytes，通过原包体门禁。Browser 专用插件不可用，原工程用 CUA in-app browser，隔离像素测试用已安装 bundled Playwright。复测与全回归结果补记于下。

最终复测：两轮面板均为 P95 16.8ms / 最大 33.5ms / 掉帧取整 0%；第二轮仅 1 条 LoAF，59.3ms。第二轮 bake 28948ms、PNG 1740ms、拓扑校准最终零差异；未把本轮耗时增加包装成速度收益。视口 CSS 798×798，Canvas 面板 998×998 / DPR 1.3。94 项 Web 回归、类型、修改文件 lint、Cloud/repository 边界、diff 与原包体门禁通过。实际页面为 Saved、模型正常显示，最终版本两轮没有新增错误；控制台保留中间 source-prepare 版本于 06:37:09 UTC 的一次 Three.js compileAsync `currentProgram.isReady` 异常（projectPipeline-DqoWYUpF.js），出现在刷新/预热期间，当前未稳定复现，不能视为已修复；通过原工程 S4 自动旋转操作、刷新复测并截图。4517 已使用最终构建，未推送/生产部署。仍未覆盖所有手动重绘层组合、大窗口/其他硬件及付费生图路径。
