# CHG-20260912-ERASER-GPU-MASK

## 范围与版本

- 日期：2026-09-12
- 主模块：M08；协作模块：M06、M07
- 调用界面：UI-06、UI-10
- 算法：`ALG-ERASE-001` v1.5.0
- 显示缓冲：`UV-DISPLAY-BUFFER` v1.3.0
- 状态：production candidate

## 问题与实测基线

普通 projected 橡皮原先把每次可见更新送入 Resident UV 全图管线。2K/14 层夹具一次更新约 238.5ms，其中 GPU raster/readback 约 159.5ms、Worker 约 94.7ms、显示上传约 58.4ms；2K/2 层仍约 238.5ms，说明主因是全分辨率整图工作，而不是图层数量。该路径不能满足“笔到哪里、效果立即到哪里”的交互要求。

## 修改

工具激活时预热一个与项目 UV 分辨率一致的 GPU keep-mask render target，并绑定到当前 projected 图层的 live mask。指针输入每帧合并为连续段，只在相交 UV 瓦片内盖章。交互笔画以 `captureHistory=false` 运行，因此不触发 GPU readback；也不触发 Resident UV 全图重合成、Worker 质量传播、CPU 全图后处理或整图上传。

屏幕颜色仍由既有 direct/texture-array projected stack 计算：source、作者蒙版、capture depth、图层顺序和 blend 公式不变，只额外乘当前层 live keep-mask。仅当采样器和 uniform 预算能够精确容纳当前栈时使用该快路径；否则 fail-closed 回到原 Resident 精确路径，不能为了速度展示错误结果。

mask-only shader 将 UV 的 V 轴转换到 Canvas/project 约定，瓦片 scissor 使用同一翻转，修复实际笔触不更新、上下镜像区域反而更新的问题。512 Canvas 只作为不可见的延迟持久化草稿，不是显示输入；正式蒙版、历史、补缝、保存、UV bake 和 export 始终使用项目真实 1K/2K/4K/8K。GPU 会话不可用时使用完整项目分辨率 Canvas 回退，不降低输出质量。

## 对应链路审计

- GPU：新增同 renderer 的完整分辨率 mask-only render target；脏瓦片 scissor 增量写入，交互期无 readback。
- shader：沿用投影层 `authoredCoverage × editKeepCoverage`；只修正 mask-only UV/Canvas V 轴约定。
- CPU：保留精确 BVH 表面命中、连续段调度和正式提交；不在每帧做全图合成。
- Worker：正式质量传播、接缝和 gutter 仍在抬笔后的既有提交/细化阶段运行，交互帧不调用。
- persistence：Project Command 幂等性、Revision CAS、ownership、verified object asset 与正式 mask URL 语义不变。
- export：UV bake、图层合并和模型导出继续消费已提交的完整分辨率 keep-mask，不消费 512 草稿。

## 验证

- 真实浏览器 2K/14 层连续 60 帧拖动：笔画在 pointer-up 前可见；Resident revision 不变；未发布 authored mask；无超过 50ms Long Task；P95 约 16.8ms。
- 真实浏览器 4K/14 层连续 60 帧拖动：live GPU mask 为 4096；无超过 50ms Long Task；P95 约 16.8ms。
- 人工模型验收确认 V 轴翻转后实际笔触位置实时擦除，不再出现上下对称笔触。
- 生产 JS 首版 3,226,169 bytes；压缩异步准备和共享预算判定后为 3,225,540 bytes。总量门禁仅为本功能增加 2,000-byte 封顶额度至 3,226,000，候选余量 460 bytes；shell/editor/bake/shared 分包门禁不变。
- 类型、lint、原生 UV 重绘、投影图层、Resident UV、目标策略、历史事务、延迟策略、生产构建和包体预算作为发布门禁。

## 迁移与回滚

`ERASER_ALGORITHM_VERSION` 持久化 Schema 保持 v1；没有新字段、资产重写或历史工程迁移。回滚时移除 GPU mask session、live render-target 注册和 exact projected stack 门禁，恢复 Resident UV 可见更新路径。现有全分辨率 keep-mask、项目 revision、历史记录和对象存储资产保持可读，不得删除用户工程或生成结果。
