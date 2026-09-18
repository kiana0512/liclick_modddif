# 多视图投影橡皮 texture-array 快速路径

- 日期：2026-09-18
- 主模块：M08
- 协作模块：M06、M07、UI-06、UI-10
- 算法：`ALG-ERASE-001` v1.5.5、`UV-DISPLAY-BUFFER` v1.5.3
- Schema / 持久资产迁移：无

## 问题与根因

`ALG-ERASE-001` v1.5.4 已阻止活动笔画把 draft 送入 Resident UV，但显示切换仍受 direct projected sampler 预算约束。六个可见多视图投影同时带图片、mask、depth/normal 时，direct shader 超出常见 WebGL 纹理单元预算，`canUseExactProjectedEraserStack` 因此为 false。结果是橡皮已激活、keep-mask 也在写入，画面却继续由 Resident UV front/重算承载，表现为条纹空洞延迟出现和明显卡顿。

另一个遗漏是 Resident UV 只在 draft revision 大于零时避让；工具已经激活但尚未 pointer-down 的窗口仍可能启动或继续最终收敛。

## 修改

1. projected-mask 橡皮一旦激活即取得显示所有权，不等待首次 pointer-down。
2. 单层或 sampler 预算允许的栈继续使用 exact direct material；WebGL2 多层栈使用既有 exact texture-array material。
3. live keep-mask 保持独立全分辨率纹理，只叠乘当前目标层的原 projection mask；不进入 texture array，不触发逐点重打包。
4. Resident UV 在同对象、同目标层的 armed preview 存在时，在创建 draft 或 flush 之前返回；已有非交互最终任务在下一取消检查点终止。
5. 预算或 WebGL 能力不安全时保持最后 verified front，禁止用 Resident UV 充当橡皮交互后备。

## 不变边界

- 不改变 projection coverage、depth、normal、层序、opacity、Top-K、gutter 或 rendered-color 公式。
- 不降低分辨率，不关闭 QA，不跳过正式 mask 保存。
- CPU/Worker 正式合成、撤销/重做、Project Command、Revision CAS、ownership、verified assets、导出和重新打开语义不变。
- Resident UV 仍可在退出橡皮或交互空闲后为正式签名做后台最终收敛。

## 验证

- `test-projected-layer-visibility.mjs`：断言 armed 多视图选择 texture-array，idle 仍为 UV-only。
- `test-resident-uv-display.mjs`：断言工具激活、尚无 draft 时即阻止 Resident UV，并取消在途 final convergence。
- `test-resident-uv-visibility-scheduling.mjs`：行为回归覆盖零 draft、零 flush、零 bake。
- TypeScript typecheck 与生产 Vite build 通过。
- 4517 真实六投影层工程：激活橡皮后 `useTextureArrays=true`、`fallback=false`；两次真实笔画前后 Resident UV draw 数保持 6、projection revision 未增加、projected material build revision 保持 1。测试笔迹随后已撤销。

## 回滚

回滚时恢复 `useProjectedTextureArrays=false`、direct-only 预算门禁与 draft-revision 级 Resident 避让即可；无需数据迁移或删除资产。回滚会重新引入多层投影橡皮退回 Resident UV 的卡顿，不影响已经保存的 mask。
