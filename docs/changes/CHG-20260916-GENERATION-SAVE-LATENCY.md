# 生成组提交后的保存等待与历史图片重复准备

主模块 M12，协作 M04/M08/M14；GENERATION-ASSET-REFERENCE/1.0.1、GENERATION-IMAGE-SOURCE/1.0.0、GPT-GROUP-STATUS-CHECKPOINT/1.0.0。

## 问题与变化

GPT 分组在相机 checkpoint 保存、每个视角获得服务端任务响应后，仍等待完整工程的 best-effort 状态保存才开始观察返图。慢上传或保存排队会把进度停在约 50%，即使远端图片已经完成。仅将这个提交后的状态保存与原返图观察重叠；相机 checkpoint 仍在付费提交前 await，组末保存仍 await 同一个保存队列，后续组必须等待上一组保存和视口完整呈现。非 GPT 分组保持原等待。没有重提生成请求。

共同保存入口原有工程隔离 SHA-256 上传缓存，但命中前仍读取每个历史内联 data URL、Base64 解码和 hash。新增只保存不可变输入 Blob/digest 的源准备缓存，先按完整 data:image/ URL 判断身份，同源在途/重复保存复用；它不包含服务端资产 URL 或任何权限/凭证。跨工程仍经过原工程隔离的 verified asset 上传缓存与上传通道。缓存最多 32 项、64MiB 保守估算（UTF-16 URL + 最坏 UTF-8 原字节 + 元信息）；过大绕过，LRU 淘汰只影响速度，失败删除当前条目，晚到失败不能删除替代条目。远端、blob 和 live canvas 不缓存。

## 验证与限制

- 实际 GeneratePanel 入口函数执行夹具：提交后状态保存一直 pending，返图观察仍开始并解除该等待，全部六视角和后续组完成；原 10/14 视角分组、固定相机、fresh 当前 UV 效果、取消、失败、删除与呈现等待回归保持。
- 实际共同保存模块：重复快照 source 读取从每次一次变为累计一次，上传仍同工程一次、另一工程单独上传；上传失败/临时地址拒绝与后续重试、原 Blob 字节、历史字段和不可变输入通过。
- 源缓存边界：同源并发、内容变化、mutable 绕过、零容量/超大绕过、有界淘汰、失败重试、淘汰后晚到错误不会破坏新条目。

这是减少保存关键路径与重复字节准备，不证明用户截图中所有等待均由保存导致；对象存储上传、服务器 CAS、GPU 计算/回读和可见呈现仍要单独测量。提交前保存不会绕过，不能将后台 Saving 状态冒充 durable 完成。

## 审计、迁移和回滚

GPU/CPU/Worker/shader、投影、逐层 UV 权重、作者 mask/normal/depth、QA、输出分辨率与 PNG 字节不变；保存只读源副本，不改变 renderer 或 live paint URL。Project Command 幂等、Revision CAS、ownership、verified object assets、持久格式和导出保持，无 Schema/历史资产迁移。回滚本轮源缓存及提交后等待重叠，保留原资产引用归一化与所有保存前置门禁。不打断用户当前生成，不恢复退休本地组件或凭据托管。
