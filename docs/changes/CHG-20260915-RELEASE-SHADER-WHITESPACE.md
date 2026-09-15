# 正式发布 shader 空白压缩

- 主模块：M15；算法：SHADER-TEMPLATE-FORMAT/1.4.0。
- 问题：合并 origin/master 后正式 JavaScript 为 3,269,367 字节，超过原预算 3,253,500 字节 15,867 字节，推送前检查阻断。
- 实现：构建期仅压缩 Three.js ShaderChunk 注册的 GLSL 字符串空白；保留换行、预处理指令、词法 token 和全部其他 JavaScript 字符串。已有应用 shader 白名单保持。Terser ecma 与已有 es2022 构建目标一致，unsafe 仍关闭，属性不混淆，日志保留。
- 验证：实际 Three.js 141 个 shader 字符串共去除 16,519 源码字节，独立 token、指令、行数与非 shader AST 叶子对照通过；幂等与拒绝未知 registry、生产 minification 行为夹具和针对修改文件 lint 通过。最终发布产物仍须对准备推送的已提交 SHA 运行 verify:prepush，不以源码节省代替预算通过。
- 审计：M06/M07/M08/M09 的 GPU、CPU、Worker、shader 数学、分辨率、QA、持久化及导出均保持，预算未调整。
- 迁移：无 Schema 或资产迁移。回滚本次 plugin/config/tests 即恢复原构建格式，既有资产无需处理。
- 4517：2026-09-15 已重建并重启，健康检查 ok=true、ready=true；该验收服务不是退役 4618 组件。
