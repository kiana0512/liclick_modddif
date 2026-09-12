# CHG-20260912-UV-SINGLE-OVERLAY

- 主模块：M07；协作：M06、M08、M09
- 算法：`PERF-UV-SOURCE-PREPARE-001` v1.8.0
- 问题：可见投影栈只剩一个连续局部重绘 literal overlay 时，旧路径仍单独生成质量栅格并执行 GPU 读回，但最终 overlay 合成只消费颜色与既有 mask；眼睛开关因此承担一次无效的完整分辨率质量通道成本。
- 修改：单个或多个连续 literal overlay 统一进入既有颜色直合成后缀。普通投影前缀仍完成原质量合成；overlay 继续按原图层顺序、Alpha 与 rendered-color mask 规则覆盖。
- GPU：单 overlay 不再提交未消费的质量附件及其读回；颜色、coverage 与 mask 仍以完整分辨率处理。CPU/Worker：沿用既有 overlay 合成，无公式变化。Shader：无采样、混合、颜色空间或阈值变化。持久化/导出：无变化。
- 正确性：不跳过接缝修补、gutter、QA 或 Resident 发布屏障，不降低 1K/2K/4K 输出；取消与异常仍拒绝发布半成品。
- 性能证据：4K 冻结浏览器夹具 17 个显隐状态及重复状态最终像素差为 0；5→4 层、仅剩一个 repaint overlay 的单次隔离样本为端到端 1122.4→892.5ms，GPU/读回 619.0→412.9ms，完整 bake 991.1→765.1ms。样本用于定位收益，不承诺所有网格、驱动或图层组合的固定比例。
- 迁移：无 Schema、Project Command、Revision CAS、ownership、verified asset 或历史工程迁移。
- 回滚：将 batched literal overlay 后缀门槛恢复为至少两个；工程数据和既有资产无需改写。
