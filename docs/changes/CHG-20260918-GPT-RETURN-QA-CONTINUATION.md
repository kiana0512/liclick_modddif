# GPT 回图比例 QA 与多视图续跑

- 日期：2026-09-18
- 主模块：M04；协作模块：M03 / M06 / M08 / M12 / M13
- 算法：`GPT-CONTENT-FRAMING/2.2.1`、`GPT-MULTIVIEW-PAIR-SEQUENCE/1.4.1`、`GPT-SILHOUETTE-RETRY/1.0.2`

## 问题与根因

新 framing v2 的回图 QA 把“返回像素宽高不等于请求像素宽高”直接当成“比例异常”。生成服务返回原生尺寸与请求尺寸不同、但宽高比完全一致时，可以用同一整数比例恢复到冻结 Capture，旧判断却在轮廓 QA 之前误拒绝，导致本组缺一张并停止所有后续多视图组。

## 修复语义

- v1/v2 统一按几何宽高比校验；保留原有比例容差及 16px 网格取整容差。原生回图尺寸不拉伸、不裁切、不降采样，按其自身像素比例整数还原。真实比例偏差仍以 `GPT_RETURN_FRAME_RATIO_MISMATCH` fail-closed。
- 轮廓 QA、空 Alpha、安全画布上限和一次同冻结视角轮廓重试不放宽。终止的轮廓重试保留稳定错误码，历史结果继续标记为 terminal QA rejection。
- 每组完成后由算法层区分 `complete`、`continue-after-qa`、`stop`。仅当本组所有缺失视角都由已识别的比例/轮廓 QA 拒绝解释时，保留成功兄弟视角并继续下一组；网络、提交、保存、投影、resident、取消或未知错误仍停止。
- QA 拒绝数量写入现有可选 Generation metadata，并以 warning 汇总。只要至少一个视角成功回贴，批次结束仍执行一次内容补缝；全批均被 QA 拒绝时不空跑补缝。

## 对应面审计

- GPU / shader / UV / repaint / export：继续消费原生回图及冻结 camera、mask、depth；投影权重、采样和导出字节公式不变。
- CPU / Worker：只调整 O(1) 比例判定和组结果分类，不新增像素循环、Worker 消息或并发任务。
- 分辨率：客户端不修改请求分辨率，也不缩放提供方原生回图；返回原生尺寸由结果资产保留。该修复只移除“尺寸相等即比例正确”的错误等价关系，不关闭真实比例/轮廓 QA。
- 持久化：只复用 `Generation.metadata: Record<string, unknown>` 的 QA 拒绝标记；Project Command、Revision CAS、ownership、verified assets 与 Schema 不变，无迁移。

## 验证与回滚

- framing 回归覆盖同宽高比原生半尺寸可恢复、一个网格量子容差、真实偏差稳定错误码、轮廓变化/空图仍拒绝。
- GPT 真实面板适配器回归覆盖：一次轮廓漂移可恢复；连续两次轮廓失败仅多提交一次且继续后续四视角；比例 QA 不消耗轮廓重试预算并继续后续四视角；普通网络/投影失败仍停止。
- 回滚时恢复 v2 精确尺寸判定和组失败即停止策略；保留已生成、QA 拒绝和已回贴资产，不删除 Generation/Layer，不重提付费任务。
