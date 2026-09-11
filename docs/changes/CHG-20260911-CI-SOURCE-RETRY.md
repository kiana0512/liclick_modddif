# CI 源码获取临时故障重试

- 主模块：M15；策略：`CI-SOURCE-RETRY/1`。
- 故障：[pipeline 630025 / build 3570491](https://gitlab.lilithgame.com/rd_center/ai_art/li3d/-/jobs/3570491)，提交 `87cff9d7`。Runner 16.2.1 在 Getting source 阶段报 `Could not resolve host: gitlab.lilithgame.com`；verify 五项成功，构建和包体门禁尚未执行。不能将本次失败归因为包体超限。
- 处理：全局 `GET_SOURCES_ATTEMPTS: '3'`，使用 Runner 自身的有限重试；取源码成功后脚本仍仅运行一次，连续失败仍阻止发布。已有 pnpm install 重试发生在 before_script，无法覆盖此次更早的故障。
- 依据：[GitLab Job stages attempts](https://docs.gitlab.com/ci/runners/configure_runners/#job-stages-attempts)。默认只尝试一次，该变量可全局配置。
- 边界：这是临时 DNS 故障的容错，不是修复集群 DNS；连续失败仍需检查 Runner Pod 的 DNS 与网络。未改部署权限、地址、凭据、镜像、输出分辨率或 QA/包体限额。
- GPU/CPU/Worker/shader/持久化/导出：均未修改。无算法像素变化、Schema/资产迁移。UV 优化候选单独保留，不混入本次修复。
- 验证：现有部署 YAML/边界测试及正式提交的 `pnpm verify:prepush`；远端是否恢复以新流水线结果为准。
- 回滚：仅移除 `GET_SOURCES_ATTEMPTS` 配置，恢复 Runner 默认一次尝试，无数据回滚。
