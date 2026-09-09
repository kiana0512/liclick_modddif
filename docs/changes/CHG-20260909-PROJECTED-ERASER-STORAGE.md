# 普通投影橡皮蒙版 GPU 尺寸交接

- 主模块：M06 投影预览、M12 历史；协作 M03 视口。
- 算法：ALG-ERASE-001 v1.3.7（运行时存储修复）；持久化 eraserAlgorithmVersion 仍为 1。
- 基线：73c6e03；维护文档 2.19.6。

## 根因与边界

普通 projected 橡皮预热注册 1×1 白色 keep-mask，第一笔提交扩大到项目所选分辨率。Three WebGL2 使用 immutable texture storage；CanvasTexture.needsUpdate 只安排 texSubImage 上传，不扩容原 GPU 分配。旧实现真实 GPU 测试返回 GL_INVALID_VALUE (1281)，采样仍是旧像素。按住时的独立实时 multiplier 可以遮住问题，退出工具后正式蒙版不能保持擦除结果。

这不是局部重绘擦除规则问题。不改它的选区、返图、图层覆盖或 GPU overlay 逻辑。

## 修复

live canvas 注册表跟踪宽高，仅尺寸改变时调用原纹理 dispose 释放 GPU 分配，并安排正确尺寸重传；共享 Texture、Source、URL、canvas 和驻留材质 uniform 身份保留，不替换图层。注册同 URL 的新 backing、显式发布以及两个纹理读取入口均覆盖；同尺寸笔触及重复读取不新增重建或上传。缓存 PNG 在尺寸变化时失效，普通发布 revision 规则保留。

## 对应管线审计

- GPU/direct/texture-array：live mask 保持独立 sampler；resize 后重分配，覆盖公式与方向不变。
- CPU/Worker/UV/export：仍读取原注册 canvas 全分辨率像素，补缝、质量权重与输出不变。
- 局部重绘：仅共用注册表尺寸安全保障，擦除及历史算法不变。
- 保存/历史：原 canvas 与 URL 不变，撤销重做原像素；PNG、项目 Schema、幂等性、Revision CAS、ownership 与 verified assets 不变。

## 验证

- 注册表回归：四入口扩容、单轴缩小、更换 backing、Texture/Source 身份、同尺寸 50 次写入不重建、PNG 缓存及读取不重复上传。
- `test-fixtures/projected-eraser-storage.html`：真实 WebGL 1×1→2048×2048；单投影、双投影 direct、双投影 array；比较按下/松开、切层、预览开关、材质重建、保存 PNG 重新加载、撤销重做，全部像素误差 ≤1，GPU error=0。
- 冻结 HEAD 注册表在同一 GPU 夹具失败（1281），修复版通过。不是用户原靴子项目端到端验收，线上仍需用户复测。
- 全量 Web 96 项回归、TypeScript 和变更文件 ESLint 通过；现有局部重绘 selection-consumption 2048 GPU 夹具同时通过。
- Cloud 构建/产物检查通过。匹配发布参数总 JS 3,147,367→3,147,538，修复新增 171 bytes；总预算仅由 3,147,500 增至 3,147,750（+250 bytes），shell/editor/bake/shared 独立上限、QA 和输出分辨率不变。

## 发布与回滚

无历史数据迁移，不清除蒙版或项目。刷新后，旧已保存 PNG 按原尺寸重新分配；尚在内存的修复靠正常蒙版发布。回退仅恢复注册表代码（会恢复 resize 问题），不删除任何资产或撤销记录。
