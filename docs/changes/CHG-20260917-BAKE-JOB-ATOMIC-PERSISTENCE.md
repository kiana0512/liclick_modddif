# CHG-20260917：Bake Job 异步原子持久化

## 范围

- 主模块：`M10` 生产 Bake、`M13` Cloud 控制面稳定性。
- 协作模块：`M15` 回归与发布门禁。
- 契约：`BAKE-JOB-PERSISTENCE/1.0.0`。
- 变更等级：L1；单一文件持久化热点，不修改 Bake 算法、状态 API 或目录结构。
- 状态：本地验证通过候选，未推送、未部署，不据此声明生产共享卷性能完成。

## 问题与根因

`substanceBakeService` 的远端轮询、最多 3 路并发产物下载进度、自动 Roughness、取消及终态都会调用 `persist()`。旧实现用 `mkdirSync + writeFileSync` 原地重写 `job.json`：

1. 共享卷或磁盘抖动会同步阻塞 Node 事件循环，影响同进程其他用户的登录、保存、历史和健康检查。
2. 只把 API 换成无序 Promise 会让同一 Job 的旧快照在新终态之后完成，破坏重启恢复。
3. 原地覆盖中断可能损坏唯一 JSON，下一次启动无法恢复任务。

## 修改

- 在既有 `writeFileAtomically` 上增加轻量按 key 串行协调器；同一 key 链接上一写入，不同 key 不共享锁。
- 每次 `persist()` 先更新时间并立即序列化不可变字符串快照，再以 Job ID 入队，避免后续内存变更污染已提交快照。
- 原子写继续先完整写临时文件，再 rename 替换；失败不先删除目标，`finally` 清理临时文件。
- 一次写失败会拒绝该调用，但后续同 Job 写从已处理的尾 Promise 继续，不让队列永久中毒。
- 远端状态、下载进度、Roughness 阶段、成功/失败/取消终态全部等待对应写入；同步恢复入口不能改 API 签名，因此只排队一次带显式错误处理的恢复快照，随后监控写仍沿同一 Job 队列排序。

## 不变项审计

- GPU/CPU/Worker/shader：未修改、未替换或绕开。
- Bake：profile、输入、远端幂等键、轮询间隔、通道、像素、颜色空间、分辨率、SHA/MIME/尺寸 QA 和输出 URL 不变。
- 状态与持久化：Job JSON 字段、目录、日志上限、状态含义、ownership 和重启读取格式不变；没有 Project Command、Revision CAS、verified object asset 或数据库 Schema 变化。
- 导出：单图下载和 ZIP 归档未修改；它们剩余的同步 metadata 热点另立补丁。

## 故障边界与验证

- 写序回归：同一 Job 的第二快照在第一快照完成前不得开始；另一 Job 可同时开始。
- 恢复回归：注入一次 writer 失败，对应 Promise 拒绝，随后同 Job 快照仍能成功。
- 原子失败回归：目标预置上一份有效 JSON，注入 rename 失败后目标字节不变，临时文件被删除。
- 编译产物形状门禁：`persist()` 不得重新出现 `mkdirSync/writeFileSync`，且必须通过按 Job writer。
- 已通过 `test:bake-artifact-plan`、Server regression 25/25、Web regression 147/147、Contracts 9/9、部署契约 8/8、全仓 typecheck 与 lint（0 error，2 个既有 warning）。
- 按 `.gitlab-ci.yml` 与 `verify-prepush.mjs` 逐项执行 build 阶段：Cloud 正式构建、221 文件/25.04 MiB 制品检查、108 chunks / 3,227,295 bytes 包体、额外 256-byte reserve 和 Cloud 部署模拟均通过，未提高任何预算。
- `pnpm verify:prepush` 包装器本身按设计拒绝未提交工作树；本轮未为绕过该保护擅自 commit，以上为其读取的同一组 CI 命令在当前工作树的等价执行结果。提交变化后仍须在干净提交上重跑正式包装器。

原子替换保证调用进程观察到完整旧版或完整新版，不宣称替代生产对象存储/数据库、多副本协调、主机断电耐久性或共享卷实测。生产仍需观测写入 P95/P99、队列深度、失败率和事件循环延迟。

## 迁移与回滚

无 Schema、Job JSON、目录、数据库或资产迁移；旧任务可由新代码直接读取。回滚恢复 `persist()` 的同步覆盖及同步调用即可，已有 Job 和产物无需改写，但会重新引入事件循环阻塞及原地半写风险。回滚不得删除现有 `job.json` 或 Bake 输出。
