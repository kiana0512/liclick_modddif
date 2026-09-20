# Bake 后台监控终态写入失败隔离

- 主模块：M10；协作：M13/M15。
- 契约：`BAKE-JOB-PERSISTENCE/1.0.1`，L1 异常边界修订。
- 状态：本地修复，未提交、推送或部署。

## 问题与修改

后台 `void monitorRemoteJob()` 在轮询/产物处理失败后尝试保存 failed 终态；若磁盘持续失败，错误日志的再次持久化也会拒绝，形成未处理 Promise rejection，可能终止整个控制面进程。

只在监控函数的终态错误保存处增加异常边界：内存继续保持 failed/finished，保留错误与完成时间，向 stderr 报告 job ID 和持久化错误，finally 释放监控登记。正常成功/失败保存仍等待原子 writer；不伪报终态已落盘，不重提远端任务，不新增重试计时器。

## 验证与限制

`test:bake-monitor-failure` 使用实际生产函数，在 `--unhandled-rejections=strict` 子进程注入轮询失败和产物失败叠加持续 ENOSPC。旧代码子进程退出 1；修复后存活、监控登记归零、失败可观测、下一任务成功，且同 Job 单飞保留。既有 `test:bake-artifact-plan` 继续验证原子替换失败保留上一完整 JSON 及后续写恢复。

磁盘写入失败时，重启只能读到最后成功快照，沿原远端 job ID 恢复查询；本次不承诺失败终态耐久性，也不掩盖存储故障。

## 审计、迁移与回滚

GPU/CPU/Worker/shader、Bake 像素/通道/分辨率/QA、产物验证、导出、Job JSON/Schema、Command 幂等、Revision CAS、ownership、verified assets 不变。无历史任务或资产迁移；回滚仅移除终态写入异常边界，会重新引入后台拒绝风险。不得删除历史 job.json 或产物。完整验证见系统规范当日记录。
