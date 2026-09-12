# CHG-20260912-UV-AGGREGATE-PREFIX

- 主模块：M07；协作：M06、M09
- 调度算法：`PERF-UV-SOURCE-PREPARE-001` v1.5.0
- 目标：在不改变 UV 像素和质量门禁的前提下，减少普通图层追加时的重复 GPU 聚合。

## 实现与正确性边界

常驻 GPU Top-K 合成器记录已经完整完成的有序图层 key 与来源尺寸。当下一次全静态、非 overlay、非 live 的栈以前一结果为精确前缀时，租用原候选目标并从新尾层继续；租用开始即撤销“完成”身份，只有最终读回/转换成功才重新提交。取消、异常、非前缀、顺序/内容变化、renderer/scope/context 变化，以及任何 live/overlay 输入均完整清空并走原全量路径。

没有修改 shader、采样、量化、Top-K、舍入校正、分辨率、QA、CPU/Worker 对照、深灰斜线、保存或导出。缓存仅是 renderer-local 派生状态，不进入工程资产；无 Schema/资产迁移。

## 验证和性能证据

- 居民缓存单测覆盖前缀恢复、取消后不可复用及非前缀重置。
- 512 与 4096 真实 Chromium WebGL 冻结/当前核对照：RGBA SHA-256、coverage SHA-256、coveredPixels 全部相同，differences=0。
- 4096、6 层追加样本：命中 5 层聚合前缀；source prepare 29.3→16.3ms，端到端 635.1→606.0ms。设备噪声和读回占比存在，不能声明所有模型或组合均获得同等比例。

## 回滚

恢复每次 `resident.reset()` 并从第 0 层聚合即可。缓存非持久，无迁移或清理要求。
