# Ceph RGW 资产完整性校验兼容

- 基线：origin/release `de1507c`，保留效率组 `bc219a8/de1507c` 的 internal endpoint、RGW IP、代理设置以及生产/A100 遥测隔离。
- UI/use case：UI-01 工程保存、UI-04 输入、UI-14 烘焙资产；主模块 M14，协作 M02/M15。
- 算法：`ALG-ASSET-VERIFY-001` / Object integrity verification，v1.1.0（原 HEAD SHA-256 校验登记为 v1.0.0）。实现 Codex；状态待真实 Ceph 验收，尚未部署。
- 输入：服务端已归属校验的 intent（owner/project/asset/objectKey/sizeBytes/MIME/SHA-256）。输出：验证成功才发布 verified 资产；失败保持 pending。单位为字节，无颜色/矩阵变换。

## 原因与实现

当前存储 HEAD 成功但不返回 x-amz-checksum-sha256，旧逻辑把缺失当作内容损坏。HEAD 原生 SHA-256 快速路径保留，明确不匹配继续拒绝；仅头缺失时使用 internalPresigner 对实际内网 host 重新签名 GET，读取完整实际内容增量计算 SHA-256。GET 再验大小和 MIME；如果 HEAD 提供 ETag，则签名 If-Match 并核对 GET ETag，避免读回不同对象版本。ETag 不解释为 MD5，客户端 metadata 不作为完整性证据。不跟随重定向，不接受压缩读回/部分响应。

每个进程最多 4 个校验任务执行，16 个 FIFO 等待；总预算 60 秒包含排队、HEAD 和 GET。超载/超时/连接中断返回可重试错误，流取消并释放槽位；超过 intent 字节数立即拒绝，沿用 160 MiB 最大资产限制，禁止 arrayBuffer/整文件 Buffer 拼接。同 owner/project/intent 的在途完成请求共用校验与入库 Promise（仅进程内，多副本可能各自读回）；每个调用者先校验身份/资产/hash，已 verified 的重放不再 HEAD/GET。

前端仅将完成接口上限由 15 秒改为 75 秒，避免后端尚在验证时提前取消；不是固定等待。浏览器上传仍走公开地址；读回不占用浏览器下载带宽。新资产仍多一次服务器读回，实际保存延迟及集群吞吐需实测，不承诺无体验影响。现有素材缓存/三并发保存/dirty 与 Saved 状态保持。

CPU 只做 Node 分块哈希；GPU/Worker/shader/投影/UV/重绘/export 像素、Layer 输出、分辨率不变。校验后才写 verified 的既有持久化边界保留，Project Command 幂等性、Revision CAS、ownership、数据库 Schema 与 ASSET_TRANSFER_PROTOCOL_VERSION=1 不变。

## 迁移与回退

无数据库或历史资产迁移。既有 verified 资产按原规则复用；尚未过期的 pending intent 可以重试完成，过期则重新申请上传。回退只还原校验与前端超时，保留效率组内网设置和所有用户数据；旧代码在此 Ceph 上会再次拒绝缺失 checksum 的资产，不能将回退认定为功能恢复。

## 测试与验收

自动回归使用实际 HTTP 服务与编译后的服务端代码，分别暴露公开/内网端口。覆盖原生 checksum 零 GET、缺失 checksum 流式读回、8 个并发完成只读取一次、verified 重放、同长度坏内容拒绝、MIME 不符、GET 503/412/中断、超时和排队超载、失败后重试、160 MiB 限制及 16 MiB 内容校验。此服务是 Ceph 行为夹具，不是公司的 Ceph。

真实环境待验收：同一部署上传小 PNG 和大模型，确认浏览器 PUT 走公开域名、后端 HEAD/GET 走内网地址；保存后刷新重开并下载逐字节比对；在隔离测试对象上验证损坏拒绝。记录不同大小下保存 P50/P95、吞吐与 App 内存，检查多用户并发及重复保存无重复读回。验收前不声称生产修复已完成。

本地验证结果：Server 全部 14 项回归、contracts 9 项测试、Web typecheck、Cloud/Repository 边界通过。16 MiB 本机 HTTP 夹具读回约 58 ms，此值不是实际 Ceph 网络性能。修改文件 lint 与最终差异检查通过。
