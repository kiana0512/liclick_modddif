# 局部重绘旋转视角后的遮挡修复

日期：2026-09-08；基线：55602ef；UI-06/UI-10 → M06；ALG-PROJ-006 2.0.1 → 2.1.0。

## 已验证问题

用户视频表现为内部重绘后，转动观察角度，外壳附近出现内部纹理/黑片。视频无法独立判断投影串面与显示深度错误，因此用真实生产材质建立不加载用户工程、不调用生图服务的 WebGL 对照场景。

内层蓝色表面、红色重绘 overlay、前方黄色半幅外壳，附加不同细分的同面诊断网格。捕获相机保持固定且开启 linear-view depth gate，只移动观察相机。旧公式在外壳应遮挡的位置显示重绘颜色：捕获可见性正确也不能修正当前相机的光栅深度前推。

旧 overlay 将 accepted 深度减 0.000080，常驻有材质面减 0.000006；并启用 overlay polygonOffset(-1,-1)。只清除 overlay 偏移会被仍前推的底层遮住；只缩小前推仍能在距离变化后穿透。过小的对称偏移另会使重合诊断面出现条纹，因此未采用这些试验方案。

## 最终变更

- 输入：当前观察相机归一化窗口深度 `gl_FragCoord.z` 与原 coverage threshold 得到的 accepted（0/1）。不是捕获相机线性深度，也不是 world/view-space 距离。
- 公式：`clamp(z + (1 - accepted) * 0.000006, 0, 1)`。有材质片元不再前推；空诊断片元保留旧后移量，不重调 capture 的阈值。
- 单层材质、direct stack、texture-array stack 和 live overlay 使用同一 GLSL helper。保留原 normal debug 几何深度，wire debug 仍为空诊断深度。
- overlay 禁用 polygonOffset；保留 depthTest、LessEqualDepth、既有晚绘制顺序、透明混合和 depthWrite=false。同面正常覆盖由相等深度和绘制顺序完成，而非把内部表面拉到外壳前面。
- 只有两处生产源码文件；没有新增渲染 pass、逐帧纹理、读回或采样开销。

## 对应路径与数据边界

GPU 当前相机深度写入改变；捕获矩阵、source-space linear-view depth/3×3 支持、normal、coverage 和 literal source-over 不变。`ProjectedLayerPreviewCompositor` 的全屏合成不使用相机 depth test/write；CPU、Worker 和 export 的颜色合成不执行该光栅优先级。GPU UV bake 的 depth 是 UV quality winner，不是当前相机遮挡，故不接入此 helper。上述路径不改算法，不引入 CPU/GPU 覆盖语义分叉。

Layer、Capture、Generation、Project Schema，mask/image、Command 幂等性、Revision CAS、ownership、verified assets、分辨率和质量门禁全部不变；无数据迁移。旧工程重建运行时材质即采用新规则，不重写蒙版或模型。已烘焙进 UV 的污染不会因此自动修复；捕获空间串面、模型重叠和 UV 共用等仍须单独诊断。

## 验证与复跑

真实 Edge WebGL / ANGLE NVIDIA RTX 4070 Ti D3D11：3 材质路径 × 2 相机类型 × 3 俯仰 × 3 距离 × 5 方位 × 3 外壳间距 × 4 状态 = 每版 3,240 状态。状态包括 overlay 开/关、真实 mask 清零及恢复；多点检查重合诊断面不能覆盖有效颜色。旧公式对照失败 1,362，新公式失败 0；总计 6,480 状态，浏览器错误 0。

夹具位于 `apps/web/test-fixtures/repaint-occlusion.*`，用生产材质工厂，不加载编辑器/store，不保存项目；只在测试中将深度公式替换成冻结旧值作为负对照。测试结束关闭浏览器释放资源，不进入生产构建入口。手动运行（需已安装 Edge 和 Playwright，可用 PLAYWRIGHT_MODULE 指向已有 index.mjs）：

```powershell
node apps/web/scripts/verify-repaint-occlusion-browser.mjs
corepack pnpm --filter @liclick/web test:projection-layers
corepack pnpm --filter @liclick/web test:regression
corepack pnpm --filter @liclick/web build
```

现有 projection regression 同时锁定三条 shader 共用 helper、无负向 accepted offset、overlay depth flags 与原覆盖门禁。隔离验证不是用户原模型、真实橡皮事件交接、所有 GPU 或 A100 页面验收；未执行付费生成，未修改用户资产。

最终代码验证：88 项 Web 回归、单独 projection regression、TypeScript/Vite 生产构建、修改文件 lint、Cloud/repository 边界、artifact 与 diff 检查通过。包体 80 chunks / 3,133,038 bytes，通过现有预算，未放宽门禁；构建仍有既有大于 500 kB chunk 的提示。

## 回退

整体恢复 ProjectedLayerMaterial 的旧深度写入与 polygonOffset，并移除 helper；不可仅回退 overlay 或常驻材质一侧。无需回退 Schema/资产或删除历史图层，重建运行时材质即可，但会重新引入已复现的遮挡错误。

发布集成：用户已授权提交 master 与部署 A100；重放到远端 master 919b1de，完整保留异步离屏预编译优化与新增测试。发布仅替换构建制品和四项 release 身份，保留现有固定账号、回调、runtime 与用户项目；实际发布结果以部署后 release/ready 核对为准。
