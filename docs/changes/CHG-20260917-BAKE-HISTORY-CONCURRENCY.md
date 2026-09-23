# CHG-20260917：Bake 历史多用户并发稳定性

## 范围

- 主模块：`M13` Cloud 控制面稳定性。
- 协作模块：`M10` 生产 Bake、`M15` 回归门禁。
- 契约：`BAKE-HISTORY-LIST/1.1.0`。
- 状态：已随 `2222576c` 进入 `master`；小范围调度与文件 I/O 修复，不迁移 Bake Job 数据，尚未据此声明生产部署。

## 问题

Bake 历史列表虽然已把 Job JSON 读取异步化，但多个用户同时请求时仍会各自扫描并读取同一批任务目录；历史响应构建还会在 HTTP 请求路径同步执行产物 `exists/stat`。共享卷延迟升高时，同一 Node 进程的登录、保存、健康检查和其他用户请求都会受到影响。

## 修改

- 同一时刻到达的 Bake 历史请求共享一次目录扫描和最多 8 路的未缓存 Job JSON 读取。
- 扫描结果按持久化 `ownerUserId` 建立本次请求批次的 owner 索引；缺少 owner 的旧任务继续拒绝展示，不从工程名或请求身份推断所有权。
- 产物存在性和大小读取改为 `fs.promises.stat`，并要求目标是普通文件。
- 每个历史请求逐任务构造输出，单次最多只展开一个任务的通道检查，避免 `limit=100` 时一次创建数百个文件操作。

## 不变项

排序、1–100 limit、状态、参数、下载 URL、未终态监控恢复、Job JSON、Bake 输出字节和归档格式不变。GPU/CPU/Worker/shader、分辨率、QA、Project Command、Revision CAS、ownership 判定、verified assets 和数据库 Schema 均不变。

## 验证

- 任务历史冒烟创建 10 个独立身份、34 个带 owner 的 Bake Job 和 1 个无 owner 旧任务。
- 同时发起 40 个鉴权历史请求，逐请求验证只返回当前身份任务、排序一致、无 owner 任务不可见。
- 继续验证匿名下载 401、跨用户下载 404、owner 下载字节一致，以及 UV/拓扑历史隔离。
- 最终 `master` 的 Server regression 24/24、Web regression 147/147、全仓 typecheck/lint、正式 `verify:prepush`、Cloud boundary、生产构建与部署模拟通过。
- 正式 Web 产物为 104 chunks / 3,214,864 bytes，原预算及额外 256-byte reserve 检查均通过。
- Cloud release-readiness 仍有 8 项 required capability 为 `in_progress`；本地并发冒烟不等同于生产共享卷压测或正式发布批准。

## 迁移与回滚

无数据库、Job JSON 或对象资产迁移。回滚可恢复逐请求扫描和同步产物 metadata 读取；已有任务无需改写，但会重新引入多用户并发下的重复扫描和事件循环阻塞风险。
