# CHG-20260826-ACTIVE-LAYER-ERASER

> 状态：Verified  
> Owner：Codex  
> Reviewer：待双人复核  
> 日期：2026-08-26  
> 分支：main  
> 基线 commit：`1635d95e4ce68d5cc98a6d8c40619170f167060c`  
> 最终 commit/tag：待提交

## 1. 问题与证据

- 实际现象：底层仍保留投影/UV/局部重绘橡皮实现，但 UI-10 入口与贴图快捷键被隐藏；旧门禁还禁止普通/合并 UV 使用橡皮。
- 期望结果：参考 Modddif，以当前活动图层为唯一目标，编辑该层覆盖并露出下层，不直接破坏最终合成。
- 证据：Modddif 文档区分 projected 与 UV mapped layer；paint/eraser 用于 UV mapped layer，projected layer 使用 Edit layer mask；快捷键表规定 Texture 模式 `E` 为 Eraser。

## 2. 范围

- 变更等级：Minor
- 主 UI/模块：`UI-09/UI-10`、`M05/M06/M07/M08/M09`
- 审计模块：`M11/M12`
- 算法 ID：`ALG-ERASE-001` v1.1.0
- 明确不做：不恢复 Windows 本地组件、localhost/4618、安装器或本地凭证；不改变投影矩阵、深度/法线阈值、Top-3、PBR 或生产 UV/Substance 服务边界。

## 3. 当前契约与根因

- 当前输入：活动 Layer、UV0 模型表面命中、画笔大小/羽化/压力、项目分辨率。
- 修改前状态：UI 隐藏；Viewport 只允许 projected/local-repaint，普通 UV 虽有 `uv-image` 路径也被入口门禁阻断；投影 keep mask 最终停留在 1K，延迟补缝最高 2K。
- 根因：UI、引擎入口与图层角色各自推断可擦性，旧性能代理分辨率被当成持久输出。
- 后续缺陷根因：普通生成投影层带有 `generationId + depthUrl` 时，实时预览会跳过原始 capture mask；橡皮提交后同一字段已变成 `maskSpace='uv'` 的作者 keep mask，但旧判断仍将其关闭。擦除当下只有临时 `liveEraserPreview` 生效，预览开关、切层或进入局部重绘卸载临时蒙版后，已擦除区域因此恢复。
- 眼睛连续点击缺陷根因：同步 LayerStore 订阅已正确关闭 resident material，因此画面先闪灭；但纹理上传或灯光变化触发的晚到 effect 随后使用结构缓存里冻结的旧 `visible=true` 再写 uniform，导致图标保持关闭而右前投影重新出现。
- 清理入口缺口：投影橡皮结果已有明确的 `maskSpace='uv' + eraserAlgorithmVersion=1` 所有权标记，但 UI-09 未提供只移除该编辑 keep mask 的命令，用户只能继续擦除或删除整层；直接复用通用“清空蒙版”又会误伤局部重绘作者 coverage 与旧捕获蒙版。

## 4. 方案

- 新增纯领域策略 `eraserTargetPolicy.ts`，统一返回 `uv-coverage`、`projected-mask`、`local-repaint-coverage`、`convert-content-aware` 或 `blocked`。
- UI-10 恢复橡皮、大小/羽化面板和 `E`；按钮、快捷键与 Viewport 指针引擎共同消费同一策略。
- 普通/合并 UV 通过 Straight-RGBA alpha 擦除；投影层保存 `maskSpace='uv'` 的 UV0 keep mask；局部重绘保留独立生成源和作者 coverage。
- 内容识别 underlay 不可原位编辑；图层右键创建普通 UV 副本，清除派生 role/generation 身份并选中新层，原 underlay 保持不变。
- `effectiveCoverage = authoredCoverage × editKeepCoverage`。GPU material、GPU/CPU UV bake、UV Worker、merge/export 使用现有 image/mask/alpha 合同，不新增并行合成语义。
- 实时投影 mask 策略先识别 `maskSpace='uv'` 并强制启用作者 keep mask，再对 projection-space capture mask 应用既有 depth 去重规则；临时 GPU 蒙版仅负责低延迟反馈，不再承担切换后的唯一可见状态。
- resident material 的纹理/灯光 effect 仍以结构签名作为重跑令牌，但每次发布 display uniform 前从 LayerStore 重新读取权威 `visible`、当前局部重绘接管层与 merged-UV 顺序边界；缓存只保留结构，不再拥有显示状态。
- UI-09 图层右键/三点菜单新增“清理蒙版”。策略只接受普通 projected、`maskSpace='uv'` 且 `eraserAlgorithmVersion=1` 的 keep mask；局部重绘、UV alpha、内容识别底图、capture mask 和旧未知 mask 均 fail-closed。执行时先取消该层延迟高分辨率补缝并销毁稳定 live canvas，再清除 mask 所有权字段、递增内容修订并请求重烘焙，防止晚到任务复活旧蒙版。
- 持久遮罩及延迟投影补缝跟随 1K/2K/4K/8K；交互代理保持 512/1024。失败显示错误并保留上一持久版本，不降低最终分辨率。
- Layer 可选字段 `eraserAlgorithmVersion=1`；旧工程惰性升级，Project Command v1、Revision CAS、ownership 与 verified layer asset 流程不变。

## 5. 风险与回退

- 主要风险：4K/8K 首次持久遮罩会增加浏览器内存与 pointer-up 提交成本；交互阶段仍使用低分辨率 GPU preview，昂贵补缝在 3 秒 idle 后执行。
- 回退步骤：移除 UI 按钮/快捷键与策略调用，恢复旧门禁；不删除任何 image/mask 资产。旧客户端会忽略 `eraserAlgorithmVersion`。
- 回退后数据兼容：兼容。projected UV mask、UV alpha 和局部重绘 mask 都是既有字段/资产；可编辑副本是普通 UV 图层。

## 6. 验证

| 验证项 | 修改后 | 结果 |
|---|---|---|
| 类型检查 | Web `tsc -b --noEmit` | Verified |
| 目标策略 | 五类目标、内容填补转换、快捷键、分辨率 | Verified |
| 投影/菜单回归 | projection layers + context menu | Verified |
| 临时预览卸载后 UV keep mask 接管 | projection layers：UV mask 优先于 generated depth/capture 去重 | Verified |
| 连续眼睛点击与晚到材质发布 | projection layers：延迟纹理/灯光 effect 重新读取 LayerStore 权威可见性 | Verified |
| UI-09 清理橡皮蒙版 | 仅当前版本普通投影 UV keep mask 可用；清理后恢复原始覆盖、菜单禁用，局部重绘/UV/旧 mask 不受影响 | Verified |
| GPU/CPU/Worker/export | UV mask/alpha 合同静态门禁与相关回归 | Verified |
| 浏览器 | 真实编辑器工具按钮、`E` 激活、`aria-pressed` 与控制台 | Verified；旧 4517 资产 URL 在隔离开发端口下仍会报既有 401，不影响本次入口/状态验证 |

执行命令：`pnpm --filter @liclick/web typecheck`、`test:eraser-target-policy`、`test:layer-context-menu-policy`、`test:projection-layers`、`pnpm docs:maintenance`。

2026-08-27 接管修复不改变 Layer/Project Schema、输出分辨率或 `ALG-ERASE-001` 的覆盖公式，旧工程无需迁移。回退只需恢复实时预览的 mask 选择顺序；已保存的 UV keep mask 仍为合法资产，不删除、不改写。

2026-08-27 眼睛竞态修复仅调整 resident material 的显示状态发布时序，不改变持久化字段、投影/UV 算法或资产。回退可恢复原 effect 输入；项目数据无需迁移。

2026-08-27 “清理蒙版”复用既有字段与 `ALG-ERASE-001` v1.0.0，不新增 Schema 或覆盖公式。回退可移除 UI-09 命令和运行时取消事件；已保存资产无需迁移，历史记录仍可恢复清理前 mask。

2026-08-27 v1.1.0 性能变更仅作用于普通 projected keep-mask：每帧只消费最新表面点并由 512 代理连续栅格补齐，低分辨率持久提交在 120ms 无输入 idle 后执行，高分辨率投影补缝仍为 3000ms idle。普通/合并 UV 保留密集 BVH/UV 重采样，局部重绘保留作者 coverage 专用路径。Project/Layer Schema、覆盖公式、持久分辨率和资产协议不变，旧工程无需迁移；回退恢复 projected 密集采样与即时提交即可。

## 7. 文档与评审

- [x] 已更新唯一准则中的当前实现/版本
- [x] 已更新 `CHANGELOG.md`
- [x] 已登记算法与 Layer 可选版本字段、迁移和回退
- [ ] Reviewer 已检查 diff 范围
- [ ] Reviewer 已检查真实输出

## 8. 结论

- 合并决定：自动门禁与真实浏览器视觉复核已完成，允许聚焦提交。
- 遗留问题：4K/8K 的真实长笔画帧时与显存数据继续纳入性能实验室，不允许通过降最终分辨率规避。
