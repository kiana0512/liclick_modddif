# CHG-20260827：GitLab Prisma 安装网络容错

> 状态：Verified
> 模块：M15 质量门禁与发布
> 日期：2026-08-27

## 问题证据

GitLab Pipeline `620181` 的 build job `3513577` 在 `before_script` 阶段失败。`pnpm install --frozen-lockfile` 下载 `@prisma/engines` 时收到 `ECONNRESET`，测试与构建脚本尚未开始执行。日志同时显示共享缓存没有 URL，379 个包全部重新下载，原 `.pnpm-store/` 缓存路径未与实际 pnpm store 对齐。

## 修改

- `PNPM_STORE_DIR` 固定为 `$CI_PROJECT_DIR/.pnpm-store`，安装命令显式使用该路径。
- `XDG_CACHE_HOME` 固定为 `$CI_PROJECT_DIR/.cache`，GitLab 缓存 `.cache/prisma/`。
- 冻结 lockfile 安装最多执行 3 次；第一次失败后等待 5 秒，第二次失败后等待 10 秒，第三次仍失败则保持 fail-closed。
- 不使用 `--ignore-scripts`，不跳过 Prisma engine，不放宽 verify/build job。

## 验证

- 干净 WSL Linux、Node.js 22.23.2、pnpm 9.15.4：Contracts 9、Web 67、Server 9、typecheck、lint 均通过。
- 同环境发布构建、Cloud artifact、Web bundle budget 与 cloud deployment simulation 均通过。
- GitLab YAML 可解析；安装重试 shell 片段通过语法与失败/恢复路径测试。

## 迁移与回退

无生产数据、Prisma schema、Project Command、Revision、对象资产或浏览器运行时迁移。回退只需恢复原 GitLab `before_script` 与缓存路径；已有 cache 可安全失效，不得为回退删除用户项目或对象资产。
