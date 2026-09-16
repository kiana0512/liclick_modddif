# GPT 多视图结合图上传预算修复

主模块 M04，协作 M03/M08/M12/M14；GPT-COLOR-REFERENCE-UPLOAD/1.1.0，沿用 REPAINT-COLOR-REFERENCE-UPLOAD/1.0.0 编码算法。

## 原因和范围

维护者反馈多视图左前上传仍提示“无损编码后超过 Atlas 上限，未配置大图对象存储”。原有 RGB 自适应压缩只匹配 local-repaint 的结合图；texture-map 的第一张 Current model view 结合图没有进入该策略。

新增窄入口：GPT2/GPT2.5、texture-map、无六视图参考两阶段 pipeline、有 framing、至少两张参考、第一张名称符合 Current model view 契约，仅 index=0 启用原尺寸自适应 RGB WebP。先尝试原无损路径，耗尽预算后才有损压缩上传副本；尺寸、全部 alpha 字节和完整 JSON <4,000,000 字节门禁保留。第二张材质参考、法线、mask、未知名称、非 GPT 和六视图参考生成不进入有损策略。上传缓存与无损策略通过 gpt-color-v2 标签隔离，错误仍删除失败缓存；个人账号缓存隔离保持。

原 PNG/capture、冻结相机、模型轮廓 framing、mask/depth/normal、返图还原、逐层投影转 UV/权重合成、GPU/CPU/Worker/shader、QA、输出分辨率均不变。未启用临时实验内核或已退役运行组件，不要求本地保存新凭据。不可压缩 alpha 或编码尺寸/字节安全上限仍明确阻断，不缩图以绕过限制。

## 验证

真实 4096×3072 纹理噪声图：PNG Base64 7,204,982 字节，无损路径超过原 inline 预算；自适应输出 3,503,335 字节，尺寸和 alpha 保持，完整 JSON 小于 4MB。局部重绘既有 1536×1536 噪声/透明度/不可压缩 alpha 回归仍通过。窄入口测试覆盖 GPT 模型、自定义视角、材质/法线/mask、未知名称、缺 framing、缺第二参考、非 GPT 与六视图 pipeline。没有提交真实付费生成，不能据此宣称十张实际生图已验收。

## 迁移和回滚

无数据库、Schema、Project Command/CAS/ownership/verified asset 或历史任务迁移，持久化和导出不改。新策略只影响后续上传副本。回滚 isGptTextureColorGuide 及调用组合可恢复旧多视图无损入口，保留原局部重绘压缩和已成功资产；回滚后复杂结合图可能重新超限。4517 必须加载新服务构建后人工复测，旧失败任务不自动重新付费提交。
