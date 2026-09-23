# 新版 UV 局部重绘实际笔迹内缩

## 范围、证据与决定（ADR）

- UI-10 → M08；审计 M06/M07/M11。`ALG-LR-UV-PAINT` v2.0.0（production 实现，本地待发布）。
- 用户确认黑边是新版重新绘制，不是旧笔迹。原生 UV 的 `stamp → end → commitStroke` 只使用画笔 feather，直接提交 RGBA；没有进入兼容投影路径的 `refreshLocalRepaintInwardCrossfadeMask`。模型轮廓 3px 内缩不是实际笔画内缩。
- 批准：说明上述缺口后用户明确“那你接上吧”。本次只补手动彩色笔迹的内缩融合，不调整生成选区、返回图片、投影/深度、图层选择、分辨率、QA 或远端服务。
- 决定：在现有 GPU 笔画胶囊距离计算中接入内缩过渡，最终 alpha 直接写入原有 UV RGBA。每个连续笔段独立计算，多个笔段仍按既有 max-alpha 累计；不是对所有累计笔迹做全局距离场重算。
- 不直接腐蚀 UV atlas：UV 岛边界不是用户笔迹边界，这会重新制造接缝。不逐笔 CPU 全图读回/距离场处理，不增加 GPU pass 或 render target。

## 输入、公式与单位

输入为实际屏幕笔段起终点、CSS 像素半径 `r`、视口长边 `L`、羽化比例 `f`。生成蒙版不参与。

`scale=L/2048`；`inset=min(3*scale,r/4)`；`outer=r-inset`；`width=min(outer,max(16*scale,r*clamp(f,0,1)))`。

`d` 为片元到实际笔段的距离；`weight=1-smoothstep(outer-width,outer,d)`。

3 是绘制轮廓退让的 2K 视口参考像素，16 复用既有 inward-crossfade 参考过渡宽度。小笔刷按半径限制退让和过渡，中心不会因固定宽度而完全消失；较大用户羽化仍保留。此处按屏幕笔迹标度，不按 UV 岛大小或 atlas 分辨率标度。源 RGB、源 alpha/遮挡约束、颜色空间与相机矩阵不变，权重只乘源 alpha。

橡皮以及没有源材质的蒙版绘制继续使用原 `[1-f,1]` 过渡，不能继承彩色笔迹内缩。普通画笔不经过本改动。旧版投影/Canvas 的累计笔迹距离场及自动应用逻辑不变。

## 对应实现、资产与回退

- CPU helper 仅算两个边界 uniform；GPU 使用原 `smoothstep`、原可见性/源采样/瓦片与 max-alpha 写入。没有新增 CPU/Worker 图像内缩副本。
- GPU 显示、异步瓦片读回、undo/redo、live canvas 和持久 PNG 共用同一已内缩 RGBA。CPU/Worker 层合成、合并 UV、导出不得再次内缩。
- 图层顺序、可见性、选中状态、Command 幂等、Revision CAS、ownership、verified assets 和 Project/Layer Schema 均不变。
- 历史迁移：无资产重写。已保存的笔迹保持原样；新笔迹使用新规则。无法仅从历史 RGBA 无损恢复原始笔段，禁止自动对旧整层腐蚀。
- 回退：恢复原生笔画 `[1-f,1]` 边界和 helper 接线；已保存 PNG 保留，仍能由旧版读取。

## 验证

- 实际 WebGL 2K（feather 0/45%）与 4K atlas：独立胶囊公式全图 alpha 对照，最大差异 1/255；2K 退让环 3652 texel、4K 14532 texel 为零。旧公式负对照分别有 3652/2520/14532 texel 不符合新边界。
- 重复笔画不累积填回内缩区；撤销重做、擦除撤销、PNG 编解码像素一致；小笔刷非空；额外覆盖 mask-only/eraser 不内缩。
- 既有真实 WebGL：UV 岛接缝 64/512/2K/4K、透明边缘、多层 Worker/CPU 显示、源边界、旋转曲面和生成蒙版外绘制。
- 模块回归：native UV、inward crossfade（96 对照、120 fuzz）、ordered composition、layer retention、bake batching、UV merge preview、export orientation；Web typecheck、改动文件 lint。
- Cloud 参数 Web 生产构建通过；原包体门禁及 256-byte 总余量门禁通过：110 chunks、3,255,109/3,256,500 bytes，未提高预算。此构建标识为本地验证，不是发布制品；正式发布仍须对最终提交运行全量 prepush。
- 实际座垫的返图暗边/几何错位尚未完成新版端到端复核，不把笔迹内缩通过等同于所有来源的黑边均已消除。没有操作、刷新或改写用户当前工程，也没有重新付费生图。

负责人：Codex；变更单：CHG-20260921-UV-REPAINT-STROKE-INWARD。
