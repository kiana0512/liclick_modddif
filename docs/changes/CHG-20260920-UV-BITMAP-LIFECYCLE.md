# UV 合成失败的在途位图清理

- 主模块：M07；协作：M03/M08/M15。
- 契约：`UV-COMPOSITE-BITMAP-LIFETIME/1.0.1`，L1 资源生命周期修订。
- 状态：本地修复，未提交、推送或部署。

## 问题与修改

Promise.all 在首个网络或解码失败时立即返回；旧 catch 已清理之后才完成的 createImageBitmap 无人释放，且下一合成可能与旧解码重叠。

成功路径继续并发加载，保持输入顺序。失败时取消本任务剩余 fetch，通过 allSettled 等待已经开始的原生解码结束，再释放所有持有输入并回复失败。Set 记录尚未释放的位图；成功绘制后立即释放并移出 Set；输出 postMessage 失败时也关闭未交接结果。保留最早触发 abort 的原始错误。

此修复没有降低尺寸或限制图层数量，也没有解决成功路径全部图层同时解码的内存峰值。原生解码不支持中途取消时须等待它结束，以保证下一任务不会重叠分配。

## 验证

`test:uv-composite-worker-lifecycle` 执行生产 Worker，覆盖失败先到/解码迟到、剩余 fetch 取消、解码/Canvas/context/draw/transfer/postMessage 异常、每份资源恰好释放一次、成功结果转移及失败后下一任务。检查不同尺寸、乱序解码后的层序、alpha clamp、source-over 与 Y 翻转调用保持。旧代码在迟到解码屏障断言失败，修复通过。

## 对应实现审计、迁移与回滚

主线程 CPU fallback、WebGL 上传/flipY、shader、投影质量核、UV 合并/export 与持久作者资产均未改动；完整分辨率、QA、像素公式、合成版本、Schema/Command/CAS/ownership/verified assets 保持。无缓存失效、项目或资产迁移。回滚仅恢复 Worker 加载及清理实现，会重新引入迟到位图泄漏；不改写历史结果。完整验证见系统规范当日记录。
