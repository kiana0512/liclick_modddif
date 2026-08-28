# 02 API 与账号、数据契约

## 1. 通用约束

- 对外路径以部署公共前缀 `/li3d` 为准，源码路由表内部使用 `/api/...`。
- 除 health、ready、release 和明确公开的服务状态外，业务 API 必须验证 Li3D Session。
- 所有项目、资产、Job、历史和下载都必须用稳定 `user.id` 做 ownership 查询；前端过滤不是安全隔离。
- 项目写入携带 `expectedRevisionId`；旧 revision 或旧 `updatedAt` 返回 409，客户端只能重新读取最新项目并重放本次增量。
- 创建任务和 Command 使用幂等 ID；重试不能重复创建项目 Revision 或重复扣用计算资源。
- 下游服务地址、令牌、CA 和 Secret 只存在服务器环境，不返回浏览器。

## 2. 服务生命周期

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/health` | 进程存活及 starting/ready/draining 状态 |
| GET | `/api/ready` | 是否可接流量；非 ready 返回非 200 |
| GET | `/api/release` | Release ID、Git SHA、版本、协议版本和能力 |

发布、排障和前后端混合版本检测必须以 `/api/release` 为准，不能用 PID 或静态页面时间判断版本。

## 3. 身份与会话

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/auth/me` | 当前用户，未登录返回 401 |
| GET | `/api/auth/provider-status` | 当前真实登录方式和缺失配置 |
| GET | `/api/auth/feishu/start` | 创建真实 OAuth/IDaaS 登录 |
| GET | `/api/auth/feishu/callback` | 已登记的 OAuth 回调 |
| GET | `/api/auth/feishu/poll/:loginId` | 登录任务轮询 |
| POST | `/api/auth/logout` | 吊销会话并清 Cookie |

`dev-login` 只能在 `dev-mock` 模式存在；生产不得开启。历史 browser handoff 不得成为零组件网页登录的依赖。

## 4. 文件夹、项目和版本化写入

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/folders` | 列表、新建 |
| PATCH/DELETE | `/api/folders/:folderId` | 重命名、删除 |
| GET/POST | `/api/projects` | 账号项目列表、新建 |
| GET/PUT/PATCH/DELETE | `/api/projects/:projectId` | 读取、保存、重命名、删除 |
| POST | `/api/projects/:projectId/commands` | 版本化幂等 Command |
| POST | `/api/projects/:projectId/duplicate` | 复制项目 |
| POST | `/api/projects/:projectId/move` | 移动文件夹，带 revision |
| POST | `/api/projects/:projectId/export/package` | 创建服务器导出任务 |

保存逻辑必须保留：账号 ownership、`expectedRevisionId`、服务器 `updatedAt` 单调递增、409 冲突提示和增量重放。禁止把“最后写入者覆盖”改回客户端时间戳覆盖。

## 5. 对象资产

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/projects/:projectId/assets/intents` | 创建签名直传意图 |
| POST | `/api/projects/:projectId/assets/intents/:intentId/complete` | SHA/HEAD 校验并完成直传 |
| GET | `/api/projects/:projectId/assets/:assetId/content` | ownership 校验后 307 到签名下载 |
| GET | 同上加 `?resolve=1` | 返回下载 URL JSON |
| POST | `/api/projects/:projectId/assets` | 小文件代理/兼容上传，不是大文件默认路径 |

直传必须校验文件大小、MIME、SHA-256、项目归属、意图过期和幂等完成。浏览器上传成功后还要把资产引用写入最新项目 Revision。

## 6. UV 与自动拓扑

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/asset-processing/status` | 真实 Asset 服务容量/Worker 状态 |
| POST | `/api/asset-processing/uv/process` | 提交正式 UV |
| POST | `/api/asset-processing/retopology/process` | 提交正式拓扑 |
| GET | `/api/asset-processing/jobs/:jobId` | 查询任务，仅 owner |
| GET | `/api/asset-processing/jobs/:jobId/events` | 任务事件流 |
| POST | `/api/asset-processing/jobs/:jobId/cancel` | 取消任务 |
| GET | `/api/asset-processing/jobs/:jobId/artifacts/:artifactId` | 下载并校验产物 |

Li3D 在提交成功后登记 `jobId -> userId`，历史和产物下载都先验证 ownership。不能把上游 Worker 的任意 URL直接透传给其他用户。

## 7. Substance 烘焙

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/bake/status` | Substance 服务状态 |
| POST | `/api/bake/jobs` | multipart 提交高模、低模、可选 Cage/贴图和设置 |
| GET | `/api/bake/jobs/:jobId` | 任务状态，仅 owner |
| POST | `/api/bake/jobs/:jobId/cancel` | 取消 |
| GET | `/api/bake/jobs/:jobId/output/:channel` | 获取指定通道 PNG |
| GET/HEAD | `/api/bake/jobs/:jobId/archive` | 获取 ZIP 交付包 |
| POST | `/api/bake/roughness` | 从 Base Color 调真实服务生成 Roughness |

通道包括 Base Color、Normal、AO、Curvature、World Normal、Thickness、Position、Roughness、Metallic。具体可用通道由服务能力、输入素材和 UI 选择共同决定。

## 8. 生图与局部重绘

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/liclick/status` | 真实 Liclick 服务状态 |
| POST | `/api/liclick/generate-image` | 创建生图任务 |
| GET | `/api/liclick/generate-image?projectId=...` | 项目任务列表 |
| GET/DELETE | `/api/liclick/generate-image/:jobId` | 查询/取消任务 |
| POST | `/api/liclick/edit-image` | Liclick 图像编辑任务 |
| GET/DELETE | `/api/liclick/edit-image/:jobId` | 查询/取消 |
| GET | `/api/modelview/status` | ModelView 状态 |
| POST | `/api/modelview/inpaint` | ModelView 局部重绘 |

服务端持有上游凭据；浏览器 Session 用户与上游身份不匹配时必须拒绝。长任务不能绑定单个浏览器 HTTP 请求生命周期，页面超时后应从账号历史恢复。

## 9. 账号历史

`GET /api/history?module=bake|uv|retopology&limit=30` 返回当前账号的任务、参数、状态和可交付产物。限制最大 100 条。

旧 UV 历史传入烘焙的特殊兼容规则：Auto UV 不改变几何，因此经过服务器校验的 UV FBX 可同时作为高模快照和带 UV 低模；拓扑改变几何，禁止复用该规则。

## 10. 已退役与暂缓接口

- `/api/comfyui/status` 和 `/api/comfyui/*`：已退役，必须 404。
- `/api/photoshop/*`：PS/DCC 实时交互暂缓，不属于本轮核心验收，Cloud 产品不得依赖。
- `/api/local-settings`、`/api/performance/native-snapshot`：若仍保留兼容路由，不得读取 Windows 组件或作为 Cloud 功能门禁；后续应完成命名和边界审计。
- `localhost:4618`、本地账号桥接、本地工作区：禁止恢复。

接口实现真源位于 `apps/server/src/index.ts`、`apps/server/src/routes/*` 和 `packages/contracts`。修改 API 时必须同步更新本文件、contracts、回归测试与 Release Manifest 协议版本。

