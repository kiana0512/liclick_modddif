# LI3D Cloud 发布与 master 验证

维护范围：M15，部署契约 CLOUD-DEPLOYMENT v1.0.0。业务 ALG、Project Command v1、Revision CAS、ownership 和资产协议不变。

## 当前操作范围

先在 master 完成 CI 验证。本次不推送 release、不触发正式部署、不修改集群或生产数据。
代码准备基于 master 5f880fd，合并 release cd30512 的部署历史。两条分支原来没有共同祖先；
合并保留双方历史，应用代码使用当前 master，逐项适配 release 的部署配置。禁止强推或以旧正文覆盖现行维护标准。

## 流水线

- 所有分支保留 contracts、Cloud 边界、typecheck、web/server regression、lint 和 release build。
- 新增部署配置回归：校验 YAML、启动配置、镜像路径、迁移入口、分支规则与凭据排除。
- master/MR 的 container:verify 并行构建 server、web 两个真实镜像目标，使用 --no-push，不写镜像仓库或集群。
- release 的 build:server/build:web 只有在上述门禁通过后才推送镜像。
- deploy:k8s 同时要求 release 分支和最终提交信息包含 [deploy]；生产部署串行执行。
- 两镜像和 db-push 初始化容器使用同一提交 SHA；apply 前已写入最终镜像标签，避免先启动旧标签。
- Runner、ACR 地址、namespace、域名、TLS、现有 PVC 名称及容量继承效率组配置。

## 镜像与服务

Docker/Kaniko 都使用根目录 .dockerignore，Dockerfile 专用副本与之保持一致。
禁止将 .env、密钥、用户 workspace、OAuth 缓存或本机 node_modules 放入构建上下文。

构建先安装完整七个工作区的冻结依赖，包含 @liclick/contracts；执行 build:release、
Cloud artifact 和既有包体门禁。前后端使用相同 release ID、Git SHA、版本、构建时间及 cloud 模式。
后端保留 /app/apps/server 目录层级，打包生产依赖、SQL 与现有 PostgreSQL 迁移脚本；
Atlas SkillHub 2.9.1 从现有公司 npm registry 安装到服务端镜像，仅托管每用户授权。
不导入个人密钥，不启用共享测试账号，不恢复已退休安装器路由。

现有 db-push 名称保留，但命令改为配置校验及 migrate-cloud-projects.mjs；
使用已有事务和 advisory lock 执行 SQL 001–003，不运行旧 SQLite Prisma db push。
启动缺少 PostgreSQL 或 HTTPS 对象存储配置会明确失败，不回退文件存储。

PVC 保留给 Atlas 受管目录、兼容历史文件和临时缓存。项目权威文档写 PostgreSQL，大资产写对象存储。
仍保持一个后端副本与 Recreate 策略，不能在未解决受管授权目录共享前直接扩容。
nginx 代理同源 /api、/workspace，保留可信 ingress 的 HTTPS scheme，允许同步 ModelView 等待 2700 秒。

## 生产环境配置（不影响 master CI）

效率组保管和配置 Qwen 实际密钥及注入，见 QWEN_HANDOFF.md。
发布脚本继续消费既有受保护变量：

- KUBE_CONFIG_B64；可选 KUBE_CONTEXT
- LI3D_SESSION_SECRET
- LI3D_FEISHU_CLIENT_ID
- LI3D_FEISHU_CLIENT_SECRET

Cloud 运行时另需以下受保护 CI/CD 变量，部署脚本会写入既有 li3d-server-secrets：

- LICLICK_CLOUD_DATABASE_URL：目标 PostgreSQL 数据库连接串。
- LICLICK_OBJECT_STORAGE_ENDPOINT：浏览器和服务端可访问的 HTTPS S3-compatible endpoint。
- LICLICK_OBJECT_STORAGE_BUCKET
- LICLICK_OBJECT_STORAGE_ACCESS_KEY_ID
- LICLICK_OBJECT_STORAGE_SECRET_ACCESS_KEY
- LICLICK_OBJECT_STORAGE_REGION：可选，默认 auto。
- LICLICK_OBJECT_STORAGE_SESSION_TOKEN：可选。
- LI3D_CLOUD_DATA_READY=true：仅在下述存量数据验收完成后配置。

对象存储须允许正式网站源的 PUT/HEAD/GET 和 checksum/CORS headers，保持 verified asset 校验；
服务端网络须可访问数据库、对象存储、公司 npm registry、IDaaS、千问及正式 GPU 服务。
这些地址、账号和现网状态尚未由本次本地修改验证，不能据 master CI 绿色认定正式环境已就绪。

## 存量数据、迁移与回滚

SQL 初始化只创建/升级表，不会把旧 PVC 的工程 JSON、SQLite 元数据或文件自动迁进新后端。
正式部署前必须备份原 PVC 和数据库，确认目标库包含原用户身份、工程、Revision、命令幂等回执与 ownership，
对象资产经长度、类型和 SHA-256 验证；旧项目保存、重开、历史与下载验收通过后才设置 LI3D_CLOUD_DATA_READY。
没有实际现网数据与服务连接信息时，不运行数据迁移，也不宣称迁移完成。本次保留原 PVC，禁止清空或重建。

回滚使用已验收且兼容相同 Cloud 数据协议的不可变镜像 SHA，同时切换 server/web/db-push。
保留新增表、对象资产、原 PVC 和历史，不运行 drop、--accept-data-loss 或以 SQLite 作为生产回退。
Qwen 的效率组补丁必须正常合并，不能用这里的旧变量片段覆盖。

## 可选容器验收

安装 Docker 的环境可用 deploy/docker-compose.yml 对接独立验收数据库和对象存储。
设置 RELEASE_ID、GIT_SHA（40 位）、RELEASE_VERSION、BUILD_TIME，
按 server.env.example 在未跟踪的 server.env 中填入验收凭据，并调整非秘密 URL 配置。
Compose 的 migrate 先成功，server 才启动；Web 只映射至 127.0.0.1:8080。
此验收不替代正式 OAuth、个人莉刻绑定、生成、工程保存与数据迁移验收。
