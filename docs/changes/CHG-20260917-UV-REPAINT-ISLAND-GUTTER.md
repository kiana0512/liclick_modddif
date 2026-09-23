# 实时局部重绘 UV 岛边缘留边

- UI-06/UI-10 → 主模块 M08；`ALG-LR-UV-PAINT` v1.2.0，`UV_REPAINT_VERSION=5`。
- 名称：UV repaint island gutter / UV 重绘岛外取样留边。状态：production 实现，本地验证；未推送或部署。
- 实施：Codex；用户原工程的新笔画视觉验收仍由维护者执行。

## 证据与边界

用户反馈车身局部重绘在刷上去时立即出现碎裂状细黑缝。原工程源图没有同样的碎裂线；原生 UV 结果在岛外为透明。上一轮 v2.1.14 的预乘 alpha 插值防止黑 RGB 污染，但不恢复 UV 岛边界之外缺少的 alpha。

新增真实 WebGL 复现：连续灰平面拆为两个不相邻 UV 岛，使用实际 UvRepaint 和生产 UV overlay shader。旧实现中心值 128、接缝值 120，暗化 8；这证明双线性覆盖下降会露出较暗底层。与切层后纹理 sampler 改变不同，本次在 live GPU 笔画内即可复现。

## 实现

颜色绘制会话按相同 UV、分辨率与 WebGL 像素中心规则准备严格 core R8 蒙版。每笔完成原始覆盖后，只在 core 外的一个 texel 邻域复制最近 core texel 的完整 RGBA，满足 level-0 双线性采样足迹；同距按固定扫描顺序。donor 选择不依赖 alpha，透明或羽化 donor 原样复制。core 内像素不修改，不自动补洞、不寻找更不透明 donor、不跨接缝传播。完全没有 core 邻居的像素不变。

这不是放宽来源/作者 mask、深度、可见性或画笔阈值；原生成源、冻结相机、共享 UV 获胜规则与笔画像素计算不变。仅颜色会话执行，蒙版会话不做留边。

三角形对应的脏瓦片范围包含外侧一个 texel，保证 tile 边界外的留边与原笔画一起读回、撤销、重做、擦除。复用已有 stamp RGBA scratch，先完成所有脏瓦片的留边结果，再以不丢弃透明像素的复制发布，避免擦除残留和读写反馈。新增程序在 prepare 时预编译。

## 对应路径审计

- GPU/shader：M08 新增严格 UV core 栅格和岛外复制；M06 生产预乘采样公式不改。单位为输出 UV texel，坐标为原模型 UV0；颜色保持原 sRGB RGBA 存储和线性 GPU 取样。每会话增加一个 R8 纹理，2K 为 4 MiB、4K 为 16 MiB；每命中瓦片增加两次全屏 quad 提交，使用 scissor，不承诺性能提升。
- CPU：仍通过原异步脏瓦片读回发布完整 RGBA；没有新整图 CPU 像素循环。
- Worker：仍按原 Canvas source-over 合成同一已发布 RGBA；没有独立留边实现或另一套 donor 规则。
- 持久化/导出：live commit barrier、PNG、合并和 FBX/GLB 继续消费同一输出。Project Command 幂等、Revision CAS、ownership、verified assets 和 Schema 不变。
- 分辨率和 QA 不降低；普通投影、Resident UV 默认接缝策略不改。

## 验证

- 新 WebGL 用例先在旧代码失败（暗化 8），修复后 64/512/2048/4096 为 0；包含斜 UV、256 texel 瓦片交界、live/Canvas 逐字节一致、撤销/重做/擦除。核心灰色值仍为 128。
- 原 HiDPI 用例 DPR 1/1.25/1.5/2 各 140 次通过；原曲面/透视/旋转/遮挡、4K、来源 alpha、作者蒙版与生产 shader 组装通过。
- 原透明边缘用例硬边/0.7 羽化的 live GPU、Canvas、PNG、Worker 和 CPU 六路径暗化均为 0；24 组 shader 数值对照误差不超过 1。CPU/Worker UV core 与 WebGL 一致。
- 原生 UV 图层发布/删除保护/保存 barrier/失败和 UV 合并/Bake/export 计划回归通过。移除旧测试中对 scissor 调用点恰好两个的文本计数；实际多 pass 裁剪由 HiDPI 与跨 tile WebGL 像素回归覆盖。
- 类型检查、修改文件 ESLint、Web 生产构建通过；包体 108 chunks / 3,232,055 bytes，低于 3,256,500 上限并满足 256 字节余量要求。尚未在用户正在操作的原页面刷写，不替代原工程视觉验收。

## 迁移与回滚

不迁移或重写旧资产；历史 RGBA 继续可读。刷新进入新版后，新笔画会为本次命中瓦片写入留边，旧区域需再次应用笔画；不自动补写用户未编辑的区域。回滚本次 M08 core/gutter pass、脏瓦片扩展及算法版本即可，已保存 PNG 保留可读，不删除工程或资产。
