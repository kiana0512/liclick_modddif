# CI 依赖缓存写入策略

- 日期：2026-09-29；状态：本地配置回归通过，待远端流水线计时。
- 主模块 M15；契约 `CI-CACHE-POLICY/1.0.0`。无业务算法、Schema、Project Command/Revision、ownership、资产、输出分辨率或 QA 变化。
- 证据：GitLab `release` pipeline #639841 的 Server regression 已完成 29 项测试，随后仍归档 `.pnpm-store/` 的约 22,155 个文件。原 `default.cache` 未指定 policy，Node、Kaniko 与 kubectl job 均继承 pull-push 缓存策略，形成重复压缩、上传和无用下载。
- 改动：Node job 默认只拉取基于 `pnpm-lock.yaml` 的缓存；master 锁文件变化时仅 contracts job 写回；可用 `LI3D_REFRESH_PNPM_CACHE=true` 在手动流水线重新填充缓存。Kaniko 与 kubectl 显式 `cache: []`，保留独立 Docker layer cache。缓存不存在时仍通过 frozen-lockfile 安装依赖，失败仍阻断相应功能 job。
- 验证：`scripts/test-cloud-deployment.mjs` 检查解析后的策略、单写入条件和非 Node job 禁用缓存；最终提交执行 `verify:prepush`，再比较远端 job 的 Saving cache 阶段与总耗时。依据 [GitLab 官方 cache 语法](https://docs.gitlab.com/ci/yaml/#cachepolicy) 与 [缓存指南](https://docs.gitlab.com/ci/caching/)。
- 迁移/回滚：无数据迁移。回滚 `.gitlab-ci.yml` 的 policy、rules 和 `cache: []` 可恢复原缓存行为；不影响部署产物或项目数据。
