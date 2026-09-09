# CI 一次性 Web 回归不申请文件监听

主模块 M15；测试运行契约 CI-SSR-WATCH v1.0.1，无产品算法变化。

流水线 628192 / job 3560727 在 test:bake-base-color-selection 启动 Vite SSR 时，监听 vite.config.ts 抛 EMFILE。一次性测试不需要监听热更新；所有同型 middlewareMode 测试将 watch.ignored 设置为恒 true，覆盖配置文件及模块监听，保留 ssrLoadModule、测试断言和 finally close。直接 watch:null 在当前配置合并后仍触发监听，故未采用。

Node 22.23.2 将 fs.watch 替换成抛 EMFILE 的探针：修复后的原失败测试通过。无跳过测试、增加失败容忍或降低门禁。运行时、Shader/GPU/CPU/Worker、UV/导出、分辨率、数据及资产权限均不改。无迁移；回退移除测试 watch.ignored 即可，但会再次依赖 CI 文件监听额度。
