# 默认关闭的 Pipeline Trace 基础接入

主模块 M13，验收 M15；探针涉及 M01/M02/M03/M04/M10/M12/M14。状态 experimental、构建默认 disabled，OpenSpec apply 进行中。用户 2026-09-22 已授权 apply，[ADR](../../openspec/changes/archive/2026-09-28-add-generation-pipeline-tracing/adr.md) 登记整体 Major 方案；当前增量尚未改服务器持久化。无业务算法变更，诊断格式 PIPELINE-TRACE v1，旧 PERF-LAB-REPORT v2 不变。

## 已实现

新增代码集中于 contracts/tracing、engine/performance/tracing 和 Performance Lab 面板；既有文件仅接入模型加载、减面/UV、捕获通道、请求/解码、上传、任务和保存的探针。VITE_LICLICK_PIPELINE_TRACE_ENABLED 缺省 false，运行时默认无会话；贴图页点击“开始录制”才加载 recorder，停止后迟到回调不能重启。旧 manual 不变。

单文档有界内存，20,000 span 上限，超限明确计数并标 truncated；同步 scope 和异步 wall 分开，显式父上下文，queue→run 使用 link。静态名称与随机引用，不存任意 detail、提示词、路径、Cookie、原始业务标识或图片。开放事件停止时标 interrupted，导出不伪造完成 duration。

提供本地阶段表与 Chrome Trace JSON 导出，并发 Promise 分轨；报告目前始终 partial/truncated。GPU/内存/供应方内部数据明确 unavailable/opaque-provider。**尚未在实际 Perfetto 中验收，不宣称可视化任务完成。**

## 验证

- test:pipeline-trace 通过：缺省关闭、并发隔离、一次终态、异常保留、观察停顿不延长已结束阶段、有界丢弃、隐私/契约拒绝、非空业务入口的关闭构建裁剪。
- Engine Session、ProjectSaveCoordinator、model-import-progress、model-triangle-limits、capture-renderer-isolation、normal-capture-material、interaction-safe-service-results、generation-polling、generation-revision-conflict-recovery 通过。Normal 测试保留原材质/相机/分辨率、失败还原和并发编码断言，新增终态检查。
- contracts build、Web typecheck、相关 ESLint、Cloud/Repository boundary 通过。
- 默认关闭 Web 构建及原包体门禁通过：总 JS **3,269,451 / 3,269,800 bytes**；editor **498,987 / 499,624**；shell **261,347 / 265,000**。未提高预算；不是最终提交的 verify:prepush，未发布。
- 关闭产物未检出 PIPELINE-TRACE、recordingEpoch、opaque-provider、traceContext、traceQueue、generation.operation；无新增 recorder/panel chunk。
- 内置浏览器真实加载 Bicycle：**1,857,094 triangles，model.load 698.100 ms async wall**，录制前后 off。本机证据 `.codex-tmp/pipeline-trace-apply/`；这不是完整工作流、像素对照或稳定 P95 预算证据。
- 临时 Vite 启动扫描发现既有 uv-stack-orientation fixture 引用不存在导出，未改该无关文件；实际模型加载和正常生产构建通过。

## 六路审计

| 路径 | 本增量与证据 |
| --- | --- |
| CPU | scope/Promise 边界，不改算法参数；异常/返回和调度回归 |
| GPU | 四通道仅测调用 wall，不新增 GPU query；原提交参数/分辨率不变 |
| Worker | 未改消息、Transferable 或编码；跨线程追踪仍为缺口 |
| shader | 无 shader/颜色空间/矩阵修改；Normal 原数值断言通过 |
| persistence | 无业务 schema/资产/Command/CAS/Repository 修改，无新表或诊断上传；保存与边界回归 |
| export | 业务图像/模型导出不变；新诊断 JSON 的实际 Perfetto 验收待完成 |

## 缺项与回退

完整 Generation 树、导入内部拆分、参考图/回贴/合成/材质/恢复探针，Node/Worker 上下文、校准、持久化、生命周期/续接/TTL、CPU/GPU/内存采样、30 分钟稳定性等仍未完成。外部计算服务源码路径待提供，该依赖不豁免本地工作。详见[实施矩阵](../../openspec/changes/archive/2026-09-28-add-generation-pipeline-tracing/implementation-status.md)。

无业务迁移。停止录制或保持构建门关闭即可停用；当前本地录制未上传，刷新丢失。回退不删除任何业务资产或历史记录。未改 4517 服务配置，未再次提交付费生图。
