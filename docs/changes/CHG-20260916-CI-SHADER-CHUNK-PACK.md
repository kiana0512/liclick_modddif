# CI shader 无损打包修复

主模块 M15；SHADER-CHUNK-PACK/1.0.0，协作 M03/M06/M07/M08。

## 问题与实现

master 4334910b 的 GitLab pipeline 632231 / build 3582243：总 JS 3,264,669 字节，比原 3,256,500 字节预算多 8,169。verify 阶段全部通过；本地按 CI Cloud、performance-lab 和发布元数据复现同一数值。

仅在 Vite build 的既有 GLSL 格式化之后，把固定 Three.js 模块注册的 141 段 ShaderChunk 字符串通过已有 fflate 打包；模块初始化同步解包一次。GPU 收到的字符串保留全部字节、空白、指令和行边界。算法、材质注入入口及输出不变。未增加依赖、放宽预算、禁用 QA 或删除功能。注册表形态/标识符冲突或超出审计容量时构建失败。

CPU 新增一次小型静态文本解码；纯几何导入通过纯函数标注消除整个池与解码器，Worker 不新增 renderer 初始化。应用 shader 不打包。M06/M07/M08 的 GPU、CPU、Worker 和 shader 采样、逐层 UV 权重合成、局部重绘 mask/alpha、投影及完整分辨率均保持。构建回归比较原模块、既有格式化模块、生产 Terser 模块的完整 ShaderChunk、ShaderLib 与导出；另以实际 Vite 验证纯几何 bundle 不含解码器。原局部重绘 shader 入口回归保持。

## 验证与范围

141 段 shader 字符串、实际 vertex/fragment 组装与 uniforms 逐字节一致；生产 Terser、纯几何 tree-shaking、错误审计和原 shader 格式化回归通过。同一 Cloud/performance-lab 元数据候选构建总 JS 3,171,896 字节，比失败构建减少 92,773 字节，原预算余量 84,604 字节；原各块预算和 256 字节余量门禁通过。exact-SHA 发布验证及实际 CI 状态仍需单独确认。Node 模块导入计时包括解析和测试对照，不能作为浏览器解码性能结论。

## 迁移和回滚

无 Schema、数据库、资产、缓存算法版本或历史任务迁移；Project Command 幂等、Revision CAS、ownership、verified assets、持久化和显式导出均不变。回滚该插件、类型声明、测试及 Vite 注册即可恢复原构建存储形式，但会恢复包体超限。4517 测试构建和正式 CI 构建分别执行；不启动生图任务，不恢复已退役本地运行组件。
