# 原生 UV 重绘纳入合并

主模块 M07，协作 M08/M11。算法 `UV_MERGE_COMPOSITION_VERSION=10`；最终合并派生键 `uv-final-v3`。

## 问题与修改

原生 `local-repaint-uv-native-v1` 图层被合并资格过滤掉，紧凑工具栏也只收集 projected。旧 UV 合成循环全部执行 destination-over，直接扩展选择仍会让不透明投影盖住重绘。

全部合并入口识别原生 UV 重绘；旧 merged UV/修补底层保留原底层顺序，原生重绘随后按作者层序从下向上 source-over。Worker/GPU/CPU 同时支持前景 opacity，透明区保留下层；Bake/自动颜色导出计划识别原生 UV 增量，不误用旧 merged base。后台最终 PNG 与手动路径使用同一顺序和覆盖方向。

保持现有 flushLiveUvCommits、live revision 守卫、冻结 PNG 和预上传后才消费来源的交接。仅消费显式选择或可见当前对象来源，保留撤销快照。附带修正 Worker 小尺寸输入的分片画布：高度不得超过实际图像高度，避免极窄图像创建超限画布而读出空像素。

## 对应路径审计

- GPU：RGBA composite WGSL 增加前景 opacity，uniform 缓冲对齐为 32 字节；既有底层默认参数保持。
- CPU/Worker：常规、交互分片、WebGPU 失败回退和 QA 核同步前景 opacity；转移所有权和取消/失败守卫保持。
- Shader/投影：投影、Top-K、可见性、UV 岛后处理及深灰斜线不改。原生 UV 本身不回退成投影显示。
- 持久化：只增加派生合并版本，不自动重写历史 PNG、来源或工程；Command 幂等、CAS、ownership、verified assets 不变。
- 导出：自动合并计划包含原生增量；既有 PNG/FBX 原生 UV 叠加及读回屏障保留。

## 验证

新增原生 UV 合并合同：来源资格、原生双层顺序、半透明覆盖、透明区保留、隐藏/跨对象排除及 Bake 增量。已有 final preparation、merge preparation、consumption、原生 UV 保存屏障和 Bake/export 测试通过。

内置浏览器实际 Worker/WebGPU 与规范 CPU 对照：4×1 覆盖 opacity 0/0.37/1；4096² 覆盖 opacity 0.37，空闲 WebGPU 与交互 CPU Worker 均零字节差异。完整 Web 回归 121 项通过，新增合同单独通过；TypeScript 与 ESLint 无错误。合并不触发用户原工程的破坏性压平。

## 迁移与回滚

无 Project Schema 或持久资产迁移。派生 final-v2 不命中新键；旧已合并资产保留原像素。回滚此提交恢复旧合并资格/顺序/Worker 协议；不会重建之前已经漏掉的笔画，需要保留的来源或撤销历史。发布必须针对最终提交执行 `pnpm verify:prepush`，不能放宽包体阈值。
