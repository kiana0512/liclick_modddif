# UV 笔刷单次光栅化

主模块 M08；`ALG-LR-UV-PAINT` v1.1.2 → v1.1.3。保持 UV_REPAINT_VERSION=4，像素与资产语义不变。

## 根因和调整

stamp 对每个命中 UV 瓦片重画完整模型，即便只是 256² scissor，顶点处理仍重复。现在先捕获该笔画全部首次触及瓦片的 before 读回，再在临时 source 上以这些瓦片的包围矩形光栅化一次。output 仍仅逐个写入原触及瓦片，包围矩形内未触及的区域不进入图层或历史。

## 对应路径审计

- GPU：只改变模型提交次数；source scratch 的清理覆盖完整本次包围矩形。output 的瓦片 scissor、alpha MaxEquation、擦除混合保持。
- Shader：可见面 ID、源相机/遮挡、共享 UV 固定几何顺序、羽化、源 alpha、颜色和深灰斜线均不改。
- CPU/Worker：原瓦片识别、before/after 读回、发布/撤销顺序和 Worker 交接保持；不跳过校验，不降分辨率。
- 持久化/导出：输出仍是同一完整 RGBA 和脏瓦片，flushLiveUvCommits 屏障及 verified assets / Command / CAS 不改；PNG/FBX/合并不增加新格式。

## 验证

内置浏览器运行 `verify-native-merge-brush-browser.mjs`，以固定提交 994df29 的画笔为对照：1K 在 DPR 1/1.25/1.5/2、4K 32 万三角面分别比较绘制、擦除、撤销、重做，所有 RGBA 字节相同。独立 HiDPI 夹具保留非零/末尾不足整瓦片、重开及 CPU 发布验证；源 scratch 可跨多瓦片，output 仍必须为单瓦片。原生产 shader 夹具覆盖共享 UV、可见/遮挡/薄斜挡板、正交/透视、曲面、旋转、大笔刷、源 alpha、作者蒙版和 sRGB，全部通过。

16 次笔刷提交中：1K 模型绘制 229→17 次；4K/32 万面 409→17 次（包含一次可见性绘制）。三轮同机测试最大帧间隔旧核约 100–184ms、新核约 16.8ms。CPU 提交中位数只约 0.9→0.7–0.8ms，主要收益在 GPU 重复几何。测试是合成平面，不宣称复杂用户工程零卡顿或 F5/图层切换问题全部解决。

## 回滚

回滚此提交恢复逐瓦片 source 光栅化。无持久格式或派生像素变化，无资产迁移；已保存笔画无需重算。发布前按最终提交执行正式门禁，不放宽包体预算。
