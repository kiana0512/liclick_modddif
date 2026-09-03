# CHG-20260903-LOCAL-REPAINT-PARALLEL-PREPARE

- 日期：2026-09-03；主模块 UI-10 → M08 / ALG-LR-008 v2.4.0；关联 M06 / ALG-PROJ-006 v2.0.1。
- 用户明确要求解决持续转圈，并授权将准备与生图并行；本次跨模块仅补正式单层材质的蒙版绑定登记，属于同一交接问题。

## 证据

4517 的“割草机器人”真实页面点击按钮 3 后长期停留在读取结果；DOM 随后记录 `localRepaintResidentHandoff=pending`。检查发现 `createProjectedLayerMaterial` 的 bindings 缺少 maskUrl/maskMapUniform，但交接函数要求两者存在。单层材质即使显示正确也无法交接；超时返回 false 后来源准备直接 return，未发布失败。辅助线框 Mesh 同样不应参与正式背景材质全覆盖检查。

## 修改与对应路径

- GPU：单层直接蒙版和多层材质登记一致，继续检查 layerId、mask URL 和真实 sampler；辅助网格排除，实际模型各材质仍全部检查。未跳过背景所有权屏障。
- Shader：进入蒙版工具、恢复可编辑层或生图开始即在隔离场景编译同一个 exact overlay 程序，持有材质到 viewport 卸载，返图复用驱动程序缓存；不向工程添加预热图层。编译中的覆盖层不能提前冒充 ready。
- CPU/Worker：生图期间提前读取作者 mask 并计算同尺寸 falloff，复用现有不可变图片和尺寸缓存；结果颜色缩放与 falloff 并行。CPU 降级算法不变；未改变实时 1024 上限和原图分辨率。
- 会话/UI：交接失败进入 failed 并清除排队；覆盖层异步准备受现有 20 秒总预算保护，错误显示真实阶段。这是故障收尾，不以计时器伪造 ready。
- 持久化/UV/export：没有字段或公式变化，作者蒙版、原图、capture depth、Project Command 幂等、Revision CAS、ownership、verified assets、UV Worker 和导出消费的资产均保持原契约。

## 验证

- 用真实 createProjectedLayerMaterial 工厂构造单层材质，验证直接蒙版可立即交接、错误 mask URL 拒绝，以及辅助 Mesh 不阻止就绪。
- 4517 第一批修复加载后，真实项目按钮进入 apply，aria-busy=false，resident 等待为 0ms；冷加载覆盖层编译记录 192.6ms。该值只代表编译段，不代表首笔或整次生成耗时。
- 最终提前编译版本：真实项目恢复层场景在工具启用前完成编译（后台 929.7ms）；返图/恢复覆盖层绑定编译段为 0.5ms，resident 等待 0ms。按钮点击路径为 resident-gpu，首个响应帧 11.3ms，aria-busy=false 并进入 apply。该响应帧不等同于真实首笔采样/涂抹延迟；没有向用户工程画测试笔划。
- layer-retention、ordered-composition、performance-merge 三项回归、Web typecheck 和生产构建通过；定向 ESLint 无错误，10 项既有警告保留。

## 迁移与回退

无数据迁移或缓存格式升级。重新加载页面重建运行时材质登记。回退本次绑定字段、辅助网格判断、提前编译/并行任务和失败收尾即可；不删除或改写 Layer、Generation、蒙版或 Revision。
