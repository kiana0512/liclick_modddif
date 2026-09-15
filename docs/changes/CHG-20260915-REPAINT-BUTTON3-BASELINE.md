# 局部重绘按钮3与指定版本兼容

主模块 M08，UI-10/UI-06；协作 M03/M07/M12。激活契约 `ALG-LR-008/2.4.6`，原生 UV 像素算法和 `UV_REPAINT_VERSION=4` 不变。

## 基线与范围

用户指定 `c6215698d299b0c6469ee20fd7de607b665ac208`（同步局部重绘默认画笔 30 的回归断言）。该提交至本次父提交 5895ce96 的局部重绘核心目录仅 resultPreviewUtils 改变；按钮3 handler、原生 UV session/绘制引擎、冻结作者遮罩、画笔30、羽化45及稀疏历史保留。ViewportCanvas 后续差异是性能测试和 Alt 悬停避让；EditorPage 后续差异是 UV/内容修补复制让步与基准样本准入。整体 checkout 旧文件会丢失这些优化。

本次恢复局部透明结果预览的原图显示：局部结果不进入后续新增的 source-alpha 裁切预览。其他贴图裁切预览、云端参考图原尺寸上传、framing 坐标恢复、轮询恢复、任务身份与取消保留，避免恢复已修复的超限/结果错位问题。没有恢复本地 Windows 组件、4618、安装器、endpoint 切换或本地凭据。

## 入口修复

指定基线也保留旧 presentationOwnerReady 条件：应用画笔只接受 exactOverlayReady，持久化投影橡皮接受 resident 或确切覆盖层。原生 UV 引擎已经准备并注册自身 RGBA 输出时，该旧 owner 条件可能拒绝落笔。不能仅恢复指定文件就视为解决。

原生路径核验当前 owner map 中同一 engine 和注册表中同一 engine.texture；Session 必须 ready，generation/target 与当前来源一致。原资源匹配、作者蒙版、投影范围、历史互斥和遮挡检查保留。旧投影路径仍沿用原 resident/exact overlay 条件。冷解码先退出画笔并显示等待，精确 ready/failed 终态结束等待；同一请求取消时清除等待，旧请求完成不能清掉新请求。

## 对应链路审计

- GPU：输入消费已经准备的原生引擎与注册 render target，不在 pointer-down 新建引擎或编译。UvRepaint、深度/面 ID、权重、source alpha、羽化、共享 UV 与 scissor shader 保持。
- CPU：仅 owner/激活条件和预览分支变化；脏瓦片读回、RGBA 差分、撤销/重做与作者选区消费保持。
- Worker/合成：uvRepaintSession 提交屏障、冻结 PNG、合并 source-over 顺序与 opacity 保持，无替代生产计算服务。
- 保存/导出：live 注册表、flushLiveUvCommits、runtime asset 上传、verified asset、Command 幂等/CAS/ownership、PNG/FBX 等待条件保持。没有静默降分辨率、关闭 QA 或改写已有资产。

## 验证及限制

执行生产 owner 条件的回归覆盖原生 UV 无旧覆盖层、原生擦除、缺失 owner、错输出纹理、preparing/failed、旧 generation/target，及旧投影/驻留擦除兼容。执行生产预览条件确认局部透明结果恢复原图，普通贴图保持新裁切；冷准备及 ready/failed 等待检查通过。原生 UV 保存/失败/历史、合并/opacity/导出计划、选区消费、图层切换、面板导航与后台解码/上传回归通过。

4517 新构建显示按钮3冷准备等待及画笔30/羽化45；临时诊断确认真实落笔时 native、owner、注册纹理、Session ready、generation/target 均匹配，旧 overlay visible=0。诊断源码已移除。实际笔画最终 UV/history 验收期间用户开始新的局部生图准备，停止浏览器操作避免干扰；不能把出现撤销按钮或蒙版历史当作 UV 成功证据。此次尚不宣称端到端局部回贴完全验收，也未由代理提交收费生图。

## 迁移与回滚

无 Schema 或资产迁移。回滚只撤销本卡涉及的 owner 条件、冷准备等待和局部预览分支，保留其他性能优化。已保存的 v4 UV RGBA 继续可读；没有缺失笔迹自动恢复。恢复旧 owner 条件会重新出现原生 UV 被旧覆盖层门禁拒绝的风险。
