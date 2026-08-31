# 远端 master 性能与状态修复合入

- 日期：2026-08-31
- 状态：合并验证完成；包体预算存在超限，详见验证结果
- 主模块：M05/M06 图层与实时投影；关联 M01/M04/M08/M12/M14/M15
- 算法：ALG-ERASE-001 v1.2.0、ALG-PROJ-007 v2.1.0、SAVE-SCHEDULER v1.1.0
- 本地检查点：66bab93；备份分支：codex/local-before-master-20260831
- 远端范围：abc3b77..8ac0379（7 个提交）

## 合并范围与决策

合入投影橡皮低延迟、图层显隐权威状态、清理蒙版后 GPU 状态恢复、PBO 上传状态修复、投影预览有界重试、多模型保存合并队列和同源 loopback 开发资产上传修复。远端删除 AGENTS.md 不作为性能变更接收，继续保留本地维护规则。合并不推送远端，不改变生产服务配置，不调用真实生成任务。

## 保留的本地契约

Qwen 继续接收干净当前效果图、完整参考图和未外扩原始蒙版；有用户输入则优化，留空则分析区域问题，结果只进入内部 Generation，指纹一致时复用。ModelView 接收仅原始蒙版内混合白灰几何的效果图、原参考图和 16-48px@2K 外扩/4-10px 羽化蒙版。Capture、Generation.maskUrl、画笔和恢复继续使用 authoredMaskUrl 优先、legacy maskUrl 回退；远端蒙版独立存 submittedMaskUrl。禁止把两类蒙版重新混为同一授权范围。

## 输入与行为

- UI-09 眼睛同步读取 LayerStore；隐藏活动层退出工具，笔画目标排除隐藏层与其他对象。
- UI-10 普通 projected 橡皮保留每帧末次采样及连续段绘制，只更新可见 keep-mask；提交窗口 48ms，切层优先完成旧提交，交接期间拒绝新笔画，高分辨率细化仍为 3000ms。
- M06 每个纹理 stripe 解绑 PIXEL_UNPACK_BUFFER，并在 finally 恢复原绑定。渐进预览自动重试总尝试最多 4 次，退避 250/500/1000ms；关闭工作区取消未完成构建，预热仅面向当前对象。
- UI-01 保存前同步延迟编辑版本，执行器只保留在途及最新待保存任务；旧操作不覆盖新保存状态，稳定资产缓存避免重复上传。Ctrl+S 不再同步读取 WebGL 缩略图。
- 文件型 Repository 的目录定位与备份队列仅用于隔离开发；4517 同源 loopback 上传兼容不等于恢复旧桌面组件。

## 全链一致性与持久化

GPU/CPU/Worker/shader 的投影、深度、coverage、颜色和 UV 公式未变，Worker packing、实际项目分辨率、UV 合并和模型导出继续读取相同作者数据。变化仅限输入调度、资源上传、资源生命周期与保存执行队列。

Project Command v1、Revision CAS、ownership、verified assets、Project/Layer/Capture/Generation Schema 均不升级；没有数据库或工程数据迁移，不改写用户模型、纹理和历史生成结果。所有回归使用测试数据，不允许借测试替换真实工程。

## 验证结果

- 完整 Web regression：71 项通过，包含本地 Qwen/远端输入分离、历史蒙版恢复，以及远端新增图层/橡皮/保存断言。
- 完整 Server regression：10 项通过，覆盖提示词、资产、Pipeline、Repository 与 Revision。
- typecheck、build、verify:modernization、check:cloud-artifact 通过；Cloud/repository 边界与 contracts 无回归。
- check:web-bundle-budget 未通过：editor route 492,908 bytes / 上限 490,000；total JavaScript 3,082,631 bytes / 上限 3,080,000。保持原预算阈值，不以放宽阈值或更改无关业务规避超限；该项需后续包体优化，不能宣称全量门禁通过。
- 不调用真实远端生成、不改写真实工程；本次未做浏览器内连续重绘手工验收，自动回归不等同于该验收。
- 维护 Markdown、DOCX、PDF 同步至 2.8.0。PDF 共 32 页，封面、保存、橡皮、投影/参数表、开发资产与修订页已渲染抽查；同时修正参数表分隔符及 DOCX/PDF 封面截断合并基线的问题。DOCX 结构校验通过（16 张表、完整基线、参数表均存在）；LibreOffice/soffice 缺失，DOCX 视觉渲染未完成，独立 PDF 抽查不能替代 DOCX 视觉验收。

## 回退

保留 66bab93 与备份分支作为合并前本地基线。若需回退，审核后以合并提交的第一父提交为主线执行非破坏性 revert；不得 reset --hard、删除用户工程或覆盖对象资产。回退只撤销本次远端优化，不撤销检查点中的 Qwen、蒙版融合与画笔授权修复。已有 Project Revision 和所有历史资产继续有效。
