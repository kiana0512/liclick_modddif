# 颜色蒙版准备去除重复 GPU 上传

- 主模块 M06，协作 M09，ALG-PROJ-007 v2.1.9（实现 Patch，采样与像素语义不变）。
- 热点：prepareRenderedColorMaskTexture 在每次材质更新中先调用 UV 准备再无条件 needsUpdate=true；同一张未变的 4K 蒙版再次绑定也重新上传。
- 修复：UV 准备共用显式色彩空间参数。只有未准备或采样属性/色彩空间需要改变时才请求上传；颜色蒙版直接使用 NoColorSpace，普通 UV 仍为 SRGBColorSpace。首次准备保留上传，内容所有者主动 needsUpdate 的 revision 不被清除；同一对象在 UV/蒙版角色之间转换仍触发必要上传。
- GPU/CPU/Worker/shader 算法和输出 RGB/alpha/coverage、方向、过滤、完整分辨率、QA 均保持；不缓存像素、不增加跨任务驻留、不引入降质。持久化/导出以及 Command/CAS/ownership/verified assets 不改，无 Schema 或资产迁移。

## 验证与局限

- 旧代码在新增回归失败：1000 次准备后 version 1002 而非初始 2。新代码 2,000 次准备、显式内容更新、40 次 UV/蒙版角色转换、flipY 两种方向与原始 RGBA 保持通过。
- Browser plugin not available；使用已安装 Playwright + Edge headless、真实 Three.js/WebGL2，4K RGBA DataTexture，128² 对照渲染。20 次重复调用：额外 texImage2D/texSubImage2D 从 20 降至 0；包含 GPU finish 的单次平均 13.35→0.14ms，最大 26.10→0.20ms；65,536 输出字节零差异，主动更改纹理内容后输出仍一致。
- 该数字是隔离重复上传热点，不能推算成整个工程速度或 FPS 收益。生产 shader 代码未改；S7 仍有独立的快速显隐驻留/状态问题，不声称已整体丝滑或状态验收通过。
- 98 项 Web 回归通过，修改文件 lint 通过；最终去掉额外的未准备标记强制上传，普通 UV 继续只在原采样属性需要变化时上传。针对性回归与真实 WebGL 复测仍通过（旧 14.51ms / 新 0.16ms，输出零差异）。

## 回退

只回退纹理准备 helper 即可，重新出现重复上传但资产与工程无需重算。新测试可保留为期望约束；历史工程与所有上传的纹理保持原格式。
