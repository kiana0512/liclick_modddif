# Web 镜像复用已验证的 Cloud 构建产物

- 日期：2026-09-29；状态：本地配置回归通过，待远端真实镜像构建。
- 主模块 M15；契约 `CI-WEB-ARTIFACT-IMAGE/1.0.0`。无业务算法、Schema、Project Command/Revision、ownership、资产、输出分辨率或服务端 QA 语义变化。
- 证据：release pipeline #639841 在 build job 已通过正式 Web 构建、Cloud 产物检查及部署模拟后，`build:web` 又执行完整 `pnpm install`；其 `@prisma/engines` postinstall 从 10:10 至至少 10:20 无新日志。前端最终运行时只有 Nginx 和静态资源，不需要 Node/Prisma 或 Blender。
- 改动：CI Web 镜像改用 `deploy/Dockerfile.web` 封装 build job 的 `apps/web/dist` artifact。专用 Docker ignore 仅额外包含这一目录；其余仓库密钥、用户工作区和 node_modules 继续排除。release 及 master/MR Web 镜像验证都等待 build 和全部 verify，使用同一制品。Server 镜像继续从源码构建，保留 Blender 和 UV/GLB QA。原 `deploy/Dockerfile` 的 Web 目标保留给源码构建的本地容器验收。
- 验证：`scripts/test-cloud-deployment.mjs` 检查 artifact 依赖、两个 Web 镜像入口、专用 Dockerfile 无 Node/Prisma/Blender 及 ignore 规则；最终提交执行 `verify:prepush`，远端 master `container:verify` 真实构建 Server/Web 目标后确认。
- 迁移/回滚：无数据迁移。回滚 CI 中的 Web Dockerfile 路径和 artifact 依赖即可恢复原源码构建镜像；构建时间会增加。
