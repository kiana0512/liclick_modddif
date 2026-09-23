# 生图结果发布的交互优先级

- 主模块 M04，协作 M03/M08/M15。
- 算法契约：`GENERATION-RESULT-PARSE/1.0.0`、`LOCAL-REPAINT-DATAURL/1.0.0`。
- 变更级别 L1；本地修改，未提交、推送或部署。
- 目标：后台生图完成时不抢占相机、滚轮和绘制帧，同时保持服务响应、图片字节、尺寸和发布顺序不变。

## 复现与根因

4517 的九模型“测试合集”在模型切换与后台生图完成重叠时出现 `1.0–2.15s` 帧间隔。长帧脚本定位把最重任务映射到 `liclickApiClient` 的 `Response.json.then`：一次 `1009.4ms`；随后两次映射到 `localRepaint/imageUtils.ts` 的 `FileReader.onload`：`864.8ms` 与 `858.7ms`。同一窗口的自动保存 timer 还有约 `243–296ms`。这说明切模型不是这组长帧的唯一原因；大生成响应在 UI 线程 JSON.parse、Blob→base64 以及后续大字符串发布与保存同时竞争了交互线程。

旧性能阶段标签在这个窗口仍显示此前的 UV/GPU 阶段，属于全局诊断标签残留。本变更以脚本 URL/字符位置和回调类型做归因，不把残留阶段名当作因果证据。

## 修复

`liclickApiClient` 的服务响应保留 256 KiB 以下原生 `Response.json()` 快路径。更大的响应先取得原始字节并转移到后台 payload Worker 的独立实例，在 Worker 内执行 UTF-8 解码和 JSON.parse。Worker 只先回传小型 ready 消息；主线程确认视口指针/滚轮已静默后，才允许 Worker structured-clone 完整结果对象。无 `Content-Length` 的响应按实际字节数判断，不会误走小响应路径。Worker 不可用、构造失败或消息失败时保留安全失败/原解析语义，不发布半个对象。

`blobToDataUrl` 同样保留 256 KiB 以下原生快路径。更大的 Blob 在同一后台 Worker 制品的新实例里用 `FileReaderSync.readAsDataURL` 精确转换，完成后先发 ready，待视口静默才回传大字符串；Worker 不可用时等待交互空闲后执行原 FileReader 路径。局部重绘返图解码取消 Blob→Data URL→Image 的无效往返，直接用短生命周期 Blob URL 解码，完成或失败均 revoke。最终预览和持久化仍得到与原路径相同的完整 PNG/Data URL。

## 正确性与实测

- 新回归执行生产调度模块，验证小 JSON 仍走原生快路径；大 JSON 的解析与完整对象发布各自经过交互门；未知长度与无效 JSON 保留原结果语义。
- 同一回归验证 300 KiB Blob 的 Data URL 逐字符等于基准 base64，且完整字符串只在交互静默后发布。
- Edge 152/4517 生产构建用 12 MiB 等价服务响应实测：持续交互 350ms 内 Promise 未发布；保护窗口最大帧 `16.7ms`，完整窗口最大帧 `16.8ms`、P95 `16.7ms`；松手后 `id`、尾字段及 12 MiB 字符长度全部精确一致，总完成 `428.5ms`。
- 两个后台协议共用一个按大任务创建独立实例的 payload Worker 制品，生产复测为保护/全程最大帧 `16.8/16.8ms`、P95 `16.8ms`，精确结果不变，总完成 `430.2ms`。小响应不创建 Worker。
- Web 全量回归 `151/151`、生产 build、typecheck、改动文件 lint 与 diff whitespace 检查通过。合并最新 master 后将 Worker 内部 ready/release/result 握手压缩为等价定长消息，并只对无预处理指令、无注释、无插值的静态应用 GLSL 压缩空白，token/directive 回归保持语义；固定包体门禁未提高：110 个 JS chunk、`3,255,804/3,256,500` bytes，保留 696-byte 总量余量并通过 256-byte 发布余量门禁；Editor `498,712/499,024`、hot chunk `713,273/715,000`。
- 没有为验证重新发起付费生图。此前真实任务的 `1009.4ms` JSON 与 `864.8/858.7ms` FileReader 是修改前基线；修改后真实服务完成态仍需下一次自然任务复测。

## GPU / CPU / Worker / shader / 持久化 / 导出审计

- GPU/shader：投影、UV、深度、质量合成、纹理尺寸、颜色空间和 QA 均未修改。
- CPU/Worker：只迁移 JSON 解码/解析与 Blob base64 转换的执行线程和结果发布时间；阈值以下继续原路径，Worker 输出保留完整值。
- 局部重绘：返图 Blob 直接解码为原尺寸 ImageData，后续 resize、feather、composite、protected-pixel 恢复及 preview 编码顺序不变。
- persistence/export：Generation、Project Command 幂等、Revision CAS、ownership、verified object assets、自动保存和导出结构不变；没有跳过结果或减少保存内容。

## 迁移、回滚与限制

无 Project Schema、Command、数据库、缓存格式或历史资产迁移。旧工程和在途任务继续使用同一响应结构；Worker 变化只涉及运行时执行位置与制品复用。

可独立回滚 `interactionSafeJsonResponse` 动态入口、payload Worker 交互分支与 Blob URL 直接解码，恢复原 `Response.json` 和 FileReader。回滚无需改写资产，但会重新引入已复现的 0.86–1.01 秒后台完成长任务。

本轮没有宣称首次九模型工程恢复已经无长帧。刷新仍会并行恢复 67 个图层、55 个投影层及多张 4K 纹理，初始窗口保留过秒峰值；恢复结束后本机回到 60 FPS、最近窗口 P95 约 17ms。该恢复链需继续按模型解析、纹理解码、GPU 上传和 React 发布分别优化，不能通过降低分辨率、关闭 QA 或删减作者层规避。
