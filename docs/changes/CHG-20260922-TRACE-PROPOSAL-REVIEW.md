# Trace OpenSpec 评审修订

- 主模块 M13，协作 M15；补齐被观测模块 M05。
- 本次等级：文档 Patch；无算法变更，无生产 Schema/运行时变化。唯一准则文档 2.22.1 → 2.22.2，仅校正 collector 版本，保留同时进行的阅读路径修订。
- 方案入口：[add-generation-pipeline-tracing](../../openspec/changes/archive/2026-09-28-add-generation-pipeline-tracing/README.md)。本次是方案修订，不是功能交付。

## 核实与修订

1. Web 产品不能自行调用 CDP。采样改为页内 Self-Profiling 能力优先，CDP 仅外部开发/自动化 sidecar；实验性 API/Worker/策略支持都需探测。审查建议中的头名 `js-self-profiling` 不正确，现有实现用 `js-profiling`，新草案模式需按目标浏览器核实。仅诊断部署配置，未修改响应头。
2. 补齐 open/draining/closed、15 分钟无在途空闲、60 分钟硬上限/rollover、刷新/重开/登录区别、服务端首次接受起 7 天固定保留；生命周期结束不伪装算法结束。
3. 明确拟替代唯一准则 §13.1 首段和 [CHG-20260908](CHG-20260908-PERFORMANCE-LAB-PRODUCTION.md) 中 perfLab=1、主动开始、不后台采集的条款。新 pipeline-auto 缺省关闭，旧 manual 不变，获批启用后才替代指定启动条件。
4. 后续整体实现按 Major 的诊断持久化契约评审并要求 ADR/批准；不能用 sidecar 名称免除评审。既有自有服务链中 traceparent 不自动等于 Cloud 拓扑改变，但扩大信任域/出口需单独批准。
5. 新增 tracing 模块按职责集中、业务旧代码只加必要探针；不承诺单目录或零修改。沿用 VITE 环境变量静态裁剪及懒加载，不引入自定义宏系统。构建关闭、运行时关闭、迁移回退分开证明。
6. spec 中用例专属数值改为通用行为；数值性能预算写入长期 spec；Bicycle 数字保留在 design/tasks 并链接 [真实运行变更卡](CHG-20260922-REAL-WORKFLOW-AUTOMATION.md) 和本机原始报告。
7. UE TaskTrace 引用校正至声明 Created 的第 46 行；当前准则 collector 版本按源码修正 2.2.1，不改历史变更卡中的历史版本。

## 验证与回退

用户补充：性能分析默认关闭，优先在业务边界用动态 if 按需开启；构建能力门不自动启动录制。方案已补充停止清理、迟到事件隔离、关闭档与编译裁剪基线的开销对照，明确 off 无新增逐帧/定时采样或上传。仅文档修订，无算法或运行时变更。

OpenSpec strict 校验；检查 spec 要求数/任务数、旧自定义宏/Minor/CDP 产品依赖表述与相对链接。只修改文档，不运行付费生图，也不把文档校验说成实现验收。

回退仅恢复本次文档修改，不移动既有目录、不撤销用户已有改动，不涉及数据迁移或生产开关。OpenSpec 文件仍待正常 Git 提交；未跟踪状态不是已发布或已交付的证明。
