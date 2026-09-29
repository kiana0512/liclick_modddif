# CHG-20260928-LOCAL-REPAINT-SUBMITTED-MASK-BLEND

> 状态：Verified locally
> 日期：2026-09-28
> 分支：codex/onboarding-simplify
> 基线 commit：7a40f0670104f14ca33532e166617e8d71ce1a53

## 1. 问题与目标

局部重绘的手绘区域与当前视角未贴图区域先合成一个核，再统一外扩羽化；ModelView 返回图只做模型轮廓裁切，未按提交给 ComfyUI 的黑白灰蒙版与生成前原图叠加。用户要求手绘部分独立做羽化外扩、未贴图部分保留既有衔接，返图使用同一张提交蒙版合并。效果图/白模引导图须保持纯白硬边，不参与羽化。

## 2. 范围与契约

- 主模块：M08；影响 M03 捕获、M04 生成编排；UI-05/UI-06/UI-10；算法 `ALG-LR-012` 从 1.1.0 到 1.2.0，`ALG-LR-002` 从 3.1.0 到 3.2.0；生产状态。
- 输入：同机位 2048 RGBA 当前效果图、原始手绘 mask、visible-depth、远端结果及提交 RGB mask。尺寸单位为像素；RGB mask 取红通道作为线性混合权重，alpha 只限定 mask 有效性；不改变相机/对象矩阵、深度编码或颜色空间。
- Worker：手绘核与可见未贴图核分别沿用既有 24–64px@2K 外扩和 4–10px 羽化，取最大值并限制在可见模型像素；原核全白。提交图中的选区纯白硬边，`compositeEdgeRadius=0`。
- 返回：`result=original×(1-mask)+remote×mask`，之后执行原模型轮廓裁切。`submittedMaskUrl` 同时是 ComfyUI 请求和本地返图合成的权威蒙版；黑色保护、白色替换、灰色混合。若原图或 mask 缺失、尺寸不同则停止回贴。
- 输出与持久化：`resultComposition=submitted-mask-v1`、`resultUrl` 为合成后的 PNG、`rawResultUrl` 为远端原 PNG；沿用现有 Generation 字段和对象存储类型，不修改 Project Command、Revision CAS 或 ownership。旧 `direct-v1` 结果不重算。

## 3. 对应路径审计

| 路径 | 结论 |
| --- | --- |
| Worker/CPU | `localRepaintGenerationInput.worker.ts` 生成提交 mask；`modelSilhouetteClip.ts` 按同 mask CPU 合成并裁轮廓 |
| GPU/shader | 仍采样已保存的 result PNG、作者授权 mask 和 capture depth，无公式改动 |
| 投影/UV/export | 已合成 PNG 是普通 Generation source；回贴、UV raster、export 合成路径不改 |
| 持久化 | 沿用 `submittedMaskUrl`、`rawResultUrl`、`resultUrl` 与 `resultComposition` 字段；无 Schema 或旧资产迁移 |

## 4. 风险、回退与验证

2K 返回额外解码原图与 mask，并进行一次逐像素合成；输出分辨率不变。回退可恢复单核外扩和原始返图裁轮廓，已生成的合成 PNG 仍可作为普通 Generation source 读取，不删除项目数据。单/多视图贴图生成、GPT 局部重绘和旧历史结果保持原路径。

自动验证：`test-local-repaint-generation-input` 锁定手绘/缺口 mask 和引导图硬边；`test-model-silhouette-clip` 锁定黑/灰/白混合及尺寸失败；`test-local-repaint-result-composite` 锁定 Generation 原图/合成图元数据；Web typecheck。真实 ComfyUI 资产的视觉验收需在部署后完成。
