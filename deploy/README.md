# LI3D Cloud 发布与 master 验证

维护范围：M15，部署契约 CLOUD-DEPLOYMENT v1.0.0。业务 ALG、Project Command v1、Revision CAS、ownership 和资产协议不变。

## 当前操作范围

master 执行完整功能和 Cloud 构建验证；打包输入变化时额外验证两镜像。
release 执行相同功能门禁并构建两镜像；只有最终提交包含 `[deploy]` 且全部验证成功后才更新生产集群。禁止强推或以旧正文覆盖现行维护标准。

## 流水线

- 所有分支保留 contracts、Cloud 边界、typecheck、web/server regression、lint 和 release build。
- 新增部署配置回归：校验 YAML、启动配置、镜像路径、迁移入口、分支规则与凭据排除。
- master/MR 只有 Docker、依赖清单、SQL 或部署配置变化时才运行 container:verify，并行构建 server、web 两个真实镜像目标，使用 --no-push，不写镜像仓库或集群。
- release 的 build:server/build:web 必须等待发布构建与全部 verify 门禁，避免未验证镜像更新 `release-latest`；deploy:k8s 再等待两镜像成功才执行。
- deploy:k8s 同时要求 release 分支和最终提交信息包含 [deploy]；生产部署串行执行。
- 两镜像和 db-push 初始化容器使用同一提交 SHA；apply 前已写入最终镜像标签，避免先启动旧标签。
- Runner、ACR 地址、namespace、域名、TLS、现有 PVC 名称及容量继承效率组配置。

## 镜像与服务

Docker/Kaniko 都使用根目录 .dockerignore，Dockerfile 专用副本与之保持一致。
禁止将 .env、密钥、用户 workspace、OAuth 缓存或本机 node_modules 放入构建上下文。

构建先安装完整七个工作区的冻结依赖，包含 @liclick/contracts；执行 build:release、
Cloud artifact 和包体报告。前后端使用相同 release ID、Git SHA、版本、构建时间及 cloud 模式。
后端保留 /app/apps/server 目录层级，打包生产依赖、SQL 与现有 PostgreSQL 迁移脚本；
Atlas SkillHub 2.9.1 从现有公司 npm registry 安装到服务端镜像，仅托管每用户授权。
不导入个人密钥，不启用共享测试账号，不恢复已退休安装器路由。

### Blender 导入预处理运行时

`BLENDER-SERVER-RUNTIME/1.0.0`：server 镜像自带官方 Blender 5.1.2 Linux x64，
Dockerfile 固定下载地址及 SHA-256，安装 Linux 动态库，并设置
`BLENDER_EXECUTABLE_PATH=/opt/blender/blender`。不依赖宿主机安装或旧 A100 tools 目录挂载；
镜像仅支持 amd64，其他架构会在构建时明确失败。生产 ConfigMap/Secret 不应覆盖此变量为旧宿主机路径。

在最终 server 阶段切换为 UID/GID 10001 后执行 `node deploy/verify-blender-runtime.mjs`，
加载实际编译产物里的 UV 修复脚本，验证 GLB 导入、合并顶点、智能 UV 展开、材质、导出回读，
以及破坏表面的输入必须被 QA 拒绝；临时测试文件始终清理。没有 GPU 或显示服务也须通过。
版本错误、动态库缺失、权限错误、超时或 QA 失败都阻止镜像发布，不能只用 `/api/health` 代替验收。

打包输入变化时 master `container:verify` 与每次 release `build:server` 自动执行此 Dockerfile 门禁，
无需增加 CI Secret、宿主机服务或 Kubernetes 挂载。首次构建需要访问 `download.blender.org`
（约 396 MB 安装包），后续复用独立下载层缓存；若 Runner 禁止外网，由效率组提供同 SHA-256 的内部制品源。
本地可在 server 编译后设置相同版本的 `BLENDER_EXECUTABLE_PATH` 运行该验收脚本。
此项仅补齐现有导入修复/减面的依赖，不替换 Asset V4 的生产 Auto UV/拓扑服务。
部署和回滚只切换镜像，不迁移数据库或重写既有模型；回退到缺少 Blender 的旧镜像会再次失去导入修复能力。

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
- QWEN3_VL_PLUS_API_KEY：可选，缺失时局部重绘自动分析功能不可用，不阻塞发布（见 QWEN_HANDOFF.md）。
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
