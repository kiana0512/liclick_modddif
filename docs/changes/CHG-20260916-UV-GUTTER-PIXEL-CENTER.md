# 局部重绘切层后白点：UV 留边拓扑

主模块 M07，协作 M06/M08/M09。`UV-GUTTER-TOPOLOGY/3`，UV merge composition 11。

## 证据与根因

用户报告刚重绘正常，新增图层后挡风玻璃出现白点。真实 Chrome 页面读取到白点的底图与原生 UV 叠层在相同邻域有 RGBA=0 的 texel；相邻有效颜色仍是深灰，透明覆盖衰减后露出模型白底。

原留边拓扑把 Canvas2D 抗锯齿 alpha >=128 当作像素中心在模型内部。软件 Canvas 的边缘 alpha 128/136 与 WebGL 非抗锯齿 UV 光栅覆盖并不等价，导致 GPU 未覆盖的 texel 被判成内部，留边不能写入。WebGPU 校准又把结果改回同一个 Canvas 金标准，所以两条路径都有问题。GPU Canvas 和软件 Canvas 的 126/127/128 差异也验证了不能用面积覆盖率代替成员判定。

从真实挡风玻璃提取三个 UV 三角形做 2K WebGL 回归：旧 CPU/Worker 各误标内部 7 个 texel、漏标 3 个，目标留边 alpha=0；新内核两项差异均为 0，目标 alpha=255。

## 变更与对应路径

- 共享像素中心光栅内核，采用 8 位子像素坐标及 top-left 边界规则。CPU 留边与 Worker 校准/回退共用；WebGPU 继续做逐像素校准，没有关闭 QA。
- 仅改变留边的岛内/岛外判定。保守面积拓扑仍用于现有洞修复；不启用洞修复，不扩大作者蒙版，不改变 seam bypass 默认值。
- 原生 GPU 笔画、shader、CPU/Worker RGBA 合成、羽化、擦除和历史不变。留边仍禁止写入拓扑内部；新增真实未涂抹 texel 保护断言。
- 视口 resident 与 Merge/export 共用新留边。UV composition、拓扑缓存键和持久化派生缓存键升级，已有派生底图重新计算。独立 PNG 作者 RGBA 不迁移。
- TypeScript 允许显式 .ts 导入，供无构建 Node 回归与浏览器共用同一内核；继续 noEmit。原计时/协作测试的模块注入同步加入该真实内核。
- Project Command 幂等、Revision CAS、ownership、verified assets、源相机/投影、原尺寸和导出协议均保持。

## 验证

- 新真实三角形测试：CPU/Worker 与 WebGL 全 2K mask 一致，留边补齐，未涂抹内部仍透明。
- 原透明边缘测试：GPU/Canvas/PNG/加层 Worker/删除层/CPU 合成，硬边与羽化均无暗化；六种材质数值误差 <=1/255，作者像素不变。
- 真实用户模型临时材质 A/B：重算并补充底图岛外留边后，挡风玻璃白点消失；内部覆盖改动为 0。对照后立即恢复原材质，未保存/改写用户工程，也未自动刷新其页面。
- resident 浏览器回归通过：无浏览器错误，显隐恢复和 UV 岛边对照差为 0，多层原生重绘合成通过。
- 拓扑复用、resident、native UV merge、留边复用/计时、600 个留边金标准、500 个修复与 40 个变换网格对照通过。类型检查和相关 lint 通过。
- 普通 Node 直接运行旧 dilation.test.mjs 被既有 @/engine 别名解析阻断；该入口不算通过。上面的真实浏览器与生产内核回归已覆盖本次改动。
- 正常生产构建与原 bundle budget 通过：102 JS chunks，3,201,717 / 3,256,500 字节。4517 已返回 `index-BH93Jfbb.js`，保留旧静态资产供未刷新页面使用；当前用户已打开页面仍需刷新加载新构建。

## 迁移与回滚

无工程 Schema/资产迁移，不需要重画已有重绘图层。刷新触发新版派生缓存键，重新生成底图；已导出的旧文件不会自动改写。

回滚共享光栅调用、版本键及测试接入即可恢复旧行为；保留作者数据。跨设备的 UV raster 规则仍通过 WebGPU 校准和 WebGL 回归验证，本次实测环境为 Windows Chrome/Edge。
