# UV 上传分段计时与共同等待

2026-09-15。主模块及维护责任 M07，协作 M06；显示调度策略 `UV-DISPLAY-BUFFER` v1.5.1。本地实现，未提交或线上部署。

## 原因与改动

用户 2K 工程最近一次记录总重算 465.8ms，其中 displayUploadMs=125.0ms。该字段包含像素准备、Worker/分块准备、GL 上传及主动等待，不能把 125ms 当成 GPU 执行时间。

普通非交互 Resident UV 原先依次上传颜色、遮罩，每张末尾各等两次浏览器绘制。现在使用已有 deferVisiblePresentationBarrier 参数，两张私有纹理提交完后共等两次，再登记并 onReady 发布。共享 GL 队列保持上传在采样之前，不增加 GPU fence/finish 同步阻塞；旧画面保持到新结果完整就绪。

保留共同的两次绘制等待，没有在本次进一步降为一次或零次；先消除重复等待并取得明确阶段数据。分块大小、4ms 批次预算、交互避让 240ms 及让出前后的取消检查不变。交互式橡皮/局部 patch 路径保留原等待方式；新结果仍不会写入当前显示纹理。

## 计时字段

每次 Resident 重算重新初始化计时；颜色与遮罩累计到同一个可选计时对象，成功发布时写入现有 residentUvProjectionStages。单位 ms。

| 字段 | 范围 |
| --- | --- |
| displayUploadPrepareMs | 像素副本、位图、Worker 纹理/遮罩准备；交互式路径还包含原有 patch 准备/上传 |
| displayUploadAllocationMs | renderer.initTexture 调用经过时间；微小直接纹理也包含初始上传 |
| displayUploadStripeWaitMs | 等待已启动分块准备的剩余时间，预取可与其他阶段重叠，不代表 Worker 总耗时 |
| displayUploadSubmitMs | 分块绑定和 texSubImage2D 的 CPU 调用经过时间，不是 GPU 执行时间 |
| displayUploadInteractionWaitMs | 等待视口交互安静及对应调度开销 |
| displayUploadYieldMs | 分块之间主动让出任务/绘制的等待 |
| displayUploadPresentationWaitMs | 上传末尾的绘制等待，普通重算为两张纹理共享的一组 |
| displayUploadOtherMs | 总计减去上述各项，包括 GL 状态保存/恢复、flush、登记等剩余开销 |

八项互斥，浮点误差范围内合计为原 displayUploadMs。它仍在 onReady 之前结束，不是从鼠标点击到屏幕实际呈现的端到端测量。计时对象只对新启动的上传收集；已有 ready/pending 缓存命中沿用原行为。共享上传函数其他消费者不传计时对象即可保持原入口。

## 路径审计

颜色、R8 遮罩、Y 翻转、Alpha、分辨率和 GPU/CPU/Worker/shader 像素算法未改动。普通合并、导出、其他预览上传使用原有默认屏障；既有 lookahead 自己的共同屏障保留。GPU QA、Project Command/CAS/ownership/verified assets、持久缓存 purpose、像素版本和 Schema 不变，无数据迁移。

## 验证

- 新增 test-resident-upload-barrier：原代码观察到 color/frame/frame/mask/frame/frame/publish，断言失败；修改后为 color/mask/frame/frame/publish。分别在共同屏障的两次等待中取消，均不发布结果；受控时钟验证分段合计。
- test-preview-upload-cleanup 增加真实上传函数的计时断言；RGBA bitmap/bytes、R8、可见/离屏、取消/失败、延后到达的分块、GL 状态恢复和资源所有权测试通过。
- test-uv-source-lookahead、test-resident-uv-display、test-uv-postprocess-scheduling、完整非增量 TypeScript 与修改文件 ESLint 通过。
- 2K 独立 run-resident-uv-browser.mjs upload-barrier：17 次显隐检查，page errors=[]，画面恢复 finalDiff 最大 0，UV 岛边缘最大差异 0。最后一轮上传总计 33.8ms：准备 16.0、分块等待 6.4、CPU 上传调用 2.7、交互等待 0.2、末尾等待 7.7、其他 0.8，其余为 0。该隔离模型用于验证接线和正确性，不与用户工程 125ms 做性能对比。
- 干净临时目录 Vite production build + 原包体门禁通过：96 块，3247218 / 3247500 字节；没有提高预算。

## 生效与回滚

更新本地 apps/web/dist 后，用户刷新页面并触发新重算才会产生新字段；本次没有刷新或操作用户工程。回滚本次两个源文件的计时及屏障差异、专项测试/入口和维护记录即可，保留先前拓扑、留边、底图与接缝工作，无资产迁移。
