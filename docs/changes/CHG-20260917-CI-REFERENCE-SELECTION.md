# 多视图选择回归与推送前检查修复

主模块 M15，协作 M04；RELEASE-PREPUSH/1.2.0。

## 原因与修改

master adfed025 的 GitLab pipeline 633432 / web-regression 3588671 在 test:remote-multiview-sequential 失败。本地完整 Web 回归复现相同错误：源码正则要求 setSelectedReferences 使用临时 multiviewReference.id，但光照处理必须保留旧多视图 ID，实际应选择 replacePairedReference 返回的持久化结果 ID。该正则未随 fe47e8e3 同步。

移除这一过时源码匹配，保留真实行为测试 test-reference-binding：执行 GeneratePanel 中实际持久化函数，检查新建六视图、已有绑定多视图光照、上传独立多视图、重复处理、页面重载、失败和过期结果。补充独立多视图的选择、保存及重复处理选择断言，禁止选中不存在的临时 ID。生产选择逻辑不变。

完整回归继续发现 test-single-view-texture-completion 的旧进度文案匹配也未覆盖光照分支。改为执行实际按钮处理函数，分别检查两种参考图在成功、失败、取消时的进度显示、输入透传、提示和锁清理；保留提交/生成/保存阶段顺序约束，并认可光照处理中分支文案。

此前 verify:prepush 仅执行 lint、build 和包体余量，未包含 Web/Server 回归、类型及契约检查。现在从 .gitlab-ci.yml 自动发现全部 verify 任务，顺序执行每项直接 script 和其 variables，支持已有 corepack pnpm / node 命令并拒绝未知语法，任一失败立即退出；全部通过后执行原 build script 与 256 字节余量检查。仍须检查最终提交对应的远端 CI；本地不模拟容器 Runner、网络或镜像构建。

## 验证

- 旧提交完整 Web 回归在同一断言失败，与 GitLab 日志一致。
- 修正后的选择行为与顺序生成测试，以及最终提交完整 verify:prepush 和远端 CI 状态，见执行结果。
- 未修改或放宽 QA、包体预算、CI 测试发现规则或失败门禁。

## 迁移与回滚

无运行时、数据库、Schema 或资产变更；GPU/CPU/Worker/shader、UV/投影/重绘/export、分辨率、Project Command 幂等、Revision CAS、ownership 和 verified assets 均不变。不需要重启 A100。回滚本次测试与脚本即可，但会恢复过时断言和发布检查遗漏。
