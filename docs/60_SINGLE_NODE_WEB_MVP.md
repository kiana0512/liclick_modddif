# LI3D 单节点 Web MVP

这一版把现有 React 工作台与 Node API 组合成一个可长期运行的 Web 服务，同时保留贴图绘制本地组件。

## 运行边界

- `apps/web`：浏览器中的统一入口、Three.js、笔刷、图层与 UV 合成。
- `apps/server`：飞书/OIDC 会话、项目文件、远端烘焙、自动拓扑、自动展 UV 和局部重绘代理。
- 本地组件 `127.0.0.1:4618`：贴图绘制所需的本地文件和 DCC 连接，不包含 ComfyUI 或 AI 模型。
- Linux 主机：systemd 常驻 Node 服务，Nginx 提供统一入口并将 `/api`、`/workspace` 和安装包下载转发到 Node。

第一版继续使用服务器上的 Workspace 文件目录。PostgreSQL、对象存储和 Redis 属于多用户扩容阶段，不是当前单节点验收的前置条件。

## 本机验收

```powershell
corepack pnpm smoke:web
corepack pnpm smoke:auth
corepack pnpm smoke:local
```

`smoke:web` 会验证：

- 首页和 SPA 子路由由同一个 Node 服务返回。
- `/api` 永远返回 JSON，不会再把 `index.html` 当成登录结果。
- 贴图绘制本地组件安装包可完整下载，大小和 SHA-256 与清单一致。

## Linux 内网测试部署

在服务器仓库根目录执行：

```bash
sudo env \
  PUBLIC_URL=http://SERVER_IP:46777 \
  LICLICK_ALLOW_INSECURE_HTTP=1 \
  bash scripts/linux-web-start.sh
```

这会构建前后端、创建 systemd 服务、写入 Nginx 配置，并将持久数据保存在：

```text
/var/lib/liclick-3d-texture/workspace
```

## HTTPS 与飞书登录

正式登录必须使用一个服务器可访问的 HTTPS 地址，并在飞书/IDaaS 后台登记回调：

```text
https://YOUR_HOST/api/auth/feishu/callback
```

部署时通过服务器环境传入以下值，不要写入 Git：

```text
FEISHU_OAUTH_CLIENT_ID
FEISHU_OAUTH_CLIENT_SECRET
FEISHU_OAUTH_AUTHORIZE_URL
FEISHU_OAUTH_TOKEN_URL
FEISHU_OAUTH_USERINFO_URL
```

若企业 IDaaS 已登记 SP Service URL，也可以改用 `IDAAS_JWT_SSO_*` 配置。纯 Web 模式默认关闭本机 Atlas 登录；它不会要求用户电脑运行旧启动器。

## 远端能力配置

部署脚本会将以下配置写入服务器运行环境：

- `LICLICK_SUBSTANCE_BAKER_*`：远端 Substance 烘焙。
- `ASSET_SERVICE_*`：自动拓扑与自动展 UV。
- `LICLICK_MODELVIEW_INPAINT_*`：远端局部重绘/ComfyUI 接口。
- `COMFYUI_*`：仅在服务器仍直接连接某个 ComfyUI Worker 时使用。

API Key、OAuth Secret、Session Secret 和企业 CA 文件只放服务器，不进入浏览器构建产物。

## 当前验收范围

完成服务器部署与登录配置后，用户应当能够：

1. 直接打开统一网址。
2. 点击右上角完成飞书登录。
3. 使用远端烘焙、工具箱、自动拓扑、自动展 UV 和局部重绘。
4. 第一次进入贴图绘制时下载安装本地组件，以后由网页自动检测。
5. 刷新网页后继续访问服务器 Workspace 中的项目。
