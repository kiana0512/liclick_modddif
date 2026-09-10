# 多视图复用单视图回贴规则

版本 2.20.1；主模块 M06，协作 M04/M05/M08；TEXTURE-PROJECTION-PARITY v1.0.0。

## 原因与实现

GPT 多视图批次的每张结果仍是一个相机的图像，但 mode=multiview/metadata.multiview=true 被原单视图专用判断排除，未走原模型 mask 边缘清理、capture-mask、ignoreSourceAlpha、minimumProjectionFacing=0.18、standard visibility。

新增 engine/generation/textureProjectionPolicy.ts，共享 texture-map 且 mode=single/multiview 判断。GeneratePanel 的原尺寸返图去黑边与显式替换、layerStore 新增投影共同使用；相机、深度、原模型完整轮廓（含孔洞）、标准面向裁切与质量混合均复用单视图既有规则。不是切换成单视图调度，也不保证不同 GPT 随机返图内容相同。

## 对应路径与数据边界

- GPU 单层/多层/texture array、预览合成、GPU UV、CPU fallback、Worker mask/export 均消费原有字段；公式不改，既有能力限制不扩展，不降低 2048 或关闭 QA。
- 后续组仍在上一组实际回贴完成后截图，组内两张请求并发。多视图结束补缝、任务取消/删除回执、持久化事务不变。
- 局部重绘/参考图生成不符合规则，不改变锁面/羽化行为。
- 新多视图保存 capture-mask，恢复时走既有 canonical 分支；作者 UV 橡皮、透明度和历史保持。老多视图不自动迁移，用户显式重新投影才按新规则替换，避免猜测旧资产或抹除编辑。
- 无 Layer/Project Schema 改动。Command 幂等、Revision CAS、ownership、verified assets 不变；显式替换继续递增 contentRevision，使派生缓存失效。

## 验证

- test-single-view-priority：实际 store 新建单/多视图，mask/depth/camera/coverage/facing/alpha/visibility/blend 字段一致；序列化恢复保留 UV 橡皮；排除 local-repaint/参考生成。
- test-single-view-auto-projection：执行生产函数，单/多视图均调用原模型遮罩边缘清理；新增与显式替换均使用同一规则；取消/并发/删除/恢复契约通过。
- 真实 Edge WebGL：同图同相机，经实际 store 的 single/multiview 入口创建材质，在三个角度、视口/覆盖捕获两模式中六组 RGBA 逐像素完全一致；原 GPU UV/Worker/遮罩检查通过，Shader 无编译错误。合成模型不替代用户原工程验收，未调用付费生图。
- 全部 108 项 Web 回归通过；TypeScript 构建、变更 ESLint、Cloud 构建通过。84 chunks / 3,157,152 bytes，既有包体预算通过；Cloud 产物检查通过。

## 发布与回滚

用户已授权同步 master 与 A100；使用同一提交的不可变构建发布，备份旧产物，保留运行数据与非版本配置，核对线上前后端版本及 ready 状态。回滚恢复三处单视图专用入口判断与 store 内 predicate；已生成图层保留原字段，不批量删除或重写用户数据。
