# 原局部重绘合并当前可见未贴图区域

- 日期：2026-09-22；主模块 M04，协作 M03/M06/M07/M08/M09/M12。
- 算法：`LOCAL-REPAINT-VISIBLE-GAPS/1.0.0`；用户要求手绘蒙版与当前视角未贴图区域一起送原局部重绘远端。

## 行为与决定

ModelView 局部重绘在同一冻结相机下采集 BaseColor/贴图覆盖 alpha、手绘蒙版与 packed linear-view depth。复用 projectionGapMaskFromAlpha，以可见模型范围内 coverage alpha < 255 判为缺口（包括边缘部分覆盖）；不以 RGB 黑白或灰色判空。深度清屏像素排除背景、孔洞；隐藏面不在可见截图中。未贴图部分与手绘区域取最大值并集，输入图将并集填为纯白。

不对合并选区执行闭运算填洞，以免吞掉已贴图小区域或背景孔洞。沿用采样蒙版外扩/羽化参数，并以可见几何裁掉背景；该融合边距仍是远端采样输入。Capture、生成元数据与持久化沿用未外扩的合并选区，防止新增缺口被旧手绘 mask 再次截掉。paintMaskSource 标记 user-and-visible-gaps-v1。界面正在编辑的 UV 手绘选区不被自动缺口覆写，仍要求先绘制蒙版；GPT 局部重绘、单视图及多视图保持既有输入。

深度从原远端请求后的辅助截图前移至提交前，用同一结果复用回贴深度保护，不新增深度渲染次数。捕获或尺寸验证失败时不静默改回旧蒙版提交。

## 对等审计、迁移与回滚

- GPU/shader：复用已有 flat-target-coverage 与 depth 捕获，未改 shader/alpha 标准/分辨率。相机、法线与对象绑定保持；无主线程全图扫描。
- CPU/Worker：合并和 PNG 编码在既有 Worker 内完成，新增一个深度输入及一个未外扩选区输出；成功与处理失败均释放位图。缺口算法复用单/多视图覆盖契约。
- 投影/UV/手动绘制/历史/导出：消费保存后的 Capture 和生成选区，几何深度、轮廓保护、实际笔迹内缩及源 alpha 规则保持，不将采样外扩蒙版用于回贴。旧生成、已画像素不重写。
- 持久化：沿用 authoredMaskUrl/maskUrl 保存本次请求的未外扩选区并集，submittedMaskUrl 保存采样蒙版；Command 幂等、Revision CAS、ownership、verified assets 和 Schema 不变，无历史数据迁移。
- 回滚恢复 ModelView 的 flat-target 和手绘蒙版输入，去掉 coverageDepthUrl/selectionMaskBlob 分支；不删除已保存结果与资产。

## 验证

- 实际生产 Worker 回归：并集、已贴图保护、黑/白纹理不误判、部分覆盖、背景/孔洞排除、未外扩回贴蒙版、输入不变、尺寸不一致及位图释放。
- 真实浏览器运行构建 Worker + OffscreenCanvas/ImageBitmap/PNG round trip：2048×2048 共 4,194,304 像素逐点检查通过；选中 701,754，完整保护已有纹理 2,414,141 像素。
- 全部 Web 回归 151/151、TypeScript、修改文件 ESLint、Web 生产构建通过；原包体门禁（含 256-byte reserve）通过，总 JS 3,255,482 / 3,256,500 bytes，未提高预算。

本地修改，未推送或部署；未调用付费生成、未修改用户工程。真实项目端到端生成/回贴效果尚未实测。
