# Li3D A100 真实服务器部署与运维交接（2026-08-23）

## 1. 文档目的

本文交接 `codex/modernization` 零组件云端候选版在 A100 测试机上的真实部署。它记录当前运行事实、服务边界、更新/回滚步骤、故障排查和上线前风险，不保存密码、Cookie、OAuth Secret、对象存储密钥或数据库口令。

## 2. 当前部署事实

| 项目 | 当前值 |
| --- | --- |
| Web/API 入口 | `http://10.3.2.59:44770/li3d/` |
| SSH 入口 | `10.3.2.59:44999`，运行用户 `aigc`；密码不入仓库 |
| 应用目录 | `/home/aigc/li3d-modernization-a100` |
| 持久运行目录 | `/home/aigc/li3d-modernization-a100/runtime` |
| 环境文件 | `/home/aigc/li3d-modernization-a100/runtime/app.env` |
| systemd 单元 | `/etc/systemd/system/li3d-modernization.service` |
| Node 可执行文件 | `/data/ai_art_comfyui/envs/comfyui-cu130/bin/node` |
| 应用日志 | `/home/aigc/li3d-modernization-a100/runtime/systemd-server.log` |
| 当前候选发布 | `modernization-4d8a8bd` / `4d8a8bd6c19c2f9620e624c6eec826f64709d5c8` / `0.1.13` |
| 监听 | `0.0.0.0:44770` |

2026-08-23 04:08 UTC 完成候选制品切换后的实机采集结果：

- `ActiveState=active`、`SubState=running`、`UnitFileState=enabled`；
- 新主进程 PID `396740`，服务为 `active/running/enabled`；
- 旧候选曾做主动 `SIGKILL` 自动恢复验证；本次通过受控 `SIGTERM` 停止、制品切换和 systemd 启动完成升级，日志显示 0 个活动请求被排空并正常退出；
- `GET /li3d/api/ready` 返回 `200` 和 `modernization-4d8a8bd`，`GET /li3d/api/release` 返回完整 Git SHA；
- 外部首页、health、release 均为 `200`，旧 `/li3d/api/comfyui/status` 为预期的 `404`；真实员工会话恢复为“任田”，浏览器控制台无本次发布产生的 warning/error；
- 根分区约 25 TB，已使用约 22 TB，利用率 **95%**，仅余约 1.4 TB。这是当前最高优先级运维风险，必须设置容量告警并由服务器管理员清理/扩容；不得由 Li3D 发布脚本擅自删除共享数据。

## 3. systemd 生命周期

当前服务以 `aigc` 用户运行，开机自动启动，异常退出 3 秒后自动重启：

```ini
[Unit]
Description=Li3D Modernization Cloud Workspace Server
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=simple
User=aigc
Group=aigc
WorkingDirectory=/home/aigc/li3d-modernization-a100
EnvironmentFile=/home/aigc/li3d-modernization-a100/runtime/app.env
Environment=NODE_ENV=production
ExecStart=/data/ai_art_comfyui/envs/comfyui-cu130/bin/node apps/server/dist/index.js
Restart=always
RestartSec=3
TimeoutStartSec=30
TimeoutStopSec=30
KillSignal=SIGTERM
LimitNOFILE=65535
StandardOutput=append:/home/aigc/li3d-modernization-a100/runtime/systemd-server.log
StandardError=append:/home/aigc/li3d-modernization-a100/runtime/systemd-server.log

[Install]
WantedBy=multi-user.target
```

常用命令：

```bash
sudo systemctl status li3d-modernization.service --no-pager --full
sudo systemctl restart li3d-modernization.service
sudo systemctl stop li3d-modernization.service
sudo systemctl start li3d-modernization.service
sudo systemctl enable li3d-modernization.service
sudo journalctl -u li3d-modernization.service -n 200 --no-pager
tail -f /home/aigc/li3d-modernization-a100/runtime/systemd-server.log
ss -ltnp | grep ':44770'
```

禁止再用 `nohup node ... &` 作为正式启动方式。2026-08-22 出现过一次 `ERR_CONNECTION_REFUSED`，根因正是手工进程脱离 SSH 后退出；改成 systemd 后已做强杀自动恢复和退出 SSH 后继续访问两项验证。

## 4. 环境变量与 Secret

`runtime/app.env` 当前包含以下配置组：

- Web：`SERVER_HOST`、`SERVER_PORT`、`LICLICK_PUBLIC_PATH`、`LICLICK_ALLOWED_ORIGINS`；
- 控制面：`LICLICK_PROJECT_REPOSITORY`、`LICLICK_CLOUD_DATABASE_URL`、`LICLICK_POSTGRES_POOL_MAX`；
- 身份：`AUTH_MODE`、`SESSION_SECRET`、Cookie 与飞书/Atlas 相关配置；
- 对象存储：endpoint、region、bucket、access key、secret key、签名 URL TTL；
- 计算服务：Asset V4、Substance Bake、ModelView、Liclick/AIGC 服务地址；
- 保护：`LICLICK_SERVER_MAX_IN_FLIGHT_REQUESTS`。

规则：

1. 环境文件权限应为 `0600`，所有者为运行用户或 root；
2. Secret 不进入 Git、CI 日志、systemd 单元和交接文档；
3. 更新代码时保留 `runtime/`，不得用发布包覆盖数据库、对象元数据、上传缓存和环境文件；
4. 旧 `COMFYUI_*` 变量即使仍留在环境文件中也不再被生产路由使用；新版本 `/api/comfyui/*` 必须返回 `404`。后续 Secret 轮换时可删除这些废弃变量。

## 5. 计算与数据边界

这台 A100 主机当前承载 Li3D Web/API 测试入口，但不代表所有用户视口都在 A100 上渲染：

- 每位用户的 3D 视口、相机、材质、局部贴图交互在各自浏览器 WebGL/WebGPU 上执行；Windows Chromium 通常由 ANGLE 转译到该用户设备的 D3D11/D3D12；
- 浏览器 Worker/WASM 承担本地 CPU 型合成、编码和部分内核；
- Li3D 服务保存账号会话、项目 revision、资产元数据和任务所有权；
- PostgreSQL/对象存储保存项目和大文件；
- 正式 UV、拓扑、Substance 烘焙、AIGC 生图和 ModelView 局部重绘调用独立服务 API；这些服务不能取得或伪造 Li3D 用户会话。

因此，100 个浏览器用户不会把 100 份逐帧渲染压到 Li3D Node 进程；服务器压力主要来自 API、数据库、对象传输、鉴权和任务调度。

## 6. 发布流程

### 6.1 发布前门禁

发布机或 CI 必须先完成：

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run check:cloud-boundary
corepack pnpm run check:project-repository-boundary
corepack pnpm run test:contracts
corepack pnpm run typecheck
corepack pnpm run lint
corepack pnpm --filter @liclick/web run test:regression
corepack pnpm --filter @liclick/server run test:regression
corepack pnpm run build:release
corepack pnpm run check:cloud-artifact
corepack pnpm run check:web-bundle-budget
corepack pnpm run simulate:cloud-deployment -- --skip-build
```

构建时必须注入 `LICLICK_RELEASE_ID`、`LICLICK_GIT_SHA`、`LICLICK_RELEASE_VERSION`、`LICLICK_BUILD_TIME` 及对应 `VITE_*`，并固定 `LICLICK_RUNTIME_MODE=cloud`。

### 6.2 上传与替换

当前 A100 目录是部署快照而不是 Git 工作区。推荐由 CI 生成只包含运行所需文件的制品，再通过受控通道上传；不要在服务器 `git pull` 或现场安装依赖。

更新顺序：

1. 记录当前 `/api/release` 和 Git SHA；
2. 备份当前代码制品，明确排除 `runtime/`；
3. 上传新 `apps/server/dist`、`apps/web/dist`、`packages/contracts/dist`、生产依赖清单和文档；
4. 校验制品 SHA-256；
5. `sudo systemctl restart li3d-modernization.service`；
6. 验证 readiness、release、登录、项目列表、静态资源、旧 ComfyUI 404；
7. 做新建项目、模型/参考图上传、保存刷新、新人引导、UV/拓扑/烘焙历史的浏览器冒烟。

长期应改为 `releases/<release-id>` + `current` 软链接的原子切换，保留最近 2～3 个制品。由于磁盘已达 95%，在容量治理完成前不得无限保留发布包。

## 7. 回滚

如果 readiness、登录、项目读取或静态资源任一失败：

1. 停止继续导入流量；
2. 切回上一份已验收制品，绝不回滚/覆盖 `runtime/` 数据；
3. 重启 systemd；
4. 核对 `/api/release` 已恢复到目标 SHA；
5. 验证项目读写和账号隔离，再恢复流量；
6. 保留失败制品、systemd 日志和请求关联 ID供复盘。

数据库 schema 变更必须使用向后兼容的 expand/migrate/contract 流程；如果新代码写入了旧版本无法读取的数据，不能只回滚二进制。

## 8. 健康检查与故障排查

```bash
curl -fsS http://127.0.0.1:44770/li3d/api/ready
curl -fsS http://127.0.0.1:44770/li3d/api/health
curl -fsS http://127.0.0.1:44770/li3d/api/release
curl -I http://127.0.0.1:44770/li3d/
curl -i http://127.0.0.1:44770/li3d/api/comfyui/status  # 必须是 404
```

| 现象 | 优先检查 |
| --- | --- |
| `ERR_CONNECTION_REFUSED` | `systemctl status`、`ss -ltnp`、systemd 日志、端口/防火墙 |
| 页面白屏 | `/api/release` 与前端 release 是否一致、静态 chunk 是否 404、浏览器控制台 |
| 登录循环 | OAuth 回调、Cookie Secure/SameSite、`SESSION_SECRET` 是否稳定、服务器时钟 |
| 项目互相可见 | 立即停服；检查稳定用户 ID、Repository ownership 条件和数据库查询，不允许前端过滤补救 |
| 上传失败 | 对象存储可达性、签名过期、大小限制、SHA-256、服务器代理回退 |
| 生成/UV/烘焙失败 | 独立服务状态、CA、队列、任务所有权和历史恢复；不能伪装成浏览器本地成功 |
| 磁盘超过 90% | 先告警和容量盘点；由管理员确认可清理目录，不执行不明范围递归删除 |

## 9. 上线前未完成项

- 正式 HTTPS 域名、飞书/莉刻生产回调和 Secure Cookie 验收；
- 生产 PostgreSQL 备份/PITR、对象存储生命周期和恢复演练；
- 网关级限流、上传配额、任务并发与熔断；
- 100 个真实测试账号的 30～60 分钟混合压测；
- Chrome/Edge/Firefox 与不同 GPU/驱动的兼容矩阵；
- 根分区 95% 的容量治理；
- 将当前直接目录替换升级为原子制品切换与自动回滚。

这些项目未完成前，A100 地址属于真实服务联调环境，不应宣称为正式生产发布。

## 10. UV 历史任务传入烘焙的版本并发规则

UV、拓扑等长任务完成时，服务器项目 revision 可能已经被资源直传、任务回写或另一个浏览器页面推进。历史面板的“传入烘焙”不得把任务开始时缓存的旧项目快照直接保存，否则服务器会以 HTTP 409 拒绝覆盖较新的项目数据。该拒绝是多人协作和账号数据安全门禁，禁止删除或降级。

2026-08-23 的修复采用以下契约：

1. 点击交接时重新读取该账号、该项目在服务器上的最新 revision；
2. 只把本次 UV 历史任务新增的 pipeline revision、模型资产路径和目标 Bake Set 合并到最新项目；
3. 保留最新项目中由其他请求写入的对象、资源清单、工作区及无关 pipeline revision；
4. 保存命令继续携带最新 `expectedRevisionId`；若并发窗口再次发生 409，最多重新读取并重放三次；
5. `updatedAt` 同样以服务器最新文档为基准单调递增，避免浏览器时钟落后或重试复用旧时间戳被第二层防覆盖门禁拒绝；
6. 非 409 错误直接上抛，三次仍冲突时明确提示用户，不伪造成功状态；
7. 保存成功后才写入当前项目状态并进入烘焙路由。

对应回归门禁覆盖最新 revision 读取、409 专项重试、pipeline 增量重放、资产清单并集和 Bake Set 定点合并。它验证的是“历史任务 → 最新项目 → 服务器资源 → 烘焙工作区 → 路由”的完整交接，不是单纯解除按钮禁用。
