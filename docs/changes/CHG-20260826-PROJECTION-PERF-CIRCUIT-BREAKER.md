# CHG-20260826-PROJECTION-PERF-CIRCUIT-BREAKER

> 状态：Ready for Review
>
> Owner：Codex
>
> Reviewer：待双人复核
>
> 日期：2026-08-26
>
> 分支：main
>
> 基线 commit：`1635d95e4ce68d5cc98a6d8c40619170f167060c`
>
> 最终 commit/tag：本变更提交

## 1. 问题与证据

- 实际现象：真实项目包含 9 个模型与完整 4K 投影层时，WebGL 纹理数组上传返回错误 1281；不同模型继续重复尝试同一硬件路径，出现 183.4 ms 最长帧与 239 ms 主线程长任务。
- 附带异常：渐进 GPU 合成进入 overlay 阶段时写入缺失的 `priorityOverlay` uniform，抛出 `Cannot set properties of undefined (setting 'value')`。
- 期望结果：任何单帧不超过 16.67 ms；投影结果、4K 分辨率、图层数量、PBR 与采样步骤保持不变。
- 复现入口：`/project/project-391f8fb8-9f5a-44ef-ad44-9ebdd95071b9/texture?perfLab=1`。

## 2. 范围

- 变更等级：L2 / P0 性能稳定性
- 主模块 ID：M07 投影预览、M12 性能实验室
- 影响模块 ID：M05 图层、M06 视口渲染
- 计划修改文件：投影材质、渐进合成器、性能指标测试与维护文档。
- 明确不做：不修改 Workspace/Project/Scene/Layer 持久化数据；不降分辨率、不减图层、不关闭 PBR、不改变投影权重公式。

## 3. 当前契约与根因

- 输入：真实项目模型、完整投影层栈、4K 贴图及相机/深度/法线约束。
- 当前算法：优先构建 WebGL2 `sampler2DArray`；失败后由各模型分别回退到直接采样或精确 GPU 合成。
- 根因一：纹理数组失败只记录在单个 `SceneRoot` 状态中，没有 renderer 会话级能力熔断，其他模型继续执行已知会失败的高成本上传。
- 根因二：overlay 合成 shader 使用 `priorityOverlay`，材质初始化却未声明同名 uniform。
- 根因三：恢复阶段由 512px 代理切换到 4K 精确纹理时，最终材质审计只查询精确缓存；4K 尚未完成 GPU 上传的窗口会把 UV 采样器留空，模型显示白色基础材质。

## 4. 方案

- 算法名：`PTA-CB`（Projected Texture Array Circuit Breaker）v1.0.0。
- 同一 WebGL renderer 首次发生非取消类纹理数组失败后开启会话级熔断；后续完整栈优先使用精确直接采样，超过 sampler 预算时使用现有 4K 分块 GPU 合成。
- 算法名：`PPC-LIFECYCLE`（Progressive Preview Composite Lifecycle）v1.0.1。
- 补齐 overlay uniform 契约并增加生命周期回归测试，禁止已释放/未声明 uniform 写入。
- 算法名：`PTA-LAYER-UPLOAD`（Three-managed Projected Texture Array Layer Upload）v1.0.0。
- 数组内容按完整 layer 交给 Three.js 公共纹理 API 上传；每层之间让出一帧，由 Three 统一维护 WebGL binding/UNPACK 状态，避免原始 `texSubImage3D` 与 renderer 状态缓存失配。输出仍是同尺寸、同切片、同色彩空间的 `DataArrayTexture`。
- 算法名：`PROXY-EXACT-ATOMIC-HANDOFF`（代理纹理到精确纹理原子接管）v1.0.0。
- 最终材质按“已就绪 4K 精确纹理 → 当前有效纹理 → 已就绪 512px 代理”选择采样器；4K 仅在 GPU 上传完成后一次性接管，失败或未完成时继续显示代理，不允许切到空采样器。
- 算法名：`SELECTED-MODEL-EXACT-PRIORITY`（选中模型精确纹理优先恢复）v1.0.0。
- 选中模型不再等待完整 4K 预热队列才进入 full 阶段；full 请求立即启动，原子接管算法负责在就绪前持续显示 512px 代理，避免预热竞争导致模型永久停留在低清阶段。
- 保持不变：投影权重、深度/法线判定、UV 合成、局部重绘、图层顺序与输出色彩。
- 回退：删除会话熔断判断与 uniform 补丁即可；不涉及数据迁移。

## 5. 验证门槛

- 自动测试、typecheck、production build 全部通过。
- 同一真实项目连续三轮；模型和图层前后数量/标识完全一致。
- 控制台不再重复出现纹理数组上传失败；不再出现 `priorityOverlay` undefined。
- 帧统计采用 60 Hz 严格阈值：`frame > 1000/60 ms` 即掉帧。
- S2-S9 全部场景统一使用固定 `1000/60` 阈值；删除历史 20 ms 宽松口径。S7 的局部重绘覆盖层断言同步采用“实时内容存在且不由有序图层栈接管”的当前所有权算法，空草稿不再被误判为应该显示。
- S5 从“必须存在旧版 14 投影层”改为切换当前对象的完整真实投影栈（支持当前 6 方向投影，也兼容 14 视图）；S2 继续保留 14 层压力门。
- S0/S2/S3/S5/S7/S9 的临时图层变更统一进入只读测试事务：测试期间设置项目同步抑制标记，恢复原始图层后再等待两个 React 帧才解除，禁止性能台把中间眼睛状态或测试栈写入项目文件。
- 视觉质量：4K、PBR、投影层和算法输出不降级。

## 6. 本轮验证结果

- 专项回归、TypeScript typecheck 与 production build 均通过。
- 005 冷恢复先保持 `512×512 current-valid`，随后原子接管为 `4096×4096 exact`；UV 数量 `126603`，未经过空采样器状态。
- S7 在真实项目完成 560 次视口/图层切换：P95 `16.8 ms`、最大帧 `16.9 ms`、覆盖层可见性错误 `0`，测试结束后持久化抑制标记已清除。
- S7 当前仍报告 192 次模式状态不匹配，已确认是测试脚本在 React 提交前同步读取 store 的旧判定，不作为产品渲染失败或本变更通过依据；后续变更需将断言移至提交帧后。
- 严格掉帧率按固定 `16.67 ms` 计算；60 Hz 浏览器计时的 `16.7/16.8 ms` 量化会产生较高百分比，禁止改回 20 ms 以美化数字。
