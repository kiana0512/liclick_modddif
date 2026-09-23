# CHG-20260920 Resident UV 验证与解压并行

## 1. 范围与版本

- 主模块：M06/M07；协作：M09/M15。
- 算法：`UV-DISPLAY-DERIVED-CACHE` v1.4.0；`UV-PERSISTENT-MERGE-KEY` v1.1.0 的 key 字节与版本不变。
- 只优化 Resident UV 跨刷新恢复的等待编排，并等价压缩 Bake high 快照克隆代码；不改 UV 合成、QA、生产 Bake 服务或作者数据。

## 2. 根因与实现

4K Resident UV 已可从压缩 Cache Storage 精确恢复，但旧路径先串行完成账号范围、模型 position/normal/uv/index 和全部来源资产真实字节 SHA-256，得到持久 key 后才读取及解压约 64MiB RGBA/mask。真实工程分段显示：可信 key 约 944.6ms，磁盘恢复约 281.9ms，两项被直接相加。

Worker 现在在完成一次正式显示后，额外写入一个很小的 active pointer，记录持久 key 与轻量 scope。scope 包括工程、对象、分辨率、处理 purpose 及有序可见层的 id/contentRevision/opacity/order。下一次同 scope 恢复时，Worker 可在主线程计算完整持久 key 的同时读取、校验并解压候选；两者完成后只有候选记录的 64 位 key 与重新计算的完整 key 完全相等才可上传。scope 不同、指针缺失、压缩摘要错误、完整 key 不同或存储不可用都丢弃候选，并走原有按完整 key 的精确读取或全量重算。

为避免性能修复突破发布门禁，Bake high 的 `SceneObject` 纯数据快照由逐字段数组克隆改为浏览器原生 `structuredClone`，仍覆盖 material slots、UV sets、边界、归一化变换、用户变换、warnings 和主 transform；随后只覆盖 high asset 的 id/name/sourcePath 与显示选择状态。

## 3. 无死角边界

- GPU/shader：无改动；缓存命中后仍使用相同完整分辨率 RGBA/mask 上传，未降低分辨率或跳过 Top-K/质量路径。
- CPU/Worker：可信 key 与解压并行；最多只多一个与最终显示缓冲同尺寸的候选，active pointer 只有一条，压缩正文仍受 4 条/256MiB 双重预算约束。
- QA/安全：候选不能绕过真实来源字节、真实几何字节、账号和 SHA-256 校验；完整 key 未匹配前绝不发布。错误 fail-open 到精确重算，不阻断生成或导出。
- persistence/export：pointer 是同源 Cache Storage 内可丢弃派生元数据，不进入 Project；Command 幂等、Revision CAS、ownership、verified assets、作者层和显式导出不变。

## 4. 验证与测量

- `test:resident-uv-display` 覆盖 scope 命中、跨 scope 拒绝、压缩字节 SHA、完整 key 发布门禁、损坏拒绝、账号/来源变化失效、4K RGBA/mask 精确恢复与 presentation 后才持久化。
- 真实项目隔离 4K 六投影层三轮：修改前 `cacheLookupMs` 796.1/832.5/899.5ms（中位 832.5ms），修改后 593.4/630.0/681.2ms（中位 630.0ms，约 -24%）；整页回放中位约 1957→1722ms，均 `completeBakeMs=0`、错误 0。
- 4517 同工程连续三轮：`cacheLookupMs` 884.8/820.6/779.6ms，中位 820.6ms；对比修改前真实热轮 1195.5ms，约 -31%。Resident 阶段总耗时 973.1/901.7/904.0ms。
- build、typecheck、专项回归、Bake high snapshot smoke 与带 256B 总余量的 bundle gate 通过；发布产物 high snapshot 714292/715000，Editor 498855/499024，总 JS 3251496/3256500。

## 5. 迁移、风险与回滚

- 无 Project Schema、作者资产、缓存正文格式或像素迁移；旧缓存没有 pointer 时自动走原串行路径，首次成功显示后自然生成 pointer。
- 风险是同 scope 候选在来源字节被原位替换时会先解压后被完整 key 拒绝，造成一次额外后台工作，但不会显示旧像素；下一次正式结果会更新 pointer。
- 回滚删除 active pointer cache、`restore-latest` 消息及 `Promise.all` 候选分支即可；已有 pointer 可留作无害孤儿派生数据，也可由浏览器站点数据清理，不需要改工程或资产。
