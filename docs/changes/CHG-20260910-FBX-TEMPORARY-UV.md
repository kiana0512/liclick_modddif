# CHG-20260910-FBX-TEMPORARY-UV

## 范围与证据

- 主模块 M07；协作 M05/M06；FBX-TEMP-UV-EXPORT v1.0.0；文档 2.20.3。
- 用户报告：未合并投影/局部重绘图层时，场景和对象 FBX 报图片无法解码；颜色导出及先合并再导出可用。
- 代码差异：旧 FBX 走独立分层烘焙并读取原始模型图片；合并后跳过原始模型图片。未证明用户工程具体哪一张资产解码失败，不以截图推断损坏文件。
- 浏览器回归另外确认：蒙版处理 Worker 转移 imageSampler 借出的共享缓存 buffer，下一次处理会报 detached ArrayBuffer；现传私有副本，postMessage 同步失败移除 pending 请求。

## 实现

两个 FBX 入口调用 prepareFbxModelExport，使用 resolveBakeUvMergePlan、getMergeUvPostprocessOptions、compositeRgbaUnderInPlace。局部投影沿用 createProjectionMaskedImage，将冻结蒙版压进 alpha；普通投影覆盖、已有 merged UV、内容修补 underlay、最终 local UV 叠加保留原顺序和透明度。已有合并结果复用，不重新读取失效的原始底图。无投影/合并源的旧 UV-only 路径保持原始底图规则。

临时烘焙使用透明输出和现有拓扑内补洞/UV gutter/几何接缝修复；不启用无约束 dilation。最终沿用已合并 FBX 的不透明颜色贴图转换，再把已编码 PNG 字节嵌入 FBX，删除重复解码/重编码和不必要的 GPU Texture 加载。

不调用图层合并发布、历史捕获、addBakedTexture、markLayersBaked、资产保存或 Project Command。开始取图层/live 预览快照，结束校验图层数组、活动模型、模型矩阵、项目身份和 live canvas revision，变更则提示重试。临时蒙版 URL 和 bake canvas 成功/失败均释放，源资产不撤销、不删除。

## 对称审计

- GPU/CPU/Worker：沿用生产 UV bake 的现有后端、校验与回退，不关闭 QA、不更改 shader/投影裁切/分辨率。underlay 使用颜色合并已验证的 CPU 字节基准，未引入实验渲染替代。蒙版 Worker 仅改变 buffer 所有权，CPU 数学不变。
- 显示和生成：不改变视口、GPT 输入、投影图层或局部重绘历史。
- 导出：仅两个 FBX 入口改为临时合成；GLB/OBJ/颜色导出入口不改。FBX 几何、方向、材质连接和 PNG 嵌入格式不改。
- 持久化：无 Schema、Command、Revision CAS、ownership、verified object assets 变化，无迁移。

## 验证

- Web 完整回归 109 contracts 通过，TypeScript 与 Cloud 生产构建通过。

- test:fbx-temporary-uv：运行生产函数，验证两个目标、隐藏/跨对象隔离、局部蒙版、live 替换去重、underlay 顺序、UV 最终覆盖、1K/2K/4K/8K 参数、并发编辑拒绝、失败与部分成功清理、无持久化写入；真实 transfer 三次处理后缓存字节不变，同源同蒙版也不重转移，异常 pending 清零。
- verify-fbx-temporary-uv-webgl.mjs：真实 Edge/WebGL/Worker，合成模型故意使用不可解码原始图片；2048×2048 投影 + 局部重绘不合并直接导出，与执行颜色合并像素阶段后导出相比，RGBA 字节差异 0；两个 FBX 各 107324 字节，内嵌 PNG 解码为 2048×2048，局部重绘颜色存在、alpha 全 255，源项目与图层引用不变。
- 合成回归不是用户工业机器人原工程复现；上线后仍需用户在原工程验收。
- 云构建检查 84 JS chunks / 3159841 字节，总量仍在 3160000 上限内，无预算放宽。生产发布元数据构建再次检查。

## 迁移与回滚

无工程/资产迁移。回滚本次提交恢复旧 FBX 准备函数即可；不需要恢复用户图层或数据。建议保留独立的蒙版缓存所有权修复，避免重复合成再次损坏共享 buffer。A100 只替换三处 dist 和 release 元数据，备份旧包与环境，保留 runtime 和非 release 配置；健康检查失败恢复备份。
