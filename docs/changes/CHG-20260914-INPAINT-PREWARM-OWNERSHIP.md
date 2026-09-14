# CHG-20260914-INPAINT-PREWARM-OWNERSHIP

## 范围与根因

- 主模块 M08，协作 M03/M06；UI-06/UI-10。
- `ALG-ERASE-001` 调度修订 v1.5.2；持久化 eraserAlgorithmVersion=1 不变。
- 用户反馈画完选区后局部生图提示“无法读取已绘制的局部重绘蒙版”。
- SurfacePaintOverlay 的局部重绘选区与普通投影橡皮共用当前运行时 owner。后台预热无条件调用 getUvPaintLayer(model, true)，可释放已有 inpaint-mask 并替换为 projected-mask；选区有内容标记未同步清除，随后 canonical mask 捕获返回空。
- 已通过生产 effect、资源访问器和捕获回调的隔离执行验证该路径；没有该次用户操作的完整运行日志，不宣称排除了所有其他读空原因。

## 修复

后台预热不再抢占以下任一状态：正在画选区、应用局部返图、选区有内容、局部生图展示准备，或当前运行时 owner 已为 inpaint-mask。最后一项直接检查 ref，覆盖指针事件已创建蒙版但 React/store 尚未重渲染的窗口。

预热 effect 增加生命周期取消标记，过期异步完成不能重新发布橡皮预览；既有 layer 身份与 GPU 就绪门禁保留。正常无选区的普通投影层继续提前预热，显式切换橡皮仍走原工具准备与提交交接逻辑。

本次采用所有权优先级保护，不另建两套常驻 GPU 缓存，不修改显式工具切换、清空蒙版和卸载的原有释放契约。已被旧代码释放的会话选区不能凭空恢复，需要重新绘制；不以旧截图或全模型蒙版冒充用户选区。

## 链路审计

- GPU：仅改变可选预热启动及晚到发布时机，原准备、backlog 补放与销毁保持。
- CPU/Worker/shader：没有修改笔刷、UV 累积、遮挡、Alpha、质量传播或绘制公式。
- 生图：原局部重绘与 GPT 局部重绘仍捕获同一 canonical UV 蒙版，冻结相机和真实 2048 捕获规则不变；不修改 GeneratePanel 或远端请求。
- 保存/导出：PNG、作者蒙版、图层持久化、UV 合并、导出和撤销/重做没有改变。Project Command、Revision CAS、ownership、verified assets、Schema 与完整分辨率不变，无迁移。

## 验证与边界

- 新增 test-inpaint-prewarm-ownership，纳入现有 test:surface-stroke-latency-policy，因此完整 Web 回归会自动执行。
- 执行实际生产 effect/getUvPaintLayer/capturePaintMask，覆盖活跃选区、未同步 ref、闲置有内容选区、应用返图、生成准备、切活动行、正常预热、effect 清理、owner 更换及 GPU 未就绪。
- 同一测试去掉修复门禁后立即触发“预热试图释放作者蒙版”，修复后原蒙版成功送至原 PNG 捕获入口。GPU 光栅/PNG 编码在夹具中是桩，不等同真实工程端到端验收。
- 通过：Web TypeScript；三个变更代码/测试文件 ESLint；surface-stroke-latency-policy、generation-framing（72 例）、projection-performance-safety、native-uv-repaint。
- 为避免同目录另一任务的构建产物冲突，本次未执行整包构建或完整回归，未提交、推送或部署。发布仍须对最终集成提交执行 verify:prepush 与完整回归。

## 回滚

2026-09-14 集成发布准备：用户授权与两阶段六视图一起同步 master/A100。资源访问器复用同步读取的当前 owner，并将 UV/投影两项相同分辨率分支合并，减少重复代码；保持 HMR 迁移、资源身份、完整分辨率与原包体门禁。最终集成提交重新执行完整回归及正式发布检查，不能沿用独立构建结论。

仅回退预热 effect 的保护和取消处理即恢复 v1.5.1 调度，但会重新暴露蒙版抢占风险。不回滚同目录的六视图/去光改动，不删除工程或资产。无数据迁移。
