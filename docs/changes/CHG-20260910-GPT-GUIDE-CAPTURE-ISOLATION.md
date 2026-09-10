# GPT 模型引导图捕获隔离

主模块 M03，协作 M04/M06/M08；维护版本 2.19.17，新增 CAPTURE-MATERIAL-ISOLATION v1.0.0。实施 Codex，视觉验收由维护者在原工程执行。

## 现象与依据

用户期望 GPT 收到两张图：带结构明暗的白模（或者保留已有纹理、未覆盖处为白模）和用户选择的材质参考。反馈图片却有纯白剪影和矩形白块。

代码发现两条竞态：成对流程先运行 withStableClayTargetPresentation，再立刻捕获 flat-target-coverage；清除 transient white 状态不代表 SceneRoot 的异步材质重建已经完成，仍驻留的白模 StandardMaterial 会被 flat 工厂变成无明暗的 BasicMaterial。补全 Worker 将特殊斜线识别为缺失纹理，不把普通白色当缺失，故白色剪影可以进入完整覆盖分支。其次 captureFlatTarget 原来仅在整个分块任务外切换/恢复材质，512px tile 之间主动让帧期间可能被视口重建替换，形成一张图片混用两代材质的方块。

两个直接执行生产函数的受控回归均能使 HEAD 基线失败、新实现通过。未对用户真实工程运行收费 GPT 请求，不能把受控时序验证描述为实机视觉验收。

## 修复契约

1. 每组等前组结果驻留后，先串行捕获本组两个视角的已有纹理；再运行原 shaded clay、mask、normal、depth 捕获。GPU 捕获始终串行，网络仍两个一组并发，组间串行。
2. 用提前保存的颜色和同视角 shaded clay/原始完整模型 mask 运行原补全 Worker。无已有纹理时使用 shaded clay；部分覆盖保留纹理并填补未覆盖白模；完全覆盖保持原当前效果。原材质参考仍为第二输入，不发送诊断 mask 当作模型图。
3. flat 捕获通过 renderSceneToPngUrl 的 prepareScene 钩子，仅在每个同步 draw 内应用目标可见性/材质及 lighting/exposure/hatch 等 uniforms，提交后立即恢复。每次只释放自己的临时材质，不释放作者纹理/常驻 shader；失败也恢复，恢复器可重复安全调用。
4. 捕获开始保存 mesh 材质身份，各 tile 前核对；中途被视口替换则报错，不编码/提交混合图片，不用旧材质快照覆盖新权威材质。用户可等待预览稳定后重新提交。

## 对应实现审计与性能

- GPU：共享 renderer 的 target/clear/viewport/scissor 机制不改，使用已有逐 tile prepare/restore 协议。常驻投影 shader 程序继续复用，避免每块克隆大 shader。普通材质临时 BasicMaterial 生命周期变为每块，额外工作限于可见性/材质引用管理；不增加图像读回或像素处理次数。
- CPU/Worker：补全与 PNG 编码原实现不变，不从返回图重新分割轮廓；原模型 mask/depth、内外轮廓 2px 裁切、颜色空间、相机和 2048 输出均保持。
- shader/UV/export：投影与局部重绘混合公式、UV 烘焙、导出、历史擦除无改动；共享 flat 捕获的局部重绘输入也获得分块隔离。
- 持久化：沿用原捕获资产保存、生成提交、Project Command 幂等/Revision CAS/ownership/verified asset。无 Schema 或数据迁移，不删除已有工程、图层或生成记录。

## 验证

- test:gpt-multiview-pairs 执行生产面板入口与配对调度：模拟白模延迟恢复；断言纹理先于白模捕获、两张固定输入、原 mask、2048、前组纹理、完整覆盖、失败保留与顺序；`--baseline` 在旧入口失败。
- test:flat-capture-material-isolation 执行生产 flat 工厂/适配器及 applyTargetOnlyMaterial：16 个 tile，真实 Three 材质/共享 shader，模拟 inter-tile yield、材质替换和 draw 失败；验证纹理身份、uniforms、可见性、释放与中断。`--baseline` 在旧适配器失败。
- 原 test:capture-renderer-isolation 验证生产分块 render 循环的像素/边界及每次 prepare/restore 接线。
- 类型、变更文件 ESLint、107 项完整 Web 回归、Cloud Web 候选构建及 cloud-artifact 通过；未运行收费 GPT 生图或原工程浏览器视觉验收。
- 候选 Cloud（/li3d/、性能实验模块开启）：84 JS chunks，共 3,157,475 bytes，低于原总预算 3,160,000。EditorPage 498,829 bytes，新增校验/时序编排超原单包 498,512 限制 317 bytes；仅登记本正确性修复的 512-byte 单包增量至 499,024，其他单包与总量预算不变。不删除校验、测试或降低分辨率换预算；正式发布参数需重新测量。

## 回滚

还原本次面板捕获先后顺序及 captureFlatTarget 生命周期，移除新测试登记即可；配对规划、投影提交与相机平滑取景不需回退。不需要迁移/删除资产。已存在的错误生成输入不会被静默重写，需要重新发起对应视角的生成。本次仅本地修改，未推送或部署。
