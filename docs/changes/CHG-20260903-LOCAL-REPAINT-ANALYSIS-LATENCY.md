# CHG-20260903-LOCAL-REPAINT-ANALYSIS-LATENCY

- 日期：2026-09-03；UI-05 → M04 / ALG-GEN-005 v1.10.0。
- 用户要求缩短“正在分析蒙版区域问题”阶段。原路径对同一四图串行调用 Qwen：一句诊断、然后英文转换；第二次重复支付网络、视觉输入和模型前向处理成本。

## 改动

空输入改为一次请求，在同一回复中生成中文 diagnosis 与对应英文 prompt。保留现有诊断校验（4–120 字单句、修复开头或无异常固定句）、最终正文校验、确定性蒙版保护、异常结束拒绝、65 秒超时。诊断和格式包装不进入生成提示词，不保存或回填用户输入。显式输入路径、四张输入图和 2048 处理尺寸均不变，不触发格式重试或静默降低 QA。自动分析策略缓存键升级为 single-request-diagnosis-to-klein-v3。

## 验证与限制

prompt-polish 集成测试通过：空输入/空白输入都只有一次 HTTP 请求且包含四图；正常诊断、无异常、非标准正文继续有效；畸形 JSON、非法诊断、空正文、截断/过滤、HTTP 失败仍拒绝。显式删除/无文字意图、输入框保持为空、范围补全和其余集成断言通过。未以真实远端计费请求测量秒数，不宣称时间减半或远端生成加速。

最终 Web 生产构建、Server TypeScript 编译与定向 lint 通过。通过原有 PowerShell 7 启动脚本重启 4517，健康接口和前端均 HTTP 200，前端 index 与最新构建一致；真实项目重新加载后 GPU-ready、提前编译 ready、resident 等待 0ms。

## 迁移与回退

仅改变请求编排和临时响应格式，不新增 Project/Generation/Layer/Capture 字段；Project Command、Revision CAS、ownership、verified assets、GPU/CPU/Worker/shader、UV/export 不变。旧提示词缓存首次重新分析，已有生成结果保留。回退服务编排及策略常量即可，无资产迁移。
