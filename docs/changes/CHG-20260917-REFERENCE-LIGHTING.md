# 多视图光照处理

- 主模块 M04，入口 UI-05 参考图菜单，协作 M12/M13。负责人 Codex，按用户要求实施。
- REFERENCE-LIGHTING v1.0.0；REFERENCE-GROUP-BINDING v1.2.0；状态 implemented，尚未发布。
- 单视图菜单继续“生成多视图”；多视图菜单改为“光照处理”，上传的独立多视图无需来源单视图。任务锁继续禁用操作。
- 输入当前多视图（仅一张）及已有登录身份/工程；前端跳过参考图重采样。服务端强制 Sunburst medium / count=1，复用 REFERENCE-DELIGHT-PROMPT v1.2.0 保色模板，忽略通用生成提示词。ratio/size 为 auto/auto，要求沿用输入构图而不强制为 3:2；实际返图尺寸由提供方决定，此功能未承诺逐像素一致。
- delight-only-v1 走既有受认证、owner 隔离、幂等任务入口，只调用一次生图；advanceReferenceDelight 不对此标记启动第二阶段。已有 six-view-delight-v1 保持 low → medium。
- 成功且资源持久化后更新当前多视图 URL、尺寸与 generationId；保留图 ID、名称、组 ID 和 derivedFromReferenceId，选择更新后的图，绑定的单视图在后续贴图使用新图。原图资产不物理删除；失败不替换。重复处理沿用同一图 ID。
- referenceOperation=lighting 与 referenceBindingSourceId 为可选任务 metadata，后者按原始单视图/独立多视图统一判定最新任务，防止新处理失败或刷新后旧任务复活。发布前重新核对当前工程、来源存在和最新任务；取消和迟到结果沿用现有保护。
- GPU/CPU/Worker/shader、投影、UV、重绘、保存/export 像素算法和分辨率设置不变；本功能仅编辑参考图。Project Schema、Command/CAS、ownership、verified assets 不变，无迁移。
- 回滚：恢复旧菜单/请求分支/绑定帮助函数，保留已保存图片和任务；回滚前须让光照任务终态，旧服务端不接受新标记。

## 验证

- 真实浏览器菜单：单图显示生成多视图，独立多图显示光照处理；回调传递当前多图，选中正确，锁定时禁用。
- 执行生产请求表达式及客户端序列化：标记、当前输入图、medium、auto/auto 与 pixelExactReferenceIds 正确。
- 服务端生产函数夹具：只提交一次，强制共用完整保色模板，成功返回最终结果；已有任务恢复只轮询、不重提六视图。
- 绑定回归：来源单图、独立上传、重复处理、同 ID/正确选中、持久化重载、失败保留和过期保护。既有两阶段/取消/失败回归通过。
- Web 类型检查、Server 构建通过；变更源码 lint 无错误（GeneratePanel 两个既有未用变量警告）。未调用付费远端生图做画质验收。
