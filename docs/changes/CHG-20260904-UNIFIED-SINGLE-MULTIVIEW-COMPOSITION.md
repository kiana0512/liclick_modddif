# CHG-20260904：统一普通单视图与多视图投影合成

## 目标

用一套普通投影质量合成取代单视图优先覆盖分支，解决单视图只是叠在旧纹理上、单视图之间按顺序硬覆盖的问题，同时保留局部重绘和显式 Overlay 的图层层级语义。

## 影响面登记

| 项目 | 内容 |
|---|---|
| UI | UI-05 图层；UI-06 贴图生成；UI-09 实时视窗 |
| 模块 | M04 生成；M05 图层；M06 投影；M07 UV/导出；M15 项目恢复 |
| 算法 | ALG-PROJ-004 v3；ALG-PROJ-005 v3；ALG-UV-004 v4 |
| 输入 | 单/多视图颜色图、capture mask、linear-view depth、相机矩阵、对象矩阵、图层参数 |
| 输出 | 实时投影颜色、UV 合成颜色、导出 BaseColor、规范化 Layer 数据 |
| 持久化 | 不再写入 `projectionCompositeMode`；旧字段加载时惰性剥离 |

## 实现

1. 普通单视图不再创建 `single-view-priority-v1`，而是以 capture mask/depth 适配后进入普通 Top-3 quality blend。
2. 删除 `priorityOverlay` 在 resident shader、progressive compositor、UV bake 和类型契约中的分支。
3. 删除单视图距离场 source Alpha；投影源保持完整不透明 RGB，几何权限交给 capture mask/depth。
4. 旧层加载时兼容读取并剥离旧标记，统一成标准 visibility。
5. 局部重绘和真正的 Overlay 保留 ordered source-over，不改变用户显式层级结果。

## 合成语义

- 普通单视图 + 普通单视图：按 coverage/quality 进入 Top-3，图层顺序不提供硬覆盖权。
- 普通单视图 + 多视图：同一质量池竞争，选择更可靠的视角贡献。
- 普通投影 + 局部重绘/显式 Overlay：先完成普通质量合成，再按图层顺序应用 Overlay。
- 分辨率、纹理数组预算、深度编码和导出尺寸均未降级。

## 迁移、风险与回退

- 迁移为加载时惰性迁移，不批量重写历史工程，不覆盖用户资产。
- 风险是依赖旧“最后一个单视图必定盖住前层”的项目外观会变化；这是本次统一语义的预期结果。
- 回退点为 ADR-2026-001 所述优先覆盖实现；回退必须整体恢复实时、渐进、UV 和导出路径，不能只恢复某一个 shader。

## 验证清单

- `test:single-view-priority`（保留旧命令名以兼容 CI，测试内容已改为统一合成契约）
- `test:generation-preview-edge-decontamination`
- `test:local-repaint-ordered-composition`
- `test:projection-performance-safety`
- `test:projection-layers`
- `test:uv-merge-layer-preview`
- `test:auto-merge-color-export`
- Web `typecheck`、`lint`、生产 `build`

## 相关决策

- 当前：`ADR-2026-002-UNIFIED-SINGLE-MULTIVIEW-COMPOSITION`
- 被替代：`ADR-2026-001-SINGLE-VIEW-PROJECTION-COMPOSITION`
