# 局部重绘原尺寸引导图上传

- 主模块 M04，协作 M08/M12/M14；算法 PIXEL-EXACT-REFERENCE-UPLOAD/1.1.0。
- 问题：GPT 局部重绘结合图与法线图使用 preservePixels，前端超过 Atlas 的 3.5 MiB 安全 JSON 数据预算直接失败，4K 截图可能无法提交。
- 行为：小图原样上传。前端只对超过原 Atlas 预算的 exact 引导图使用独立的 16 MiB 文件上限，完整原文件交给控制平面；未启用普通参考图 WebP/缩图策略。服务端 8 位 PNG 使用非调色板、原尺寸、无损自适应 PNG 编码，并解码对比尺寸、通道及每个 RGBA 字节；有 ICC 的文件保留原编码。结果仍超过原 JSON 预算时，只通过现有 verified Asset Transfer 对象上传和 owned 短期下载地址交给 Atlas upload_asset。原 Atlas 预算保持不变。
- 4517：未配置对象存储时，适合无损压缩的引导图可以提交；不可压缩的超限图片明确失败，提示配置大图对象存储上传。未伪造成功、降分辨率或恢复退役组件。
- 1.1.0：无损 PNG 仍超限时增加原尺寸 lossless WebP（effort 6），仅选完整解码 RGBA 字节、尺寸与通道都相等且编码更小的候选。透明像素下 RGB 也比较，编码器清除隐藏 RGB 时拒绝该候选；ICC 保持原文件，不尝试转码。仍超限沿用 verified 对象上传，不扩大 Atlas 预算。对象副本扩展名与 MIME 匹配实际选定的编码。
- 用户工程实测：测试合集的 back-left/front-right 原尺寸 1998×1910 / 1998×1916 PNG 无损后为 3,875,876 / 3,972,236 字节，WebP 为 2,432,900 / 2,491,302 字节，全部 RGBA 相等。实际运行上传助手后 data URL 为 3,243,571 / 3,320,635 字节，Atlas upload_asset 均返回 isError=false、上传成功与 asset_id；验证阶段只上传参考资产，没有重复提交已成功任务。
- 安全：大图输入限 16 MiB/64M 像素；对象路径需要当前 job 的 userId/projectId，保留个人 Atlas 账号、ownership、SHA 校验与 verified 状态。缓存仍按个人账号与原文件摘要隔离。图片处理仅位于资产上传阶段，任何失败都发生在 generate_image 前，付费提交不加重试。
- 审计：GPU/CPU/Worker/shader 捕获、法线、作者 mask/depth、回贴、UV、QA、输出分辨率与导出算法均不变；React/Zustand 未新增算法。Project Command 幂等、Revision CAS、工程资产与历史记录保持。新增上传副本仍按既有对象资产生命周期管理，不修改原 Capture。
- 验证：真实超限 PNG 16,806,542 → 19,906 data URL 字节，解码 RGBA 与尺寸一致；真实 4096² PNG 超限元数据移除后逐字节一致；不可压缩超限图阻断；隔离对象适配器验证所属账号/工程、原像素、verified 下载及缺失 ownership/验证失败阻断；实际 GPT 两/三图请求序列化与取消测试通过。完整回归、最终 SHA 发布检查须通过后推送。
- 迁移：无需 Schema 或历史资产迁移。Cloud 使用既有 Asset Transfer v1，未更改协议。回滚需同时恢复前端旧预算门禁与服务端 upload_asset 参数构建，并保留已验证的上传资产；禁止仅回滚服务端后接受大 Base64 直接送进旧 JSON 通道。
- 1.1.0 回滚：恢复只尝试 PNG 的编码选择及固定 PNG 对象 MIME；无历史迁移，已上传的 WebP 资产保持可读。未在此验证中连接正式对象存储。
