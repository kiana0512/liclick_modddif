# LI3D PBR Job 状态、日志与错误规范 v0.1

状态：设计基线

版本：0.1

建立日期：2026-07-20

上游文档：

- `docs/39_PBR_3A_MODULE_2_3_AND_DCC_PIPELINE_V0_1.md`
- `docs/40_PBR_ASSET_MANIFEST_AND_RELEASE_SCHEMA_V0_1.md`

## 1. 目的

本规范定义模块 2、模块 3 和启动器共用的任务系统，使 Substance 烘焙、ComfyUI、贴图转换和 DCC 发送具备统一的：

- 状态。
- 进度。
- 取消。
- 重试。
- 日志。
- 错误码。
- 持久化。
- 重启恢复。
- 幂等与防重复。
- UI 表达。

当前仓库中的 Liclick 图片生成任务和 ComfyUI 调用具有各自状态处理。本规范是 PBR Pipeline 的目标模型，不会在文档阶段改变现有生成任务行为。

## 2. 核心原则

1. Job 提交后冻结输入和参数。
2. 重试创建新 Attempt，不覆盖历史。
3. `cancelled` 与 `failed` 是不同状态。
4. Job 成功不等于资产已经发布。
5. 外部程序退出码为 0 也不等于结果有效，必须收集并验证输出。
6. 任务状态必须落盘，不能只存在前端内存。
7. 用户日志、技术日志和审计日志分层保存。
8. DCC 发送必须有幂等键和目标回执。
9. 后端重启后不能把未知结果猜成成功。
10. 密钥、令牌和敏感路径不得进入可分享日志。

## 3. Job 类型

```text
preflight
bake
comfy-pbr
texture-convert
dcc-delivery
connector-install
diagnostic
```

### 3.1 preflight

读取模型和贴图，生成高低模、UV、材质、坐标、文件和环境检查报告。

### 3.2 bake

调用 Substance 命令行 Baker，生成 BaseColor、AO 和可选 Normal。

### 3.3 comfy-pbr

调用可选 ComfyUI 工作流，净化 BaseColor 或生成 Roughness Candidate。

### 3.4 texture-convert

执行 Normal 方向转换、分辨率转换、色彩空间处理和通道打包。

### 3.5 dcc-delivery

生成目标交付包并调用 DCC Connector 导入，等待 Receipt。

### 3.6 connector-install

安装、修复或升级 LI3D 自有 DCC 插件。

### 3.7 diagnostic

执行启动器或工作台环境诊断。

## 4. Job Schema

```json
{
  "schemaVersion": "0.1",
  "id": "job_...",
  "kind": "bake",
  "projectId": "project-id",
  "assetId": "asset_...",
  "draft": {
    "id": "draft_...",
    "revision": 12
  },
  "status": "queued",
  "stage": "waiting-for-worker",
  "progress": {
    "value": 0,
    "unit": "percent",
    "completedItems": 0,
    "totalItems": 3
  },
  "inputSnapshot": {},
  "parameterSnapshot": {},
  "environmentSnapshot": {},
  "attemptIds": [],
  "activeAttemptId": null,
  "result": null,
  "error": null,
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "startedAt": null,
  "finishedAt": null,
  "createdBy": {},
  "idempotencyKey": "..."
}
```

### 4.1 必需字段

- `schemaVersion`
- `id`
- `kind`
- `projectId`
- `status`
- `stage`
- `inputSnapshot`
- `parameterSnapshot`
- `environmentSnapshot`
- `attemptIds`
- `createdAt`
- `updatedAt`
- `createdBy`
- `idempotencyKey`

### 4.2 快照规则

Job 提交时冻结：

- File ID、相对路径、大小和 SHA-256。
- Draft ID 和 revision。
- 实际参数，不只保存预设名称。
- 目标软件、适配器和协议版本。
- 外部工具路径和版本。
- GPU/CPU 与设备信息。
- Comfy Workflow ID、版本和节点映射版本。
- Target Profile 完整快照。

Job 运行时发现输入哈希与快照不同，必须以 `ASSET-INPUT-CHANGED` 阻塞或失败，不能继续处理被替换的文件。

## 5. Job 状态

### 5.1 非终态

| 状态 | 含义 |
| --- | --- |
| `created` | 已建立但尚未完成提交验证 |
| `validating` | 正在验证输入、参数和环境 |
| `blocked` | 存在需要用户处理的阻塞问题，可以修复后重新验证 |
| `queued` | 已冻结并进入队列 |
| `running` | Worker 或外部程序正在执行 |
| `cancelling` | 已接受取消请求，正在停止本地或远程工作 |
| `collecting` | 执行结束，正在收集、校验和注册输出 |
| `review-required` | 任务产生了 Candidate，需要用户检查或选择 |

### 5.2 终态

| 状态 | 含义 |
| --- | --- |
| `succeeded` | 任务完成且输出通过任务级验证 |
| `failed` | 因错误无法完成 |
| `cancelled` | 用户或系统明确取消 |
| `expired` | 外部任务或连接在规定时间内无法恢复，结果未知或不可再查询 |

### 5.3 `succeeded` 不表示 `published`

`published` 属于 Release 状态，不属于 Job 状态。

- Bake Job succeeded：说明生成和验证了 Candidate。
- Comfy Job succeeded：说明生成和验证了 Candidate。
- 用户验收并发布：创建 Release。
- DCC Delivery Job succeeded：说明得到目标侧有效 Receipt。

## 6. 状态转换

```text
created
  -> validating
      -> blocked
          -> validating
      -> queued
          -> running
              -> cancelling
                  -> cancelled
              -> collecting
                  -> review-required
                      -> succeeded
                  -> succeeded
                  -> failed
              -> failed
          -> cancelled
      -> failed
```

额外转换：

- `running`、`cancelling` 或 `collecting` 在外部状态无法恢复时可以进入 `expired`。
- `review-required` 可由用户拒绝结果后进入 `succeeded`，但结果标记为未选择；发布行为仍由 Draft/Release 管理。
- 终态不能回到非终态。重试创建新 Attempt 或新 Job。

## 7. Attempt Schema

```json
{
  "schemaVersion": "0.1",
  "id": "attempt_...",
  "jobId": "job_...",
  "number": 1,
  "status": "running",
  "workerId": "worker_...",
  "process": {
    "pid": 1234,
    "executable": "redacted-or-relative",
    "startedAt": "ISO-8601",
    "exitCode": null,
    "signal": null
  },
  "external": {
    "provider": "substance",
    "taskId": null,
    "receiptId": null
  },
  "outputCandidates": [],
  "error": null,
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "finishedAt": null,
  "supersedesAttemptId": null
}
```

规则：

- Attempt number 从 1 递增。
- Attempt 使用所属 Job 的冻结快照。
- 用户修改参数后应创建新 Job，而不是在同一 Job 重试。
- 仅因暂时性错误按相同参数重试时，创建新 Attempt。
- 每个 Attempt 有独立日志和输出临时目录。

## 8. Stage 与进度

Status 表示生命周期，Stage 表示当前具体步骤。

### 8.1 Bake Stage

```text
validating-inputs
preparing-work-directory
building-command
baking-base-color
baking-ambient-occlusion
baking-normal
verifying-files
registering-candidates
finished
```

### 8.2 Comfy Stage

```text
checking-provider
uploading-inputs
patching-workflow
queueing-prompt
waiting-in-queue
sampling
downloading-output
verifying-output
registering-candidates
finished
```

### 8.3 DCC Delivery Stage

```text
checking-connector
building-delivery
converting-files
verifying-package
connecting
sending-manifest
transferring-files
waiting-for-import
validating-receipt
finished
```

### 8.4 进度规则

- `value` 范围 0 到 100。
- 同一 Attempt 中进度默认单调不下降。
- 不知道百分比时使用 `indeterminate: true`，不能伪造平滑进度。
- 同时保存 `completedItems/totalItems`，例如已完成 2/3 张贴图。
- 外部程序无法提供进度时，UI 显示当前 Stage、持续时间和活动状态。
- Job 完成前不能只因为动画到达 100 就标记成功。

## 9. JobEvent

状态变化通过追加事件记录。

```json
{
  "schemaVersion": "0.1",
  "id": "event_...",
  "jobId": "job_...",
  "attemptId": "attempt_...",
  "sequence": 18,
  "type": "status.changed",
  "timestamp": "ISO-8601",
  "actor": {
    "kind": "worker",
    "id": "worker_..."
  },
  "data": {
    "from": "running",
    "to": "collecting"
  }
}
```

事件类型建议：

```text
job.created
job.validated
job.blocked
job.queued
attempt.created
attempt.started
stage.changed
progress.updated
log.appended
warning.added
cancel.requested
cancel.acknowledged
process.exited
external.task-linked
output.discovered
output.verified
candidate.registered
receipt.received
attempt.finished
job.finished
```

规则：

- `sequence` 在 Job 内严格递增。
- 事件追加后不修改。
- 当前 Job 快照可由事件更新生成，但事件不是 UI 每次加载必须全量重放的唯一存储。
- 审计需要时可用事件解释状态为何改变。

## 10. 日志规范

### 10.1 用户日志

目标：让艺术家知道发生了什么和下一步做什么。

示例：

```text
正在烘焙 BaseColor
BaseColor 已完成，开始检查 4096 x 4096 PNG
未生成 AO：高模文件无法读取
建议重新选择高模，或打开完整日志查看路径错误
```

禁止直接把长堆栈或原始 JSON 当用户文案。

### 10.2 技术日志

记录：

- Worker 和线程信息。
- 外部进程路径、参数的脱敏版本。
- 标准输出和标准错误。
- HTTP 状态、Provider Task ID。
- 进程退出码和信号。
- 各阶段耗时。
- 文件发现和验证详情。
- 异常堆栈。

建议格式：UTF-8 JSON Lines，同时可生成便于阅读的纯文本视图。

```json
{"timestamp":"...","level":"info","jobId":"job_...","attemptId":"attempt_...","stage":"baking-normal","message":"Substance process started","data":{}}
```

### 10.3 审计日志

记录：

- 谁创建、取消或重试任务。
- 谁确认警告。
- 谁选择或拒绝 Candidate。
- 谁发布 Release。
- 谁改变 DCC Target Profile。
- 谁执行插件安装或修复。

### 10.4 日志等级

- `trace`
- `debug`
- `info`
- `warn`
- `error`
- `fatal`

生产默认保存 `info` 以上，诊断模式可以临时启用 `debug`。`trace` 不应长期默认开启。

### 10.5 日志关联字段

所有任务日志尽量包含：

- `projectId`
- `assetId`
- `draftId`
- `releaseId`
- `deliveryId`
- `jobId`
- `attemptId`
- `requestId`
- `connectorId`
- `externalTaskId`

## 11. ErrorRecord

```json
{
  "code": "BAKE-PROCESS-EXIT-NONZERO",
  "category": "BAKE",
  "severity": "error",
  "retryable": true,
  "userMessage": "Substance 烘焙未完成。",
  "technicalMessage": "Process exited with code 1.",
  "stage": "baking-normal",
  "suggestedActions": [
    "打开完整日志",
    "检查输入模型",
    "使用相同参数重试",
    "GPU 失败时尝试 CPU"
  ],
  "details": {},
  "cause": null,
  "occurredAt": "ISO-8601"
}
```

### 11.1 严重程度

- `info`
- `warning`
- `error`
- `fatal`

### 11.2 retryable

- `true`：相同 Job 参数可以创建新 Attempt。
- `false`：必须修改输入、参数、环境或软件后创建新 Job。
- `conditional`：满足 Suggested Action 后可以重试。

实现中可以使用枚举而非布尔值，以表达 `conditional`。

### 11.3 错误展示

UI 默认显示：

- 用户文案。
- 出错步骤。
- 是否保留已完成结果。
- 主要解决动作。
- 错误码。
- 完整日志入口。

技术信息放在可展开区域。

## 12. 首批错误码

### 12.1 ENV

| 错误码 | 含义 | 默认处理 |
| --- | --- | --- |
| `ENV-SUBSTANCE-NOT-FOUND` | 未找到 Substance Baker | 阻塞，选择路径或安装 |
| `ENV-SUBSTANCE-INCOMPATIBLE` | 版本不在兼容范围 | 阻塞或用户确认 |
| `ENV-GPU-UNAVAILABLE` | GPU 不可用 | 警告，可选择 CPU |
| `ENV-COMFY-UNAVAILABLE` | ComfyUI 不可用 | 可跳过 |
| `ENV-DCC-NOT-FOUND` | 未找到目标 DCC | 阻塞发送 |
| `ENV-CONNECTOR-MISSING` | 未安装连接器 | 提供安装/修复 |
| `ENV-CONNECTOR-INCOMPATIBLE` | 插件或协议不兼容 | 升级或回滚 |
| `ENV-DISK-SPACE-LOW` | 空间不足 | 阻塞或警告 |

### 12.2 ASSET 和 IO

| 错误码 | 含义 | 默认处理 |
| --- | --- | --- |
| `ASSET-FILE-MISSING` | 输入文件缺失 | 重新定位 |
| `ASSET-HASH-MISMATCH` | 文件校验失败 | 阻塞 |
| `ASSET-INPUT-CHANGED` | 提交后输入被替换 | 创建新 Job |
| `ASSET-UNSUPPORTED-FORMAT` | 格式不支持 | 转换或更换输入 |
| `IO-PATH-OUTSIDE-PROJECT` | 输出路径逃逸 | 安全阻止 |
| `IO-PERMISSION-DENIED` | 无读写权限 | 修复权限或路径 |
| `IO-DISK-FULL` | 磁盘已满 | 失败并保留日志 |
| `IO-ATOMIC-PUBLISH-FAILED` | 原子发布失败 | 不注册 Release |

### 12.3 MESH

| 错误码 | 含义 | 默认处理 |
| --- | --- | --- |
| `MESH-LOW-UV-MISSING` | 低模无 UV | 阻塞 |
| `MESH-BOUNDS-MISMATCH` | 高低模空间明显不匹配 | 阻塞或人工确认 |
| `MESH-UDIM-NOT-FOUND` | 目标 UDIM 不存在 | 阻塞 |
| `MESH-MATERIAL-MAPPING-AMBIGUOUS` | 材质槽无法匹配 | 人工映射 |
| `MESH-UV-OVERLAP` | UV 重叠 | 警告或阻塞 |
| `MESH-NORMAL-WARNING` | 平滑组或法线风险 | 警告 |

### 12.4 BAKE

| 错误码 | 含义 | 默认处理 |
| --- | --- | --- |
| `BAKE-COMMAND-BUILD-FAILED` | 无法构造命令 | 修复参数 |
| `BAKE-PROCESS-SPAWN-FAILED` | 无法启动 Baker | 检查路径/权限 |
| `BAKE-PROCESS-EXIT-NONZERO` | Baker 非零退出 | 查看日志，可重试 |
| `BAKE-OUTPUT-MISSING` | 预期输出缺失 | 分项失败 |
| `BAKE-OUTPUT-INVALID-PNG` | 输出不是有效 PNG | 分项失败 |
| `BAKE-OUTPUT-SIZE-MISMATCH` | 输出尺寸错误 | 分项失败 |
| `BAKE-CANCEL-TIMEOUT` | 取消超时 | 强制结束并记录 |

### 12.5 COMFY

| 错误码 | 含义 | 默认处理 |
| --- | --- | --- |
| `COMFY-AUTH-FAILED` | 远程鉴权失败 | 更新连接设置 |
| `COMFY-WORKFLOW-MISSING` | 工作流不存在 | 阻塞该可选步骤 |
| `COMFY-WORKFLOW-INCOMPATIBLE` | 节点映射不兼容 | 切换受支持版本 |
| `COMFY-UPLOAD-FAILED` | 输入上传失败 | 可重试 |
| `COMFY-QUEUE-FAILED` | 无法入队 | 可重试 |
| `COMFY-TASK-FAILED` | 远程执行失败 | 保留原始贴图 |
| `COMFY-OUTPUT-INVALID` | 输出验证失败 | 不注册 Candidate |
| `COMFY-CANCEL-UNCONFIRMED` | 远程取消未确认 | 本地取消，忽略迟到结果 |

### 12.6 PBR

| 错误码 | 含义 | 默认处理 |
| --- | --- | --- |
| `PBR-COLORSPACE-UNKNOWN` | 色彩空间未知 | 发布前阻塞 |
| `PBR-NORMAL-ORIENTATION-UNKNOWN` | Normal 方向未知 | 发布或发送前阻塞 |
| `PBR-CHANNEL-MISSING` | 必需通道缺失 | 阻塞 Release |
| `PBR-PACKING-INVALID` | 通道打包映射无效 | 修复 Profile |
| `PBR-RESOLUTION-MISMATCH` | 通道尺寸不一致 | 警告或转换 |

### 12.7 DCC

| 错误码 | 含义 | 默认处理 |
| --- | --- | --- |
| `DCC-CONNECTION-FAILED` | 无法连接插件 | 启动或修复连接器 |
| `DCC-PROTOCOL-MISMATCH` | 协议版本不匹配 | 升级/回滚 |
| `DCC-CAPABILITY-MISSING` | 目标缺少所需能力 | 更换 Profile 或目标 |
| `DCC-TRANSFER-FAILED` | 文件传输失败 | 幂等重试 |
| `DCC-IMPORT-FAILED` | 目标导入失败 | 返回目标错误 |
| `DCC-RECEIPT-TIMEOUT` | 未收到回执 | 查询状态，不猜成功 |
| `DCC-RECEIPT-INVALID` | 回执无法验证 | 任务失败或人工检查 |
| `DCC-DUPLICATE-REQUEST` | 目标发现重复请求 | 返回原 Receipt |

## 13. 取消语义

### 13.1 用户取消

1. API 接受取消请求并写入 `cancel.requested`。
2. Job 进入 `cancelling`。
3. Worker 停止排队、子进程或远程任务。
4. 写入外部取消结果。
5. 停止注册新的正式 Candidate。
6. Job 进入 `cancelled`。

### 13.2 Bake 取消

- 先请求进程正常结束。
- 超时后再强制结束进程树。
- 已验证输出作为 Attempt 附件保留，默认不成为当前 Candidate。
- 临时文件根据保留策略清理。

### 13.3 Comfy 取消

- 本地立即停止等待并标记取消意图。
- 尽力调用远程 interrupt/cancel。
- 保存 Prompt ID，迟到结果一律不自动应用。
- 用户可以在诊断页查看远程取消是否确认。

### 13.4 DCC 取消

- 发送前取消：终止构建和传输。
- 发送中取消：中止后续分块并通知插件。
- 已开始目标导入：插件尽力取消；如果不能回滚，回执必须报告目标侧部分结果。
- 状态未知时使用 `expired` 或 `DCC-RECEIPT-TIMEOUT`，不能标记 cancelled-success。

## 14. 重试语义

### 14.1 同一 Job 新 Attempt

允许条件：

- 输入哈希未变。
- 参数未变。
- Draft revision 仍与 Job 快照一致，或结果只作为历史 Candidate。
- 错误标记为可重试。

示例：暂时性文件锁、远程网络失败、DCC 连接瞬断。

### 14.2 创建新 Job

以下情况必须新建 Job：

- 用户改变分辨率、采样、Ray Distance 或地图选择。
- 用户替换高模、低模、Cage 或贴图。
- Draft revision 已改变并希望结果应用到当前 Draft。
- 切换 GPU/CPU 被视为生产参数变化。
- 更改 Comfy Workflow 或 Seed。
- 更改 DCC Target Profile。

### 14.3 分项重试

Bake Job 可以为 BaseColor、AO、Normal 建立子项状态。只重试失败地图时：

- 新 Attempt 记录选择的地图集合。
- 复用的成功文件通过 File ID 引用。
- 新旧结果共同生成 Candidate 集合。
- 不覆盖旧 Attempt 文件和日志。

## 15. 幂等与防重复

### 15.1 idempotencyKey

建议由以下内容生成稳定摘要：

```text
job kind
project id
asset/draft/release id
input file hashes
parameter snapshot hash
target profile hash
user request nonce or operation scope
```

相同键的活动 Job 默认返回已有 Job，不重复启动。

### 15.2 DCC 请求

DCC Connector 必须记录：

- `requestId`
- `idempotencyKey`
- `deliveryId`
- `receiptId`
- 目标对象身份

插件收到重复请求时：

- 如果原请求已成功，返回原 Receipt。
- 如果原请求仍在执行，返回当前状态。
- 如果原请求失败，按明确的 retry policy 决定是否重试。
- 不无提示再导入一套对象。

## 16. DCC Receipt

```json
{
  "schemaVersion": "0.1",
  "id": "receipt_...",
  "requestId": "request_...",
  "idempotencyKey": "...",
  "deliveryId": "delivery_...",
  "status": "succeeded",
  "target": {
    "host": "blender",
    "hostVersion": "...",
    "connectorVersion": "...",
    "scene": "..."
  },
  "importedObjects": [],
  "materials": [],
  "textures": [],
  "conversionsApplied": [],
  "warnings": [],
  "errors": [],
  "startedAt": "ISO-8601",
  "finishedAt": "ISO-8601"
}
```

Receipt 通过本地连接会话和 Delivery Manifest 校验。目标插件不能只返回自由文本“OK”。

## 17. 持久化

建议任务目录：

```text
jobs/<kind>/<jobId>/
  job.json
  events.jsonl
  user.log
  audit.jsonl
  attempts/
    <attemptId>/
      attempt.json
      technical.jsonl
      stdout.log
      stderr.log
      temp/
      outputs/
```

规则：

- Job 状态写入使用临时文件加原子 rename。
- Event 追加需要序列号和刷新策略。
- 大型 stdout/stderr 不写入 `job.json`。
- 当前状态和事件都持久化，便于快速加载和审计。
- Server 进程退出不删除活动 Job。

## 18. 重启恢复

服务启动时扫描非终态 Job：

### 18.1 queued

- 验证快照和锁。
- 重新加入队列。

### 18.2 running

- 本地子进程：验证 PID 仅作辅助，不能因 PID 相同就认定是原进程。
- Comfy：通过保存的 Prompt ID 查询远程 history/queue。
- DCC：通过 requestId/idempotencyKey 查询连接器状态或 Receipt。
- 无法确认时进入恢复检查，不直接重跑。

### 18.3 cancelling

- 继续取消流程。
- 无法确认远程状态时记录警告并进入 `cancelled` 或 `expired`，取决于是否可能产生目标侧副作用。

### 18.4 collecting

- 重新扫描 Attempt 输出。
- 重新验证哈希和文件。
- 注册过程必须幂等。

### 18.5 恢复超时

超过规定恢复窗口后进入 `expired`，保留所有外部 ID 和日志供人工检查。

## 19. 队列、并发和资源锁

### 19.1 资源类型

- GPU Bake。
- CPU Bake。
- Comfy Provider。
- 项目发布写锁。
- DCC Host Session。
- Connector 安装目录。

### 19.2 锁规则

- 同一 Draft 可以并行运行不会写同一文件的只读预检。
- 同一 Job 只允许一个 active Attempt。
- 同一 Release Publisher 使用项目级短时发布锁。
- 同一 DCC Host 的并发能力由 Connector capability 决定。
- Connector 安装/修复时禁止同时发送任务。
- 锁有 owner、创建时间、租约和恢复策略。

### 19.3 队列优先级

建议：

- 用户当前交互任务：高。
- 显式发送 DCC：高。
- 正式 Bake：正常。
- Comfy 可选处理：正常。
- 后台预检和缩略图：低。
- 诊断：按用户触发提高。

优先级不能抢占已经进入不可安全中断阶段的外部任务。

## 20. API 方向

```text
POST /api/projects/:projectId/jobs
GET  /api/projects/:projectId/jobs
GET  /api/projects/:projectId/jobs/:jobId
POST /api/projects/:projectId/jobs/:jobId/cancel
POST /api/projects/:projectId/jobs/:jobId/retry
GET  /api/projects/:projectId/jobs/:jobId/events
GET  /api/projects/:projectId/jobs/:jobId/logs
GET  /api/projects/:projectId/jobs/:jobId/attempts/:attemptId
```

### 20.1 创建请求

客户端提交意图和 Draft/Release 引用。Server 负责：

- 读取并冻结实际文件哈希。
- 规范化参数。
- 生成环境快照。
- 计算 idempotencyKey。
- 验证权限和路径。
- 创建 Job。

客户端不能自行声明“输入已经验证”。

### 20.2 状态推送

首版可以轮询，后续可使用 SSE 或 WebSocket。无论传输方式如何，Server 落盘状态是唯一真相，前端本地状态不是任务真相。

## 21. UI 映射

### 21.1 状态视觉

| 状态 | UI 语义 |
| --- | --- |
| created/validating | 正在准备 |
| blocked | 需要处理 |
| queued | 排队中 |
| running/collecting | 正在执行 |
| cancelling | 正在取消 |
| review-required | 等待检查 |
| succeeded | 已完成 |
| failed | 失败 |
| cancelled | 已取消 |
| expired | 状态未知，需要检查 |

### 21.2 颜色

- 粉紫：当前活动、主进度和主操作。
- 绿色：成功和连接就绪。
- 黄色/橙色：警告、等待人工确认。
- 红色：阻塞或失败。
- 灰色：取消、未开始或离线。

不能只依靠颜色，必须同时提供图标和文字。

### 21.3 用户操作

按状态显示准确动作：

- blocked：修复、重新检查。
- queued：取消、调整队列。
- running：取消、查看日志。
- review-required：检查结果、接受、拒绝、重烘。
- failed：查看原因、按原参数重试、修改后新建任务。
- cancelled：查看已保留结果、重新开始。
- expired：查询外部状态、打开目标软件、人工确认。

## 22. 启动器集成

启动器展示系统级任务摘要，不替代 Web 任务面板。

启动器需要：

- Worker 是否在线。
- 活动 Job 数量。
- GPU/Comfy/DCC 资源占用。
- 最近失败任务和错误码。
- 打开对应 Web 项目和 Job 的入口。
- 服务重启前提示活动任务风险。
- 完整日志目录入口。

服务重启不能无提示把 running Job 丢失。

## 23. 日志保留和清理

- Release 和 Delivery 引用的 Job/Attempt 元数据长期保留。
- 用户日志、错误和 Receipt 长期保留。
- stdout/stderr 和大体积临时文件按可配置周期清理。
- 清理前确认文件未被 Candidate、Release、Delivery 或诊断包引用。
- 清理动作写审计日志。
- 用户可以导出某个 Job 的脱敏诊断包。

## 24. 隐私与安全

- 日志中不记录访问令牌、Cookie、授权头和密钥。
- 命令行参数含敏感值时保存脱敏版本。
- 用户目录可以在分享日志中替换为 `%USERPROFILE%`。
- 远程 Comfy URL 可保存主机信息，但认证材料单独保存在安全设置中。
- DCC Socket 只监听明确的本地接口，并使用会话令牌。
- Web 请求必须校验 projectId、路径和当前会话权限。
- 诊断包导出前执行脱敏扫描。

## 25. 与当前实现的差异

当前代码中部分图片生成任务使用 `submitting/running/succeeded/failed`，取消可能被映射为 `failed`；PBR Pipeline 不复用这一语义。

PBR Pipeline 实现时必须：

- 增加明确 `cancelled` 和 `cancelling`。
- 区分 Job 与 Attempt。
- 将输出先注册为 Candidate。
- 持久化参数和环境快照。
- 使用错误码而非只保存自由文本。
- 对 DCC 使用 Receipt 和幂等键。

这是新模块的目标模型，不要求在第一步重构现有模块 1 生成任务。

## 26. 测试与验收

### 26.1 状态机

- 非法状态转换被拒绝。
- 终态不能恢复到 running。
- blocked 可以重新 validating。
- cancel 请求产生 cancelling 和 cancelled 事件。
- failed 与 cancelled 可区分。

### 26.2 持久化

- 服务重启后 queued Job 重新排队。
- collecting Job 可以幂等重新收集。
- Job JSON 不因进程中断只写入一半。
- Event sequence 无重复和倒序。

### 26.3 重试

- 相同快照可创建新 Attempt。
- 参数变化必须创建新 Job。
- 分项重试不覆盖成功文件。
- 旧 Attempt 的日志和退出码保留。

### 26.4 取消

- Bake 子进程可以停止。
- Comfy 迟到结果不自动应用。
- DCC 部分导入得到明确 Receipt 或未知状态。
- 取消不会发布 Candidate 或 Release。

### 26.5 幂等

- 双击提交不会创建两个活动 Job。
- DCC 重复请求不重复创建对象。
- 重复收集输出不会生成重复 Candidate。
- 重复发布请求返回同一结果或明确冲突。

### 26.6 日志和错误

- 用户看到可执行建议。
- 完整日志可按 Job 和 Attempt 查找。
- 日志不存在密钥和明文令牌。
- 每个关键失败都产生稳定错误码。

## 27. v0.1 实施顺序

1. 在共享包定义 Job、Attempt、Event、Error 和 Receipt Schema。
2. 实现安全的 Job 文件存储和原子写入。
3. 实现状态转换守卫。
4. 实现事件追加和日志服务。
5. 实现队列和资源锁最小版本。
6. 先接 Preflight Job。
7. 接 Substance Bake Job。
8. 接 Comfy PBR Job。
9. 接 Texture Convert Job。
10. 接首个 DCC Delivery Job 和 Receipt。
11. 接启动器状态摘要和诊断入口。
12. 完成重启恢复、取消、重试和幂等测试。

## 28. 变更记录

### v0.1 - 2026-07-20

- 首次定义 PBR Pipeline Job、Attempt、状态机、Stage、Event 和进度。
- 定义取消、重试、幂等、持久化、重启恢复、队列和资源锁。
- 建立首批 ENV、ASSET、IO、MESH、BAKE、COMFY、PBR 和 DCC 错误码。
- 定义 DCC Receipt、日志分层、UI 映射和启动器集成要求。

