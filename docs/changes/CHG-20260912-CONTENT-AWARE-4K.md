# CHG-20260912-CONTENT-AWARE-4K

- 主模块：M07；协作：M05、M06、M08
- 算法：`LOCAL-BOUNDARY-REPAIR` v1.2.0
- 问题：内容识别修补固定截断在 2048²；用户选择 4K 时，投影覆盖、拓扑和缺口先降采样判定，细缝和小 UV 岛可能消失或出现放大边缘。提高到 4K 后，旧 Worker 启动还会在 UI 线程显式复制完整 topology、region、seam 与 source-exclusion，再由 `postMessage` 复制/转移，形成可删除的大数组峰值。
- 修改：生产修补上限提升为 4096²，1K/2K/4K 按所选纹理分辨率运行；8K 明确保持 4K 修补上限。Worker 路径直接保留完整且只读的 resident topology 视图，由浏览器结构化克隆创建 Worker 副本；只有短生命周期 RGBA/write mask 进入 transfer list。主线程兼容路径仍显式复制全部输入。
- 正确性：同区域原始边界仍是唯一颜色来源；不跨 UV 区域，不启用全局平均色，不把新生成颜色当成下一轮 donor，不改变 Alpha、覆盖阈值、接缝链接、层序或原子发布屏障。
- GPU/CPU/Worker/shader：投影 GPU 与 shader 不变；CPU 主线程兼容核不变；Worker 核与输出字节不变，只调整输入所有权和生产分辨率。完整 4K 输出不降低 QA。
- 性能与验证：2K 浏览器夹具 Worker/主线程逐字节差 0，262,144 texel 修补约 769ms；4K Worker 夹具修补 524,288 texel 约 2965ms，中心颜色 `[140,80,95]`、无全局兜底、PNG 4096²。4K 是质量修复，不宣称总时长比 2K 更短；交互优化是删除 UI 线程显式 topology/region/seam/source-exclusion 预复制。单元契约确认只转移 RGBA/write mask，resident topology/region buffer 不被 detach。
- 持久化/导出：图层仍保存现有独立 UV repair PNG；Project/Layer Schema、Command、Revision CAS、ownership、verified assets 与导出合成不变。历史 2K repair 图层不自动重算。
- 迁移：无批量迁移；用户再次运行内容识别修补时按当前选择生成新修补层。
- 回滚：恢复 2048 上限并恢复 Worker 前显式只读数组复制；已有 4K 修补层是合法 UV 资产，不需删除或改写。
