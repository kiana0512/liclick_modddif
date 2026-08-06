# 多模型自动拓扑：本地改动与远端同步说明

## 1. 目标

拓扑界面支持一次选择多个 FBX。每个 FBX 仍作为独立任务提交、排队、执行和交付；不同模型不会在本地或远端合并，单个任务失败也不应阻塞同批其他任务。

## 2. 本地行为

- 一次最多选择 20 个 `.fbx` 文件。
- 按文件名、文件大小和最后修改时间去重。
- 每个 FBX 独立调用现有拓扑接口。
- 使用 `Promise.allSettled` 并行提交，允许部分成功、部分失败。
- 每个子任务独立轮询、订阅事件、取消和下载。
- 页面将多个子任务聚合为一个批次进度。
- 历史记录按批次显示为一条记录，但保留全部子任务和全部交付文件。

## 3. 请求协议

本地没有新增“多模型批量接口”，仍然对每个模型独立调用：

```http
POST /api/v1/assets/retopology/process
Content-Type: multipart/form-data
Idempotency-Key: <每个子任务唯一值>
X-Request-ID: <每个请求唯一 UUID>
```

单次请求的 multipart 内容保持不变：

| 字段 | 内容 |
| --- | --- |
| `project` | 单个 FBX 文件 |
| `metadata` | JSON 字符串 |
| `reference_images` | 可选参考图，可重复 |

示例 metadata：

```json
{
  "api_version": "6.0",
  "external_asset_id": "<每个子任务唯一 ID>",
  "options": {
    "algorithm": "agent",
    "budget_mode": "automatic",
    "topology_style": "mixed_game_ready",
    "preserve_source": true,
    "preserve_sharp_edges": true,
    "preserve_boundaries": true,
    "delivery_profile": "next_gen_game_prop"
  },
  "reference_views": [],
  "user_request": "保留主要轮廓、开口、支撑关系与关键负空间。"
}
```

## 4. 子任务标识

本地先生成批次 ID：

```text
li3d:<首个文件名>:retopology:v6:<UUID>
```

每个子任务再生成独立标识：

```text
<batchId>:<从 1 开始的序号>:<当前文件名>
```

处理规则：

- `external_asset_id` 与 `Idempotency-Key` 使用相同的子任务标识。
- 含非 ASCII 字符的标识会转换为稳定的 ASCII 哈希。
- 上传到远端的文件名会转换为 ASCII 安全名称。
- 每个子任务的 `X-Request-ID` 独立生成。

## 5. 远端响应约定

每个子任务提交成功时，远端应返回 HTTP `202`：

```json
{
  "job_id": "...",
  "job_type": "RETOPOLOGY_PROCESS_V2",
  "status": "QUEUED",
  "status_url": "...",
  "events_url": "...",
  "cancel_url": "..."
}
```

本地会校验：

- HTTP 状态码必须为 `202`。
- `job_id` 必须存在。
- 初始状态必须为 `QUEUED`。
- `job_type` 必须为 `RETOPOLOGY_PROCESS_V2`。
- `status_url`、`events_url`、`cancel_url` 必须存在。

## 6. 本地批次头

浏览器到本地后端增加以下请求头：

```text
X-LI3D-History-Batch-ID
X-LI3D-History-Batch-Index
X-LI3D-History-Batch-Size
X-LI3D-History-Source-Name
X-LI3D-History-Metadata
```

这些头只用于本地历史记录、批次聚合和显示。它们由本地后端消费，不会转发给远端资产服务，因此远端不需要新增批次头处理逻辑。

## 7. 远端需要支持或确认

1. 允许同一用户在短时间内并行提交多个拓扑任务。
2. 每个请求只处理一个 FBX，不合并不同模型。
3. 每个任务独立排队、执行、取消和交付。
4. 单个任务失败不能取消或污染同批其他任务。
5. 确认 `external_asset_id` 和 `Idempotency-Key` 的字符集及最大长度。
6. 返回 `422` 时提供具体字段、限制和校验原因。
7. 保证重复的 `Idempotency-Key` 返回同一任务，而不同子任务 ID 不会互相冲突。

## 8. 当前 422 问题的重点排查项

当前曾出现以下组合：

- 一个子任务在提交阶段收到 `422 ASSET_PROTOCOL_INVALID`。
- 另一个子任务成功创建，但随后在远端 Blender 执行阶段失败。

这说明本地后端已成功连接并转发请求，`422` 来自远端提交校验。

优先检查子任务 ID 长度：ASCII 文件名生成的完整子任务 ID 可能达到约 140 个字符；包含中文的标识会被哈希为较短的 ASCII ID。如果远端限制为 128 字符，可能出现 ASCII 文件被拒绝、中文文件反而成功进入队列的现象。

建议远端明确返回类似信息：

```json
{
  "error": {
    "code": "ASSET_PROTOCOL_INVALID",
    "summary": "external_asset_id exceeds 128 characters",
    "field": "external_asset_id",
    "maximum_length": 128
  },
  "request_id": "..."
}
```

## 9. 本地相关文件

| 文件 | 改动 |
| --- | --- |
| `apps/web/src/routes/AssetProcessingPage.tsx` | 多文件选择、独立提交、批次状态聚合和部分失败隔离 |
| `apps/web/src/services/assetProcessingApiClient.ts` | 批次历史头、子任务请求和交付文件来源任务定位 |
| `apps/server/src/routes/assetProcessing.ts` | 读取并登记批次历史信息 |
| `apps/server/src/routes/history.ts` | 将同一批次的子任务合并为一条历史记录 |
| `apps/server/src/services/assetJobOwnership.ts` | 持久化批次 ID、序号和批次大小 |
| `apps/server/src/routes/httpUtils.ts` | 放行新增的本地批次 CORS 请求头 |

## 10. 验收建议

使用 3 个 FBX 验证：

1. 三个请求分别返回不同 `job_id`。
2. 三个任务可同时处于 `QUEUED/RUNNING`。
3. 人为让其中一个失败，另外两个仍能完成。
4. 成功任务分别返回自己的 BLEND 和 FBX。
5. 重试单个子任务不会创建重复任务。
6. 长 ASCII 文件名、中文文件名和短文件名均能提交。
7. 历史记录在本地显示为一条批次记录，并包含全部成功交付物。
