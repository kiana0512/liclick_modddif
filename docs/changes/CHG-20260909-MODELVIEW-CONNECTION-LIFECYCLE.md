# ModelView 复用连接误触发建连超时

- 主模块 M04；协作 M08/M15。
- 请求生命周期契约 MODELVIEW-CONNECTION-LIFECYCLE v1.0.1；ALG-GEN-006 视角队列算法不变。
- 基线 0f0a0ee；维护文档 2.19.7。

## 证据与修复

原共享 requestModelview 在每次 socket 分配时启动 10 秒计时，只在 connect/secureConnect 时清除。Agent 复用 socket 不会重发建连事件，因此即使上游已接收任务，也在 10 秒被本地误中止。冻结原函数的本地 HTTP 双请求复现：第二次确认使用同一 socket，上游等待 11 秒返回，客户端约 10014ms 报连接超时。A100 到配置地址使用受管 CA 的只读 GET 能完成 TCP/TLS 并返回 405；不是一次付费生成验证，也不据此保证远端永不故障。

仅对 request.reusedSocket=false 的新连接计时；已结束后到达的 socket 不再设置计时器。HTTPS 保持 secureConnect 而不是 TCP connect 为完成条件。成功、错误、取消和超时都清理建连监听与计时器。全部三种 ModelView 入口共用修复，不增加自动重试，避免重复生成。

## 验证范围

- 编译后的实际请求函数：HTTP/HTTPS 复用、新连接、TLS 未握手、总超时、取消/提前取消、迟到 socket 与监听清理。
- 实际后端代理 smoke：第二次 HTTP 请求确认同一 socket，等待 11 秒（超过建连期限、低于任务期限），验证 PNG 返回和保存、幂等性与其他三种入口输入校验。
- 仅本地测试服务；不提交真实远端生图，不修改用户项目。
- 验证结果：16 项 HTTP/HTTPS 生命周期检查、真实后端 11 秒 keep-alive smoke、完整服务端 15 项回归全部通过；TypeScript 编译、变更文件 ESLint 和 git diff --check 通过。A100 实际多视图任务仍待部署后用户验收。

## 不变项与回滚

10 秒建连上限及所有生产任务总超时值不变；保留 TLS CA/rejectUnauthorized、服务地址、API key、请求头、提示词、multipart、任务取消和响应上限。GPU/CPU/Worker/shader、蒙版、投影/UV/export、分辨率、Schema/Command/CAS/ownership/verified assets 均不改。无需数据迁移；回滚恢复原请求函数会重新暴露复用误超时风险，历史资产保持。此卡不表示已提交 master 或部署 A100。
