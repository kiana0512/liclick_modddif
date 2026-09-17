# CHG-20260917：Bake 产物验收异步文件 I/O

## 范围

- 主模块：`M10` 生产 UV/拓扑/Bake。
- 协作模块：`M13` 控制面稳定性、`M15` 回归门禁。
- 契约：`BAKE-ARTIFACT-IO/1.1.0`。
- 状态：production scheduling patch；不修改烘焙算法或产物格式。

## 问题

远端 Substance 任务下载和验收本身位于异步流程，但缓存命中检查仍使用 `existsSync/statSync`，Base Color 存在检查使用 `existsSync`，PNG 尺寸验收使用 `openSync/readSync/closeSync`。本地盘上单次开销很小；在共享卷、磁盘抖动或多个任务并发下载时，这些调用会阻塞 LI3D Node 控制面的事件循环。

## 修改

- 缓存尺寸检查改为 `fs.promises.stat`；缺失、不可读或并发替换均按缓存未命中处理，继续走原下载、SHA-256 和尺寸验证路径。
- 自动 Roughness 前的 Base Color 检查改为 `fs.promises.access`；失败继续使用原产品错误并禁止提交远端 Roughness。
- PNG 24-byte 文件头读取改为异步 `FileHandle.read`，并在 `finally` 中等待关闭句柄。
- 调用者等待 PNG 尺寸完成后才发布 outputs；完整文件写入、SHA-256、MIME、分辨率和失败顺序不变。

## 不变项

GPU/CPU/Worker/shader、Substance profile、Bake 通道、像素、颜色空间、分辨率、QA、远端任务幂等键、Project Command、Revision CAS、ownership、verified assets、Job JSON 和输出 URL 均不变。

## 验证

- `test:bake-artifact-plan` 执行编译后的实际 Roughness 阶段，覆盖 access/read/remote/MIME/write/dimensions 六类失败和成功发布顺序。
- 回归同时检查 `downloadArtifacts` 与 `pngSize` 不再调用同步文件 API。
- Server typecheck、lint、完整 regression 必须通过。

## 迁移与回滚

无 Schema、数据库、Job JSON 或资产迁移。回滚可恢复同步 stat/access/header 读取；已有任务和产物无需改写，但会重新引入共享卷抖动阻塞 Node 事件循环的风险。
