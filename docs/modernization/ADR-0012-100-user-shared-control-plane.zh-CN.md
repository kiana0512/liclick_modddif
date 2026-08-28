# ADR-0012：100 用户共享控制面与浏览器本机图形边界

## 状态

已实现，待生产环境容量验收。

## 决策

LI3D Cloud 采用三类相互独立的计算/存储平面：

- 浏览器计算平面：Three.js/React Three Fiber、WebGL2、WebGPU、Worker、WASM，调用每位用户自己设备的 CPU/GPU；普通交互禁止服务器补算。
- LI3D 控制平面：可横向扩展的无状态 Node.js App，负责 SSO、权限、项目命令、历史、签名 URL 和任务编排；权威元数据写入共享 PostgreSQL。
- 数据与生产任务平面：模型/贴图进入对象存储，Auto UV/拓扑/Bake/AIGC 进入独立 GPU/API 集群。

选择 `LICLICK_PROJECT_REPOSITORY=postgres` 时，项目、Revision、Command 回执、用户、会话、OAuth state/PKCE 事务、文件夹、用户设置、UV/拓扑任务历史和对象上传元数据全部进入共享 PostgreSQL；缺少数据库地址时启动失败，不允许静默回退为本地文件。

## 隔离规则

- 所有业务读取必须同时带 `user_id` 和资源 ID；知道其他账号的 Project/Job/Asset ID 也不能读取。
- 对象 key 为 `users/<sha256(userId)>/projects/<projectId>/...`，仅由服务端在验证登录与项目 ownership 后签发短期 URL。
- 浏览器切换账号通过新的服务端 Session Cookie；退出只撤销当前 token，不修改全局“当前用户”。
- OAuth state 在数据库使用原子 `UPDATE ... WHERE state_consumed=FALSE RETURNING` 消费，支持跨副本回调并拒绝重放。
- 应用节点磁盘和内存只允许缓存/在途状态，不是账号数据的权威源。

## 容量规则

- 视口帧和贴图交互不发送逐帧图形命令到 LI3D App，因此 100 用户不会形成 100 份服务器端 D3D/GPU 渲染。
- App 默认最多接收 256 个在途请求，过载返回 503 与 `Retry-After`；正式环境由负载均衡按 readiness 分流。
- 数据库池默认每副本最多 20 条连接；副本数必须服从 PostgreSQL 连接预算。
- 大文件走对象存储直传直下，生产 GPU 任务走独立集群队列，二者不能占用 App Server 本机 GPU。

## 验证

`pnpm --filter @liclick/server test:postgres-control-plane` 创建 100 个账号和 8 个应用 Repository 副本，覆盖项目、Session、OAuth 一次性 state、文件夹、任务、对象元数据、设置的跨副本读写、跨账号越权探测及数据库重启恢复。该测试是数据正确性门禁；真实 100 浏览器带宽和八小时长稳仍是生产部署门禁。
