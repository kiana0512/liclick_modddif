# 蒙版投影转 UV 的 PNG 主线程阶段

主模块 M07，协作 M03/M08/M09/M12/M13；MASKED-PROJECTED-PNG/1.0.0（关联 ALG-LR-013，图像公式不变；私有 Worker 增加 pngOnly 请求）。

## 问题与变化

逐层投影蒙版预处理已在 Worker 执行，但返回完整 RGBA 后，主线程仍创建全尺寸 Canvas、putImageData 并 toBlob 编码 PNG。Resident UV 准备、显式 Merge 和带投影蒙版的导出共用此入口。新的 Worker 支持把其返回的 task-owned RGBA 直接再次转交，使用同等 Canvas 2D putImageData/PNG 编码，主线程只收 PNG ArrayBuffer 并登记 Blob URL。缓存 imageSampler 原数据仍在原处理入口复制，不转移或分离借用数组；转交编码的只有 Worker 返回的私有 output ImageData。

Worker 串行编码，最多同时创建一个全尺寸 Canvas；成功/失败均释放 Canvas，失败明确返回，不跳过蒙版或改用未经处理的来源。原像素消息协议仍可用，浏览器不支持 OffscreenCanvas.convertToBlob 时保留原 Canvas PNG 兼容路径。没有重采样或降低分辨率，没有修改回图 framing/相机或透明轮廓门禁。

## 验证与边界

- 内置浏览器使用真正 4096×4096 RGBA 和带孔洞/边界的投影 mask，两个 alpha 策略（保留源 alpha/原忽略源 alpha）各做旧/新/旧/新：完整 decoded RGBA SHA-256、尺寸一致，八次无像素差异，0 runtime error；未提交付费生图。
- 旧四次均有 51–60ms 主线程 longtask，新四次均无 >50ms longtask。旧总耗时约 1.65–1.91s，新约 1.67–1.72s；此例主要减少主线程阻塞，不代表总处理或真实用户工程已零掉帧。PNG 编码、GPU 首次编译、光栅/合成和回读仍可能占时。
- 实际 Worker 消息处理回归：并发只分配一个 PNG Canvas、原 RGBA 送入编码器、成功/失败释放、编码失败不污染后续队列、原 pixel 消息保持。借用 source/mask alias 三次转移不分离、post 失败清理、模型轮廓/原 RGB/薄片/framing、临时 UV/导出和保存门禁保持。

## 审计、迁移和回滚

GPU/CPU/Worker/shader 的 projected alpha 公式、Top-K/逐层 UV 权重、完整 RGBA/coverage、normal/depth/作者 mask、QA 和输出分辨率不变。PNG 已解码像素保持；编码器环境可能改变 PNG 压缩字节，派生 Blob URL 按原通道重新生成，不复用旧 task output buffer。持久资产、Project Command 幂等、Revision CAS、ownership、verified assets、保存成功后付费门禁和导出语义不改。私有任务消息是同一构建中的新可选字段，无持久 Schema/资产迁移；不转移 live canvas 或缓存像素。回滚主线程 PNG 分支和 Worker pngOnly 扩展，保留原蒙版公式与全部失败保护；既有 PNG 资产仍可读取。
