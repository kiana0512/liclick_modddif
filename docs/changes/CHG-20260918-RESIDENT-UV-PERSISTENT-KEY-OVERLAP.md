# CHG-20260918 Resident UV 派生键与恢复缓存稳定化

## 1. 范围与版本

- 主模块：M06/M07；协作：M09。
- 算法：`UV-PERSISTENT-MERGE-KEY` v1.1.0、`UV-DISPLAY-DERIVED-CACHE` v1.2.0。
- 优化 Resident UV 与显式投影转 UV 共用的持久派生键准备，并修复工程恢复期间 A/B/C 合法状态循环淘汰；不改合成像素、生产 Bake 服务或缓存身份。

## 2. 根因与实现

持久键必须摘要真实模型 position/normal/uv/index 字节和每个来源资产字节。来源资产此前已有最多 3 路并发，但几何属性仍逐项等待 SHA-256，且全部几何完成后才开始来源 fetch；4K 多视图工程因此把可独立的 CPU/crypto 与网络等待串行相加。

现在先冻结完全相同的几何字节 span 与目标记录，再用最多 2 路队列计算摘要；来源仍以最多 3 路读取和摘要。两条队列同时启动，最终在生成完全相同的 JSON 与 SHA-256 key 前汇合。共享 ArrayBuffer span 仍只摘要一次，来源 URL 仍去重，失败仍返回无缓存并走原始精确计算。

真实工程恢复还会依次呈现多个合法的内容识别底层组合。旧缓存固定保留 2 条：当恢复顺序为 A→B→C 时，下一次刷新从已淘汰的 A 开始，并在计算 A 时淘汰 B、计算 B 时淘汰 C，形成永久全量重算。现在磁盘窗口最多保留 4 条，同时以压缩后总字节 256MiB 为硬上限；当前实际显示状态和本次新写状态在裁剪时固定保留。旧条目没有压缩长度元数据时按完整预算计费并渐进淘汰，不读取其完整响应来做迁移。

## 3. 无死角边界

- GPU/shader：无改动；Resident 合成、Top-K、接缝、gutter 与完整分辨率不变。
- CPU/Worker：摘要最多 2 个几何副本和 3 个来源响应同时在途；压缩 Worker 的磁盘窗口最多 4 条且总压缩字节不超过 256MiB，无无界 `Promise.all`。
- QA：不跳过任何摘要或输入字段，缓存命中仍要求真实字节完全一致。
- persistence/export：`persistent-5` key 版本不变；Cache Storage 仅新增派生响应 `x-compressed-length` 元数据并自动兼容/淘汰旧条目，不涉及作者资产。Project Command/Revision CAS、ownership、verified assets 和导出路径不变。

## 4. 验证与测量

- `test:persistent-merge-preparation` 继续覆盖跨刷新相同字节命中、UV 字节失效、账号隔离、损坏拒绝、4K RGBA 精确恢复和有界流写入；新增断言峰值最多为 2 个几何 SHA + 3 个来源 SHA，且两队列确实重叠。
- `test:resident-uv-display` 覆盖当前状态固定、A/B/C 恢复窗口、第五条有界淘汰、F5 精确 RGBA/mask 恢复、账号/来源变化失效与损坏拒绝。
- 独立真实 4K 六投影层回放：冷首帧约 2722.5ms；相同状态 F5 通过压缩精确恢复，`completeBakeMs=0`、`underlayCompositeMs=0`，恢复阶段约 756ms、总回放约 1792ms。4517 真实工程修改前连续重载约 2342–2348ms 且 `not-found`；修复后连续三次为 987.0/909.4/924.5ms，全部 `completeBakeMs=0`、`underlayCompositeMs=0`，不再运行 GPU 投影、质量合成与 gutter。数值受设备与磁盘缓存影响，只作为此机器趋势，不作为跨设备时限保证。

## 5. 迁移、风险与回滚

- 无 Project Schema、键值、作者资产或像素迁移；旧派生缓存可读，缺少新长度头的条目按保守预算自然淘汰。
- 风险是弱设备上增加一份几何摘要在途副本及最多四条压缩缓存；并发和 256MiB 总预算均为硬界，错误继续 fail-open 到精确重算。
- 回滚摘要部分可删除 `runBounded` 和 geometry job 收集；缓存部分恢复两条固定裁剪并移除长度头。两者都不需要清作者资产或迁移工程，但恢复两条后真实 A/B/C 工程会再次循环 miss。
