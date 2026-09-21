# 局部重绘实心中心与线性外圈羽化

## ADR / 算法卡

- 主模块 M08，审计 M06/M07/M11；UI-10。负责人 Codex。
- `ALG-LR-UV-PAINT` / Native UV repaint solid-core linear feather / 原生 UV 重绘实心中心线性羽化，v3.0.0，本地待发布。
- 用户明确要求“内部保证一定区域实心，外部改成线性羽化，离边缘越近羽化越强”。旧版外圈使用 smoothstep，极大羽化或小笔刷可能没有实心区。
- 保留默认羽化 45%、半径、3px@2K 内缩、源采样与生成蒙版外绘制权限。中心最小半径取内缩后有效半径的 10%，已向用户说明；这是新画笔语义，不自动重写历史结果。

## 公式 / 单位

CSS 像素半径 r、视口长边 L、羽化 f：s=L/2048，outer=r-min(3s,r/4)，width=min(0.9outer,max(16s,r·clamp(f,0,1)))，inner=outer-width。

片元距实际屏幕笔段的距离为 d。权重 clamp((outer-d)/width,0,1)：d≤inner 实心；外圈径向线性递减；d≥outer 为零。过渡走过 25%/50%/75% 时权重为 75%/50%/25%。中心实心指画笔权重为 1，不覆盖源透明度、遮挡或图层不透明度限制。

每笔段是解析胶囊距离，不是整层全局距离场。保持原 max-alpha 累计，不增加 GPU pass、RT、全图读回或降低分辨率。归一化距离与边界同除 r。

## 对应实现与兼容

- CPU helper 算边界，GPU 仅对 paintsSource 且非 erase 使用线性公式。
- 橡皮与 mask-only 仍使用原 smoothstep/feather 范围，无内缩。生成输入、选区、图层选择与多层显隐不变。
- GPU 显示与异步瓦片读回共用同一 RGBA；undo/redo、持久 PNG、CPU/Worker 合成、合并 UV 和导出消费同一像素，不重复执行羽化。颜色空间、深度和投影矩阵不变。
- 历史投影/Canvas 累计蒙版距离场是兼容路径，不改写其旧资产或更换其距离场公式；本次范围为当前原生 UV 画笔。
- Project/Layer Schema、Command 幂等、Revision CAS、ownership、verified assets 不变，无数据迁移。
- 回退恢复 v2.0.0 的 smoothstep 和宽度上限 outer；已保存 PNG 仍可读取，不删除新旧笔迹。

## 验证

真实 WebGL 全图独立线性 oracle 通过，覆盖 2K 的 0/45/100% 羽化及 4K，最大误差 1/255；100% 羽化仍有 5036 个全不透明 texel。2K/4K 内缩零环分别 3652/14532 texel。重复笔画不填满过渡环，undo/redo、PNG 编解码逐字节一致；橡皮保持旧曲线、小笔刷非空、选区不继承内缩。

UV 岛 64/512/2K/4K、旋转曲面、GPU/Canvas/PNG/CPU/Worker 多层显示测试通过（夹具 maxDarkening=0）。native UV、旧 inward-crossfade（96 对照与 120 fuzz）、ordered composition、layer retention、export orientation 回归、Web typecheck、改动代码 lint 与 diff 检查通过。未推送、部署或操作用户工程；不将合成夹具等同于用户座垫端到端黑边已消除。
