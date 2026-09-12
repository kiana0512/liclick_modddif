# CHG-20260912-UV-AGGREGATE-PREFIX

## v1.7.0 双缓冲前一精确前缀

Resident Top-K 原本就用两个全分辨率候选 target 做 ping-pong：完成第 N 层后，当前 target 是 N 层精确结果，另一个 target 仍是 N-1 层精确结果。现在为两个 slot 分别登记完整 layer key/source-size 前缀。关闭最高优先级可见投影层时直接选择 N-1 slot，避免重新加载来源、重新投影下面 N-1 层和重复累计；再次打开时从 N-1 只追加最后一层。

slot 租用时立即清空“已完成”身份，计算取消或失败后两个候选均不可复活；只有精确读回、既有 CPU/Worker 后处理、接缝、gutter、上传与调用方生命周期全部成功后才重新提交。中间层显隐、层序/内容/几何、renderer 或 context 改变仍走完整重算。该优化复用现有两个目标，不增加 256 MiB 光栅预算，也不创建第三份 Top-K 候选。

- 主模块：M07；协作：UI-06、M06、M09
- 调度算法：`PERF-UV-SOURCE-PREPARE-001` v1.7.0
- 输入/输出：输入仍为有序可见图层快照；输出仍为完整分辨率精确 RGBA、coverage 与 rendered-color mask。
- 持久化/迁移：不改变 Project/Layer/Revision/Command、ownership 或对象资产；缓存只在 renderer 生命周期内存在，无数据迁移。
- 回滚：删除 slot 状态登记和选择，恢复只允许最后一次完整前缀继续追加；现有工程与导出资产无需清理。

4K 冻结浏览器夹具继续覆盖 17 次 5→0→5 组合、A/B 往返、模型旋转、压缩恢复与 UV 岛边缘；所有重复状态像素差异为 0，页面错误为 0。低面数且逐层光栅已命中的夹具主要耗时仍在精确读回/接缝/gutter/上传，因此不能把该样本外推为所有图层组合的固定提速；收益边界是“关闭当前最高优先级投影层且其下层光栅无法全部驻留”的高面数/多层工程。

## v1.6.0 图层眼睛双状态 LRU

同一 renderer 和精确几何 scope 下，完成的 RGBA/coverage/rendered-color mask 聚合结果从单状态提升为原 256 MiB 硬预算内最多两个状态的 LRU。图层眼睛在 A/B 两个可见组合间往返时可以复用完整精确结果；第三组合淘汰最久未读状态，预算不足时仍先释放逐层光栅并按 LRU 收缩，绝不突破预算。

内容、层序、UV/index/position/normal、drawRange、模型层级、context loss 或 renderer 变化继续清空所有聚合状态；读取和存储仍做独立字节复制，取消或旧生命周期完成不能复活。GPU/CPU/Worker/shader、Top-K、接缝、补边、完整分辨率、QA、持久化和导出不变，无迁移；回滚将 `resolved` 恢复为单项即可。

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
