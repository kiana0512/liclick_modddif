# 一次性回归的 Vite 配置合并与文件监听修复

- 主模块 M15，协作 M13/M08；测试基础设施修复，业务算法、ALG-PERF-SESSION-001 v1.0.4、ALG-PROJ-007 v2.1.9 与 Schema 均不变。
- 证据：master a9989dc 的流水线 628484，web-regression 作业 3562203，在 test:performance-lab-stress 阶段报 EMFILE，监听目标为 vite.config.ts。
- 原因：Vite 6.4.3 的 mergeConfigRecursively 忽略 null 覆盖值；加载项目配置后，内联 server.watch:null 不能可靠关闭监听。此前仅写 null 的修复不充分。
- 修复：性能台压力测试与重绘选区消费测试均使用 watch.ignored 函数忽略所有路径，保留真实项目配置、SSR 加载和原有全部断言；测试末尾新增 getWatched() 必须为空的断言，finally 仍关闭服务器。
- 验证：两个完整测试分别在 fs.watch 被替换为立即抛出 EMFILE 的环境下通过，原生文件监听调用数均为 0。性能台仍执行 100 次启停、100,000 次滚轮和 200,100 个 timeline 事件；重绘仍验证稀疏历史、朝向覆盖、擦除边界、原子恢复和生命周期。
- 不改生产 GPU/CPU/Worker/shader、纹理输出、分辨率、持久化、导出或部署条件，不放宽 CI 门禁。
- 回退：仅回退两处测试配置及新增断言即可，无资产或数据库迁移；回退会重新暴露受限 Runner 的监听耗尽风险。
