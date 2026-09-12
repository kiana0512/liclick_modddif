# CHG-20260912-ERASER-RESIDENT-PREWARM

## 范围

- 日期：2026-09-12
- 主模块：M08；协作模块：M06、M07
- UI：UI-06、UI-10
- 算法：`ALG-ERASE-001` v1.5.1
- 显示缓冲：`UV-DISPLAY-BUFFER` v1.3.1

## 根因

v1.5.0 的 GPU mask 在选择橡皮后异步创建。若 pointer-down 早于准备完成，手势从 Canvas fallback 开始；GPU 随后接管，但新会话没有收到这次手势的 `begin` 和已经采集的笔段，因此首笔或前几笔需要等待下一次 pointer-down 才显示。与此同时 exact projected 材质栈也在工具激活后才编译，进一步放大首次反馈延迟。

流水线 #630458 的 `web-regression` 另因 `test-projection-performance-safety` 尚未同步 v1.5.0 的共享预算门禁而失败。合并最新 master 后，测试同时执行 array-failure fallback 与橡皮 exact-stack 两个消费者的真值表；运行时仍共享同一 sampler/uniform 安全谓词。

## 修改

当前普通 projected 图层进入可编辑状态后即预热中性白 GPU keep-mask，并发布 live binding，让 exact direct/texture-array 图层栈在用户选择橡皮前驻留。工具切换不销毁同一图层/模型/分辨率的 GPU 会话。

准备窗口内到达的笔段同时写入正确的完整分辨率 Canvas fallback，并记录归一化屏幕起止点、viewport、像素半径、羽化与 erase 操作。GPU 注册前按原顺序补放 backlog：指针仍按下时保持 stroke 打开，后续帧直接续写；已经抬笔时补放完成后立即关闭无历史 readback 的显示 stroke。晚到准备只有仍是当前 layer session 才能发布；图层、模型或分辨率变化按既有销毁路径释放旧纹理和 render target。

CI 修复让 direct fallback 与 projected eraser exact-stack 明确共享 sampler/uniform 安全谓词，并由回归测试覆盖两个消费者的完整真值表；不放松正确性条件。

## 链路与数据审计

- GPU/shader：中性白 mask 和 exact stack 提前驻留；覆盖公式、V 轴、深度、颜色、图层顺序不变。
- CPU/Worker：仅记录准备窗口内的少量屏幕段；正式 CPU/Worker 质量传播、接缝和 gutter 不变。
- persistence/export：backlog 只属于 renderer 会话，不进入 Project/Layer Schema；正式完整分辨率 keep-mask、历史、保存、UV bake 和导出不变。
- Cloud：浏览器零安装与 Cloud 控制面边界不变；不增加 localhost/本地组件或凭据路径。
- 包体：合并最新 master 后正式 Release 实测总 JS 为 3,226,327 bytes；总 JS 门禁从 3,226,000 精确调整为 3,226,500，仍只余 173 bytes。shell/editor/bake/shared 分包门禁、输出分辨率和 QA 门禁均不变。

## 验证与回滚

验证包括类型、零警告 lint、`test:surface-stroke-latency-policy` 的常驻预热/首笔补放结构断言、`test:projection-performance-safety`、原生 UV、投影层、Resident UV、历史事务、Release 构建、包体门禁和 Cloud 部署模拟。

无 Schema 或资产迁移。回滚时移除 projected-layer 预热 effect 和 `eraserGpuBacklog` 补放，恢复 v1.5.0 的工具激活准备；已有工程、蒙版、历史和对象存储资产保持兼容，不得删除。
