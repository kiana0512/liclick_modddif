# 2026-08-27 LI3D 贴图编辑器优化总结

> 状态：Verified
> Owner：Codex
> Reviewer：待双人复核
> 日期：2026-08-27
> 分支：main
> 同步基线：`origin/main@cf7ecec`
> 关联提交：`b9ca6db`、`e6aa7c8`、`a0ad0f6`、`59b63ce`、本次单视图投影提交
> 关联 ADR：`docs/decisions/ADR-2026-001-SINGLE-VIEW-PROJECTION-COMPOSITION.md`

## 1. 今日结果

今天围绕橡皮蒙版、图层显隐、局部重绘显示所有权、GPT2/远端单视图对齐、返回图黑边、投影黑边以及单/多视图叠加割裂完成了一轮闭环优化。最终规则是：多视图继续使用 Top-3 质量混合；单视图核心保持有序优先覆盖；只有在同一对象已有可见多视图或 UV 底层时，单视图轮廓才使用编辑器生成的距离场 Alpha 平滑接回底层。

| 序号 | 用户现象 | 根因 | 最终处理 |
|---:|---|---|---|
| 1 | 局部重绘在有序图层栈下重复投影到底面 | renderer GPU overlay 与 ordered projected stack 同时拥有显示权 | 创建、复用、重绑和 pointer-down 四条路径统一检查 ordered-stack ownership，任一时刻只允许一个表示可见 |
| 2 | 投影层擦除后，开关预览、切层或进入局部重绘，蒙版消失 | 临时 live mask 卸载后，`generationId + depth` 去重规则错误跳过了已经变为 UV keep mask 的作者覆盖 | `maskSpace='uv'` 优先作为作者 coverage 参与常驻投影，capture-space mask 才允许被 depth 替代 |
| 3 | 连续点击图层眼睛，关闭后只闪一下又出现 | 晚到纹理/灯光 effect 从结构缓存重新发布旧 `visible=true` | `Layer.visible` 成为唯一权威；每次写 resident material uniform 时即时读取 LayerStore |
| 4 | 无法恢复橡皮擦前的原始投影 | 缺少只删除当前版本投影 keep mask 的安全入口 | 图层右键/三点菜单新增“清理蒙版”，执行前取消延迟补缝并销毁 live canvas；局部重绘、UV alpha、旧未知 mask 均 fail-closed |
| 5 | GPT2 与远端预览接近，但投影效果不一致、局部出现条纹或半透明 | 单视图投影未统一保留 capture silhouette；surface-locked depth 命中后又被扫描模型插值法线和 angle quality 二次衰减 | 两个提供方统一使用 capture camera/mask/linear-view depth；可靠 depth 命中对 coverage/quality 权威，实时、渐进预览和 GPU UV bake 同步 |
| 6 | 生成返回图透明轮廓有黑边 | mask 只改 Alpha，边界 RGB 仍混入深色背景 | 根据 capture mask 梯度从主体内部回拉 RGB，再保留连续抗锯齿 Alpha；显示裁切副本与投影源分离 |
| 7 | 投影到模型后轮廓仍有明显黑边 | 线性采样和 mipmap 在 mask 边界采到供应方深色背景 | 投影专用图片保持原 capture 尺寸，先去污染，再将清理 RGB 向 mask 外扩散 1.5%（8–48 px）；独立 capture mask 继续决定几何覆盖 |
| 8 | 新单视图压在旧多视图上时边界割裂 | 单视图是 ordered priority overlay，多视图是 quality blend；原单视图在 capture 边界内快速接近不透明 | 有可见底层时生成 inward distance field：轮廓 Alpha 0.12，约 3.5% 画幅宽度内平滑升至 1.0；核心仍由单视图接管，无底层时保持不透明 |

## 2. 架构与算法变化

### 2.1 UI 与模块

- UI：`UI-05` 生成面板、`UI-06` 中央视口、`UI-09` 图层面板、`UI-10` 底部工具条。
- 主模块：`M04` 生成编排、`M05` 图层领域、`M06` 实时投影、`M07` UV 合成、`M08` 局部重绘。
- 主要算法：`ALG-ERASE-001` v1.0.0、`ALG-PROJ-002` v3.0.0、`ALG-PROJ-003` v3.0.0、`ALG-PROJ-005` v2.0.0、`ALG-UV-004` v3.0.0。

### 2.2 当前叠加语义

```text
多视图 projected layers
  → Top-3 quality blend（保持原逻辑）
  → 得到稳定底层

新单视图 single-view-priority-v1
  ├─ 核心：source alpha=1，ordered priority 覆盖
  ├─ 轮廓：若已有可见底层，distance-field alpha 0.12→1.0
  └─ 几何边界：始终乘 capture mask + depth surface lock

实时视口 / progressive preview / GPU UV bake
  → 读取同一个 Layer.imageUrl Alpha、capture mask/depth 和 ignoreSourceAlpha 契约
```

普通多视图的 Top-3 候选、强质量权重、颜色一致性和 dominance 没有修改。单视图也没有改成普通质量层，因为那会削弱文字、Logo 和用户明确要求的新纹理；本次只把最容易暴露割裂的轮廓宽带交给旧结果托底。

### 2.3 关键参数

| 参数 | 值 | 说明 |
|---|---:|---|
| 距离场最低 Alpha | `0.12` | 轮廓处让底层占主导，同时保留少量单视图颜色连续性 |
| 距离场宽度 | `max(24,min(128,maxDim×0.035))` | 1024 图约 36 px，2048 图约 72 px，4K 上限 128 px |
| RGB 外扩距离 | `max(8,min(48,maxDim×0.015))` | 只保护纹理过滤采样，不改变 mask footprint |
| surface-lock visibility feather | `0.00→0.05` | 3×3 depth 邻域出现可信支持时快速恢复完整覆盖 |
| 单视图 minimum facing | `0`（有 depth/mask 时） | 避免扫描模型不稳定法线把捕获表面切成条纹 |

距离场与 RGB 外扩共用同一组全帧 queue/distance buffer。相比同时保留两套数组，4K 峰值额外内存减少约 100 MB。

## 3. 数据、兼容与失败策略

- Project Command v1、Revision CAS、ownership、verified asset 上传和资产类别均未改变。
- 没有新增 Layer Schema 字段。新投影源的 Alpha 存在 PNG 中，Layer 通过显式 `ignoreSourceAlpha=false` 选择消费；缺少显式 false 的旧单视图继续忽略供应方 Alpha。
- `projectionEdgeBlendMode=distance-field-v1` 只用于创建阶段声明“Alpha 是编辑器作者数据”，不会把供应方不可信 Alpha 当作覆盖。
- 没有可见 projected/UV 底层时，不生成距离场叠加权重，单视图仍完整显示。
- 边缘处理失败时回退到原始生成图，并保持 `ignoreSourceAlpha=true`，避免错误 Alpha 改变投影。
- 旧工程无需迁移或批量重写。已有单视图若要获得新过渡效果，需要重新生成或重新创建投影层。

## 4. 回退

1. 单视图叠加回退：停止传入 `edgeBlend`，不写 `distance-field-v1`，恢复 `ignoreSourceAlpha=true`。
2. 投影边缘回退：直接使用原始 generation result 作为 Layer.imageUrl；capture mask/depth 资产保持不变。
3. surface-lock 回退：恢复旧 angle/quality 衰减，但不得删除 mask、depth 或历史 Layer。
4. 橡皮/眼睛/清理蒙版回退：分别移除 UI 命令或恢复显示发布时序；已保存 keep mask 仍是合法资产。

所有回退均不需要删除用户项目、改写 Revision 或恢复已废弃的 Windows 本地组件。

## 5. 验证

| 验证项 | 结果 |
|---|---|
| `test:generation-preview-edge-decontamination` | 预览 Alpha、轮廓 RGB 去污染、投影 RGB 外扩与距离场梯度通过 |
| `test:single-view-priority` | GPT2/远端分流、capture mask、旧层迁移和 editor-authored Alpha 契约通过 |
| `test:projection-layers` | surface-lock、可见性、mask 恢复及实时/烘焙静态门禁通过 |
| `typecheck` | Web `tsc -b --noEmit` 通过 |
| `build` | contracts build、Web TypeScript 与 Vite production build 通过 |
| Chrome `127.0.0.1:4517` | 最新构建可加载真实项目，图层栈、生成面板和 3D 视口正常；60 FPS HUD 正常 |

## 6. 今日提交与远端同步

- `b9ca6db`：阻止局部重绘 renderer overlay 在 ordered stack 已接管时重复投影到底面。
- `e6aa7c8`：让投影橡皮 UV keep mask 在预览、切层和工具切换后继续生效。
- `a0ad0f6`：阻止关闭投影预览后被晚到材质 effect 异步恢复。
- `59b63ce`：图层右键/三点菜单新增安全“清理蒙版”。
- 本次提交：统一 GPT2/远端单视图投影、返回图与投影边缘去污染、surface-lock coverage/quality 及单/多视图距离场过渡。

同步方式为先获取 `origin/main@cf7ecec`，再将 3 个本地提交重放到最新远端，并合并远端新增的生成结果透明预览能力；没有使用 force push，也没有覆盖远端历史。

## 7. 结论

今天的优化已把“蒙版编辑状态”“图层显示状态”“局部重绘显示所有权”和“单视图投影覆盖”分别收敛到明确权威来源，并让面板显示图、投影源、实时预览和最终烘焙拥有清晰的数据边界。当前允许合入 `main`；后续重点是用更多 2K/4K 真实资产观察 0.12 与 3.5% 两个参数是否需要按物体屏占比进一步自适应。
