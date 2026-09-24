# CHG-20260924-REFERENCE-IMPORT-BUDGET

M02 输入资产 / REFERENCE-IMPORT-BUDGET v1.0.0，production；负责人 Codex，用户明确要求导入参考图压缩至 4 MB 内。

文件选择、参考图库拖拽/粘贴、编辑器拖拽及 URL 回退共用 prepareImportedReferenceImage，在创建参考图并触发保存/去高光之前处理。输入 Blob 或 URL，输出 data URL；图片编码字节不超过 4,000,000。小图保留原始编码；大图复用参考图 WebP 压缩器，保留透明通道、比例，按既有质量/尺寸梯度压缩，失败明确报错，不保存超限原图。URL 必须可读取以验证字节预算。

显示尺寸从处理后图片读取；后续保存、去高光和任务引用同一压缩源。无需 Project Schema 迁移，已有参考图和生成/捕获图不重写。GPU/CPU/Worker/shader/投影/UV/导出算法不变，此规则仅作用用户新导入参考资产。任务提交仍保留现有更严格的 Atlas JSON/Base64 预算，不把文件 4 MB 误当请求总大小。

验证：Web typecheck；test-reference-import-budget.mjs 覆盖小图不改写、恰好上限、URL 超限压缩、输出字节和失败资源释放。浏览器真实编码质量未做端到端验收。回退移除导入调用，恢复仅在生图提交时处理；已有压缩资产不逆向恢复。
