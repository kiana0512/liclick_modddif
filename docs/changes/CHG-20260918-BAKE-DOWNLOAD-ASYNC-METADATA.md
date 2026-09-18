# CHG-20260918：Bake 下载与 ZIP 异步 metadata

## 范围

- 主模块：`M10` Bake 产物；协作：`M13` Cloud HTTP、`M15` 回归门禁。
- 契约：`BAKE-DOWNLOAD-METADATA/1.0.0`。
- 变更等级：L1；只处理下载热路径文件 metadata，不修改归档格式或 Bake 算法。

## 问题与修改

单图下载原先先同步加载冷 Job，再以 `existsSync` 检查输出；ZIP 清单对每个通道同步执行 Job/路径检查和 `existsSync/statSync`。共享卷抖动会直接阻塞 Node 事件循环，多用户同时下载时影响同进程其他请求。

- 新增异步 Job 读取入口，沿用现有内存缓存、owner 检查、异常远端任务恢复和监控语义。
- 单图路径统一委托异步输出 metadata：仅成功 Job、持久 owner、已配置通道且 `stat` 为普通文件时返回。
- ZIP 先异步取得 Job，再按既有通道顺序逐项等待 metadata；故意保持单请求并发为 1，避免一次归档请求对共享卷产生无界扇出。
- HTTP GET/HEAD、下载文件名、ZIP local/central header、CRC32、ZIP64、流式背压与错误处理均沿用原实现。

## 不变项与风险边界

GPU/CPU/Worker/shader、Bake 输入、远端幂等、像素、通道、颜色空间、分辨率、SHA/MIME/尺寸 QA、Job JSON、Project Command、Revision CAS、ownership、verified assets、Schema、对象存储和导出字节均不变；无数据或资产迁移。

metadata 验证与后续打开文件之间仍可能遇到文件系统竞态，流读取失败继续由现有 HTTP/归档错误路径处理；本补丁不把本地测试解释为生产共享卷耐久性验证。

## 验证与回滚

- 归档回归注入异步 Job/metadata，实现 owner 隔离、缺失通道跳过、顺序稳定和单请求 metadata 并发不超过 1。
- 源码形状门禁拒绝归档清单重新引入 `existsSync/statSync/readFileSync`。
- 远端 Bake 冒烟的单图与 ZIP 调用改为等待异步入口，继续覆盖 owner/跨 owner 拒绝。
- Server 完整回归、类型检查及正式发布门禁以最终提交记录为准。

回滚恢复同步路径与归档清单函数即可；无需数据回滚，但会重新引入共享卷 metadata 阻塞。
