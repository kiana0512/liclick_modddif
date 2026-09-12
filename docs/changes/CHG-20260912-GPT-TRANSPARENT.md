# GPT 透明背景与源 Alpha 回贴一致性

- 授权：用户要求一并接通透明返图请求与单/多视图 Alpha；原远端局部重绘内缩保留。
- 主模块 M04/M06；协作 M07/M08/M12。算法 `GPT-TRANSPARENT-TEXTURE/1.0.0`。
- 状态：本地实现，未推送/部署，不调用真实收费生成。

## 规则

莉刻技能 registry 已核对 GPT2、Sunburst、Flare 支持 background=transparent。服务端仅对这些模型的 texture-map/local-repaint 请求设置此参数，不改变参考图生成、其他模型、原远端 ModelView/Klein、画布分辨率、数量或提示词。参数随现有 extraParams 原样进入任务应答和磁盘记录；直接完成、轮询和列表恢复均已透传该字段。

前端独立 engine 策略读取实际记录的 background=transparent，而非只看模型名。单/多视图仍共用 capture-mask 投影与质量混合，但显式 ignoreSourceAlpha=false；源 Alpha 与捕获 coverage、深度/角度和橡皮蒙版共同限定覆盖。新返图不再调用旧 RGB 边缘去污染/背景抠图，也不执行主体裁边或重新缩放；下载/保存沿用 Blob/Data URL 原字节管线。面板预览直接展示返图，透明图层缩略图只缩小原图，不再做几何抠图；放大使用原图。它们都不能作为裁边后的投影源。

新局部 GPT 延续 GPT-REPAINT-ALPHA/1.0.0，不做内缩或强制不透明；原 ModelView/Klein 保留 ALG-LR-013。原始笔刷选区始终是写入授权。

## 对应实现与兼容

- GPU 常驻/投影预览/烘焙、CPU UV raster、Worker mask、UV 合并及 FBX 预处理已透传 ignoreSourceAlpha，复用原 source-alpha × mask 公式，不增加新的 Shader 分支。
- 规范 capture-mask 图层 setLayers 保留显式 false；旧无标记默认 true，历史 single-view-priority 迁移保持既有规则。保存仍使用原 Layer 布尔字段，不升级项目 Schema/命令/CAS。
- 原始资产与缓存签名包含的 imageUrl/ignoreSourceAlpha 不变；新生成使用独立资产 URL，不重写旧缓存和旧图层。旧 GPT 任务没有 transparent 请求记录时仍使用旧路径。
- 不增加黑色识别、自动补洞、重复内缩；尚不能把接口支持等同实际返图完美，需真实图验证细杆、孔洞及透明边缘。

## 验证与回退

2026-09-12 验证：前端完整 123 项回归通过，服务端 GPT 参数及个人账号边界专项通过，前后端 TypeScript/生产构建通过。包预算 93 个 JS 块共 3,218,627 字节，小于原 3,222,000 字节上限，未放宽预算。修改前端文件 ESLint 零错误；LayersPanel 保留五个未涉及的既有 unused 警告。未实际发起付费生成、未进行真实返图视觉验收、未推送或部署。

新增服务端测试覆盖两类任务及三种 GPT 模型参数，参考图/非 GPT 不变；前端覆盖单/多一致性、保存刷新保留 false、橡皮蒙版不变、旧任务不迁移、透明/半透明像素与 mask 的乘积、重复处理绕过。其他前端回归覆盖 GPU/CPU/Worker/合并/导出透传。

回退可先关闭后续透明参数提交；已完成的新图层必须保留显式 false 的规范化读取支持，否则旧构建会恢复为忽略 Alpha。旧图层不批量改写，不删除资产，不自动重新提交收费任务。
